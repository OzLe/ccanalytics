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
        COUNT(DISTINCT tc.session_id) AS sessions_using_tool
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
          ELSE 0
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
      successRate: Number(row.success_rate),
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
 * GET /api/tools/chains
 *
 * Detect common sequential tool call chain patterns.
 * Query params: ?period=7d&minOccurrences=3
 */
router.get("/chains", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const minOccurrences = Math.max(parseInt(req.query.minOccurrences as string) || 3, 1);

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
