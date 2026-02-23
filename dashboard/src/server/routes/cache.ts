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

const router = Router();

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
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens
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

    const uncachedInputTokens = Math.max(0, totalInputTokens - cacheReadTokens);
    const denominator = cacheReadTokens + cacheWriteTokens + uncachedInputTokens;
    const cacheHitRate = denominator > 0 ? cacheReadTokens / denominator : 0;

    // Estimate savings: cache reads are ~10x cheaper than regular input
    // $3/MTok input vs $0.30/MTok cache read = $2.70/MTok saved
    const estimatedSavingsUSD = (cacheReadTokens / 1_000_000) * 2.70;

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
