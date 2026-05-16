/**
 * @module utils/tokenSums
 *
 * Canonical SQL SUM expressions for the token-aggregation surfaces.
 *
 * SINGLE SOURCE OF TRUTH for how a "total tokens" column is computed across
 * the CLI analyzers, dashboard routes, and analytical views. Mirrors the
 * `buildRateCaseSql()` pattern in `pricing.ts`: callers import these strings
 * verbatim into their SQL so the four formulas that previously drifted
 * (~294x gap between `/api/activity/hourly` and `/api/tokens/total` on the
 * live dataset, SEM2-288 / SEM2-289 / SEM2-296) cannot drift again.
 *
 * Two SUMs are surfaced and explicitly named so consumers cannot accidentally
 * conflate them:
 *
 *   - `totalTokensSql`         = `SUM(input + output)`. The CANONICAL HEADLINE
 *     ("Tokens In/Out"). Matches Anthropic's API shape: the API has no
 *     `total_tokens` field; it bills per-category at four different rates, and
 *     no Anthropic surface publishes a 4-way sum. Same shape `/api/cost/total`
 *     reconciles against.
 *
 *   - `contextVolumeTokensSql` = `SUM(input + output + cache_creation + cache_read)`.
 *     A SECONDARY, well-labeled metric ("Context Volume"). It honestly
 *     surfaces the cache-replay signal — on the live dataset this is ~98%
 *     `cache_read`, i.e. it is a "context replay" indicator, not an actual
 *     work measure. Kept because it carries real information (model context
 *     processed including cached prompt replay) that the headline elides.
 *
 * The four per-category SUMs are also exported so any consumer that needs
 * them (the In/Out subtitle, the cache hit-rate route) reads them from the
 * same single place.
 */

/**
 * SQL SUM expressions for token aggregation.
 *
 * Each value is a complete SQL expression (a `COALESCE(SUM(...), 0)`) intended
 * to be interpolated as a SELECT column. They are bare-column form (no table
 * alias); if the surrounding query needs a `ct.` prefix on the columns, the
 * caller is responsible for that — same convention as the existing
 * `dashboard/src/server/routes/activity.ts` aliased queries.
 */
export interface TokenSumSql {
  /**
   * Canonical headline `total_tokens` — Anthropic-API style 2-way sum
   * (input + output). What `/api/cost/total` reconciles against; what the
   * dashboard's "Tokens In/Out" KPI surfaces.
   */
  totalTokensSql: string;
  /**
   * Secondary `context_volume_tokens` — 4-way sum
   * (input + output + cache_creation + cache_read). The model-processed
   * volume INCLUDING cached prompt replay. Surfaced as a "Context Volume"
   * card so the cache-replay signal is not lost, but never the headline.
   */
  contextVolumeTokensSql: string;
  /** `SUM(input_tokens)` — the In side of the headline. */
  inputTokensSql: string;
  /** `SUM(output_tokens)` — the Out side of the headline. */
  outputTokensSql: string;
  /**
   * `SUM(cache_creation_tokens)` — surfaced as "cache write" across the rest
   * of the codebase (matches `CostBreakdown.totalCacheWriteTokens`).
   */
  cacheCreationTokensSql: string;
  /** `SUM(cache_read_tokens)` — the dominant component of `contextVolumeTokensSql`. */
  cacheReadTokensSql: string;
}

/**
 * Build the canonical set of token-SUM SQL expressions.
 *
 * The expressions are deliberately plain string literals (not template-driven)
 * so they are easy to grep for and impossible to misconfigure at the call site.
 *
 * @param alias - Optional table alias to prefix each column with (e.g. `"ct"`
 *   yields `ct.input_tokens`). Pass `""` (the default) for the bare-column
 *   form used by queries whose `FROM` clause has no alias on
 *   `conversation_turns`. Matches the alias-prefix convention of
 *   `costRowPredicateSql()` in `sqlPredicates.ts`.
 * @returns A frozen {@link TokenSumSql} record of SUM expressions.
 */
export function buildTokenSumSql(alias: string = ""): TokenSumSql {
  const prefix = alias ? `${alias}.` : "";
  return Object.freeze({
    // Canonical headline — Anthropic-API style. The 2-way sum the cost
    // population reconciles against (TOK-001).
    totalTokensSql: `COALESCE(SUM(${prefix}input_tokens + ${prefix}output_tokens), 0)`,
    // 4-way "context volume" — what the model processed including cache
    // replay. Kept and surfaced as a SECONDARY metric (TOK-002).
    contextVolumeTokensSql: `COALESCE(SUM(${prefix}input_tokens + ${prefix}output_tokens + ${prefix}cache_creation_tokens + ${prefix}cache_read_tokens), 0)`,
    // Per-category SUMs — exported so any consumer (the In/Out subtitle,
    // the cache hit-rate route) reads them from the same single place.
    inputTokensSql: `COALESCE(SUM(${prefix}input_tokens), 0)`,
    outputTokensSql: `COALESCE(SUM(${prefix}output_tokens), 0)`,
    cacheCreationTokensSql: `COALESCE(SUM(${prefix}cache_creation_tokens), 0)`,
    cacheReadTokensSql: `COALESCE(SUM(${prefix}cache_read_tokens), 0)`,
  });
}
