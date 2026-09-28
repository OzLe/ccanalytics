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
  cacheCreationPerM: number;
  cacheReadPerM: number;
}

/**
 * Pricing table for known Anthropic models (USD per million tokens), keyed by
 * normalized model id (see {@link normalizeModelId}).
 *
 * Rates verified against the official Anthropic pricing table
 * (platform.claude.com/docs/en/about-claude/pricing) on 2026-09-28. Cache
 * writes here are 5-minute writes, 1.25x input. Cache reads are 0.1x input
 * except on Opus 5.5 (0.05x) and Fable 5.1 / Mythos 5.1 (0.025x).
 */
const PRICING: [string, ModelPricing][] = [
  // Claude 5 family. Mythos is the Project Glasswing twin of Fable: same rates.
  ["claude-fable-5-1", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheReadPerM: 0.25 }],
  ["claude-mythos-5-1", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheReadPerM: 0.25 }],
  ["claude-fable-5", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheReadPerM: 1 }],
  ["claude-mythos-5", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheReadPerM: 1 }],
  ["claude-opus-5-5", { inputPerM: 4, outputPerM: 20, cacheCreationPerM: 5, cacheReadPerM: 0.2 }],
  ["claude-opus-5", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  // Sonnet 5's $2/$10 launch price became its standard price; the rise to
  // $3/$15 announced for 2026-09-01 was cancelled.
  ["claude-sonnet-5", { inputPerM: 2, outputPerM: 10, cacheCreationPerM: 2.5, cacheReadPerM: 0.2 }],
  // Claude 4 family
  ["claude-opus-4-8", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4-7", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4-6", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4-5", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4-1", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheReadPerM: 1.5 }],
  ["claude-opus-4", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheReadPerM: 1.5 }],
  ["claude-sonnet-4-6", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-sonnet-4-5", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-sonnet-4", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  // Haiku 4 shipped only as 4.5; a future haiku-4.x is reported, not guessed (COST-006).
  ["claude-haiku-4-5", { inputPerM: 1, outputPerM: 5, cacheCreationPerM: 1.25, cacheReadPerM: 0.1 }],
  // Claude 3.x
  ["claude-3-7-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-3-5-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-3-5-haiku", { inputPerM: 0.8, outputPerM: 4, cacheCreationPerM: 1, cacheReadPerM: 0.08 }],
  ["claude-3-opus", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheReadPerM: 1.5 }],
  ["claude-3-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-3-haiku", { inputPerM: 0.25, outputPerM: 1.25, cacheCreationPerM: 0.3, cacheReadPerM: 0.03 }],
];

const PRICING_BY_ID = new Map(PRICING);

/** Default pricing when model is unknown (uses Sonnet 4.x rates). */
const DEFAULT_PRICING: ModelPricing = {
  inputPerM: 3,
  outputPerM: 15,
  cacheCreationPerM: 3.75,
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
 * Build a SQL `CASE` expression that maps a model column to its per-MTok rate
 * for one pricing category, derived from {@link PRICING}. This is the single
 * generator the dashboard cost/cache routes and the backfill use, so the SQL
 * rate tables can never drift from `pricing.ts`.
 *
 * The column is normalized like {@link getPricing} does; the `ELSE` arm uses
 * {@link DEFAULT_PRICING}, as does a NULL model.
 *
 * @param rateKey - Which rate to emit (inputPerM, outputPerM, ...)
 * @param modelColumn - SQL column/expression holding the model id (default "model")
 * @returns A SQL `CASE ... END` string
 */
export function buildRateCaseSql(
  rateKey: PricingRateKey,
  modelColumn = "model",
): string {
  const lines = PRICING.map(
    ([id, pricing]) => `    WHEN '${id}' THEN ${pricing[rateKey]}`,
  );
  return `CASE ${normalizedModelSql(modelColumn)}\n${lines.join("\n")}\n    ELSE ${DEFAULT_PRICING[rateKey]}\n  END`;
}

/**
 * Build a SQL `CASE` expression for the per-MTok *cache-read savings rate* of
 * a model: the dollars saved per million tokens by reading from cache instead
 * of paying the full input price, i.e. `inputPerM - cacheReadPerM`.
 *
 * Derived from {@link PRICING} so the dashboard cache route can never drift
 * (COST-001). The `ELSE` arm uses {@link DEFAULT_PRICING}.
 *
 * NOTE (framing, MAX-004 — out of scope here): this is an *API-list-price*
 * savings figure; a flat-subscription user does not realize these dollars.
 *
 * @param modelColumn - SQL column/expression holding the model id (default "model")
 * @returns A SQL `CASE ... END` string
 */
export function buildCacheSavingsRateCaseSql(modelColumn = "model"): string {
  const lines = PRICING.map(
    ([id, pricing]) =>
      `    WHEN '${id}' THEN ${pricing.inputPerM - pricing.cacheReadPerM}`,
  );
  return `CASE ${normalizedModelSql(modelColumn)}\n${lines.join("\n")}\n    ELSE ${
    DEFAULT_PRICING.inputPerM - DEFAULT_PRICING.cacheReadPerM
  }\n  END`;
}

/**
 * Look up pricing for a model; unknown and missing ids get DEFAULT_PRICING.
 */
export function getPricing(model: string | null | undefined): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  return PRICING_BY_ID.get(normalizeModelId(model)) ?? DEFAULT_PRICING;
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
 * Calculate cost in USD from token counts and model.
 *
 * @param model - Model identifier (e.g. "claude-sonnet-4-20250514")
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param cacheCreationTokens - Number of cache creation tokens
 * @param cacheReadTokens - Number of cache read tokens
 * @returns Cost in USD
 */
export function calculateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const p = getPricing(model);
  return (
    (inputTokens * p.inputPerM) / 1_000_000 +
    (outputTokens * p.outputPerM) / 1_000_000 +
    (cacheCreationTokens * p.cacheCreationPerM) / 1_000_000 +
    (cacheReadTokens * p.cacheReadPerM) / 1_000_000
  );
}
