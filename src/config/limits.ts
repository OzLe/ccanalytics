/**
 * @module config/limits
 *
 * Single source of truth for the ESTIMATED Claude rate-limit ceilings used by
 * the subscription-recommendation feature, modeled on the structure and
 * doc-comment style of {@link module:config/subscription}.
 *
 * IMPORTANT — these are ESTIMATES, not published limits. Claude Code's JSONL
 * does not log structured 5-hour / weekly limit-hit events, and Anthropic does
 * not publish exact per-tier message ceilings. Every recommendation surface
 * (CLI / API / UI) therefore carries {@link RECOMMENDATION_ESTIMATE_CAVEAT}.
 *
 * NOTE: this is presentation/analysis metadata only. Nothing here changes how
 * cost is computed — per-model rates live in src/utils/pricing.ts and tier
 * prices live in src/config/subscription.ts.
 *
 * The dashboard SERVER imports these runtime values directly across the tree
 * (the same precedent pricing.ts / sqlPredicates.ts established); the React UI
 * mirrors only the TYPES and receives all numeric ceilings through the API
 * payload (never hard-coded in React).
 */

import type { SubscriptionTier } from "../types/config.js";

/** Estimated rate-limit ceilings for one tier. ALL VALUES ARE ESTIMATES. */
export interface TierLimitCeilings {
  /** Estimated model requests allowed per rolling 5-hour window. */
  fiveHourRequests: number;
  /** Estimated blended tokens allowed per rolling 5-hour window. */
  fiveHourTokens: number;
  /** Estimated model requests allowed per rolling 7-day window. */
  weeklyRequests: number;
  /** Estimated blended tokens allowed per rolling 7-day window. */
  weeklyTokens: number;
}

/**
 * Avg blended tokens per model request — used to derive token ceilings from
 * request ceilings. Grounded in the live dataset's per-request token mix
 * (input + output + cache_creation + cache_read). Documented ESTIMATE.
 */
export const AVG_TOKENS_PER_REQUEST = 35_000;

/**
 * Heuristic count of active 5-hour windows in a week, used to derive the
 * weekly request ceiling from the 5-hour request ceiling
 * (`weeklyRequests ≈ fiveHourRequests × WEEKLY_WINDOWS_PER_WEEK`). ESTIMATE.
 */
export const WEEKLY_WINDOWS_PER_WEEK = 25;

/** Caveat string shown on EVERY recommendation surface (CLI/API/UI). */
export const RECOMMENDATION_ESTIMATE_CAVEAT =
  "Estimate from local session data; Anthropic's exact limits are not published.";

/**
 * Default per-tier ceilings. ESTIMATES grounded in 2026 research:
 *   Pro     ≈ 45 prompts / 5h
 *   Max 5x  ≈ 225 prompts / 5h   (5×)
 *   Max 20x ≈ 900 prompts / 5h   (20×)
 * Token ceilings = requests × {@link AVG_TOKENS_PER_REQUEST}.
 * Weekly requests ≈ fiveHourRequests × {@link WEEKLY_WINDOWS_PER_WEEK}
 * (~25 active 5h windows/week heuristic); weekly tokens follow the same
 * requests × AVG_TOKENS_PER_REQUEST derivation.
 *
 * `none` is API pay-as-you-go: its ceilings are zero sentinels and are never
 * used as a fill% denominator (see {@link resolveCeilings} guard and the
 * neutral verdict in src/recommendation/engine.ts).
 */
export const DEFAULT_TIER_LIMITS: Record<SubscriptionTier, TierLimitCeilings> = {
  none: {
    fiveHourRequests: 0,
    fiveHourTokens: 0,
    weeklyRequests: 0,
    weeklyTokens: 0,
  },
  pro: {
    fiveHourRequests: 45,
    fiveHourTokens: 45 * AVG_TOKENS_PER_REQUEST,
    weeklyRequests: 45 * WEEKLY_WINDOWS_PER_WEEK,
    weeklyTokens: 45 * WEEKLY_WINDOWS_PER_WEEK * AVG_TOKENS_PER_REQUEST,
  },
  "max-5x": {
    fiveHourRequests: 225,
    fiveHourTokens: 225 * AVG_TOKENS_PER_REQUEST,
    weeklyRequests: 225 * WEEKLY_WINDOWS_PER_WEEK,
    weeklyTokens: 225 * WEEKLY_WINDOWS_PER_WEEK * AVG_TOKENS_PER_REQUEST,
  },
  "max-20x": {
    fiveHourRequests: 900,
    fiveHourTokens: 900 * AVG_TOKENS_PER_REQUEST,
    weeklyRequests: 900 * WEEKLY_WINDOWS_PER_WEEK,
    weeklyTokens: 900 * WEEKLY_WINDOWS_PER_WEEK * AVG_TOKENS_PER_REQUEST,
  },
};

/** Ordered paid tiers for up/downgrade neighbour lookup (excludes "none"). */
export const PAID_TIER_ORDER: SubscriptionTier[] = ["pro", "max-5x", "max-20x"];

/**
 * The four numeric dimensions of {@link TierLimitCeilings}, in stable order.
 * Used by override sanitization and auto-calibration so every consumer walks
 * the same dimension set.
 */
export const CEILING_DIMENSIONS: ReadonlyArray<keyof TierLimitCeilings> = [
  "fiveHourRequests",
  "fiveHourTokens",
  "weeklyRequests",
  "weeklyTokens",
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

/** Observed raw peaks used to auto-calibrate ceilings (§3.3). */
export interface ObservedPeaks {
  /** Max raw request count across 5-hour windows. */
  fiveHourRequests: number;
  /** Max raw token sum across 5-hour windows. */
  fiveHourTokens: number;
  /** Max raw request count across weekly windows. */
  weeklyRequests: number;
  /** Max raw token sum across weekly windows. */
  weeklyTokens: number;
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
 * Auto-calibration (§3.3, opt-in, default ON): raise each ceiling dimension to
 * **at least** the observed peak so a user who blows past the published
 * estimate is not pinned at a meaningless ">100%" fill.
 *
 * `calibrated[dim] = max(defaultCeilings[dim], observedPeaks[dim])`. A dimension
 * is flagged `calibrated: true` only when the observed peak strictly exceeds the
 * default ceiling. `ceilingSource` is `"calibrated"` if any dimension was
 * raised, else `"default"`.
 *
 * Pure and DB-free so the analyzer, API route, and unit tests share one rule.
 *
 * @param defaultCeilings - Override-resolved default ceilings.
 * @param peaks - Observed raw peaks from window reconstruction.
 * @returns The default + calibrated ceilings and per-dimension provenance.
 */
export function calibrateCeilings(
  defaultCeilings: TierLimitCeilings,
  peaks: ObservedPeaks,
): CalibrationResult {
  const calibrated: TierLimitCeilings = { ...defaultCeilings };
  const calibratedFlags: CalibratedFlags = {
    fiveHourRequests: false,
    fiveHourTokens: false,
    weeklyRequests: false,
    weeklyTokens: false,
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
