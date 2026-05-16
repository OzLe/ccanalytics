/**
 * @module server/routes/activity
 *
 * Activity / time-series API endpoints.
 * Mirrors TimeSeriesAnalyzer queries with raw SQL against DuckDB.
 *
 * ACT-001 / SEM2-293: every hour-of-day, day-of-week, and local-date
 * expression projects the stored UTC-wall-clock TIMESTAMP through the user's
 * IANA zone using
 *   `(ts AT TIME ZONE 'UTC') AT TIME ZONE $userTz`
 * so the dashboard surfaces match the user's local clock. `$3` is reserved for
 * the timezone bind; filter clauses therefore start at `$4`.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import {
  parseFilters,
  buildTurnFilterClauses,
  envelope,
} from "../helpers/parseFilters.js";
import { wrapTimestampForTz } from "../../../../src/utils/timezone.js";

const router = Router();

/**
 * GET /api/activity/hourly
 *
 * Get hourly activity distribution (24 rows, one per hour of day).
 * Query params: ?period=7d&model=X&project=Y
 *
 * KPI-002: filters role='assistant' to match v_hourly_activity, the CLI
 * TimeSeriesAnalyzer.getHourlyActivity, and the daily/heatmap/weekly paths —
 * "activity" is one consistent population (assistant turns) everywhere.
 *
 * ACT-001: hour is in the user's IANA zone (resolved by parseFilters).
 *
 * ACT-003 / SEM2-295: the response always contains exactly 24 rows (one per
 * hour-of-day). Hours with no traffic get `messageCount = 0` and zeroed-out
 * aggregates, instead of being silently dropped. The LEFT JOIN against
 * `generate_series(0, 23, 1)` runs server-side so CLI users and any future
 * automation see the same complete axis the React page used to backfill by
 * hand. The hour-of-day axis is still tz-projected per LANE D2.
 */
router.get("/hourly", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    // $3 is the user timezone; filter binds start at $4.
    const f = buildTurnFilterClauses(filters, 4);
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bAND model\b/, "AND ct.model").replace(/\bAND session_id\b/, "AND ct.session_id"),
    );
    const localTs = wrapTimestampForTz("ct.timestamp", "$3");

    // Compute per-hour aggregates in the user's tz first, then LEFT JOIN onto
    // generate_series(0, 23) so every hour appears even when traffic is zero.
    // DuckDB plans generate_series as a tiny constant scan, so the join is
    // essentially free relative to the per_hour aggregation.
    const sql = `
      WITH per_hour AS (
        SELECT
          EXTRACT(HOUR FROM ${localTs})::INTEGER AS hour_of_day,
          COUNT(*) AS message_count,
          COUNT(DISTINCT ct.session_id) AS session_count,
          AVG(ct.cost_usd) AS avg_cost,
          SUM(ct.input_tokens + ct.output_tokens) AS total_tokens,
          SUM(ct.cost_usd) AS total_cost,
          CASE WHEN COUNT(*) > 0
            THEN SUM(ct.input_tokens + ct.output_tokens)::DOUBLE / COUNT(*)
            ELSE 0
          END AS avg_tokens_per_turn
        FROM conversation_turns ct
        WHERE ct.role = 'assistant'
          AND ct.timestamp >= $1 AND ct.timestamp < $2
          ${filterClauses.join("\n          ")}
        GROUP BY hour_of_day
      )
      SELECT
        h.hour_of_day AS hour_of_day,
        COALESCE(p.message_count, 0) AS message_count,
        COALESCE(p.session_count, 0) AS session_count,
        COALESCE(p.avg_cost, 0) AS avg_cost,
        COALESCE(p.total_tokens, 0) AS total_tokens,
        COALESCE(p.total_cost, 0) AS total_cost,
        COALESCE(p.avg_tokens_per_turn, 0) AS avg_tokens_per_turn
      FROM generate_series(0, 23, 1) AS h(hour_of_day)
      LEFT JOIN per_hour p USING (hour_of_day)
      ORDER BY h.hour_of_day ASC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      filters.userTimezone,
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
 *
 * ACT-001: the local date is computed in the user's IANA zone.
 */
router.get("/daily", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const localTs = wrapTimestampForTz("timestamp", "$3");

    const sql = `
      SELECT
        CAST(${localTs} AS DATE) AS date,
        COUNT(*) AS value
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
      GROUP BY date
      ORDER BY date ASC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      filters.userTimezone,
    ]);

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
 *
 * KPI-002: counts role='assistant' turns only, so the heatmap shares the same
 * population as /api/activity/hourly and /api/activity/daily.
 *
 * ACT-001: both DOW and hour are projected through the user's IANA zone, so a
 * turn at 22:30Z on a Wednesday correctly lands in Thursday's bucket for an
 * Asia/Jerusalem user.
 */
router.get("/heatmap", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const localTs = wrapTimestampForTz("ct.timestamp", "$3");

    const sql = `
      SELECT
        EXTRACT(DOW FROM ${localTs})::INTEGER AS day_of_week,
        EXTRACT(HOUR FROM ${localTs})::INTEGER AS hour_of_day,
        COUNT(*) AS value
      FROM conversation_turns ct
      WHERE ct.role = 'assistant'
        AND ct.timestamp >= $1 AND ct.timestamp < $2
      GROUP BY day_of_week, hour_of_day
      ORDER BY day_of_week ASC, hour_of_day ASC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      filters.userTimezone,
    ]);

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
