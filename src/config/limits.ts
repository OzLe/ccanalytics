/**
 * @module config/limits
 *
 * Single source of truth for the ESTIMATED Claude rate-limit ceilings used by
 * the subscription-recommendation feature, modeled on the structure and
 * doc-comment style of {@link module:config/subscription}.
 *
 * Usage is metered the way Anthropic actually scales its 5h / weekly limits:
 * by **API-equivalent cost (`cost_usd`) per rolling window**, NOT by raw
 * request counts or raw token sums. `cost_usd` (computed at ingest from
 * src/utils/pricing.ts) already encodes per-model rates, output>input weighting,
 * cache-creation, and the cache-read discount — exactly the weighting the
 * published limits track. Raw token sums are ~97% cheap cache re-reads and
 * massively overstate consumption; request counts don't match token/cost
 * metering at all.
 *
 * IMPORTANT — these are ESTIMATES, not published limits. Claude Code's JSONL
 * does not log structured 5-hour / weekly limit-hit events, and Anthropic does
 * not publish exact per-tier dollar ceilings. Every recommendation surface
 * (CLI / API / UI) therefore carries {@link RECOMMENDATION_ESTIMATE_CAVEAT}.
 *
 * NOTE: this is presentation/analysis metadata only. Nothing here changes how
 * cost is computed — per-model rates live in src/utils/pricing.ts and tier
 * prices live in src/config/subscription.ts. The feature only READS the stored
 * conversation_turns.cost_usd column.
 *
 * The dashboard SERVER imports these runtime values directly across the tree
 * (the same precedent pricing.ts / sqlPredicates.ts established); the React UI
 * mirrors only the TYPES and receives all numeric ceilings through the API
 * payload (never hard-coded in React).
 */

import type { SubscriptionTier } from "../types/config.js";

/** Estimated rate-limit ceilings for one tier. ALL VALUES ARE ESTIMATES. */
export interface TierLimitCeilings {
  /**
   * Estimated API-equivalent cost (USD) allowed per rolling 5-hour window —
   * the metering-aligned unit (sums conversation_turns.cost_usd).
   */
  fiveHourCostUSD: number;
  /**
   * Estimated API-equivalent cost (USD) allowed per rolling 7-day window —
   * the metering-aligned unit (sums conversation_turns.cost_usd).
   */
  weeklyCostUSD: number;
}

/**
 * Heuristic count of active 5-hour windows in a week, used to derive the
 * weekly cost ceiling from the 5-hour cost ceiling
 * (`weeklyCostUSD ≈ fiveHourCostUSD × WEEKLY_WINDOWS_PER_WEEK`). ESTIMATE.
 */
export const WEEKLY_WINDOWS_PER_WEEK = 25;

/** Caveat string shown on EVERY recommendation surface (CLI/API/UI). */
export const RECOMMENDATION_ESTIMATE_CAVEAT =
  "Estimate from local session data; Anthropic's exact limits are not published.";

/**
 * Default per-tier ceilings, expressed in API-equivalent USD per rolling
 * window — the unit Anthropic's limits actually scale with. ESTIMATES scaled
 * 1× / 5× / 20× from a Pro base of $5 per 5-hour window:
 *   Pro     ≈ $5  / 5h
 *   Max 5x  ≈ $25 / 5h   (5×)
 *   Max 20x ≈ $100 / 5h  (20×)
 * Weekly ceilings = `fiveHourCostUSD × {@link WEEKLY_WINDOWS_PER_WEEK}`
 * (~25 active 5h windows/week heuristic).
 *
 * `none` is API pay-as-you-go: its ceilings are zero sentinels and are never
 * used as a fill% denominator (see {@link resolveCeilings} guard and the
 * neutral verdict in src/recommendation/engine.ts).
 */
export const DEFAULT_TIER_LIMITS: Record<SubscriptionTier, TierLimitCeilings> = {
  none: {
    fiveHourCostUSD: 0,
    weeklyCostUSD: 0,
  },
  pro: {
    fiveHourCostUSD: 5,
    weeklyCostUSD: 5 * WEEKLY_WINDOWS_PER_WEEK, // 125
  },
  "max-5x": {
    fiveHourCostUSD: 25,
    weeklyCostUSD: 25 * WEEKLY_WINDOWS_PER_WEEK, // 625
  },
  "max-20x": {
    fiveHourCostUSD: 100,
    weeklyCostUSD: 100 * WEEKLY_WINDOWS_PER_WEEK, // 2500
  },
};

/** Ordered paid tiers for up/downgrade neighbour lookup (excludes "none"). */
export const PAID_TIER_ORDER: SubscriptionTier[] = ["pro", "max-5x", "max-20x"];

/**
 * The two numeric cost dimensions of {@link TierLimitCeilings}, in stable
 * order. Used by override sanitization and auto-calibration so every consumer
 * walks the same dimension set.
 */
export const CEILING_DIMENSIONS: ReadonlyArray<keyof TierLimitCeilings> = [
  "fiveHourCostUSD",
  "weeklyCostUSD",
];

/**
 * Sparse per-tier ceiling overrides: any tier/dimension omitted falls back to
 * {@link DEFAULT_TIER_LIMITS}. Mirrors the `RecommendationConfig.ceilings`
 * shape so CLI and API can share one merge.
 */
export type TierLimitOverrides = Partial<
  Record<SubscriptionTier, Partial<TierLimitCeilings>>
>;

/**
 * Effective ceilings for a tier = {@link DEFAULT_TIER_LIMITS}`[tier]`
 * deep-merged with a sparse per-dimension override. Lives here so the CLI
 * analyzer and the dashboard API resolve ceilings identically (§4.3).
 *
 * Only finite, non-negative override values are honoured; anything else falls
 * back to the default for that dimension.
 *
 * @param tier - Subscription tier whose ceilings to resolve.
 * @param overrides - Sparse overrides (typically `config.recommendation.ceilings`).
 * @returns A fully-populated {@link TierLimitCeilings}.
 */
export function resolveCeilings(
  tier: SubscriptionTier,
  overrides?: TierLimitOverrides,
): TierLimitCeilings {
  const base = DEFAULT_TIER_LIMITS[tier];
  const tierOverride = overrides?.[tier];
  if (!tierOverride) {
    return { ...base };
  }
  const merged: TierLimitCeilings = { ...base };
  for (const dim of CEILING_DIMENSIONS) {
    const v = tierOverride[dim];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      merged[dim] = v;
    }
  }
  return merged;
}

/** Discriminates whether the active ceilings are the defaults or calibrated. */
export type CeilingSource = "default" | "calibrated";

/** Per-dimension flag set: `true` where auto-calibration raised the ceiling. */
export type CalibratedFlags = Record<keyof TierLimitCeilings, boolean>;

/** Observed raw peak costs used to auto-calibrate ceilings (§3.3). */
export interface ObservedPeaks {
  /** Max raw API-equivalent cost (USD) across 5-hour windows. */
  fiveHourCostUSD: number;
  /** Max raw API-equivalent cost (USD) across weekly windows. */
  weeklyCostUSD: number;
}

/** Result of {@link calibrateCeilings}: the active ceilings plus provenance. */
export interface CalibrationResult {
  /** The starting (override-resolved) default ceilings. */
  default: TierLimitCeilings;
  /** The ceilings actually used for fill% — raised to ≥ observed peaks. */
  calibrated: TierLimitCeilings;
  /** Per-dimension flag: did calibration raise this ceiling above default? */
  calibratedFlags: CalibratedFlags;
  /** "calibrated" if any dimension was raised, else "default". */
  ceilingSource: CeilingSource;
}

/**
 * Auto-calibration (§3.3, opt-in, default ON): raise each cost ceiling
 * dimension to **at least** the observed peak cost so a user who blows past the
 * published estimate is not pinned at a meaningless ">100%" fill.
 *
 * `calibrated[dim] = max(defaultCeilings[dim], observedPeaks[dim])`. A dimension
 * is flagged `calibrated: true` only when the observed peak strictly exceeds the
 * default ceiling. `ceilingSource` is `"calibrated"` if any dimension was
 * raised, else `"default"`.
 *
 * Pure and DB-free so the analyzer, API route, and unit tests share one rule.
 *
 * @param defaultCeilings - Override-resolved default ceilings.
 * @param peaks - Observed raw peak costs from window reconstruction.
 * @returns The default + calibrated ceilings and per-dimension provenance.
 */
export function calibrateCeilings(
  defaultCeilings: TierLimitCeilings,
  peaks: ObservedPeaks,
): CalibrationResult {
  const calibrated: TierLimitCeilings = { ...defaultCeilings };
  const calibratedFlags: CalibratedFlags = {
    fiveHourCostUSD: false,
    weeklyCostUSD: false,
  };
  let anyRaised = false;
  for (const dim of CEILING_DIMENSIONS) {
    const peak = peaks[dim];
    if (Number.isFinite(peak) && peak > defaultCeilings[dim]) {
      calibrated[dim] = peak;
      calibratedFlags[dim] = true;
      anyRaised = true;
    }
  }
  return {
    default: { ...defaultCeilings },
    calibrated,
    calibratedFlags,
    ceilingSource: anyRaised ? "calibrated" : "default",
  };
}
