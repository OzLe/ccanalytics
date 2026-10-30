/**
 * @module utils/pricing
 *
 * Anthropic model pricing for cost calculation from token counts.
 * Prices are per million tokens.
 *
 * SINGLE SOURCE OF TRUTH for per-model rates. The dashboard API SQL `CASE`
 * expressions in `dashboard/src/server/routes/cost.ts` and
 * `dashboard/src/server/routes/cache.ts`, and the cost backfill in
 * `src/db/cost-backfill.ts`, are GENERATED from `PRICING` below via
 * `buildRateCaseSql()` — they must never be hand-maintained again, so
 * `pricing.ts` and the SQL can no longer drift.
 *
 * MATCHING: a model id matches an entry EXACTLY after normalization — lowercased,
 * with a trailing release date removed (`claude-haiku-4-5-20251001` →
 * `claude-haiku-4-5`). Prefix matching let a new point release inherit a
 * sibling's rates without any warning: Fable 5.1 took Fable 5's $1 cache read
 * instead of $0.25. Every id now needs its own entry; one without is priced at
 * DEFAULT_PRICING and reported by `reportUnknownModels()`, `/api/health` and
 * `npm run check:pricing`.
 *
 * IMPORTANT — stored-cost backfill rule:
 *   `conversation_turns.cost_usd` and `sub_agents.cost_usd` are computed at
 *   ingest time by `calculateCost()` and STORED. Editing the rates here does
 *   NOT retroactively correct already-ingested rows. Any rate change MUST be
 *   followed by `npm run backfill:costs` (`scripts/backfill-costs.ts`), which
 *   recomputes the stored cost columns in place. See COST-002.
 */

/** Per-million-token pricing for a model. */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  /** Writing to the 5-minute prompt cache. */
  cacheCreationPerM: number;
  /** Writing to the 1-hour prompt cache. */
  cacheWrite1hPerM: number;
  cacheReadPerM: number;
}

/**
 * How to price cache writes whose transcript does not record the 5-minute /
 * 1-hour split (`usage.cache_creation`, absent from older transcripts).
 * Claude Code caches the main conversation for 1 hour and sub-agents for 5
 * minutes — every recorded write on 2026-09-28 followed that — so main-thread
 * rows use "1h" (decision D1) and sub-agent rows "5m".
 */
export type UnrecordedCacheTtl = "1h" | "5m";

/**
 * Pricing table for known Anthropic models (USD per million tokens), keyed by
 * normalized model id (see {@link normalizeModelId}).
 *
 * Rates verified against the official Anthropic pricing table
 * (platform.claude.com/docs/en/about-claude/pricing) on 2026-10-30. Cache
 * writes cost 1.25x input for the 5-minute cache and 2x input for the 1-hour
 * cache. Cache reads are 0.1x input except on Opus 5.5 / Sonnet 5.5 (0.05x)
 * and Fable 5.1 / Mythos 5.1 (0.025x).
 *
 * A model priced by prompt length (Haiku 5.5) has its short-prompt rates here
 * and its long-prompt rates in {@link LONG_PROMPT_PRICING}.
 */
const PRICING: [string, ModelPricing][] = [
  // Claude 5 family. Mythos is the Project Glasswing twin of Fable: same rates.
  ["claude-fable-5-1", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheWrite1hPerM: 20, cacheReadPerM: 0.25 }],
  ["claude-mythos-5-1", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheWrite1hPerM: 20, cacheReadPerM: 0.25 }],
  ["claude-fable-5", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheWrite1hPerM: 20, cacheReadPerM: 1 }],
  ["claude-mythos-5", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheWrite1hPerM: 20, cacheReadPerM: 1 }],
  ["claude-opus-5-5", { inputPerM: 4, outputPerM: 20, cacheCreationPerM: 5, cacheWrite1hPerM: 8, cacheReadPerM: 0.2 }],
  ["claude-opus-5", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheWrite1hPerM: 10, cacheReadPerM: 0.5 }],
  ["claude-sonnet-5-5", { inputPerM: 2, outputPerM: 10, cacheCreationPerM: 2.5, cacheWrite1hPerM: 4, cacheReadPerM: 0.1 }],
  // Sonnet 5's $2/$10 launch price became its standard price; the rise to
  // $3/$15 announced for 2026-09-01 was cancelled.
  ["claude-sonnet-5", { inputPerM: 2, outputPerM: 10, cacheCreationPerM: 2.5, cacheWrite1hPerM: 4, cacheReadPerM: 0.2 }],
  // Prompts up to 100K tokens; longer prompts are in LONG_PROMPT_PRICING.
  ["claude-haiku-5-5", { inputPerM: 0.1, outputPerM: 0.5, cacheCreationPerM: 0.125, cacheWrite1hPerM: 0.2, cacheReadPerM: 0.01 }],
  // Claude 4 family
  ["claude-opus-4-8", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheWrite1hPerM: 10, cacheReadPerM: 0.5 }],
  ["claude-opus-4-7", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheWrite1hPerM: 10, cacheReadPerM: 0.5 }],
  ["claude-opus-4-6", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheWrite1hPerM: 10, cacheReadPerM: 0.5 }],
  ["claude-opus-4-5", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheWrite1hPerM: 10, cacheReadPerM: 0.5 }],
  ["claude-opus-4-1", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheWrite1hPerM: 30, cacheReadPerM: 1.5 }],
  ["claude-opus-4", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheWrite1hPerM: 30, cacheReadPerM: 1.5 }],
  ["claude-sonnet-4-6", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheWrite1hPerM: 6, cacheReadPerM: 0.3 }],
  ["claude-sonnet-4-5", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheWrite1hPerM: 6, cacheReadPerM: 0.3 }],
  ["claude-sonnet-4", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheWrite1hPerM: 6, cacheReadPerM: 0.3 }],
  // Haiku 4 shipped only as 4.5; a future haiku-4.x is reported, not guessed (COST-006).
  ["claude-haiku-4-5", { inputPerM: 1, outputPerM: 5, cacheCreationPerM: 1.25, cacheWrite1hPerM: 2, cacheReadPerM: 0.1 }],
  // Claude 3.x
  ["claude-3-7-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheWrite1hPerM: 6, cacheReadPerM: 0.3 }],
  ["claude-3-5-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheWrite1hPerM: 6, cacheReadPerM: 0.3 }],
  ["claude-3-5-haiku", { inputPerM: 0.8, outputPerM: 4, cacheCreationPerM: 1, cacheWrite1hPerM: 1.6, cacheReadPerM: 0.08 }],
  ["claude-3-opus", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheWrite1hPerM: 30, cacheReadPerM: 1.5 }],
  ["claude-3-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheWrite1hPerM: 6, cacheReadPerM: 0.3 }],
  ["claude-3-haiku", { inputPerM: 0.25, outputPerM: 1.25, cacheCreationPerM: 0.3, cacheWrite1hPerM: 0.5, cacheReadPerM: 0.03 }],
];

const PRICING_BY_ID = new Map(PRICING);

/** Higher rates a model charges for a request whose prompt is long. */
interface LongPromptPricing {
  /** A prompt of more than this many tokens pays `pricing`. */
  overTokens: number;
  pricing: ModelPricing;
}

/**
 * Models priced by prompt length, keyed like {@link PRICING} (which holds
 * their short-prompt rates). A request's prompt length counts all its input:
 * `input_tokens + cache_creation_tokens + cache_read_tokens`. A request over
 * the threshold pays the higher rates for ALL its tokens, output included,
 * and each request is priced on its own — so the tier can only be chosen per
 * turn, never from summed tokens.
 */
const LONG_PROMPT_PRICING = new Map<string, LongPromptPricing>([
  ["claude-haiku-5-5", {
    overTokens: 100_000,
    pricing: { inputPerM: 0.5, outputPerM: 2.5, cacheCreationPerM: 0.625, cacheWrite1hPerM: 1, cacheReadPerM: 0.05 },
  }],
]);

/** Default pricing when model is unknown (uses Sonnet 4.x rates). */
const DEFAULT_PRICING: ModelPricing = {
  inputPerM: 3,
  outputPerM: 15,
  cacheCreationPerM: 3.75,
  cacheWrite1hPerM: 6,
  cacheReadPerM: 0.3,
};

/** Rate field of {@link ModelPricing} — used to generate per-category SQL CASE. */
export type PricingRateKey = keyof ModelPricing;

/**
 * Normalize a model id for pricing lookup: lowercase, and drop a trailing
 * `-YYYYMMDD` release date (`claude-opus-4-5-20251101` → `claude-opus-4-5`).
 */
export function normalizeModelId(model: string): string {
  return model.toLowerCase().replace(/-\d{8}$/, "");
}

/** SQL twin of {@link normalizeModelId} for a model column. */
export function normalizedModelSql(modelColumn = "model"): string {
  return `regexp_replace(lower(${modelColumn}), '-[0-9]{8}$', '')`;
}

/**
 * Return the full id→pricing table (read-only copy).
 * Consumers that need to generate SQL or audit coverage use this so the
 * table is defined in exactly one place.
 */
export function getPricingEntries(): ReadonlyArray<readonly [string, ModelPricing]> {
  return PRICING;
}

/** Return the default (Sonnet) pricing used for unmatched models. */
export function getDefaultPricing(): ModelPricing {
  return DEFAULT_PRICING;
}

/**
 * The model ids priced by prompt length. Their cost can only be computed per
 * request, so a recompute from summed tokens must skip them.
 */
export function promptLengthPricedModels(): string[] {
  return [...LONG_PROMPT_PRICING.keys()];
}

/**
 * SQL for one row's prompt length — all its input, cached or not — as
 * {@link calculateCost} measures it for {@link LONG_PROMPT_PRICING}.
 *
 * @param prefix - Table alias with its dot, e.g. "ct." (default none)
 */
export function promptTokensSql(prefix = ""): string {
  return (
    `(COALESCE(${prefix}input_tokens, 0) + COALESCE(${prefix}cache_creation_tokens, 0)` +
    ` + COALESCE(${prefix}cache_read_tokens, 0))`
  );
}

/**
 * Shared generator for the per-model SQL `CASE` expressions: one `WHEN` per
 * {@link PRICING} entry, a nested prompt-length `CASE` for the models in
 * {@link LONG_PROMPT_PRICING}, and {@link DEFAULT_PRICING} in the `ELSE` arm.
 */
function buildPricingCaseSql(value: (p: ModelPricing) => number, prefix: string): string {
  const lines = PRICING.map(([id, pricing]) => {
    const long = LONG_PROMPT_PRICING.get(id);
    const rate = long
      ? `CASE WHEN ${promptTokensSql(prefix)} > ${long.overTokens} THEN ${value(long.pricing)} ELSE ${value(pricing)} END`
      : `${value(pricing)}`;
    return `    WHEN '${id}' THEN ${rate}`;
  });
  return `CASE ${normalizedModelSql(`${prefix}model`)}\n${lines.join("\n")}\n    ELSE ${value(DEFAULT_PRICING)}\n  END`;
}

/**
 * Build a SQL `CASE` expression that maps a row to its per-MTok rate for one
 * pricing category, derived from {@link PRICING} and
 * {@link LONG_PROMPT_PRICING}. This is the single generator the dashboard
 * cost/cache routes, the CLI analyzers and the backfill use, so the SQL rate
 * tables can never drift from `pricing.ts`.
 *
 * The model column is normalized like {@link getPricing} does; the `ELSE` arm
 * uses {@link DEFAULT_PRICING}, as does a NULL model. The rate is per request:
 * use it on a turn row (inside `SUM(...)` to aggregate), never on summed
 * tokens. The row needs `model`, `input_tokens`, `cache_creation_tokens` and
 * `cache_read_tokens` columns.
 *
 * @param rateKey - Which rate to emit (inputPerM, outputPerM, ...)
 * @param prefix - Table alias with its dot, e.g. "ct." (default none)
 * @returns A SQL `CASE ... END` string
 */
export function buildRateCaseSql(rateKey: PricingRateKey, prefix = ""): string {
  return buildPricingCaseSql((p) => p[rateKey], prefix);
}

/**
 * Build a SQL `CASE` expression for the per-MTok *cache-read savings rate* of
 * a row: the dollars saved per million tokens by reading from cache instead
 * of paying the full input price, i.e. `inputPerM - cacheReadPerM`.
 *
 * Derived like {@link buildRateCaseSql}, so the dashboard cache route can
 * never drift (COST-001), and per request like it.
 *
 * NOTE (framing, MAX-004 — out of scope here): this is an *API-list-price*
 * savings figure; a flat-subscription user does not realize these dollars.
 *
 * @param prefix - Table alias with its dot, e.g. "ct." (default none)
 * @returns A SQL `CASE ... END` string
 */
export function buildCacheSavingsRateCaseSql(prefix = ""): string {
  return buildPricingCaseSql((p) => p.inputPerM - p.cacheReadPerM, prefix);
}

/**
 * Build the SQL for one row's cache-write cost in USD: the 5-minute writes at
 * the 5-minute rate plus the 1-hour writes (`cache_creation_1h_tokens`) at the
 * 1-hour rate. A row whose split was not recorded (NULL) counts entirely as
 * `unrecordedAs`. The row needs the columns {@link buildRateCaseSql} needs,
 * plus `cache_creation_1h_tokens`.
 *
 * @param unrecordedAs - "1h" for main-thread rows, "5m" for sub-agent rows
 * @param prefix - Table alias with its dot, e.g. "ct." (default none)
 */
export function buildCacheWriteCostSql(
  unrecordedAs: UnrecordedCacheTtl,
  prefix = "",
): string {
  const total = `${prefix}cache_creation_tokens`;
  const oneHour = `COALESCE(${prefix}cache_creation_1h_tokens, ${unrecordedAs === "1h" ? total : "0"})`;
  return (
    `((${total} - ${oneHour}) * (${buildRateCaseSql("cacheCreationPerM", prefix)})` +
    ` + ${oneHour} * (${buildRateCaseSql("cacheWrite1hPerM", prefix)})) / 1000000.0`
  );
}

/**
 * Look up pricing for a model; unknown and missing ids get DEFAULT_PRICING.
 *
 * @param promptTokens - The request's prompt length (input + cache writes +
 *   cache reads); selects the long-prompt rates of a model in
 *   {@link LONG_PROMPT_PRICING}. Default 0: the short-prompt rates.
 */
export function getPricing(model: string | null | undefined, promptTokens = 0): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  const id = normalizeModelId(model);
  const long = LONG_PROMPT_PRICING.get(id);
  if (long && promptTokens > long.overTokens) return long.pricing;
  return PRICING_BY_ID.get(id) ?? DEFAULT_PRICING;
}

/**
 * Whether a model id has its own pricing entry (i.e. does NOT fall through to
 * {@link DEFAULT_PRICING}). Used by diagnostics to surface models that are
 * being priced at the Sonnet default — the failure mode that hid the
 * claude-opus-4-7 mispricing (COST-007).
 */
export function hasKnownPricing(model: string | null | undefined): boolean {
  if (!model) return false;
  return PRICING_BY_ID.has(normalizeModelId(model));
}

/**
 * The model ids in `models` that have no pricing entry, sorted and without
 * duplicates. Missing ids and the "<synthetic>" placeholder (0 tokens) are
 * expected and left out.
 */
export function unpricedModels(models: Iterable<string | null | undefined>): string[] {
  const unknown = new Set<string>();
  for (const m of models) {
    if (!m || m === "<synthetic>") continue;
    if (!hasKnownPricing(m)) unknown.add(m);
  }
  return [...unknown].sort();
}

/**
 * Inspect a set of model ids and warn (once) about any that have no pricing
 * entry and therefore fall through to DEFAULT_PRICING. Intended to be called
 * once per ingest run with the distinct models seen in the batch.
 *
 * Returns the list of unknown model ids so callers can also assert/test on it.
 *
 * @param models - Iterable of model ids encountered during ingestion
 * @param warn - Sink for the warning line (default: console.warn)
 */
export function reportUnknownModels(
  models: Iterable<string | null | undefined>,
  warn: (msg: string) => void = console.warn,
): string[] {
  const list = unpricedModels(models);
  if (list.length > 0) {
    warn(
      `[pricing] ${list.length} model id(s) have no pricing entry and ` +
        `were priced at DEFAULT (Sonnet) rates — costs for these may be wrong: ` +
        `${list.join(", ")}. Add them to PRICING in src/utils/pricing.ts and ` +
        `run \`npm run backfill:costs\`.`,
    );
  }
  return list;
}

/**
 * Cost in USD of `totalTokens` cache writes, `oneHourTokens` of them to the
 * 1-hour cache and the rest to the 5-minute cache.
 */
export function cacheWriteCost(
  pricing: ModelPricing,
  totalTokens: number,
  oneHourTokens: number,
): number {
  return (
    ((totalTokens - oneHourTokens) * pricing.cacheCreationPerM) / 1_000_000 +
    (oneHourTokens * pricing.cacheWrite1hPerM) / 1_000_000
  );
}

/**
 * Calculate cost in USD from token counts and model, for ONE request: a model
 * in {@link LONG_PROMPT_PRICING} is priced by this request's prompt length.
 *
 * @param model - Model identifier (e.g. "claude-sonnet-4-20250514")
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param cacheCreationTokens - Number of cache creation tokens (both caches)
 * @param cacheReadTokens - Number of cache read tokens
 * @param cacheCreation1hTokens - How many of the cache creation tokens went to
 *   the 1-hour cache; the rest are 5-minute writes
 * @returns Cost in USD
 */
export function calculateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  cacheCreation1hTokens = 0,
): number {
  const p = getPricing(model, inputTokens + cacheCreationTokens + cacheReadTokens);
  return (
    (inputTokens * p.inputPerM) / 1_000_000 +
    (outputTokens * p.outputPerM) / 1_000_000 +
    ((cacheCreationTokens - cacheCreation1hTokens) * p.cacheCreationPerM) / 1_000_000 +
    (cacheCreation1hTokens * p.cacheWrite1hPerM) / 1_000_000 +
    (cacheReadTokens * p.cacheReadPerM) / 1_000_000
  );
}
