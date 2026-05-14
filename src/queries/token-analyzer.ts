/**
 * @module queries/token-analyzer
 *
 * F1 — Total Tokens KPI.
 *
 * Token-count aggregation over `conversation_turns`. Deliberately mirrors
 * `CostAnalyzer` (same `costRowPredicate()`, same `buildTurnFilters` plumbing)
 * so the Total Tokens KPI reconciles 1:1 with Total Cost — both aggregate the
 * exact same row population.
 */

import type { TimeRange, TokenBreakdown, TokenTotals, QueryFilters } from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildTurnFilters } from "./filter-builder.js";

/**
 * Canonical row-inclusion predicate for token aggregation (F1 / D6).
 *
 * The SAME predicate `costRowPredicate()` uses in `cost-analyzer.ts` and the
 * `/api/cost/*` routes — "real assistant turns", explicitly excluding only the
 * `<synthetic>` placeholder model (0 tokens, $0). F1 intentionally mirrors the
 * COST predicate (not the looser `v_session_summary` / `v_hourly_activity`
 * `assistant`-only predicate) so Total Tokens reconciles with Total Cost.
 *
 * @param alias - Table alias for conversation_turns ("" for the bare column form)
 */
function costRowPredicate(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `${p}role = 'assistant' AND ${p}model IS NOT NULL AND ${p}model <> '<synthetic>'`;
}

/** Raw aggregate row shape returned by both token SELECTs. */
interface TokenAggregateRow {
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

/** Map a raw aggregate row (or `undefined` for an empty result) to a breakdown. */
function toBreakdown(row: TokenAggregateRow | undefined): TokenBreakdown {
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

/** The four SUM columns, identical for the period and all-time queries. */
const TOKEN_SUM_COLUMNS = `
    COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(cache_creation_tokens), 0) AS cache_write_tokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
    COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens`;

/**
 * Analyzes token totals from the conversation_turns fact table.
 *
 * The CLI counterpart of the `/api/tokens/total` route — `query tokens` and
 * `dashboard` both consume `getTotalTokens`, so the route and the analyzer must
 * stay in lock-step.
 */
export class TokenAnalyzer {
  constructor(private executor: QueryExecutor) {}

  /**
   * Get the Total Tokens breakdown for a period plus the unfiltered all-time
   * grand total.
   *
   * Two separate aggregates (clearer than a single CTE, and matches how the
   * codebase already does multi-query routes):
   *   1. **period** — `timestamp >= $1 AND timestamp < $2` plus the active
   *      model/project filters.
   *   2. **allTime** — the same `costRowPredicate()`, but NO timestamp bound and
   *      NO filters (D7). A pure, dataset-wide constant.
   *
   * @param range - Time range for the period block
   * @param filters - Optional model/project filters (applied to the period block only)
   * @returns `{ period, allTime }` token breakdowns
   */
  async getTotalTokens(range: TimeRange, filters?: QueryFilters): Promise<TokenTotals> {
    // 1. Period block — filtered, time-bounded.
    const f = buildTurnFilters(filters, 3);
    const periodSql = `
      SELECT${TOKEN_SUM_COLUMNS}
      FROM conversation_turns
      WHERE ${costRowPredicate()}
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
    `;
    const periodResult = await this.executor.query<TokenAggregateRow>(periodSql, [
      range.start,
      range.end,
      ...f.params,
    ]);

    // 2. All-time block — fully unfiltered, dataset-wide (D7).
    const allTimeSql = `
      SELECT${TOKEN_SUM_COLUMNS}
      FROM conversation_turns
      WHERE ${costRowPredicate()}
    `;
    const allTimeResult = await this.executor.query<TokenAggregateRow>(allTimeSql);

    return {
      period: toBreakdown(periodResult.rows[0]),
      allTime: toBreakdown(allTimeResult.rows[0]),
    };
  }
}

/**
 * Convenience wrapper — construct a `TokenAnalyzer` and run `getTotalTokens` in
 * one call. Mirrors the ergonomics expected of the F1 query surface.
 *
 * @param executor - An active QueryExecutor
 * @param range - Time range for the period block
 * @param filters - Optional model/project filters
 * @returns `{ period, allTime }` token breakdowns
 */
export async function getTotalTokens(
  executor: QueryExecutor,
  range: TimeRange,
  filters?: QueryFilters,
): Promise<TokenTotals> {
  return new TokenAnalyzer(executor).getTotalTokens(range, filters);
}
