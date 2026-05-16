/**
 * @module utils/sqlPredicates
 *
 * Shared SQL row-inclusion predicates used by multiple query paths so the
 * populations they aggregate over cannot drift. Mirrors the
 * pricing.ts `buildRateCaseSql()` / `buildCacheSavingsRateCaseSql()` SSOT
 * pattern: the SQL fragment is generated in exactly one place and every
 * consumer (CLI analyzers, dashboard routes) imports the same emitter.
 *
 * The dashboard side imports this file directly via cross-tree relative
 * path (`../../../../src/utils/sqlPredicates.js`), the same precedent
 * pricing.ts established.
 */
/* eslint-disable -- SSOT generator; intentionally minimal, no surrounding code. */

/**
 * Canonical predicate for "cost-bearing assistant turns".
 *
 * Reference: v_daily_cost in sql/views.sql, whose WHERE clause is
 *   ct.role = 'assistant'
 *     AND ct.model IS NOT NULL
 *     AND ct.model <> '<synthetic>'
 * — every assistant turn except the `<synthetic>` placeholder model and the
 * vanishingly-few NULL-model rows. The dashboard `/api/cost/*` routes, the
 * CLI `CostAnalyzer`, and `TokenAnalyzer` all use this same predicate so
 * token / turn / cost counts reconcile across surfaces.
 *
 * Used by:
 *   - cost views (v_daily_cost) — the existing reference (NOT changed by
 *     this helper; the view stays the canonical spec).
 *   - activity views (post-LANE J / SEM2-297) — TimeSeriesAnalyzer and
 *     /api/activity/{hourly,daily,heatmap,trend} now AND in this predicate
 *     so the activity population matches the cost population. Before this,
 *     activity counted every role='assistant' row, which differed from
 *     v_daily_cost's population by up to ~5.8% per day on the live dataset.
 *
 * The fragment is a literal SQL string (no bind params), so adding it to a
 * WHERE clause does NOT shift any `$N` index in the surrounding query.
 *
 * @param alias - Table alias prefix for `conversation_turns` (default "ct").
 *   Pass "" for the bare-column form (`role = 'assistant' AND ...`).
 * @returns SQL fragment, parenthesised, safe to AND into a WHERE clause.
 */
export function costRowPredicateSql(alias: string = "ct"): string {
  const p = alias ? `${alias}.` : "";
  return `(${p}role = 'assistant' AND ${p}model <> '<synthetic>' AND ${p}model IS NOT NULL)`;
}
