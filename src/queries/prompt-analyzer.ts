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
 */

import type {
  PromptRankingRow,
  PromptStats,
  PromptDetail,
  PromptFilterOptions,
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

    const paramOffset = 3 + f.params.length;

    const sql = `
      WITH ${this.buildPromptPairsCTE(f.clauses)}
      SELECT
        turn_id,
        session_id,
        prompt_preview,
        response_cost,
        complexity_score,
        tool_call_count,
        total_tokens,
        multi_turn_depth,
        CASE WHEN has_thinking = 1 THEN TRUE ELSE FALSE END AS has_thinking,
        model,
        timestamp,
        COUNT(*) OVER () AS _total_count
      FROM scored_prompts
      ORDER BY ${sortColumn} ${order}, timestamp DESC
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
    }>(sql, [range.start, range.end, ...f.params, limit, offset]);

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

    // Aggregate stats
    const statsSql = `
      WITH ${this.buildPromptPairsCTE(f.clauses)}
      SELECT
        COUNT(*) AS total_prompts,
        COALESCE(AVG(response_cost), 0) AS avg_cost,
        COALESCE(MAX(response_cost), 0) AS max_cost,
        COALESCE(AVG(complexity_score), 0) AS avg_complexity
      FROM scored_prompts
    `;

    const statsResult = await this.executor.query<{
      total_prompts: number;
      avg_cost: number;
      max_cost: number;
      avg_complexity: number;
    }>(statsSql, [range.start, range.end, ...f.params]);

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
      GROUP BY label, bucket_min, bucket_max
      ORDER BY bucket_min ASC
    `;

    const costDistResult = await this.executor.query<{
      label: string;
      bucket_min: number;
      bucket_max: number;
      count: number;
    }>(costDistSql, [range.start, range.end, ...f.params]);

    // Complexity distribution — 5 even buckets of 20
    const complexityDistSql = `
      WITH ${this.buildPromptPairsCTE(f.clauses)}
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
      FROM scored_prompts
      GROUP BY label, bucket_min, bucket_max
      ORDER BY bucket_min ASC
    `;

    const complexityDistResult = await this.executor.query<{
      label: string;
      bucket_min: number;
      bucket_max: number;
      count: number;
    }>(complexityDistSql, [range.start, range.end, ...f.params]);

    return {
      totalPrompts: Number(stats?.total_prompts ?? 0),
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

    // 6. Compute complexity score relative to the full dataset.
    //    Reuses the same CTE that powers getPromptRanking, scanning all
    //    prompts to compute PERCENT_RANK, then extracts the score for this turn.
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
