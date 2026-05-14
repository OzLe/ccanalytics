/**
 * @module queries/prompt-analyzer
 *
 * Prompt-level analytical queries.
 * Analyzes request-response pairs: each user turn paired with its subsequent
 * assistant turn(s), scored by a composite complexity metric.
 *
 * Complexity score (0-100) is an equal-weighted composite of:
 *   1. Tool calls triggered          (PERCENT_RANK)
 *   2. Total tokens consumed          (PERCENT_RANK)
 *   3. Multi-turn depth               (PERCENT_RANK)
 *   4. Thinking tokens used           (boolean: 0 or 100)
 *
 * KPI-005: the complexity score is a GLOBAL percentile — PERCENT_RANK is
 * always computed over the entire prompt population (full date range, no
 * model/project filters), never over the filtered subset. This makes a given
 * prompt's score identical in the ranked list, the stats distributions, and
 * the detail view regardless of the active period/model/project filter.
 * The filters still control WHICH prompts are listed; they no longer change
 * the score of any individual prompt.
 */

import type {
  PromptRankingRow,
  PromptStats,
  PromptDetail,
  PromptFilterOptions,
  PromptThroughputStats,
  DistributionBucket,
} from "../types/prompts.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildTurnFilters } from "./filter-builder.js";

/**
 * Analyzes user prompts and their assistant responses from conversation_turns
 * and tool_calls tables.
 */
export class PromptAnalyzer {
  constructor(private executor: QueryExecutor) {}

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build dynamic WHERE clauses from PromptFilterOptions, translating them
   * into the QueryFilters shape expected by buildTurnFilters.
   *
   * Returns { clauses, params, startIndex } for composing into SQL.
   */
  private buildFilters(options?: PromptFilterOptions, startIndex: number = 1) {
    const filters =
      options?.model || options?.project
        ? { model: options.model, project: options.project }
        : undefined;
    return buildTurnFilters(filters, startIndex);
  }

  /**
   * The core CTE that pairs each user turn with its subsequent assistant
   * response(s) and computes raw dimensions + complexity score.
   *
   * Expects two bind parameters ($1, $2) for time range start/end,
   * followed by any filter params starting at $startIndex.
   *
   * @param filterClauses - SQL AND fragments for filtering
   * @returns SQL CTE string (without leading WITH — caller wraps)
   */
  private buildPromptPairsCTE(filterClauses: string[]): string {
    return `
      -- Number all turns sequentially within each session
      ordered_turns AS (
        SELECT
          turn_id,
          session_id,
          role,
          timestamp,
          input_tokens,
          output_tokens,
          cache_creation_tokens,
          cache_read_tokens,
          cost_usd,
          model,
          content_text,
          has_tool_use,
          has_thinking,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, turn_id) AS rn
        FROM conversation_turns
        WHERE timestamp >= $1 AND timestamp < $2
          ${filterClauses.join("\n          ")}
      ),

      -- Identify user turns that have real prompt text
      user_turns AS (
        SELECT *
        FROM ordered_turns
        WHERE role = 'user'
          AND content_text IS NOT NULL
      ),

      -- For each user turn, find the next user turn's rn to bound assistant turns
      user_bounds AS (
        SELECT
          ut.turn_id,
          ut.session_id,
          ut.rn AS user_rn,
          ut.timestamp,
          ut.content_text AS prompt_text,
          LEAD(ut.rn) OVER (PARTITION BY ut.session_id ORDER BY ut.rn) AS next_user_rn
        FROM user_turns ut
      ),

      -- Aggregate assistant response(s) between each user turn and the next
      assistant_agg AS (
        SELECT
          ub.turn_id AS user_turn_id,
          ub.session_id,
          COALESCE(SUM(ot.cost_usd), 0) AS response_cost,
          COALESCE(SUM(ot.input_tokens), 0) + COALESCE(SUM(ot.output_tokens), 0)
            + COALESCE(SUM(ot.cache_creation_tokens), 0)
            + COALESCE(SUM(ot.cache_read_tokens), 0) AS total_tokens,
          COALESCE(SUM(ot.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(ot.output_tokens), 0) AS output_tokens,
          COALESCE(SUM(ot.cache_creation_tokens), 0) AS cache_creation_tokens,
          COALESCE(SUM(ot.cache_read_tokens), 0) AS cache_read_tokens,
          COUNT(ot.turn_id) AS multi_turn_depth,
          MAX(CASE WHEN ot.has_thinking THEN 1 ELSE 0 END) AS has_thinking,
          -- Pick the model from the first assistant turn
          MIN(ot.model) AS model,
          -- Collect assistant turn IDs for tool call join
          LIST(ot.turn_id) AS assistant_turn_ids
        FROM user_bounds ub
        JOIN ordered_turns ot
          ON ot.session_id = ub.session_id
          AND ot.rn > ub.user_rn
          AND (ub.next_user_rn IS NULL OR ot.rn < ub.next_user_rn)
          AND ot.role = 'assistant'
        GROUP BY ub.turn_id, ub.session_id
      ),

      -- Count tool calls across assistant turns for each prompt
      tool_counts AS (
        SELECT
          aa.user_turn_id,
          aa.session_id,
          COUNT(tc.tool_call_id) AS tool_call_count
        FROM assistant_agg aa
        JOIN LATERAL UNNEST(aa.assistant_turn_ids) AS t(aid) ON TRUE
        LEFT JOIN tool_calls tc
          ON tc.turn_id = t.aid
          AND tc.session_id = aa.session_id
        GROUP BY aa.user_turn_id, aa.session_id
      ),

      -- Combine into prompt pairs with raw dimensions
      prompt_pairs AS (
        SELECT
          ub.turn_id,
          ub.session_id,
          ub.prompt_text,
          ub.timestamp,
          COALESCE(aa.response_cost, 0) AS response_cost,
          COALESCE(aa.total_tokens, 0) AS total_tokens,
          COALESCE(aa.input_tokens, 0) AS input_tokens,
          COALESCE(aa.output_tokens, 0) AS output_tokens,
          COALESCE(aa.cache_creation_tokens, 0) AS cache_creation_tokens,
          COALESCE(aa.cache_read_tokens, 0) AS cache_read_tokens,
          COALESCE(aa.multi_turn_depth, 0) AS multi_turn_depth,
          COALESCE(aa.has_thinking, 0) AS has_thinking,
          COALESCE(aa.model, 'unknown') AS model,
          COALESCE(tc.tool_call_count, 0) AS tool_call_count
        FROM user_bounds ub
        LEFT JOIN assistant_agg aa
          ON aa.user_turn_id = ub.turn_id AND aa.session_id = ub.session_id
        LEFT JOIN tool_counts tc
          ON tc.user_turn_id = ub.turn_id AND tc.session_id = ub.session_id
      ),

      -- Compute percentile ranks and composite complexity score
      scored_prompts AS (
        SELECT
          pp.*,
          LEFT(pp.prompt_text, 200) AS prompt_preview,
          ROUND(
            (
              COALESCE(PERCENT_RANK() OVER (ORDER BY pp.tool_call_count), 0) * 100
              + COALESCE(PERCENT_RANK() OVER (ORDER BY pp.total_tokens), 0) * 100
              + COALESCE(PERCENT_RANK() OVER (ORDER BY pp.multi_turn_depth), 0) * 100
              + (CASE WHEN pp.has_thinking = 1 THEN 100 ELSE 0 END)
            ) / 4.0
          , 1) AS complexity_score
        FROM prompt_pairs pp
      )`;
  }

  /**
   * KPI-005: a self-contained CTE chain that computes the GLOBAL complexity
   * score for every prompt in the entire dataset (no model/project filter).
   * All CTE names are `g_`-prefixed so it can be composed alongside the
   * filtered `buildPromptPairsCTE` chain without name collisions.
   *
   * Produces a final CTE `g_scored_prompts (turn_id, complexity_score)`.
   * Expects two bind parameters at $startIndex / $startIndex+1 for the global
   * date range — callers pass a wide-open range (2000-01-01 .. 2099-12-31) so
   * the percentile population is the whole dataset.
   *
   * @param p - 1-based bind-parameter index of the global range start
   * @returns SQL CTE string (without leading WITH — caller wraps)
   */
  private buildGlobalScoresCTE(p: number): string {
    return `
      g_ordered_turns AS (
        SELECT
          turn_id,
          session_id,
          role,
          timestamp,
          input_tokens,
          output_tokens,
          cache_creation_tokens,
          cache_read_tokens,
          content_text,
          has_thinking,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, turn_id) AS rn
        FROM conversation_turns
        WHERE timestamp >= $${p} AND timestamp < $${p + 1}
      ),
      g_user_turns AS (
        SELECT * FROM g_ordered_turns
        WHERE role = 'user' AND content_text IS NOT NULL
      ),
      g_user_bounds AS (
        SELECT
          ut.turn_id,
          ut.session_id,
          ut.rn AS user_rn,
          LEAD(ut.rn) OVER (PARTITION BY ut.session_id ORDER BY ut.rn) AS next_user_rn
        FROM g_user_turns ut
      ),
      g_assistant_agg AS (
        SELECT
          ub.turn_id AS user_turn_id,
          ub.session_id,
          COALESCE(SUM(ot.input_tokens), 0) + COALESCE(SUM(ot.output_tokens), 0)
            + COALESCE(SUM(ot.cache_creation_tokens), 0)
            + COALESCE(SUM(ot.cache_read_tokens), 0) AS total_tokens,
          COUNT(ot.turn_id) AS multi_turn_depth,
          MAX(CASE WHEN ot.has_thinking THEN 1 ELSE 0 END) AS has_thinking,
          LIST(ot.turn_id) AS assistant_turn_ids
        FROM g_user_bounds ub
        JOIN g_ordered_turns ot
          ON ot.session_id = ub.session_id
          AND ot.rn > ub.user_rn
          AND (ub.next_user_rn IS NULL OR ot.rn < ub.next_user_rn)
          AND ot.role = 'assistant'
        GROUP BY ub.turn_id, ub.session_id
      ),
      g_tool_counts AS (
        SELECT
          aa.user_turn_id,
          aa.session_id,
          COUNT(tc.tool_call_id) AS tool_call_count
        FROM g_assistant_agg aa
        JOIN LATERAL UNNEST(aa.assistant_turn_ids) AS t(aid) ON TRUE
        LEFT JOIN tool_calls tc
          ON tc.turn_id = t.aid
          AND tc.session_id = aa.session_id
        GROUP BY aa.user_turn_id, aa.session_id
      ),
      g_prompt_pairs AS (
        SELECT
          ub.turn_id,
          COALESCE(aa.total_tokens, 0) AS total_tokens,
          COALESCE(aa.multi_turn_depth, 0) AS multi_turn_depth,
          COALESCE(aa.has_thinking, 0) AS has_thinking,
          COALESCE(tc.tool_call_count, 0) AS tool_call_count
        FROM g_user_bounds ub
        LEFT JOIN g_assistant_agg aa
          ON aa.user_turn_id = ub.turn_id AND aa.session_id = ub.session_id
        LEFT JOIN g_tool_counts tc
          ON tc.user_turn_id = ub.turn_id AND tc.session_id = ub.session_id
      ),
      g_scored_prompts AS (
        SELECT
          pp.turn_id,
          ROUND(
            (
              COALESCE(PERCENT_RANK() OVER (ORDER BY pp.tool_call_count), 0) * 100
              + COALESCE(PERCENT_RANK() OVER (ORDER BY pp.total_tokens), 0) * 100
              + COALESCE(PERCENT_RANK() OVER (ORDER BY pp.multi_turn_depth), 0) * 100
              + (CASE WHEN pp.has_thinking = 1 THEN 100 ELSE 0 END)
            ) / 4.0
          , 1) AS complexity_score
        FROM g_prompt_pairs pp
      )`;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get a paginated, sorted ranking of user prompts with complexity scores.
   *
   * @param options - Filter, sort, and pagination options
   * @returns Array of ranked prompt rows
   */
  async getPromptRanking(options?: PromptFilterOptions): Promise<{
    rows: PromptRankingRow[];
    total: number;
  }> {
    const range = options?.period ?? {
      start: new Date("2000-01-01"),
      end: new Date("2099-12-31"),
    };
    const f = this.buildFilters(options, 3);

    const sortColumnMap: Record<string, string> = {
      timestamp: "timestamp",
      response_cost: "response_cost",
      complexity_score: "complexity_score",
      tool_call_count: "tool_call_count",
      total_tokens: "total_tokens",
      multi_turn_depth: "multi_turn_depth",
    };
    const sortColumn = sortColumnMap[options?.sort ?? "complexity_score"] ?? "complexity_score";
    const order = options?.order === "asc" ? "ASC" : "DESC";
    const limit = options?.limit ?? 50;
    const page = options?.page ?? 1;
    const offset = (page - 1) * limit;

    // KPI-005: the global-score CTE binds the full date range at these two
    // indices; the limit/offset follow. complexity_score below comes from the
    // global g_scored_prompts join, not the filtered scored_prompts.
    const globalRangeIndex = 3 + f.params.length;
    const paramOffset = globalRangeIndex + 2;

    const sql = `
      WITH ${this.buildPromptPairsCTE(f.clauses)},
      ${this.buildGlobalScoresCTE(globalRangeIndex)}
      SELECT
        sp.turn_id,
        sp.session_id,
        sp.prompt_preview,
        sp.response_cost,
        gs.complexity_score,
        sp.tool_call_count,
        sp.total_tokens,
        sp.multi_turn_depth,
        CASE WHEN sp.has_thinking = 1 THEN TRUE ELSE FALSE END AS has_thinking,
        sp.model,
        sp.timestamp,
        COUNT(*) OVER () AS _total_count
      FROM scored_prompts sp
      LEFT JOIN g_scored_prompts gs ON gs.turn_id = sp.turn_id
      -- KPI-004: list only prompts that actually got an assistant response;
      -- multi_turn_depth = 0 rows (consecutive user turns) are all-zero noise.
      WHERE sp.multi_turn_depth > 0
      ORDER BY ${sortColumn === "complexity_score" ? "gs.complexity_score" : `sp.${sortColumn}`} ${order}, sp.timestamp DESC
      LIMIT $${paramOffset} OFFSET $${paramOffset + 1}
    `;

    const result = await this.executor.query<{
      turn_id: string;
      session_id: string;
      prompt_preview: string;
      response_cost: number;
      complexity_score: number;
      tool_call_count: number;
      total_tokens: number;
      multi_turn_depth: number;
      has_thinking: boolean;
      model: string;
      timestamp: Date;
      _total_count: number;
    }>(sql, [
      range.start,
      range.end,
      ...f.params,
      new Date("2000-01-01"),
      new Date("2099-12-31"),
      limit,
      offset,
    ]);

    const total = result.rows.length > 0 ? Number(result.rows[0]._total_count) : 0;

    return {
      rows: result.rows.map((row) => ({
        turnId: row.turn_id,
        sessionId: row.session_id,
        promptPreview: row.prompt_preview ?? "",
        responseCost: Number(row.response_cost),
        complexityScore: Number(row.complexity_score),
        toolCallCount: Number(row.tool_call_count),
        totalTokens: Number(row.total_tokens),
        multiTurnDepth: Number(row.multi_turn_depth),
        hasThinking: Boolean(row.has_thinking),
        model: row.model,
        timestamp: new Date(row.timestamp),
      })),
      total,
    };
  }

  /**
   * Get aggregate statistics about prompts in the filtered range.
   *
   * @param options - Filter options (period, model, project)
   * @returns Aggregate prompt statistics with distribution histograms
   */
  async getPromptStats(options?: PromptFilterOptions): Promise<PromptStats> {
    const range = options?.period ?? {
      start: new Date("2000-01-01"),
      end: new Date("2099-12-31"),
    };
    const f = this.buildFilters(options, 3);
    // KPI-005: the global-score CTE binds the full date range at these indices.
    const globalRangeIndex = 3 + f.params.length;
    const globalParams = [new Date("2000-01-01"), new Date("2099-12-31")];

    // Aggregate stats.
    // KPI-004: prompts with multi_turn_depth = 0 (a user turn immediately
    // followed by another user turn — no assistant response) are excluded from
    // total_prompts and avg_cost so the headline average is not deflated ~28%;
    // their count is surfaced as prompts_with_no_response.
    // KPI-005: avg_complexity uses the GLOBAL percentile score so it is
    // consistent with the ranked list and the detail view.
    const statsSql = `
      WITH ${this.buildPromptPairsCTE(f.clauses)},
      ${this.buildGlobalScoresCTE(globalRangeIndex)}
      SELECT
        COUNT(*) FILTER (WHERE sp.multi_turn_depth > 0) AS total_prompts,
        COUNT(*) FILTER (WHERE sp.multi_turn_depth = 0) AS prompts_with_no_response,
        COALESCE(AVG(sp.response_cost) FILTER (WHERE sp.multi_turn_depth > 0), 0) AS avg_cost,
        COALESCE(MAX(sp.response_cost), 0) AS max_cost,
        COALESCE(AVG(gs.complexity_score) FILTER (WHERE sp.multi_turn_depth > 0), 0) AS avg_complexity
      FROM scored_prompts sp
      LEFT JOIN g_scored_prompts gs ON gs.turn_id = sp.turn_id
    `;

    const statsResult = await this.executor.query<{
      total_prompts: number;
      prompts_with_no_response: number;
      avg_cost: number;
      max_cost: number;
      avg_complexity: number;
    }>(statsSql, [range.start, range.end, ...f.params, ...globalParams]);

    const stats = statsResult.rows[0];

    // Cost distribution — use logarithmic-ish buckets
    const costDistSql = `
      WITH ${this.buildPromptPairsCTE(f.clauses)}
      SELECT
        CASE
          WHEN response_cost = 0 THEN '$0 (free)'
          WHEN response_cost < 0.001 THEN '$0–$0.001'
          WHEN response_cost < 0.01 THEN '$0.001–$0.01'
          WHEN response_cost < 0.05 THEN '$0.01–$0.05'
          WHEN response_cost < 0.10 THEN '$0.05–$0.10'
          WHEN response_cost < 0.50 THEN '$0.10–$0.50'
          ELSE '$0.50+'
        END AS label,
        CASE
          WHEN response_cost = 0 THEN 0
          WHEN response_cost < 0.001 THEN 0
          WHEN response_cost < 0.01 THEN 0.001
          WHEN response_cost < 0.05 THEN 0.01
          WHEN response_cost < 0.10 THEN 0.05
          WHEN response_cost < 0.50 THEN 0.10
          ELSE 0.50
        END AS bucket_min,
        CASE
          WHEN response_cost = 0 THEN 0
          WHEN response_cost < 0.001 THEN 0.001
          WHEN response_cost < 0.01 THEN 0.01
          WHEN response_cost < 0.05 THEN 0.05
          WHEN response_cost < 0.10 THEN 0.10
          WHEN response_cost < 0.50 THEN 0.50
          ELSE 999
        END AS bucket_max,
        COUNT(*) AS count
      FROM scored_prompts
      WHERE multi_turn_depth > 0
      GROUP BY label, bucket_min, bucket_max
      ORDER BY bucket_min ASC
    `;

    const costDistResult = await this.executor.query<{
      label: string;
      bucket_min: number;
      bucket_max: number;
      count: number;
    }>(costDistSql, [range.start, range.end, ...f.params]);

    // Complexity distribution — 5 even buckets of 20.
    // KPI-005: bucketed on the GLOBAL percentile score, consistent with the
    // ranked list and the detail view.
    const complexityDistSql = `
      WITH ${this.buildPromptPairsCTE(f.clauses)},
      ${this.buildGlobalScoresCTE(globalRangeIndex)},
      filtered_scores AS (
        SELECT gs.complexity_score
        FROM scored_prompts sp
        LEFT JOIN g_scored_prompts gs ON gs.turn_id = sp.turn_id
      )
      SELECT
        CASE
          WHEN complexity_score < 20 THEN '0–20'
          WHEN complexity_score < 40 THEN '20–40'
          WHEN complexity_score < 60 THEN '40–60'
          WHEN complexity_score < 80 THEN '60–80'
          ELSE '80–100'
        END AS label,
        CASE
          WHEN complexity_score < 20 THEN 0
          WHEN complexity_score < 40 THEN 20
          WHEN complexity_score < 60 THEN 40
          WHEN complexity_score < 80 THEN 60
          ELSE 80
        END AS bucket_min,
        CASE
          WHEN complexity_score < 20 THEN 20
          WHEN complexity_score < 40 THEN 40
          WHEN complexity_score < 60 THEN 60
          WHEN complexity_score < 80 THEN 80
          ELSE 100
        END AS bucket_max,
        COUNT(*) AS count
      FROM filtered_scores
      GROUP BY label, bucket_min, bucket_max
      ORDER BY bucket_min ASC
    `;

    const complexityDistResult = await this.executor.query<{
      label: string;
      bucket_min: number;
      bucket_max: number;
      count: number;
    }>(complexityDistSql, [range.start, range.end, ...f.params, ...globalParams]);

    return {
      totalPrompts: Number(stats?.total_prompts ?? 0),
      // KPI-004: prompts whose user turn had no assistant response.
      promptsWithNoResponse: Number(stats?.prompts_with_no_response ?? 0),
      avgCost: Number(stats?.avg_cost ?? 0),
      maxCost: Number(stats?.max_cost ?? 0),
      avgComplexity: Number(stats?.avg_complexity ?? 0),
      costDistribution: costDistResult.rows.map(
        (row): DistributionBucket => ({
          label: row.label,
          min: Number(row.bucket_min),
          max: Number(row.bucket_max),
          count: Number(row.count),
        }),
      ),
      complexityDistribution: complexityDistResult.rows.map(
        (row): DistributionBucket => ({
          label: row.label,
          min: Number(row.bucket_min),
          max: Number(row.bucket_max),
          count: Number(row.count),
        }),
      ),
    };
  }

  /**
   * NEW-004: throughput / agentic-depth metrics from the prompt pairs.
   *
   * v_prompt_analysis already computes multi_turn_depth and tool_call_count
   * per prompt; getPromptStats never surfaced them. This reuses the same
   * filtered prompt-pairs CTE and the KPI-004 `multi_turn_depth > 0` rule
   * (responded prompts only) to return:
   *   promptsPerSession  = responded prompts / distinct sessions
   *   turnsPerPrompt     = AVG(multi_turn_depth)
   *   toolCallsPerPrompt = AVG(tool_call_count)
   *
   * @param options - Filter options (period, model, project)
   * @returns Aggregate throughput statistics
   */
  async getPromptThroughput(
    options?: PromptFilterOptions,
  ): Promise<PromptThroughputStats> {
    const range = options?.period ?? {
      start: new Date("2000-01-01"),
      end: new Date("2099-12-31"),
    };
    const f = this.buildFilters(options, 3);

    const sql = `
      WITH ${this.buildPromptPairsCTE(f.clauses)}
      SELECT
        COUNT(*) FILTER (WHERE multi_turn_depth > 0) AS total_prompts,
        COUNT(DISTINCT session_id) FILTER (WHERE multi_turn_depth > 0) AS total_sessions,
        COALESCE(AVG(multi_turn_depth) FILTER (WHERE multi_turn_depth > 0), 0) AS turns_per_prompt,
        COALESCE(AVG(tool_call_count) FILTER (WHERE multi_turn_depth > 0), 0) AS tool_calls_per_prompt
      FROM scored_prompts
    `;
    const result = await this.executor.query<{
      total_prompts: number;
      total_sessions: number;
      turns_per_prompt: number;
      tool_calls_per_prompt: number;
    }>(sql, [range.start, range.end, ...f.params]);

    const row = result.rows[0];
    const totalPrompts = Number(row?.total_prompts ?? 0);
    const totalSessions = Number(row?.total_sessions ?? 0);

    return {
      totalPrompts,
      totalSessions,
      promptsPerSession: totalSessions > 0 ? totalPrompts / totalSessions : 0,
      turnsPerPrompt: Number(row?.turns_per_prompt ?? 0),
      toolCallsPerPrompt: Number(row?.tool_calls_per_prompt ?? 0),
    };
  }

  /**
   * Get full detail for a single prompt-response pair.
   *
   * @param turnId - The turn_id of the user turn
   * @returns Full prompt detail with associated tool calls, or null if not found
   */
  async getPromptDetail(turnId: string): Promise<PromptDetail | null> {
    // 1. Get the user turn
    const userTurnResult = await this.executor.query<{
      turn_id: string;
      session_id: string;
      timestamp: Date;
      content_text: string | null;
      rn: number;
    }>(
      `SELECT
         turn_id,
         session_id,
         timestamp,
         content_text,
         ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, turn_id) AS rn
       FROM conversation_turns
       WHERE turn_id = $1 AND role = 'user'`,
      [turnId],
    );

    if (userTurnResult.rowCount === 0) {
      return null;
    }
    const userTurn = userTurnResult.rows[0];

    // 2. Find the next user turn's rn to bound assistant turns
    const nextUserResult = await this.executor.query<{ rn: number }>(
      `WITH ordered AS (
         SELECT
           turn_id,
           role,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, turn_id) AS rn
         FROM conversation_turns
         WHERE session_id = $1
       )
       SELECT MIN(rn) AS rn
       FROM ordered
       WHERE role = 'user' AND rn > $2`,
      [userTurn.session_id, userTurn.rn],
    );
    const nextUserRn = nextUserResult.rows[0]?.rn ?? null;

    // 3. Get assistant turns between user turn and next user turn
    const boundClause = nextUserRn !== null ? `AND rn < $3` : "";
    const assistantParams: unknown[] = [userTurn.session_id, userTurn.rn];
    if (nextUserRn !== null) {
      assistantParams.push(nextUserRn);
    }

    const assistantResult = await this.executor.query<{
      turn_id: string;
      content_text: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      cost_usd: number;
      model: string | null;
      has_thinking: boolean;
    }>(
      `WITH ordered AS (
         SELECT
           turn_id,
           role,
           content_text,
           input_tokens,
           output_tokens,
           cache_creation_tokens,
           cache_read_tokens,
           cost_usd,
           model,
           has_thinking,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, turn_id) AS rn
         FROM conversation_turns
         WHERE session_id = $1
       )
       SELECT turn_id, content_text, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens, cost_usd, model, has_thinking
       FROM ordered
       WHERE role = 'assistant' AND rn > $2 ${boundClause}
       ORDER BY rn ASC`,
      assistantParams,
    );

    // 4. Aggregate assistant metrics
    let responseCost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let hasThinking = false;
    let model = "unknown";
    const responseTexts: string[] = [];
    const assistantTurnIds: string[] = [];

    for (const row of assistantResult.rows) {
      responseCost += Number(row.cost_usd);
      inputTokens += Number(row.input_tokens);
      outputTokens += Number(row.output_tokens);
      cacheCreationTokens += Number(row.cache_creation_tokens);
      cacheReadTokens += Number(row.cache_read_tokens);
      if (row.has_thinking) hasThinking = true;
      if (row.model && model === "unknown") model = row.model;
      if (row.content_text) responseTexts.push(row.content_text);
      assistantTurnIds.push(row.turn_id);
    }

    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const multiTurnDepth = assistantResult.rowCount;

    // 5. Get tool calls from assistant turns
    let toolCalls: PromptDetail["toolCalls"] = [];
    if (assistantTurnIds.length > 0) {
      // Build placeholders for the IN clause
      const placeholders = assistantTurnIds.map((_, i) => `$${i + 2}`).join(", ");
      const toolCallResult = await this.executor.query<{
        tool_call_id: string;
        tool_name: string;
        tool_type: string;
        mcp_server: string | null;
        duration_ms: number | null;
        success: boolean | null;
      }>(
        `SELECT tool_call_id, tool_name, tool_type, mcp_server, duration_ms, success
         FROM tool_calls
         WHERE session_id = $1 AND turn_id IN (${placeholders})
         ORDER BY tool_call_id ASC`,
        [userTurn.session_id, ...assistantTurnIds],
      );

      toolCalls = toolCallResult.rows.map((tc) => ({
        toolCallId: tc.tool_call_id,
        toolName: tc.tool_name,
        toolType: tc.tool_type,
        mcpServer: tc.mcp_server,
        durationMs: tc.duration_ms != null ? Number(tc.duration_ms) : null,
        success: tc.success,
      }));
    }

    // 6. Compute complexity score as a GLOBAL percentile (KPI-005).
    //    Scans all prompts over the full date range with no filters, so this
    //    detail score is identical to the score shown for the same prompt in
    //    getPromptRanking / getPromptStats (which now also score globally).
    const complexityResult = await this.executor.query<{
      complexity_score: number;
    }>(
      `WITH ${this.buildPromptPairsCTE([])}
       SELECT complexity_score
       FROM scored_prompts
       WHERE turn_id = $3`,
      [new Date("2000-01-01"), new Date("2099-12-31"), turnId],
    );

    const complexityScore = complexityResult.rows[0]
      ? Number(complexityResult.rows[0].complexity_score)
      : 0;

    return {
      turnId: userTurn.turn_id,
      sessionId: userTurn.session_id,
      promptText: userTurn.content_text,
      responseText: responseTexts.join("\n\n---\n\n") || null,
      responseCost,
      complexityScore,
      toolCallCount: toolCalls.length,
      totalTokens,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      multiTurnDepth,
      hasThinking,
      model,
      timestamp: new Date(userTurn.timestamp),
      toolCalls,
    };
  }
}
