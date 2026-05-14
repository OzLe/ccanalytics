/**
 * @module server/routes/cache
 *
 * Cache efficiency API endpoints.
 * Mirrors CacheAnalyzer queries with raw SQL against DuckDB.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import {
  parseFilters,
  buildTurnFilterClauses,
  envelope,
} from "../helpers/parseFilters.js";
// SINGLE SHARED RATE SOURCE (COST-001): the cache-read savings rate CASE is
// generated from the same PRICING table as src/utils/pricing.ts, so it can
// never drift and automatically covers claude-opus-4-7.
import { buildCacheSavingsRateCaseSql } from "../../../../src/utils/pricing.js";

const router = Router();

/**
 * Per-model cache-read savings rate ($/MTok = inputPerM - cacheReadPerM),
 * generated from the shared PRICING table. COST-001: claude-opus-4-7 is
 * covered automatically (4.5/MTok), instead of falling through to the
 * Opus-4 (13.5) rate as it did with the old hand-maintained CASE.
 */
const SAVINGS_RATE_CASE = buildCacheSavingsRateCaseSql();

/**
 * GET /api/cache/metrics
 *
 * Get overall cache metrics for a time range.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/metrics", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);

    const sql = `
      SELECT
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(cache_read_tokens * ${SAVINGS_RATE_CASE} / 1000000.0), 0) AS estimated_savings_usd
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    const cacheReadTokens = Number(row?.cache_read_tokens ?? 0);
    const cacheWriteTokens = Number(row?.cache_write_tokens ?? 0);
    const totalInputTokens = Number(row?.total_input_tokens ?? 0);

    // KPI-001: input_tokens is already the uncached-input figure (cache reads
    // are a SEPARATE Anthropic API field, not a subset of input_tokens).
    // Canonical denominator = cache_read + cache_creation + input_tokens,
    // matching v_cache_efficiency / v_session_summary and /api/cache/trend.
    const uncachedInputTokens = totalInputTokens;
    const denominator = cacheReadTokens + cacheWriteTokens + uncachedInputTokens;
    const cacheHitRate = denominator > 0 ? cacheReadTokens / denominator : 0;

    const estimatedSavingsUSD = Number(row?.estimated_savings_usd ?? 0);

    let interpretation: "effective" | "moderate" | "ineffective";
    if (cacheHitRate > 0.8) {
      interpretation = "effective";
    } else if (cacheHitRate >= 0.5) {
      interpretation = "moderate";
    } else {
      interpretation = "ineffective";
    }

    res.json(
      envelope(
        {
          cacheHitRate,
          cacheReadTokens,
          cacheWriteTokens,
          uncachedInputTokens,
          estimatedSavingsUSD,
          interpretation,
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cache/trend
 *
 * Get cache efficiency trending over time (daily).
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/trend", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);

    const sql = `
      SELECT
        CAST(timestamp AS DATE) AS date,
        CASE
          WHEN (SUM(cache_read_tokens) + SUM(cache_creation_tokens) + SUM(input_tokens)) > 0
          THEN SUM(cache_read_tokens)::DOUBLE /
               (SUM(cache_read_tokens) + SUM(cache_creation_tokens) + SUM(input_tokens))::DOUBLE
          ELSE 0.0
        END AS cache_hit_rate,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_creation_tokens) AS cache_write_tokens
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY CAST(timestamp AS DATE)
      ORDER BY date ASC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.date as string).toISOString(),
      cacheHitRate: Number(row.cache_hit_rate),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

export default router;
