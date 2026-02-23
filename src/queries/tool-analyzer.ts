/**
 * @module queries/tool-analyzer
 *
 * Tool usage analytical queries.
 * Analyzes tool call frequency, success rates, MCP server usage,
 * and sequential tool chain patterns.
 */

import type { ToolUsageStats, TimeRange, QueryFilters } from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildTurnFilters } from "./filter-builder.js";

/** Success rate details for a single tool. */
export interface ToolSuccessRate {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
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
        COUNT(DISTINCT tc.session_id) AS sessions_using_tool
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
          ELSE 0
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
      success_rate: number;
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
      successRate: Number(row.success_rate),
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
}
