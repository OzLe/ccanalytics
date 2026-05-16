/**
 * @module queries/session-analyzer
 *
 * Session-level analytical queries.
 * Provides session listing, detail drill-down, and aggregate statistics.
 */

import type {
  SessionSummary,
  SessionDetail,
  TimeRange,
  SortOrder,
  QueryFilters,
  SessionContextPressure,
  ContextPressureStats,
} from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildSessionFilters } from "./filter-builder.js";

/**
 * NEW-001: model-aware, self-correcting context-window denominator.
 *
 * The 1M-context capability is NOT reliably encoded in the model id — in the
 * data `claude-opus-4-7` (a plain id) legitimately reaches ~861k tokens/turn.
 * So the window is 1,000,000 when EITHER the model id hints at a 1M variant
 * ('-1m' / '1m-context') OR the turn's own context tokens already exceed
 * 200,000 (which is only possible on the 1M-context variant); otherwise
 * 200,000. This keeps utilization in a sane 0..1 range with no schema change
 * and no brittle id heuristic. Mirrors the CASE in v_context_pressure.
 */
const CONTEXT_WINDOW_CASE = `
        CASE
          WHEN LOWER(COALESCE(ct.model, '')) LIKE '%-1m%'
            OR LOWER(COALESCE(ct.model, '')) LIKE '%1m-context%'
            OR (ct.input_tokens + ct.cache_read_tokens + ct.cache_creation_tokens) > 200000
          THEN 1000000
          ELSE 200000
        END`;

/** Aggregate statistics across all sessions in a time range. */
export interface SessionAggregateStats {
  totalSessions: number;
  totalTurns: number;
  avgTurnsPerSession: number;
  avgDurationMinutes: number;
  medianDurationMinutes: number;
  totalCostUSD: number;
  avgCostPerSession: number;
  uniqueModels: string[];
}

/** Histogram bucket for distribution analysis. */
export interface HistogramBucket {
  /** Lower bound of the bucket (inclusive). */
  min: number;
  /** Upper bound of the bucket (exclusive). */
  max: number;
  /** Count of sessions in this bucket. */
  count: number;
}

/**
 * Analyzes session-level data from the v_session_summary view.
 * Provides listing, detail, and aggregate queries.
 */
export class SessionAnalyzer {
  constructor(private executor: QueryExecutor) {}

  /**
   * Get paginated session summaries within a time range.
   * Reads from the v_session_summary view.
   *
   * @param options - Query options (range, sort, pagination)
   * @returns Array of session summaries
   */
  async getSessions(options: {
    range: TimeRange;
    sortBy?: "start_time" | "cost" | "turns" | "duration";
    order?: SortOrder;
    limit?: number;
    offset?: number;
    filters?: QueryFilters;
  }): Promise<SessionSummary[]> {
    const sortColumnMap: Record<string, string> = {
      start_time: "start_time",
      cost: "total_cost_usd",
      turns: "num_turns",
      duration: "duration_seconds",
    };
    const sortColumn = sortColumnMap[options.sortBy ?? "start_time"] ?? "start_time";
    const order = options.order === "asc" ? "ASC" : "DESC";
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    // v_session_summary has columns from sessions (model, project_path, etc)
    const f = buildSessionFilters(options.filters, 5, "v_session_summary");
    const sql = `
      SELECT session_id, start_time, end_time, duration_seconds, model,
             total_cost_usd, num_turns, num_tool_calls, cache_hit_rate,
             project_path
      FROM v_session_summary
      WHERE start_time >= $1 AND start_time < $2
        ${f.clauses.join("\n        ")}
      ORDER BY ${sortColumn} ${order}
      LIMIT $3 OFFSET $4
    `;
    const result = await this.executor.query<{
      session_id: string;
      start_time: Date;
      end_time: Date | null;
      duration_seconds: number | null;
      model: string;
      total_cost_usd: number;
      num_turns: number;
      num_tool_calls: number;
      cache_hit_rate: number;
      project_path: string | null;
    }>(sql, [options.range.start, options.range.end, limit, offset, ...f.params]);

    return result.rows.map((row) => ({
      sessionId: row.session_id,
      startTime: new Date(row.start_time),
      endTime: row.end_time ? new Date(row.end_time) : null,
      durationMinutes: (Number(row.duration_seconds) || 0) / 60,
      model: row.model,
      totalCostUSD: Number(row.total_cost_usd),
      numTurns: Number(row.num_turns),
      numToolCalls: Number(row.num_tool_calls),
      cacheHitRate: Number(row.cache_hit_rate),
      projectPath: row.project_path,
    }));
  }

  /**
   * Get full detail for a single session including all turns.
   *
   * @param sessionId - Session UUID
   * @returns Full session detail with turns, tool calls, and errors, or null
   */
  async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    // 1. Query session summary
    const sessionResult = await this.executor.query<{
      session_id: string;
      start_time: Date;
      end_time: Date | null;
      duration_seconds: number | null;
      model: string;
      total_cost_usd: number;
      num_turns: number;
      num_tool_calls: number;
      cache_hit_rate: number;
      project_path: string | null;
    }>(
      `SELECT session_id, start_time, end_time, duration_seconds, model,
              total_cost_usd, num_turns, num_tool_calls, cache_hit_rate,
              project_path
       FROM v_session_summary
       WHERE session_id = $1`,
      [sessionId],
    );

    if (sessionResult.rowCount === 0) {
      return null;
    }
    const session = sessionResult.rows[0];

    // 2. Query turns
    const turnsResult = await this.executor.query<{
      turn_id: string;
      role: string;
      timestamp: Date;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      cost_usd: number;
      model: string | null;
      stop_reason: string | null;
    }>(
      `SELECT turn_id, role, timestamp, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens, cost_usd, model, stop_reason
       FROM conversation_turns
       WHERE session_id = $1
       ORDER BY timestamp ASC`,
      [sessionId],
    );

    // 3. Query tool calls
    const toolCallsResult = await this.executor.query<{
      tool_call_id: string;
      turn_id: string;
      tool_name: string;
      tool_type: string;
      mcp_server: string | null;
      duration_ms: number | null;
      success: boolean | null;
      error_message: string | null;
    }>(
      `SELECT tool_call_id, turn_id, tool_name, tool_type, mcp_server,
              duration_ms, success, error_message
       FROM tool_calls
       WHERE session_id = $1
       ORDER BY tool_call_id ASC`,
      [sessionId],
    );

    // 4. Query errors
    const errorsResult = await this.executor.query<{
      error_id: string;
      timestamp: Date;
      error_type: string;
      message: string;
      is_retryable: boolean;
      retry_count: number;
    }>(
      `SELECT error_id, timestamp, error_type, message, is_retryable, retry_count
       FROM errors
       WHERE session_id = $1
       ORDER BY timestamp ASC`,
      [sessionId],
    );

    // 5. Combine into SessionDetail
    return {
      sessionId: session.session_id,
      startTime: new Date(session.start_time),
      endTime: session.end_time ? new Date(session.end_time) : null,
      durationMinutes: (Number(session.duration_seconds) || 0) / 60,
      model: session.model,
      totalCostUSD: Number(session.total_cost_usd),
      numTurns: Number(session.num_turns),
      numToolCalls: Number(session.num_tool_calls),
      cacheHitRate: Number(session.cache_hit_rate),
      projectPath: session.project_path,
      turns: turnsResult.rows.map((t) => ({
        turnId: t.turn_id,
        role: t.role,
        timestamp: new Date(t.timestamp),
        inputTokens: Number(t.input_tokens),
        outputTokens: Number(t.output_tokens),
        cacheWriteTokens: Number(t.cache_creation_tokens),
        cacheReadTokens: Number(t.cache_read_tokens),
        costUSD: Number(t.cost_usd),
        model: t.model,
        stopReason: t.stop_reason,
      })),
      toolCalls: toolCallsResult.rows.map((tc) => ({
        toolCallId: tc.tool_call_id,
        turnId: tc.turn_id,
        toolName: tc.tool_name,
        toolType: tc.tool_type,
        mcpServer: tc.mcp_server,
        durationMs: tc.duration_ms != null ? Number(tc.duration_ms) : null,
        success: tc.success,
        errorMessage: tc.error_message,
      })),
      errors: errorsResult.rows.map((e) => ({
        errorId: e.error_id,
        timestamp: new Date(e.timestamp),
        errorType: e.error_type,
        message: e.message,
        isRetryable: Boolean(e.is_retryable),
        retryCount: Number(e.retry_count),
      })),
    };
  }

  /**
   * Get aggregate statistics across all sessions in a time range.
   *
   * @param range - Time range to aggregate over
   * @returns Aggregate statistics
   */
  async getSessionStats(range: TimeRange, filters?: QueryFilters): Promise<SessionAggregateStats> {
    // COST-004 / SEM2-280: read aggregates from v_session_summary, NOT the
    // sessions table. sessions.total_cost_usd (and num_turns) are stored
    // aggregates that the ingestion upsert overwrites with the LATEST batch's
    // recomputed value, so on incremental ingest they drift below the true
    // per-session totals. v_session_summary derives both from
    // conversation_turns (SUM(cost_usd), COUNT(*)) so it reconciles with the
    // CostAnalyzer total (which sums conversation_turns.cost_usd directly).
    // The view exposes the same model / project_path / source_type columns the
    // filter clauses reference, so the swap is a pure source change.
    const f = buildSessionFilters(filters, 3, "v_session_summary");
    const sql = `
      SELECT
        COUNT(*) AS total_sessions,
        COALESCE(SUM(num_turns), 0) AS total_turns,
        COALESCE(AVG(num_turns), 0) AS avg_turns_per_session,
        COALESCE(AVG(duration_seconds) / 60.0, 0) AS avg_duration_minutes,
        COALESCE(MEDIAN(duration_seconds) / 60.0, 0) AS median_duration_minutes,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        COALESCE(AVG(total_cost_usd), 0) AS avg_cost_per_session
      FROM v_session_summary
      WHERE start_time >= $1 AND start_time < $2
        ${f.clauses.join("\n        ")}
    `;
    const statsResult = await this.executor.query<{
      total_sessions: number;
      total_turns: number;
      avg_turns_per_session: number;
      avg_duration_minutes: number;
      median_duration_minutes: number;
      total_cost_usd: number;
      avg_cost_per_session: number;
    }>(sql, [range.start, range.end, ...f.params]);

    const f2 = buildSessionFilters(filters, 3, "v_session_summary");
    const modelsResult = await this.executor.query<{ model: string }>(
      `SELECT DISTINCT model
       FROM v_session_summary
       WHERE start_time >= $1 AND start_time < $2
         AND model IS NOT NULL
         ${f2.clauses.join("\n         ")}`,
      [range.start, range.end, ...f2.params],
    );

    const stats = statsResult.rows[0];
    if (!stats) {
      return {
        totalSessions: 0,
        totalTurns: 0,
        avgTurnsPerSession: 0,
        avgDurationMinutes: 0,
        medianDurationMinutes: 0,
        totalCostUSD: 0,
        avgCostPerSession: 0,
        uniqueModels: [],
      };
    }

    return {
      totalSessions: Number(stats.total_sessions),
      totalTurns: Number(stats.total_turns),
      avgTurnsPerSession: Number(stats.avg_turns_per_session),
      avgDurationMinutes: Number(stats.avg_duration_minutes),
      medianDurationMinutes: Number(stats.median_duration_minutes),
      totalCostUSD: Number(stats.total_cost_usd),
      avgCostPerSession: Number(stats.avg_cost_per_session),
      uniqueModels: modelsResult.rows.map((r) => r.model),
    };
  }

  /**
   * NEW-001: per-session context-window utilization ("context pressure").
   *
   * Per assistant turn the context proxy is input + cache_read +
   * cache_creation tokens (separate fields in the Anthropic API); utilization
   * = context_tokens / window, window being MODEL-AWARE (1M for 1M-context
   * models, 200k otherwise — see CONTEXT_WINDOW_CASE). Mirrors the
   * v_context_pressure view; re-implemented inline to support
   * period/model/project filters.
   *
   * @param range - Time range (on conversation_turns.timestamp)
   * @param filters - Optional model/project filters
   * @param limit - Max sessions to return, ordered by peak utilization desc
   * @returns Per-session context-pressure rows
   */
  async getContextPressure(
    range: TimeRange,
    filters?: QueryFilters,
    limit: number = 100,
  ): Promise<SessionContextPressure[]> {
    const f = buildSessionFilters(filters, 4, "s");
    const sql = `
      WITH turn_util AS (
        SELECT
          ct.session_id,
          ct.stop_reason,
          (ct.input_tokens + ct.cache_read_tokens + ct.cache_creation_tokens) AS context_tokens,
          (ct.input_tokens + ct.cache_read_tokens + ct.cache_creation_tokens)::DOUBLE
            / (${CONTEXT_WINDOW_CASE})::DOUBLE AS context_utilization
        FROM conversation_turns ct
        JOIN sessions s ON s.session_id = ct.session_id
        WHERE ct.role = 'assistant'
          AND ct.timestamp >= $1 AND ct.timestamp < $2
          ${f.clauses.join("\n          ")}
      )
      SELECT
        session_id,
        COUNT(*) AS assistant_turns,
        MAX(context_utilization) AS peak_context_pct,
        MAX(context_tokens) AS peak_context_tokens,
        AVG(context_utilization) AS avg_context_pct,
        COUNT(*) FILTER (WHERE context_utilization > 0.60) AS turns_over_60,
        COUNT(*) FILTER (WHERE context_utilization > 0.80) AS turns_over_80,
        COUNT(*) FILTER (WHERE context_utilization > 0.60)::DOUBLE
          / NULLIF(COUNT(*), 0)::DOUBLE AS pressure_share,
        COUNT(*) FILTER (WHERE stop_reason = 'max_tokens') AS max_tokens_turns
      FROM turn_util
      GROUP BY session_id
      ORDER BY peak_context_pct DESC
      LIMIT $3
    `;
    const result = await this.executor.query<{
      session_id: string;
      assistant_turns: number;
      peak_context_pct: number;
      peak_context_tokens: number;
      avg_context_pct: number;
      turns_over_60: number;
      turns_over_80: number;
      pressure_share: number;
      max_tokens_turns: number;
    }>(sql, [range.start, range.end, limit, ...f.params]);

    return result.rows.map((row) => ({
      sessionId: row.session_id,
      assistantTurns: Number(row.assistant_turns),
      peakContextPct: Number(row.peak_context_pct),
      peakContextTokens: Number(row.peak_context_tokens),
      avgContextPct: Number(row.avg_context_pct),
      turnsOver60: Number(row.turns_over_60),
      turnsOver80: Number(row.turns_over_80),
      pressureShare: Number(row.pressure_share),
      maxTokensTurns: Number(row.max_tokens_turns),
    }));
  }

  /**
   * NEW-001: dataset-level context-pressure summary — the Overview KPI.
   * % of sessions whose peak context utilization exceeds 0.60 (and a stricter
   * 0.80 "critical" band), plus the worst peak and a max_tokens truncation
   * sub-stat. Uses the same model-aware window as {@link getContextPressure}.
   *
   * @param range - Time range (on conversation_turns.timestamp)
   * @param filters - Optional model/project filters
   * @returns Aggregate context-pressure statistics
   */
  async getContextPressureStats(
    range: TimeRange,
    filters?: QueryFilters,
  ): Promise<ContextPressureStats> {
    const f = buildSessionFilters(filters, 3, "s");
    const sql = `
      WITH turn_util AS (
        SELECT
          ct.session_id,
          ct.stop_reason,
          (ct.input_tokens + ct.cache_read_tokens + ct.cache_creation_tokens)::DOUBLE
            / (${CONTEXT_WINDOW_CASE})::DOUBLE AS context_utilization
        FROM conversation_turns ct
        JOIN sessions s ON s.session_id = ct.session_id
        WHERE ct.role = 'assistant'
          AND ct.timestamp >= $1 AND ct.timestamp < $2
          ${f.clauses.join("\n          ")}
      ),
      per_session AS (
        SELECT
          session_id,
          MAX(context_utilization) AS peak_context_pct,
          COUNT(*) FILTER (WHERE stop_reason = 'max_tokens') AS max_tokens_turns
        FROM turn_util
        GROUP BY session_id
      )
      SELECT
        COUNT(*) AS total_sessions,
        COUNT(*) FILTER (WHERE peak_context_pct > 0.60) AS sessions_over_60,
        COUNT(*) FILTER (WHERE peak_context_pct > 0.80) AS sessions_over_80,
        COALESCE(MAX(peak_context_pct), 0) AS worst_peak_pct,
        COALESCE(SUM(max_tokens_turns), 0) AS max_tokens_turns
      FROM per_session
    `;
    const result = await this.executor.query<{
      total_sessions: number;
      sessions_over_60: number;
      sessions_over_80: number;
      worst_peak_pct: number;
      max_tokens_turns: number;
    }>(sql, [range.start, range.end, ...f.params]);

    const row = result.rows[0];
    const totalSessions = Number(row?.total_sessions ?? 0);
    const sessionsOver60 = Number(row?.sessions_over_60 ?? 0);
    const sessionsOver80 = Number(row?.sessions_over_80 ?? 0);

    return {
      totalSessions,
      sessionsOver60,
      sessionsOver80,
      pressureRate: totalSessions > 0 ? sessionsOver60 / totalSessions : 0,
      criticalRate: totalSessions > 0 ? sessionsOver80 / totalSessions : 0,
      worstPeakPct: Number(row?.worst_peak_pct ?? 0),
      maxTokensTurns: Number(row?.max_tokens_turns ?? 0),
    };
  }
}
