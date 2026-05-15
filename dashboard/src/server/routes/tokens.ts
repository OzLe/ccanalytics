/**
 * @module server/routes/tokens
 *
 * F1 — Total Tokens KPI API endpoint.
 *
 * Mirrors `TokenAnalyzer.getTotalTokens` with raw SQL against DuckDB. Uses the
 * SAME `costRowPredicate()` the cost route uses (`role='assistant' AND model IS
 * NOT NULL AND model <> '<synthetic>'`) so Total Tokens reconciles 1:1 with
 * `/api/cost/total`. A new route file per the one-route-file-per-domain
 * structure (`cost.ts`, `cache.ts`, `activity.ts`…) and the `/api/cost/total`
 * precedent.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import { parseFilters, buildTurnFilterClauses, envelope } from "../helpers/parseFilters.js";

const router = Router();

/**
 * Canonical row-inclusion predicate for token aggregation (F1 / D6).
 *
 * The SAME predicate `costRowPredicate()` uses in `routes/cost.ts` and the CLI
 * `cost-analyzer.ts` / `token-analyzer.ts` — "real assistant turns", excluding
 * only the `<synthetic>` placeholder model. F1 intentionally mirrors the COST
 * predicate (not the looser `v_session_summary` / `v_hourly_activity`
 * `assistant`-only predicate) so the headline reconciles with Total Cost.
 *
 * @param alias - Table alias for conversation_turns; "" for the bare column form.
 */
function costRowPredicate(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `${p}role = 'assistant' AND ${p}model IS NOT NULL AND ${p}model <> '<synthetic>'`;
}

/** The four SUM columns + the combined total, identical for both queries. */
const TOKEN_SUM_COLUMNS = `
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens`;

/** Map a raw aggregate row (or `undefined`) to the API breakdown shape. */
function toBreakdown(row: Record<string, unknown> | undefined) {
  if (!row) {
    return {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
  return {
    totalTokens: Number(row.total_tokens),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
  };
}

/**
 * GET /api/tokens/total
 *
 * Total token breakdown for a period plus the unfiltered all-time grand total,
 * returned together so the Total Tokens card never needs a second request.
 *
 * Query params: ?period=7d&model=X&project=Y&source=Z
 *
 * - `data.period` — `timestamp >= $1 AND timestamp < $2` plus the active
 *   model/project/source filters.
 * - `data.allTime` — the same `costRowPredicate()`, but NO timestamp bound and
 *   NO filters (D7). A fixed per-request constant — changing the period or a
 *   filter never alters it.
 */
router.get("/total", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);

    // 1. Period block — filtered, time-bounded.
    const periodSql = `
      SELECT${TOKEN_SUM_COLUMNS}
      FROM conversation_turns
      WHERE ${costRowPredicate()}
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
    `;
    const periodResult = await query(periodSql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    // 2. All-time block — fully unfiltered, dataset-wide (D7).
    const allTimeSql = `
      SELECT${TOKEN_SUM_COLUMNS}
      FROM conversation_turns
      WHERE ${costRowPredicate()}
    `;
    const allTimeResult = await query(allTimeSql, []);

    res.json(
      envelope(
        {
          period: toBreakdown(periodResult.rows[0] as Record<string, unknown> | undefined),
          allTime: toBreakdown(allTimeResult.rows[0] as Record<string, unknown> | undefined),
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
