/**
 * @module server/routes/sessions
 *
 * Session analysis API endpoints.
 * Mirrors SessionAnalyzer queries with raw SQL against DuckDB.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import {
  parseFilters,
  buildSessionFilterClauses,
  envelope,
} from "../helpers/parseFilters.js";

const router = Router();

/**
 * GET /api/sessions
 *
 * Get paginated session summaries.
 * Query params: ?period=7d&model=X&project=Y&sort=start_time&order=desc&limit=50&offset=0
 */
router.get("/", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const sortBy = (req.query.sort as string) || "start_time";
    const order = (req.query.order as string) === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const sortColumnMap: Record<string, string> = {
      start_time: "start_time",
      startTime: "start_time",
      cost: "total_cost_usd",
      totalCostUSD: "total_cost_usd",
      turns: "num_turns",
      numTurns: "num_turns",
      duration: "duration_seconds",
      durationMinutes: "duration_seconds",
      numToolCalls: "num_tool_calls",
      cacheHitRate: "cache_hit_rate",
      model: "model",
      projectPath: "project_path",
      sourceType: "source_type",
    };
    const sortColumn = sortColumnMap[sortBy] ?? "start_time";

    const f = buildSessionFilterClauses(filters, 5, "v_session_summary");
    const fCount = buildSessionFilterClauses(filters, 3, "v_session_summary");

    const sql = `
      SELECT session_id, start_time, end_time, duration_seconds, model,
             total_cost_usd, num_turns, num_tool_calls, cache_hit_rate,
             project_path, source_type
      FROM v_session_summary
      WHERE start_time >= $1 AND start_time < $2
        ${f.clauses.join("\n        ")}
      ORDER BY ${sortColumn} ${order}
      LIMIT $3 OFFSET $4
    `;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM v_session_summary
      WHERE start_time >= $1 AND start_time < $2
        ${fCount.clauses.join("\n        ")}
    `;

    const [result, countResult] = await Promise.all([
      query(sql, [filters.range.start, filters.range.end, limit, offset, ...f.params]),
      query(countSql, [filters.range.start, filters.range.end, ...fCount.params]),
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      sessionId: row.session_id,
      startTime: row.start_time ? new Date(row.start_time as string).toISOString() : null,
      endTime: row.end_time ? new Date(row.end_time as string).toISOString() : null,
      durationMinutes: (Number(row.duration_seconds) || 0) / 60,
      model: row.model,
      totalCostUSD: Number(row.total_cost_usd),
      numTurns: Number(row.num_turns),
      numToolCalls: Number(row.num_tool_calls),
      cacheHitRate: Number(row.cache_hit_rate),
      projectPath: row.project_path,
      sourceType: row.source_type ?? "claude-code",
    }));

    const total = Number((countResult.rows[0] as Record<string, unknown>)?.total ?? 0);

    res.json({
      data: rows,
      meta: {
        period: filters.period,
        timestamp: new Date().toISOString(),
        total,
        limit,
        offset,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sessions/stats
 *
 * Get aggregate statistics across all sessions in a time range.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/stats", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildSessionFilterClauses(filters, 3, "sessions");

    const statsSql = `
      SELECT
        COUNT(*) AS total_sessions,
        COALESCE(SUM(num_turns), 0) AS total_turns,
        COALESCE(AVG(num_turns), 0) AS avg_turns_per_session,
        COALESCE(AVG(duration_seconds) / 60.0, 0) AS avg_duration_minutes,
        COALESCE(MEDIAN(duration_seconds) / 60.0, 0) AS median_duration_minutes,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
        COALESCE(AVG(total_cost_usd), 0) AS avg_cost_per_session
      FROM sessions
      WHERE start_time >= $1 AND start_time < $2
        ${f.clauses.join("\n        ")}
    `;

    const f2 = buildSessionFilterClauses(filters, 3, "sessions");
    const modelsSql = `
      SELECT DISTINCT model
      FROM sessions
      WHERE start_time >= $1 AND start_time < $2
        AND model IS NOT NULL
        ${f2.clauses.join("\n        ")}
    `;

    const [statsResult, modelsResult] = await Promise.all([
      query(statsSql, [filters.range.start, filters.range.end, ...f.params]),
      query(modelsSql, [filters.range.start, filters.range.end, ...f2.params]),
    ]);

    const stats = statsResult.rows[0] as Record<string, unknown> | undefined;
    if (!stats) {
      return res.json(
        envelope(
          {
            totalSessions: 0,
            totalTurns: 0,
            avgTurnsPerSession: 0,
            avgDurationMinutes: 0,
            medianDurationMinutes: 0,
            totalCostUSD: 0,
            avgCostPerSession: 0,
            uniqueModels: [],
          },
          filters.period,
        ),
      );
    }

    res.json(
      envelope(
        {
          totalSessions: Number(stats.total_sessions),
          totalTurns: Number(stats.total_turns),
          avgTurnsPerSession: Number(stats.avg_turns_per_session),
          avgDurationMinutes: Number(stats.avg_duration_minutes),
          medianDurationMinutes: Number(stats.median_duration_minutes),
          totalCostUSD: Number(stats.total_cost_usd),
          avgCostPerSession: Number(stats.avg_cost_per_session),
          uniqueModels: modelsResult.rows.map(
            (r: Record<string, unknown>) => r.model as string,
          ),
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sessions/:id
 *
 * Get full detail for a single session including all turns, tool calls, and errors.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const sessionId = req.params.id;

    // 1. Query session summary
    const sessionResult = await query(
      `SELECT session_id, start_time, end_time, duration_seconds, model,
              total_cost_usd, num_turns, num_tool_calls, cache_hit_rate,
              project_path, source_type
       FROM v_session_summary
       WHERE session_id = $1`,
      [sessionId],
    );

    if (sessionResult.rowCount === 0) {
      return res.status(404).json({ error: `Session not found: ${sessionId}` });
    }

    const session = sessionResult.rows[0] as Record<string, unknown>;

    // 2. Query turns
    const turnsResult = await query(
      `SELECT turn_id, role, timestamp, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens, cost_usd, model, stop_reason
       FROM conversation_turns
       WHERE session_id = $1
       ORDER BY timestamp ASC`,
      [sessionId],
    );

    // 3. Query tool calls
    const toolCallsResult = await query(
      `SELECT tool_call_id, turn_id, tool_name, tool_type, mcp_server,
              duration_ms, success, error_message
       FROM tool_calls
       WHERE session_id = $1
       ORDER BY tool_call_id ASC`,
      [sessionId],
    );

    // 4. Query errors
    const errorsResult = await query(
      `SELECT error_id, timestamp, error_type, message, is_retryable, retry_count
       FROM errors
       WHERE session_id = $1
       ORDER BY timestamp ASC`,
      [sessionId],
    );

    res.json({
      data: {
        sessionId: session.session_id,
        startTime: session.start_time
          ? new Date(session.start_time as string).toISOString()
          : null,
        endTime: session.end_time
          ? new Date(session.end_time as string).toISOString()
          : null,
        durationMinutes: (Number(session.duration_seconds) || 0) / 60,
        model: session.model,
        totalCostUSD: Number(session.total_cost_usd),
        numTurns: Number(session.num_turns),
        numToolCalls: Number(session.num_tool_calls),
        cacheHitRate: Number(session.cache_hit_rate),
        projectPath: session.project_path,
        sourceType: session.source_type ?? "claude-code",
        turns: turnsResult.rows.map((t: Record<string, unknown>) => ({
          turnId: t.turn_id,
          role: t.role,
          timestamp: t.timestamp ? new Date(t.timestamp as string).toISOString() : null,
          inputTokens: Number(t.input_tokens),
          outputTokens: Number(t.output_tokens),
          cacheWriteTokens: Number(t.cache_creation_tokens),
          cacheReadTokens: Number(t.cache_read_tokens),
          costUSD: Number(t.cost_usd),
          model: t.model,
          stopReason: t.stop_reason,
        })),
        toolCalls: toolCallsResult.rows.map((tc: Record<string, unknown>) => ({
          toolCallId: tc.tool_call_id,
          turnId: tc.turn_id,
          toolName: tc.tool_name,
          toolType: tc.tool_type,
          mcpServer: tc.mcp_server,
          durationMs: tc.duration_ms != null ? Number(tc.duration_ms) : null,
          success: tc.success,
          errorMessage: tc.error_message,
        })),
        errors: errorsResult.rows.map((e: Record<string, unknown>) => ({
          errorId: e.error_id,
          timestamp: e.timestamp ? new Date(e.timestamp as string).toISOString() : null,
          errorType: e.error_type,
          message: e.message,
          isRetryable: Boolean(e.is_retryable),
          retryCount: Number(e.retry_count),
        })),
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
