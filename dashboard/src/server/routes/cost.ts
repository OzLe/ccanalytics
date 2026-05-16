/**
 * @module server/routes/cost
 *
 * Cost analysis API endpoints.
 * Mirrors CostAnalyzer queries with raw SQL against DuckDB.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import {
  parseFilters,
  buildTurnFilterClauses,
  buildSessionFilterClauses,
  envelope,
} from "../helpers/parseFilters.js";
// SINGLE SHARED RATE SOURCE (COST-001 / COST-003): the per-model rate CASE
// expressions below are GENERATED from the same PRICING table that
// src/utils/pricing.ts uses for ingest-time cost calculation. They are no
// longer hand-maintained, so the SQL rates can never drift from pricing.ts.
import { buildRateCaseSql } from "../../../../src/utils/pricing.js";
// ACT-001 / SEM2-293: hour-of-day / local-date / DATE_TRUNC math projects the
// stored UTC-wall-clock timestamp through the user's IANA zone. $3 is the
// timezone bind everywhere; filter clauses therefore start at $4.
import { wrapTimestampForTz } from "../../../../src/utils/timezone.js";
import { costRowPredicateSql } from "../../../../src/utils/sqlPredicates.js";

const router = Router();

/**
 * Per-model rate CASE expressions ($/MTok), generated from the shared
 * PRICING table in src/utils/pricing.ts. `model` is the bare column name;
 * routes that alias the table (e.g. `ct`) regenerate against `ct.model`.
 *
 * COST-001: includes claude-opus-4-7 (= 5/25/6.25/0.5) and claude-sonnet-4-6
 * automatically because they are entries in the shared table.
 */
const INPUT_RATE_CASE = buildRateCaseSql("inputPerM");
const OUTPUT_RATE_CASE = buildRateCaseSql("outputPerM");
const CACHE_CREATION_RATE_CASE = buildRateCaseSql("cacheCreationPerM");
const CACHE_READ_RATE_CASE = buildRateCaseSql("cacheReadPerM");

/** Same four CASE expressions, qualified to the `ct` table alias. */
const INPUT_RATE_CASE_CT = buildRateCaseSql("inputPerM", "ct.model");
const OUTPUT_RATE_CASE_CT = buildRateCaseSql("outputPerM", "ct.model");
const CACHE_CREATION_RATE_CASE_CT = buildRateCaseSql("cacheCreationPerM", "ct.model");
const CACHE_READ_RATE_CASE_CT = buildRateCaseSql("cacheReadPerM", "ct.model");

/**
 * GET /api/cost/total
 *
 * Get total cost breakdown (input, output, cache_write, cache_read).
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/total", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);

    // COST-003: totalCostUSD is SUM of the stored cost_usd column — the single
    // canonical cost basis, identical to v_daily_cost / sessions / the daily
    // and trend endpoints. The per-category breakdown (input/output/cache) is
    // still rate-derived since cost_usd is a single combined total; after the
    // COST-002 backfill the per-category sum reconciles with stored_cost_usd.
    const sql = `
      SELECT
        COALESCE(SUM(cost_usd), 0) AS stored_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
        COALESCE(SUM(input_tokens * ${INPUT_RATE_CASE} / 1000000.0), 0) AS input_cost_usd,
        COALESCE(SUM(output_tokens * ${OUTPUT_RATE_CASE} / 1000000.0), 0) AS output_cost_usd,
        COALESCE(SUM(cache_creation_tokens * ${CACHE_CREATION_RATE_CASE} / 1000000.0), 0) AS cache_write_cost_usd,
        COALESCE(SUM(cache_read_tokens * ${CACHE_READ_RATE_CASE} / 1000000.0), 0) AS cache_read_cost_usd
      FROM conversation_turns
      WHERE ${costRowPredicateSql("")}
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return res.json(
        envelope(
          {
            totalCostUSD: 0,
            inputCostUSD: 0,
            outputCostUSD: 0,
            cacheWriteCostUSD: 0,
            cacheReadCostUSD: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheWriteTokens: 0,
            totalCacheReadTokens: 0,
          },
          filters.period,
        ),
      );
    }

    const inputCostUSD = Number(row.input_cost_usd);
    const outputCostUSD = Number(row.output_cost_usd);
    const cacheWriteCostUSD = Number(row.cache_write_cost_usd);
    const cacheReadCostUSD = Number(row.cache_read_cost_usd);

    res.json(
      envelope(
        {
          // Canonical: SUM of the stored cost_usd column (COST-003).
          totalCostUSD: Number(row.stored_cost_usd),
          inputCostUSD,
          outputCostUSD,
          cacheWriteCostUSD,
          cacheReadCostUSD,
          totalInputTokens: Number(row.total_input_tokens),
          totalOutputTokens: Number(row.total_output_tokens),
          totalCacheWriteTokens: Number(row.total_cache_write_tokens),
          totalCacheReadTokens: Number(row.total_cache_read_tokens),
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cost/daily
 *
 * Get daily cost aggregation broken down by model.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/daily", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    // $3 = userTimezone (ACT-001); filter binds start at $4.
    const f = buildTurnFilterClauses(filters, 4);
    const localDate = `CAST(${wrapTimestampForTz("timestamp", "$3")} AS DATE)`;

    const sql = `
      SELECT
        CAST(${localDate} AS VARCHAR) AS date,
        model,
        SUM(cost_usd) AS total_cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        COUNT(*) AS turn_count,
        COUNT(DISTINCT session_id) AS session_count
      FROM conversation_turns
      WHERE ${costRowPredicateSql("")}
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY CAST(${localDate} AS VARCHAR), model
      ORDER BY date ASC, total_cost DESC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      filters.userTimezone,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      date: String(row.date),
      model: row.model,
      totalCost: Number(row.total_cost),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheCreationTokens: Number(row.cache_creation_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      turnCount: Number(row.turn_count),
      sessionCount: Number(row.session_count),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cost/by-model
 *
 * Get cost broken down by model.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/by-model", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bmodel\b/, "ct.model").replace(/\bsession_id\b/, "ct.session_id"),
    );

    const sql = `
      SELECT
        ct.model,
        COUNT(DISTINCT ct.session_id) AS session_count,
        COALESCE(SUM(ct.cost_usd), 0) AS stored_cost_usd,
        COALESCE(SUM(ct.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(ct.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(ct.cache_creation_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(ct.cache_read_tokens), 0) AS total_cache_read_tokens,
        COALESCE(SUM(ct.input_tokens * ${INPUT_RATE_CASE_CT} / 1000000.0), 0) AS input_cost_usd,
        COALESCE(SUM(ct.output_tokens * ${OUTPUT_RATE_CASE_CT} / 1000000.0), 0) AS output_cost_usd,
        COALESCE(SUM(ct.cache_creation_tokens * ${CACHE_CREATION_RATE_CASE_CT} / 1000000.0), 0) AS cache_write_cost_usd,
        COALESCE(SUM(ct.cache_read_tokens * ${CACHE_READ_RATE_CASE_CT} / 1000000.0), 0) AS cache_read_cost_usd
      FROM conversation_turns ct
      WHERE ${costRowPredicateSql("ct")}
        AND ct.timestamp >= $1 AND ct.timestamp < $2
        ${filterClauses.join("\n        ")}
      GROUP BY ct.model
      ORDER BY stored_cost_usd DESC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => {
      const inputCostUSD = Number(row.input_cost_usd);
      const outputCostUSD = Number(row.output_cost_usd);
      const cacheWriteCostUSD = Number(row.cache_write_cost_usd);
      const cacheReadCostUSD = Number(row.cache_read_cost_usd);

      return {
        model: row.model,
        sessionCount: Number(row.session_count),
        // Canonical: SUM of the stored cost_usd column (COST-003).
        totalCostUSD: Number(row.stored_cost_usd),
        inputCostUSD,
        outputCostUSD,
        cacheWriteCostUSD,
        cacheReadCostUSD,
        totalInputTokens: Number(row.total_input_tokens),
        totalOutputTokens: Number(row.total_output_tokens),
        totalCacheWriteTokens: Number(row.total_cache_write_tokens),
        totalCacheReadTokens: Number(row.total_cache_read_tokens),
      };
    });

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cost/by-project
 *
 * Get cost broken down by project.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/by-project", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildSessionFilterClauses(filters, 3);

    // Join conversation_turns to get per-model token data for correct rate-based costs
    const sql = `
      SELECT
        COALESCE(s.project_path, 'unknown') AS project_path,
        COALESCE(MAX(s.project_name), COALESCE(s.project_path, 'unknown')) AS project_name,
        COUNT(DISTINCT s.session_id) AS session_count,
        COALESCE(SUM(ct.cost_usd), 0) AS stored_cost_usd,
        COALESCE(SUM(ct.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(ct.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(ct.cache_creation_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(ct.cache_read_tokens), 0) AS total_cache_read_tokens,
        COALESCE(SUM(ct.input_tokens * ${INPUT_RATE_CASE_CT} / 1000000.0), 0) AS input_cost_usd,
        COALESCE(SUM(ct.output_tokens * ${OUTPUT_RATE_CASE_CT} / 1000000.0), 0) AS output_cost_usd,
        COALESCE(SUM(ct.cache_creation_tokens * ${CACHE_CREATION_RATE_CASE_CT} / 1000000.0), 0) AS cache_write_cost_usd,
        COALESCE(SUM(ct.cache_read_tokens * ${CACHE_READ_RATE_CASE_CT} / 1000000.0), 0) AS cache_read_cost_usd
      FROM sessions s
      JOIN conversation_turns ct ON ct.session_id = s.session_id AND ${costRowPredicateSql("ct")}
      WHERE s.start_time >= $1 AND s.start_time < $2
        ${f.clauses.join("\n        ")}
      GROUP BY s.project_path
      ORDER BY stored_cost_usd DESC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => {
      const inputCostUSD = Number(row.input_cost_usd);
      const outputCostUSD = Number(row.output_cost_usd);
      const cacheWriteCostUSD = Number(row.cache_write_cost_usd);
      const cacheReadCostUSD = Number(row.cache_read_cost_usd);
      // Canonical: SUM of the stored cost_usd column (COST-003).
      const totalCostUSD = Number(row.stored_cost_usd);

      return {
        projectPath: row.project_path,
        projectName: row.project_name as string,
        totalCostUSD,
        sessionCount: Number(row.session_count),
        tokenBreakdown: {
          totalCostUSD,
          inputCostUSD,
          outputCostUSD,
          cacheWriteCostUSD,
          cacheReadCostUSD,
          totalInputTokens: Number(row.total_input_tokens),
          totalOutputTokens: Number(row.total_output_tokens),
          totalCacheWriteTokens: Number(row.total_cache_write_tokens),
          totalCacheReadTokens: Number(row.total_cache_read_tokens),
        },
      };
    });

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cost/trend
 *
 * Get cost trending over time, bucketed by day (default) or specified bucket.
 * Query params: ?period=7d&bucket=day&model=X&project=Y
 */
router.get("/trend", async (req, res, next) => {
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

    // ACT-001: $3 = userTimezone, filter binds shift to $4.
    const f = buildTurnFilterClauses(filters, 4);
    const localTs = wrapTimestampForTz("timestamp", "$3");

    const sql = `
      SELECT
        DATE_TRUNC('${duckBucket}', ${localTs}) AS ts,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
      FROM conversation_turns
      WHERE ${costRowPredicateSql("")}
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY ts
      ORDER BY ts ASC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      filters.userTimezone,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.ts as string).toISOString(),
      costUSD: Number(row.cost_usd),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheCreationTokens: Number(row.cache_creation_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

export default router;
