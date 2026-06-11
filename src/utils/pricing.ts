/**
 * @module utils/pricing
 *
 * Anthropic model pricing for cost calculation from token counts.
 * Prices are per million tokens.
 *
 * SINGLE SOURCE OF TRUTH for per-model rates. The dashboard API SQL `CASE`
 * expressions in `dashboard/src/server/routes/cost.ts` and
 * `dashboard/src/server/routes/cache.ts` are GENERATED from `PRICING` below
 * via `buildRateCaseSql()` / `getPricingEntries()` — they must never be
 * hand-maintained again, so `pricing.ts` and the SQL can no longer drift.
 *
 * IMPORTANT — stored-cost backfill rule:
 *   `conversation_turns.cost_usd` is computed at ingest time by
 *   `calculateCost()` and STORED. Editing the rates here does NOT retroactively
 *   correct already-ingested rows. Any rate change MUST be followed by running
 *   `scripts/backfill-costs.mjs`, which recomputes the stored `cost_usd` and
 *   `sessions.total_cost_usd` columns in place. See COST-002.
 */

/** Per-million-token pricing for a model. */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheCreationPerM: number;
  cacheReadPerM: number;
}

/**
 * Pricing table for known Anthropic models (USD per million tokens).
 * Keys are matched as prefixes against the lowercased model ID; the FIRST
 * matching prefix wins, so more-specific prefixes MUST come before broader
 * ones (e.g. `claude-opus-4-7` before `claude-opus-4`).
 *
 * Rates verified against the official Anthropic pricing table
 * (platform.claude.com/docs/en/about-claude/pricing, June 2026):
 *   Fable 5 / Mythos 5         = 10 / 50 / 12.5 / 1.0
 *   Opus 4.5 / 4.6 / 4.7 / 4.8 = 5 / 25 / 6.25 / 0.5
 *   Opus 4 family (4.0 / 4.1)  = 15 / 75 / 18.75 / 1.5
 *   Sonnet 4.x                 = 3 / 15 / 3.75 / 0.3
 *   Haiku 4.5                  = 1 / 5 / 1.25 / 0.1
 * cache-write = 1.25x input and cache-read = 0.1x input for every entry.
 */
const PRICING: [string, ModelPricing][] = [
  // Claude 5 family — Fable 5 is the generally-available id; Mythos 5 is the
  // same model + rates via Project Glasswing. $10/$50 per MTok (above Opus-tier).
  ["claude-fable-5", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheReadPerM: 1 }],
  ["claude-mythos-5", { inputPerM: 10, outputPerM: 50, cacheCreationPerM: 12.5, cacheReadPerM: 1 }],
  // Claude 4 family — specific models before broader prefixes (first match wins)
  ["claude-opus-4-5", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4-6", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  // claude-opus-4-7 / claude-opus-4-8: official rates 5/25/6.25/0.5. They MUST
  // precede the broad "claude-opus-4" prefix below, otherwise they fall through
  // to the Opus-4 ($15/$75/...) rates and are overcharged 3x (COST-001 for 4.7;
  // COST-008 found claude-opus-4-8 with exactly this fallthrough).
  ["claude-opus-4-7", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4-8", { inputPerM: 5, outputPerM: 25, cacheCreationPerM: 6.25, cacheReadPerM: 0.5 }],
  ["claude-opus-4", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheReadPerM: 1.5 }],
  // Sonnet 4.x — claude-sonnet-4-5 / -4-6 / -4-7 all resolve here via the
  // broad "claude-sonnet-4" prefix (rates are identical across the 4.x line).
  // An explicit claude-sonnet-4-6 entry is listed so a model present in the DB
  // has an exact, intentional entry rather than resolving by accident.
  ["claude-sonnet-4-6", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-sonnet-4", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-haiku-4-5", { inputPerM: 1, outputPerM: 5, cacheCreationPerM: 1.25, cacheReadPerM: 0.1 }],
  // NOTE: there is no public "claude-haiku-4-x" model that is not 4.5
  // (Haiku 4 shipped as 4.5), so the broad "claude-haiku-4" catch-all entry
  // was removed (COST-006) — a hypothetical future haiku-4.x now hits
  // DEFAULT_PRICING and is surfaced by reportUnknownModels() (COST-007)
  // rather than being silently priced with a guessed rate.
  // Claude 3.7 family
  ["claude-3-7-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  // Claude 3.5 family
  ["claude-3-5-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-3-5-haiku", { inputPerM: 0.8, outputPerM: 4, cacheCreationPerM: 1, cacheReadPerM: 0.08 }],
  // Claude 3 family
  ["claude-3-opus", { inputPerM: 15, outputPerM: 75, cacheCreationPerM: 18.75, cacheReadPerM: 1.5 }],
  ["claude-3-sonnet", { inputPerM: 3, outputPerM: 15, cacheCreationPerM: 3.75, cacheReadPerM: 0.3 }],
  ["claude-3-haiku", { inputPerM: 0.25, outputPerM: 1.25, cacheCreationPerM: 0.3, cacheReadPerM: 0.03 }],
];

/** Default pricing when model is unknown (uses Sonnet rates). */
const DEFAULT_PRICING: ModelPricing = {
  inputPerM: 3,
  outputPerM: 15,
  cacheCreationPerM: 3.75,
  cacheReadPerM: 0.3,
};

/** Rate field of {@link ModelPricing} — used to generate per-category SQL CASE. */
export type PricingRateKey = keyof ModelPricing;

/**
 * Return the full prefix→pricing table (read-only copy).
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
 * generator the dashboard cost/cache routes use so the SQL rate tables can
 * never drift from `pricing.ts`.
 *
 * The prefix order of `PRICING` is preserved (first match wins), which mirrors
 * `getPricing()` exactly. The `ELSE` arm uses {@link DEFAULT_PRICING}.
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
    ([prefix, pricing]) =>
      `    WHEN ${modelColumn} LIKE '${prefix}%' THEN ${pricing[rateKey]}`,
  );
  return `CASE\n${lines.join("\n")}\n    ELSE ${DEFAULT_PRICING[rateKey]}\n  END`;
}

/**
 * Build a SQL `CASE` expression for the per-MTok *cache-read savings rate* of
 * a model: the dollars saved per million tokens by reading from cache instead
 * of paying the full input price, i.e. `inputPerM - cacheReadPerM`.
 *
 * Derived from {@link PRICING} so the dashboard cache route can never drift
 * (COST-001 — claude-opus-4-7 is covered automatically). The `ELSE` arm uses
 * {@link DEFAULT_PRICING}.
 *
 * NOTE (framing, MAX-004 — out of scope here): this is an *API-list-price*
 * savings figure; a flat-subscription user does not realize these dollars.
 *
 * @param modelColumn - SQL column/expression holding the model id (default "model")
 * @returns A SQL `CASE ... END` string
 */
export function buildCacheSavingsRateCaseSql(modelColumn = "model"): string {
  const lines = PRICING.map(
    ([prefix, pricing]) =>
      `    WHEN ${modelColumn} LIKE '${prefix}%' THEN ${
        pricing.inputPerM - pricing.cacheReadPerM
      }`,
  );
  return `CASE\n${lines.join("\n")}\n    ELSE ${
    DEFAULT_PRICING.inputPerM - DEFAULT_PRICING.cacheReadPerM
  }\n  END`;
}

/**
 * Look up pricing for a model by prefix matching.
 */
export function getPricing(model: string | null | undefined): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of PRICING) {
    if (lower.startsWith(prefix)) {
      return pricing;
    }
  }
  return DEFAULT_PRICING;
}

/**
 * Whether a model id matches a known pricing prefix exactly (i.e. does NOT
 * fall through to {@link DEFAULT_PRICING}). Used by diagnostics to surface
 * models that are being priced at the Sonnet default — the exact failure
 * mode that hid the claude-opus-4-7 mispricing (COST-007).
 */
export function hasKnownPricing(model: string | null | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return PRICING.some(([prefix]) => lower.startsWith(prefix));
}

/**
 * Inspect a set of model ids and warn (once) about any that have no exact
 * pricing entry and therefore fall through to DEFAULT_PRICING. Intended to be
 * called once per ingest run with the distinct models seen in the batch.
 *
 * Returns the list of unknown model ids so callers can also assert/test on it.
 * The "<synthetic>" placeholder model is treated as expected and not warned.
 *
 * @param models - Iterable of model ids encountered during ingestion
 * @param warn - Sink for the warning line (default: console.warn)
 */
export function reportUnknownModels(
  models: Iterable<string | null | undefined>,
  warn: (msg: string) => void = console.warn,
): string[] {
  const unknown = new Set<string>();
  for (const m of models) {
    if (!m) continue;
    if (m === "<synthetic>") continue;
    if (!hasKnownPricing(m)) {
      unknown.add(m);
    }
  }
  const list = [...unknown].sort();
  if (list.length > 0) {
    warn(
      `[pricing] ${list.length} model id(s) have no exact pricing entry and ` +
        `were priced at DEFAULT (Sonnet) rates — costs for these may be wrong: ` +
        `${list.join(", ")}. Add them to PRICING in src/utils/pricing.ts and ` +
        `re-run scripts/backfill-costs.mjs.`,
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
