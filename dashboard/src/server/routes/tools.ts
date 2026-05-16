/**
 * @module server/routes/tools
 *
 * Tool usage analysis API endpoints.
 * Mirrors ToolAnalyzer queries with raw SQL against DuckDB.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import {
  parseFilters,
  buildTurnFilterClauses,
  envelope,
} from "../helpers/parseFilters.js";

const router = Router();

/**
 * GET /api/tools/usage
 *
 * Get usage stats for all tools in a time range.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/usage", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);
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
        -- KPI-009: avg_per_session — surfaced so this route matches the
        -- v_tool_usage view instead of silently omitting the column.
        COUNT(*)::DOUBLE / NULLIF(COUNT(DISTINCT tc.session_id), 0)::DOUBLE
          AS avg_per_session
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
        ${filterClauses.join("\n        ")}
      GROUP BY tc.tool_name, tc.tool_type, tc.mcp_server
      ORDER BY call_count DESC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
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

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tools/success-rates
 *
 * Get success/failure rates per tool with common errors.
 * Query params: ?period=7d
 */
router.get("/success-rates", async (req, res, next) => {
  try {
    const filters = parseFilters(req);

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
          -- v_tool_usage and /api/tools/usage. "No data", not a 0% tool.
          ELSE NULL
        END AS success_rate,
        COALESCE(AVG(tc.duration_ms), 0) AS avg_duration_ms
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
      GROUP BY tc.tool_name
      ORDER BY total_calls DESC
    `;

    const errorSql = `
      SELECT tc.tool_name, tc.error_message
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
        AND tc.success = FALSE
        AND tc.error_message IS NOT NULL
    `;

    const [result, errorResult] = await Promise.all([
      query(sql, [filters.range.start, filters.range.end]),
      query(errorSql, [filters.range.start, filters.range.end]),
    ]);

    const errorsByTool = new Map<string, string[]>();
    for (const row of errorResult.rows as Array<Record<string, unknown>>) {
      const toolName = row.tool_name as string;
      const errors = errorsByTool.get(toolName) ?? [];
      const msg = row.error_message as string;
      if (!errors.includes(msg)) {
        errors.push(msg);
      }
      errorsByTool.set(toolName, errors);
    }

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      toolName: row.tool_name,
      totalCalls: Number(row.total_calls),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      // KPI-006: preserve NULL (no data) instead of coercing to 0%.
      successRate: row.success_rate != null ? Number(row.success_rate) : null,
      avgDurationMs: Number(row.avg_duration_ms),
      commonErrors: (errorsByTool.get(row.tool_name as string) ?? []).slice(0, 5),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tools/mcp-servers
 *
 * Get MCP server-level aggregation.
 * Query params: ?period=7d
 */
router.get("/mcp-servers", async (req, res, next) => {
  try {
    const filters = parseFilters(req);

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

    const toolsSql = `
      SELECT DISTINCT tc.mcp_server, tc.tool_name
      FROM tool_calls tc
      JOIN conversation_turns ct ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
      WHERE tc.tool_type = 'mcp'
        AND tc.mcp_server IS NOT NULL
        AND ct.timestamp >= $1 AND ct.timestamp < $2
    `;

    const [result, toolsResult] = await Promise.all([
      query(sql, [filters.range.start, filters.range.end]),
      query(toolsSql, [filters.range.start, filters.range.end]),
    ]);

    const toolsByServer = new Map<string, string[]>();
    for (const row of toolsResult.rows as Array<Record<string, unknown>>) {
      const server = row.mcp_server as string;
      const tools = toolsByServer.get(server) ?? [];
      tools.push(row.tool_name as string);
      toolsByServer.set(server, tools);
    }

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      serverName: row.server_name,
      totalCalls: Number(row.total_calls),
      uniqueTools: toolsByServer.get(row.server_name as string) ?? [],
      totalTokens: 0,
      avgDurationMs: Number(row.avg_duration_ms),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tools/failure-trend
 *
 * NEW-002: tool failure-rate trend, bucketed over time and split
 * builtin-vs-MCP. failure_rate = COUNT(success = FALSE) / COUNT(success IS NOT
 * NULL); NULL-success calls are excluded from the denominator. Mirrors
 * v_tool_failure_trend and ToolAnalyzer.getToolFailureTrend.
 *
 * Query params: ?period=7d&bucket=day&model=X&project=Y
 */
router.get("/failure-trend", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const bucket = (req.query.bucket as string) || "day";
    const validBuckets: Record<string, string> = {
      hour: "hour",
      day: "day",
      week: "week",
      month: "month",
    };
    const duckBucket = validBuckets[bucket];
    if (!duckBucket) {
      return res.status(400).json({
        error: `Invalid time bucket: ${bucket}. Valid values: hour, day, week, month`,
      });
    }

    const f = buildTurnFilterClauses(filters, 3);
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

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    // Pivot (bucket, tool_class) rows into one point per bucket.
    type Acc = { totalCalls: number; evaluatedCalls: number; failureCount: number };
    const empty = (): Acc => ({ totalCalls: 0, evaluatedCalls: 0, failureCount: 0 });
    const finalize = (a: Acc) => ({
      totalCalls: a.totalCalls,
      evaluatedCalls: a.evaluatedCalls,
      failureCount: a.failureCount,
      failureRate: a.evaluatedCalls > 0 ? a.failureCount / a.evaluatedCalls : null,
    });

    const byBucket = new Map<string, { builtin: Acc; mcp: Acc }>();
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const key = new Date(row.ts as string).toISOString();
      let entry = byBucket.get(key);
      if (!entry) {
        entry = { builtin: empty(), mcp: empty() };
        byBucket.set(key, entry);
      }
      const target = row.tool_class === "mcp" ? entry.mcp : entry.builtin;
      target.totalCalls += Number(row.total_calls);
      target.evaluatedCalls += Number(row.evaluated_calls);
      target.failureCount += Number(row.failure_count);
    }

    const rows = [...byBucket.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, entry]) => {
        const overall = empty();
        for (const s of [entry.builtin, entry.mcp]) {
          overall.totalCalls += s.totalCalls;
          overall.evaluatedCalls += s.evaluatedCalls;
          overall.failureCount += s.failureCount;
        }
        return {
          timestamp: ts,
          builtin: finalize(entry.builtin),
          mcp: finalize(entry.mcp),
          overall: finalize(overall),
        };
      });

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tools/failure-chains
 *
 * NEW-003: tool-failure chains / rework signal — consecutive runs of
 * success = FALSE tool calls within a session, found with a gaps-and-islands
 * window query over chronological (ct.timestamp) ordering, with
 * tc.tool_call_id as a stable tiebreaker for parallel tool_use blocks within
 * the same assistant turn (TOOL-004, SEM2-285). Returns a dataset summary
 * plus the worst-offender sessions. Mirrors v_session_failure_chains and
 * ToolAnalyzer.getFailureChains.
 *
 * Query params: ?period=7d&model=X&project=Y&limit=20
 */
router.get("/failure-chains", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const topLimit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const f = buildTurnFilterClauses(filters, 3);
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bAND model\b/, "AND ct.model").replace(/\bAND session_id\b/, "AND ct.session_id"),
    );

    // TOOL-003 (SEM2-284) / TOOL-004 (SEM2-285): see tool-analyzer.ts
    // getFailureChains for the full explanation. Chronological ordering must
    // use ct.timestamp; tc.tool_call_id is a random base62 string and is
    // retained only as a stable tiebreaker for parallel tool_use blocks
    // within the same assistant turn.
    const sql = `
      WITH ordered_tools AS (
        SELECT
          tc.session_id,
          tc.success,
          ROW_NUMBER() OVER (PARTITION BY tc.session_id ORDER BY ct.timestamp, tc.tool_call_id) AS rn
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

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const sessions = (result.rows as Array<Record<string, unknown>>).map((row) => ({
      sessionId: row.session_id as string,
      maxFailureStreak: Number(row.max_failure_streak),
      failureChains2Plus: Number(row.failure_chains_2plus),
      failureChains3Plus: Number(row.failure_chains_3plus),
      totalFailedInChains: Number(row.total_failed_in_chains),
    }));

    const sessionsWithToolCalls = sessions.length;
    const sessionsWithChains2Plus = sessions.filter((s) => s.failureChains2Plus > 0).length;
    const sessionsWithChains3Plus = sessions.filter((s) => s.failureChains3Plus > 0).length;
    const worstStreak = sessions.reduce((m, s) => Math.max(m, s.maxFailureStreak), 0);

    res.json(
      envelope(
        {
          summary: {
            sessionsWithToolCalls,
            sessionsWithChains2Plus,
            sessionsWithChains3Plus,
            chainRate3Plus:
              sessionsWithToolCalls > 0
                ? sessionsWithChains3Plus / sessionsWithToolCalls
                : 0,
            worstStreak,
          },
          topSessions: sessions.filter((s) => s.maxFailureStreak >= 2).slice(0, topLimit),
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tools/chains
 *
 * Detect common sequential tool call chain patterns.
 * Query params: ?period=7d&minOccurrences=3
 */
router.get("/chains", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const minOccurrences = Math.max(parseInt(req.query.minOccurrences as string) || 3, 1);

    // TOOL-002 (SEM2-283) / TOOL-004 (SEM2-285): see tool-analyzer.ts
    // getToolChains for the full explanation. Chronological ordering must
    // use ct.timestamp; tc.tool_call_id is a random base62 string and is
    // retained only as a stable tiebreaker for parallel tool_use blocks
    // within the same assistant turn.
    const sql = `
      WITH ordered_tools AS (
        SELECT
          tc.session_id,
          tc.tool_name,
          tc.duration_ms,
          ROW_NUMBER() OVER (PARTITION BY tc.session_id ORDER BY ct.timestamp, tc.tool_call_id) AS rn
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

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      minOccurrences,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      chain: (row.chain as string).split(" -> "),
      occurrences: Number(row.occurrences),
      avgDurationMs: Number(row.avg_duration_ms),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

export default router;
