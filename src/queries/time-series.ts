/**
 * @module queries/time-series
 *
 * Time series analytical queries.
 * Provides hourly, daily, and weekly activity aggregations,
 * activity heatmaps, and model usage distribution over time.
 *
 * ACT-001 / SEM2-293: every hour-of-day, day-of-week, local-date, and
 * date-truncated expression projects the stored UTC-wall-clock TIMESTAMP
 * through the user's IANA zone via
 *   `(ts AT TIME ZONE 'UTC') AT TIME ZONE $userTz`
 * so the CLI surfaces match the dashboard and the user's wall clock. `$3` is
 * reserved for the timezone bind, so `buildTurnFilters` starts at `$4`.
 */

import type {
  TimeRange,
  TimeBucket,
  TimeSeriesPoint,
  HourlyActivity,
  QueryFilters,
} from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildTurnFilters } from "./filter-builder.js";
import { resolveTimezone, wrapTimestampForTz } from "../utils/timezone.js";
// ACT-005 / SEM2-297: every activity surface (hourly / daily / heatmap /
// weekly) now applies the SAME row-inclusion predicate as v_daily_cost so
// activity and cost populations reconcile (previously activity counted every
// role='assistant' row, which diverged from v_daily_cost by up to ~5.8%/day on
// the live dataset because v_daily_cost additionally excludes the
// '<synthetic>' model and NULL-model rows).
import { costRowPredicateSql } from "../utils/sqlPredicates.js";
// TOK-RE-002: shared SUM(input + output) SSOT so every total_tokens surface
// agrees by construction with the dashboard route mirror.
import { buildTokenSumSql } from "../utils/tokenSums.js";

const SUMS = buildTokenSumSql("ct");

/** Token usage breakdown at a point in time. */
export interface TokenUsagePoint {
  timestamp: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUSD: number;
}

/** Activity heatmap cell (hour-of-day x day-of-week). */
export interface HeatmapCell {
  dayOfWeek: number; // 0 = Sunday
  hourOfDay: number; // 0-23
  value: number; // count of sessions or turns
}

/** Model usage at a point in time. */
export interface ModelUsagePoint {
  timestamp: Date;
  model: string;
  sessionCount: number;
  totalTokens: number;
  totalCostUSD: number;
}

/**
 * Analyzes time-series activity data from conversation_turns and the
 * v_hourly_activity view.
 */
export class TimeSeriesAnalyzer {
  constructor(private executor: QueryExecutor) {}

  /**
   * Get hourly activity distribution.
   * Mirrors the v_hourly_activity view (one row per local hour-of-day).
   *
   * KPI-002 / ACT-005 (SEM2-297): "activity" means cost-bearing ASSISTANT
   * turns — `costRowPredicateSql()` is applied here, in /api/activity/hourly,
   * and in the heatmap/daily/weekly paths so every activity surface is
   * computed on the SAME population as v_daily_cost / the cost analyzer /
   * /api/cost/*. Without the synthetic + null-model exclusion, activity
   * counts diverge from cost by up to ~5.8%/day on the live dataset.
   *
   * ACT-003 / SEM2-295: the response always contains exactly 24 rows. Hours
   * with no traffic get `messageCount = 0` and zeroed aggregates so CLI users
   * and any future automation never see a silently-dropped hour. The
   * LEFT JOIN against `generate_series(0, 23, 1)` keeps the tz-projected
   * hour-of-day axis from LANE D2 intact; only the cardinality is padded.
   *
   * @param range - Time range to query
   * @returns Hourly activity data (24 rows, one per hour of day)
   */
  async getHourlyActivity(range: TimeRange, filters?: QueryFilters): Promise<HourlyActivity[]> {
    const userTimezone = resolveTimezone(filters?.userTimezone);
    // $3 is the user timezone; filter binds start at $4. The
    // costRowPredicateSql() fragment is a literal — adds zero binds, so the
    // index sequence is unchanged.
    const f = buildTurnFilters(filters, 4);
    // Prefix filter clauses with ct. for aliased queries
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bAND model\b/, "AND ct.model").replace(/\bAND session_id\b/, "AND ct.session_id"),
    );
    const localTs = wrapTimestampForTz("ct.timestamp", "$3");
    // Aggregate per-hour in the CTE, then LEFT JOIN generate_series(0,23) so
    // every hour is present even when the underlying bucket is empty. DuckDB
    // plans generate_series as a constant scan, so the join cost is trivial.
    const sql = `
      WITH per_hour AS (
        SELECT
          EXTRACT(HOUR FROM ${localTs})::INTEGER AS hour_of_day,
          COUNT(*) AS message_count,
          COUNT(DISTINCT ct.session_id) AS session_count,
          AVG(ct.cost_usd) AS avg_cost,
          ${SUMS.totalTokensSql} AS total_tokens,
          SUM(ct.cost_usd) AS total_cost,
          CASE WHEN COUNT(*) > 0
            THEN ${SUMS.totalTokensSql}::DOUBLE / COUNT(*)
            ELSE 0
          END AS avg_tokens_per_turn
        FROM conversation_turns ct
        WHERE ${costRowPredicateSql("ct")}
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
    const result = await this.executor.query<{
      hour_of_day: number;
      message_count: number;
      session_count: number;
      avg_cost: number;
      total_tokens: number;
      total_cost: number;
      avg_tokens_per_turn: number;
    }>(sql, [range.start, range.end, userTimezone, ...f.params]);

    return result.rows.map((row) => ({
      hourOfDay: Number(row.hour_of_day),
      messageCount: Number(row.message_count),
      sessionCount: Number(row.session_count),
      avgCost: Number(row.avg_cost),
      totalTokens: Number(row.total_tokens),
      totalCost: Number(row.total_cost),
      avgTokensPerTurn: Number(row.avg_tokens_per_turn),
    }));
  }

  /**
   * Get daily activity aggregation.
   *
   * ACT-001: the per-day boundary is the user's local midnight (resolved via
   * `filters.userTimezone`), not UTC midnight.
   *
   * ACT-005 (SEM2-297): same cost-row predicate as v_daily_cost — see
   * `costRowPredicateSql()`. Aligns the daily-activity population with
   * the daily-cost population (was off by ~5.8% on some days).
   *
   * @param range - Time range to query
   * @param filters - Optional model/project/timezone filters
   * @returns Daily activity time series
   */
  async getDailyActivity(
    range: TimeRange,
    filters?: QueryFilters,
  ): Promise<TimeSeriesPoint[]> {
    const userTimezone = resolveTimezone(filters?.userTimezone);
    const localTs = wrapTimestampForTz("timestamp", "$3");
    const sql = `
      SELECT
        CAST(${localTs} AS DATE) AS date,
        COUNT(*) AS value
      FROM conversation_turns
      WHERE ${costRowPredicateSql("")}
        AND timestamp >= $1 AND timestamp < $2
      GROUP BY date
      ORDER BY date ASC
    `;
    const result = await this.executor.query<{
      date: string;
      value: number;
    }>(sql, [range.start, range.end, userTimezone]);

    return result.rows.map((row) => ({
      timestamp: new Date(row.date),
      value: Number(row.value),
    }));
  }

  /**
   * Get an activity heatmap (hour-of-day x day-of-week).
   *
   * KPI-002 / ACT-005 (SEM2-297): counts cost-bearing assistant turns
   * (`costRowPredicateSql()`), so the heatmap shares the same population as
   * /api/activity/hourly, /api/activity/daily, and v_daily_cost — the four
   * surfaces reconcile turn-for-turn.
   *
   * ACT-001: both DOW and hour are projected through the user's IANA zone,
   * so a turn at 22:30Z on a Wednesday correctly lands in Thursday's bucket
   * for an Asia/Jerusalem user.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project/timezone filters
   * @returns Array of heatmap cells with day/hour/count
   */
  async getActivityHeatmap(
    range: TimeRange,
    filters?: QueryFilters,
  ): Promise<HeatmapCell[]> {
    const userTimezone = resolveTimezone(filters?.userTimezone);
    const localTs = wrapTimestampForTz("ct.timestamp", "$3");
    const sql = `
      SELECT
        EXTRACT(DOW FROM ${localTs})::INTEGER AS day_of_week,
        EXTRACT(HOUR FROM ${localTs})::INTEGER AS hour_of_day,
        COUNT(*) AS value
      FROM conversation_turns ct
      WHERE ${costRowPredicateSql("ct")}
        AND ct.timestamp >= $1 AND ct.timestamp < $2
      GROUP BY day_of_week, hour_of_day
      ORDER BY day_of_week ASC, hour_of_day ASC
    `;
    const result = await this.executor.query<{
      day_of_week: number;
      hour_of_day: number;
      value: number;
    }>(sql, [range.start, range.end, userTimezone]);

    return result.rows.map((row) => ({
      dayOfWeek: Number(row.day_of_week),
      hourOfDay: Number(row.hour_of_day),
      value: Number(row.value),
    }));
  }

  /**
   * Get weekly activity trend.
   *
   * ACT-001: the week boundary uses the user's local clock (DATE_TRUNC sees
   * the tz-projected local TIMESTAMP, not UTC), so the bar a user sees on
   * the dashboard starts at their local Monday/Sunday.
   *
   * ACT-005 (SEM2-297): same cost-row predicate as v_daily_cost, so the
   * weekly activity bar height matches the weekly cost bar height for the
   * same date range.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project/timezone filters
   * @returns Weekly activity time series
   */
  async getWeeklyTrend(
    range: TimeRange,
    filters?: QueryFilters,
  ): Promise<TimeSeriesPoint[]> {
    const userTimezone = resolveTimezone(filters?.userTimezone);
    const localTs = wrapTimestampForTz("timestamp", "$3");
    const sql = `
      SELECT
        DATE_TRUNC('week', ${localTs}) AS week,
        COUNT(*) AS value
      FROM conversation_turns
      WHERE ${costRowPredicateSql("")}
        AND timestamp >= $1 AND timestamp < $2
      GROUP BY week
      ORDER BY week ASC
    `;
    const result = await this.executor.query<{
      week: string;
      value: number;
    }>(sql, [range.start, range.end, userTimezone]);

    return result.rows.map((row) => ({
      timestamp: new Date(row.week),
      value: Number(row.value),
    }));
  }
}
