/**
 * @module server/routes/activity
 *
 * Activity / time-series API endpoints.
 * Mirrors TimeSeriesAnalyzer queries with raw SQL against DuckDB.
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
 * GET /api/activity/hourly
 *
 * Get hourly activity distribution (24 rows, one per hour of day).
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/hourly", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bAND model\b/, "AND ct.model").replace(/\bAND session_id\b/, "AND ct.session_id"),
    );

    const sql = `
      SELECT
        EXTRACT(HOUR FROM ct.timestamp)::INTEGER AS hour_of_day,
        COUNT(*) AS message_count,
        COUNT(DISTINCT ct.session_id) AS session_count,
        COALESCE(AVG(ct.cost_usd), 0) AS avg_cost,
        COALESCE(SUM(ct.input_tokens + ct.output_tokens), 0) AS total_tokens,
        COALESCE(SUM(ct.cost_usd), 0) AS total_cost,
        CASE WHEN COUNT(*) > 0
          THEN COALESCE(SUM(ct.input_tokens + ct.output_tokens), 0)::DOUBLE / COUNT(*)
          ELSE 0
        END AS avg_tokens_per_turn
      FROM conversation_turns ct
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
        ${filterClauses.join("\n        ")}
      GROUP BY hour_of_day
      ORDER BY hour_of_day ASC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      hourOfDay: Number(row.hour_of_day),
      messageCount: Number(row.message_count),
      sessionCount: Number(row.session_count),
      avgCost: Number(row.avg_cost),
      totalTokens: Number(row.total_tokens),
      totalCost: Number(row.total_cost),
      avgTokensPerTurn: Number(row.avg_tokens_per_turn),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/activity/daily
 *
 * Get daily activity aggregation (turn counts per day).
 * Query params: ?period=7d
 */
router.get("/daily", async (req, res, next) => {
  try {
    const filters = parseFilters(req);

    const sql = `
      SELECT
        CAST(timestamp AS DATE) AS date,
        COUNT(*) AS value
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
      GROUP BY date
      ORDER BY date ASC
    `;

    const result = await query(sql, [filters.range.start, filters.range.end]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.date as string).toISOString(),
      value: Number(row.value),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/activity/heatmap
 *
 * Get activity heatmap (hour-of-day x day-of-week).
 * Query params: ?period=7d
 */
router.get("/heatmap", async (req, res, next) => {
  try {
    const filters = parseFilters(req);

    const sql = `
      SELECT
        EXTRACT(DOW FROM ct.timestamp)::INTEGER AS day_of_week,
        EXTRACT(HOUR FROM ct.timestamp)::INTEGER AS hour_of_day,
        COUNT(*) AS value
      FROM conversation_turns ct
      WHERE ct.timestamp >= $1 AND ct.timestamp < $2
      GROUP BY day_of_week, hour_of_day
      ORDER BY day_of_week ASC, hour_of_day ASC
    `;

    const result = await query(sql, [filters.range.start, filters.range.end]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      dayOfWeek: Number(row.day_of_week),
      hourOfDay: Number(row.hour_of_day),
      value: Number(row.value),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

export default router;
