/**
 * @module queries/tool-analyzer
 *
 * Tool usage analytical queries.
 * Analyzes tool call frequency, success rates, MCP server usage,
 * and sequential tool chain patterns.
 */

import type {
  ToolUsageStats,
  TimeRange,
  TimeBucket,
  QueryFilters,
  ToolFailureTrendPoint,
  SessionFailureChainStats,
  FailureChainSummary,
} from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildTurnFilters } from "./filter-builder.js";

/** Success rate details for a single tool. */
export interface ToolSuccessRate {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  /** KPI-006: null when the tool has only NULL-success calls ("no data"). */
  successRate: number | null;
  avgDurationMs: number;
  commonErrors: string[];
}

/** A detected sequential tool call chain pattern. */
export interface ToolChain {
  /** Ordered sequence of tool names. */
  chain: string[];
  /** Number of times this chain appeared. */
  occurrences: number;
  /** Average total duration of the chain in ms. */
  avgDurationMs: number;
}

/** Aggregated usage for an MCP server. */
export interface MCPServerUsage {
  serverName: string;
  totalCalls: number;
  uniqueTools: string[];
  totalTokens: number;
  avgDurationMs: number;
}

/**
 * Analyzes tool usage patterns from the v_tool_usage view and tool_calls table.
 */
export class ToolAnalyzer {
  constructor(private executor: QueryExecutor) {}

  /**
   * Get usage stats for all tools in a time range.
   * Reads from the v_tool_usage view.
   *
   * @param range - Time range to query
   * @returns Array of tool usage statistics
   */
  async getToolUsage(range: TimeRange, filters?: QueryFilters): Promise<ToolUsageStats[]> {
    const f = buildTurnFilters(filters, 3);
    // Prefix filter clauses with ct. for joined queries
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bAND model\b/, "AND ct.model").replace(/\bAND session_id\b/, "AND ct.session_id"),
    );
    const sql = `
      SELECT
        tc.tool_name,
        tc.tool_type,
        tc.mcp_server,
        COUNT(*) AS call_count,
        COUNT(*) FILTER (WHERE tc.success = TRUE) AS success_count,
        COUNT(*) FILTER (WHERE tc.success = FALSE) AS failure_count,
        CASE
          WHEN COUNT(*) FILTER (WHERE tc.success IS NOT NULL) > 0
          THEN COUNT(*) FILTER (WHERE tc.success = TRUE)::DOUBLE /
               COUNT(*) FILTER (WHERE tc.success IS NOT NULL)::DOUBLE
          ELSE NULL
        END AS success_rate,
        COALESCE(AVG(tc.duration_ms), 0) AS avg_duration_ms,
        COUNT(DISTINCT tc.session_id) AS sessions_using_tool,
        -- KPI-009: avg_per_session — surfaced here so the analyzer matches
        -- the v_tool_usage view definition instead of silently omitting it.
        COUNT(*)::DOUBLE / NULLIF(COUNT(DISTINCT tc.session_id), 0)::DOUBLE
          AS avg_per_session
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
        ${filterClauses.join("\n        ")}
      GROUP BY tc.tool_name, tc.tool_type, tc.mcp_server
      ORDER BY call_count DESC
    `;
    const result = await this.executor.query<{
      tool_name: string;
      tool_type: string;
      mcp_server: string | null;
      call_count: number;
      success_count: number;
      failure_count: number;
      success_rate: number | null;
      avg_duration_ms: number;
      sessions_using_tool: number;
      avg_per_session: number | null;
    }>(sql, [range.start, range.end, ...f.params]);

    return result.rows.map((row) => ({
      toolName: row.tool_name,
      toolType: row.tool_type,
      mcpServer: row.mcp_server,
      callCount: Number(row.call_count),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      successRate: row.success_rate != null ? Number(row.success_rate) : null,
      avgDurationMs: Number(row.avg_duration_ms),
      sessionsUsingTool: Number(row.sessions_using_tool),
      avgPerSession: row.avg_per_session != null ? Number(row.avg_per_session) : 0,
    }));
  }

  /**
   * Get success/failure rates per tool.
   *
   * @param range - Time range to query
   * @returns Per-tool success rates with error details
   */
  async getToolSuccessRates(range: TimeRange): Promise<ToolSuccessRate[]> {
    const sql = `
      SELECT
        tc.tool_name,
        COUNT(*) AS total_calls,
        COUNT(*) FILTER (WHERE tc.success = TRUE) AS success_count,
        COUNT(*) FILTER (WHERE tc.success = FALSE) AS failure_count,
        CASE
          WHEN COUNT(*) FILTER (WHERE tc.success IS NOT NULL) > 0
          THEN COUNT(*) FILTER (WHERE tc.success = TRUE)::DOUBLE /
               COUNT(*) FILTER (WHERE tc.success IS NOT NULL)::DOUBLE
          -- KPI-006: ELSE NULL (not 0) for all-NULL-success groups, matching
          -- v_tool_usage and getToolUsage. A tool whose results were never
          -- captured is "no data", not a 0% (total-failure) tool.
          ELSE NULL
        END AS success_rate,
        COALESCE(AVG(tc.duration_ms), 0) AS avg_duration_ms
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
      GROUP BY tc.tool_name
      ORDER BY total_calls DESC
    `;
    const result = await this.executor.query<{
      tool_name: string;
      total_calls: number;
      success_count: number;
      failure_count: number;
      success_rate: number | null;
      avg_duration_ms: number;
    }>(sql, [range.start, range.end]);

    // Get common errors per tool
    const errorSql = `
      SELECT tc.tool_name, tc.error_message
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
        AND tc.success = FALSE
        AND tc.error_message IS NOT NULL
    `;
    const errorResult = await this.executor.query<{
      tool_name: string;
      error_message: string;
    }>(errorSql, [range.start, range.end]);

    const errorsByTool = new Map<string, string[]>();
    for (const row of errorResult.rows) {
      const errors = errorsByTool.get(row.tool_name) ?? [];
      if (!errors.includes(row.error_message)) {
        errors.push(row.error_message);
      }
      errorsByTool.set(row.tool_name, errors);
    }

    return result.rows.map((row) => ({
      toolName: row.tool_name,
      totalCalls: Number(row.total_calls),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      // KPI-006: preserve NULL (no data) rather than coercing to 0.
      successRate: row.success_rate != null ? Number(row.success_rate) : null,
      avgDurationMs: Number(row.avg_duration_ms),
      commonErrors: (errorsByTool.get(row.tool_name) ?? []).slice(0, 5),
    }));
  }

  /**
   * Get MCP server-level aggregation.
   *
   * @param range - Time range to query
   * @returns Per-server usage statistics
   */
  async getMCPServerUsage(range: TimeRange): Promise<MCPServerUsage[]> {
    const sql = `
      SELECT
        tc.mcp_server AS server_name,
        COUNT(*) AS total_calls,
        COALESCE(AVG(tc.duration_ms), 0) AS avg_duration_ms
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE tc.tool_type = 'mcp'
        AND tc.mcp_server IS NOT NULL
        AND ct.timestamp >= $1 AND ct.timestamp < $2
      GROUP BY tc.mcp_server
      ORDER BY total_calls DESC
    `;
    const result = await this.executor.query<{
      server_name: string;
      total_calls: number;
      avg_duration_ms: number;
    }>(sql, [range.start, range.end]);

    // Get unique tools per server
    const toolsSql = `
      SELECT DISTINCT tc.mcp_server, tc.tool_name
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE tc.tool_type = 'mcp'
        AND tc.mcp_server IS NOT NULL
        AND ct.timestamp >= $1 AND ct.timestamp < $2
    `;
    const toolsResult = await this.executor.query<{
      mcp_server: string;
      tool_name: string;
    }>(toolsSql, [range.start, range.end]);

    const toolsByServer = new Map<string, string[]>();
    for (const row of toolsResult.rows) {
      const tools = toolsByServer.get(row.mcp_server) ?? [];
      tools.push(row.tool_name);
      toolsByServer.set(row.mcp_server, tools);
    }

    return result.rows.map((row) => ({
      serverName: row.server_name,
      totalCalls: Number(row.total_calls),
      uniqueTools: toolsByServer.get(row.server_name) ?? [],
      totalTokens: 0, // Tool calls don't track tokens directly
      avgDurationMs: Number(row.avg_duration_ms),
    }));
  }

  /**
   * Detect common tool call chains (e.g., Read -> Edit -> Bash).
   * Uses window functions to find sequential 3-tool patterns within sessions.
   *
   * @param range - Time range to query
   * @param minOccurrences - Minimum occurrences to include (default: 3)
   * @returns Detected tool chain patterns
   */
  async getToolChains(
    range: TimeRange,
    minOccurrences: number = 3,
  ): Promise<ToolChain[]> {
    const sql = `
      WITH ordered_tools AS (
        SELECT
          tc.session_id,
          tc.tool_name,
          tc.duration_ms,
          ROW_NUMBER() OVER (PARTITION BY tc.session_id ORDER BY tc.tool_call_id) AS rn
        FROM tool_calls tc
        JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
        WHERE ct.timestamp >= $1 AND ct.timestamp < $2
      ),
      chains AS (
        SELECT
          a.tool_name || ' -> ' || b.tool_name || ' -> ' || c.tool_name AS chain,
          COALESCE(a.duration_ms, 0) + COALESCE(b.duration_ms, 0) + COALESCE(c.duration_ms, 0) AS total_duration_ms
        FROM ordered_tools a
        JOIN ordered_tools b ON a.session_id = b.session_id AND b.rn = a.rn + 1
        JOIN ordered_tools c ON a.session_id = c.session_id AND c.rn = a.rn + 2
      )
      SELECT
        chain,
        COUNT(*) AS occurrences,
        COALESCE(AVG(total_duration_ms), 0) AS avg_duration_ms
      FROM chains
      GROUP BY chain
      HAVING COUNT(*) >= $3
      ORDER BY occurrences DESC
      LIMIT 20
    `;
    const result = await this.executor.query<{
      chain: string;
      occurrences: number;
      avg_duration_ms: number;
    }>(sql, [range.start, range.end, minOccurrences]);

    return result.rows.map((row) => ({
      chain: row.chain.split(" -> "),
      occurrences: Number(row.occurrences),
      avgDurationMs: Number(row.avg_duration_ms),
    }));
  }

  // NOTE (latent bug, deferred ingestion fix): getToolUsage, getToolSuccessRates,
  // getMCPServerUsage and getToolChains above all AVG(tc.duration_ms) and
  // COALESCE it to 0. tool_calls.duration_ms is 100% NULL in the data (the
  // adapters never populate it), so every "Avg Time" figure is silently 0.
  // The NEW-002/003 methods below deliberately do NOT touch duration_ms —
  // they are purely success/failure based and unaffected.

  /**
   * NEW-002: tool failure-rate trend, bucketed over time and split
   * builtin-vs-MCP.
   *
   * failure_rate = COUNT(success = FALSE) / COUNT(success IS NOT NULL).
   * NULL-success calls are excluded from the denominator (a result that was
   * never captured is "no data", not a failure — same rule as v_tool_usage).
   * Buckets via DATE_TRUNC on the JOINed conversation_turns.timestamp; the
   * tool class is 'mcp' for tool_type = 'mcp' and 'builtin' for everything
   * else. Mirrors v_tool_failure_trend; re-implemented inline for the
   * configurable bucket and period/model/project filters.
   *
   * @param range - Time range to query
   * @param bucket - Aggregation granularity (default: day)
   * @param filters - Optional model/project filters
   * @returns One point per time bucket with builtin / mcp / overall series
   */
  async getToolFailureTrend(
    range: TimeRange,
    bucket: TimeBucket = "day",
    filters?: QueryFilters,
  ): Promise<ToolFailureTrendPoint[]> {
    const validBuckets: Record<TimeBucket, string> = {
      hour: "hour",
      day: "day",
      week: "week",
      month: "month",
    };
    const duckBucket = validBuckets[bucket];
    if (!duckBucket) {
      throw new Error(`Invalid time bucket: ${bucket}`);
    }

    const f = buildTurnFilters(filters, 3);
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bAND model\b/, "AND ct.model").replace(/\bAND session_id\b/, "AND ct.session_id"),
    );
    const sql = `
      SELECT
        DATE_TRUNC('${duckBucket}', ct.timestamp) AS ts,
        CASE WHEN tc.tool_type = 'mcp' THEN 'mcp' ELSE 'builtin' END AS tool_class,
        COUNT(*) AS total_calls,
        COUNT(*) FILTER (WHERE tc.success IS NOT NULL) AS evaluated_calls,
        COUNT(*) FILTER (WHERE tc.success = FALSE) AS failure_count
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
        ${filterClauses.join("\n        ")}
      GROUP BY ts, tool_class
      ORDER BY ts ASC, tool_class
    `;
    const result = await this.executor.query<{
      ts: string;
      tool_class: string;
      total_calls: number;
      evaluated_calls: number;
      failure_count: number;
    }>(sql, [range.start, range.end, ...f.params]);

    // Pivot the (bucket, tool_class) rows into one point per bucket.
    const byBucket = new Map<
      string,
      { builtin: SeriesAcc; mcp: SeriesAcc }
    >();
    for (const row of result.rows) {
      const key = row.ts;
      let entry = byBucket.get(key);
      if (!entry) {
        entry = { builtin: emptySeriesAcc(), mcp: emptySeriesAcc() };
        byBucket.set(key, entry);
      }
      const target = row.tool_class === "mcp" ? entry.mcp : entry.builtin;
      target.totalCalls += Number(row.total_calls);
      target.evaluatedCalls += Number(row.evaluated_calls);
      target.failureCount += Number(row.failure_count);
    }

    return [...byBucket.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, entry]) => {
        const overall = emptySeriesAcc();
        for (const s of [entry.builtin, entry.mcp]) {
          overall.totalCalls += s.totalCalls;
          overall.evaluatedCalls += s.evaluatedCalls;
          overall.failureCount += s.failureCount;
        }
        return {
          timestamp: new Date(ts),
          builtin: finalizeSeries(entry.builtin),
          mcp: finalizeSeries(entry.mcp),
          overall: finalizeSeries(overall),
        };
      });
  }

  /**
   * NEW-003: tool-failure chains / rework signal — consecutive runs of
   * success = FALSE tool calls within a session.
   *
   * Within a session, tool_calls are ordered by tool_call_id (the same
   * ordering proxy getToolChains uses). A gaps-and-islands window query finds
   * maximal consecutive failure runs; per session it reports the longest
   * streak and counts of streaks >= 2 and >= 3. The dataset KPI is the share
   * of sessions (with evaluated tool calls) that contain a streak >= 3.
   * Mirrors v_session_failure_chains; re-implemented inline for the
   * period/model/project filters.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @param topLimit - Max worst-offender sessions to return (default: 20)
   * @returns Dataset summary plus the top sessions by max failure streak
   */
  async getFailureChains(
    range: TimeRange,
    filters?: QueryFilters,
    topLimit: number = 20,
  ): Promise<FailureChainSummary> {
    const f = buildTurnFilters(filters, 4);
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bAND model\b/, "AND ct.model").replace(/\bAND session_id\b/, "AND ct.session_id"),
    );
    // Per-session chain stats: gaps-and-islands over tool_call_id ordering.
    const sql = `
      WITH ordered_tools AS (
        SELECT
          tc.session_id,
          tc.success,
          ROW_NUMBER() OVER (PARTITION BY tc.session_id ORDER BY tc.tool_call_id) AS rn
        FROM tool_calls tc
        JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
        WHERE ct.timestamp >= $1 AND ct.timestamp < $2
          AND tc.success IS NOT NULL
          ${filterClauses.join("\n          ")}
      ),
      streak_groups AS (
        SELECT
          session_id,
          success,
          rn - ROW_NUMBER() OVER (PARTITION BY session_id, success ORDER BY rn) AS streak_group
        FROM ordered_tools
      ),
      failure_streaks AS (
        SELECT session_id, streak_group, COUNT(*) AS streak_len
        FROM streak_groups
        WHERE success = FALSE
        GROUP BY session_id, streak_group
      ),
      per_session AS (
        SELECT
          s.session_id,
          COALESCE(MAX(fs.streak_len), 0) AS max_failure_streak,
          COUNT(fs.streak_group) FILTER (WHERE fs.streak_len >= 2) AS failure_chains_2plus,
          COUNT(fs.streak_group) FILTER (WHERE fs.streak_len >= 3) AS failure_chains_3plus,
          COALESCE(SUM(fs.streak_len) FILTER (WHERE fs.streak_len >= 2), 0) AS total_failed_in_chains
        FROM (SELECT DISTINCT session_id FROM ordered_tools) s
        LEFT JOIN failure_streaks fs ON fs.session_id = s.session_id
        GROUP BY s.session_id
      )
      SELECT
        session_id,
        max_failure_streak,
        failure_chains_2plus,
        failure_chains_3plus,
        total_failed_in_chains
      FROM per_session
      ORDER BY max_failure_streak DESC, failure_chains_2plus DESC
    `;
    const result = await this.executor.query<{
      session_id: string;
      max_failure_streak: number;
      failure_chains_2plus: number;
      failure_chains_3plus: number;
      total_failed_in_chains: number;
    }>(sql, [range.start, range.end, topLimit, ...f.params]);

    const rows: SessionFailureChainStats[] = result.rows.map((row) => ({
      sessionId: row.session_id,
      maxFailureStreak: Number(row.max_failure_streak),
      failureChains2Plus: Number(row.failure_chains_2plus),
      failureChains3Plus: Number(row.failure_chains_3plus),
      totalFailedInChains: Number(row.total_failed_in_chains),
    }));

    const sessionsWithToolCalls = rows.length;
    const sessionsWithChains2Plus = rows.filter((r) => r.failureChains2Plus > 0).length;
    const sessionsWithChains3Plus = rows.filter((r) => r.failureChains3Plus > 0).length;
    const worstStreak = rows.reduce((m, r) => Math.max(m, r.maxFailureStreak), 0);

    return {
      sessionsWithToolCalls,
      sessionsWithChains2Plus,
      sessionsWithChains3Plus,
      chainRate3Plus:
        sessionsWithToolCalls > 0 ? sessionsWithChains3Plus / sessionsWithToolCalls : 0,
      worstStreak,
      topSessions: rows.filter((r) => r.maxFailureStreak >= 2).slice(0, topLimit),
    };
  }
}

/** NEW-002: mutable accumulator for one tool-class failure series. */
interface SeriesAcc {
  totalCalls: number;
  evaluatedCalls: number;
  failureCount: number;
}

function emptySeriesAcc(): SeriesAcc {
  return { totalCalls: 0, evaluatedCalls: 0, failureCount: 0 };
}

/** NEW-002: turn a {@link SeriesAcc} into the public failure-rate series. */
function finalizeSeries(acc: SeriesAcc): ToolFailureTrendPoint["overall"] {
  return {
    totalCalls: acc.totalCalls,
    evaluatedCalls: acc.evaluatedCalls,
    failureCount: acc.failureCount,
    failureRate: acc.evaluatedCalls > 0 ? acc.failureCount / acc.evaluatedCalls : null,
  };
}
