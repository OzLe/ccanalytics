/**
 * @module recommendation/engine
 *
 * The subscription-recommendation decision engine (§5), implemented as a PURE
 * function `recommend(input)` so it is trivially unit-testable with no DB.
 *
 * It answers one question: given local Claude Code usage, should the user
 * DOWNGRADE (under-utilizing), UPGRADE (frequently at/near limits), or STAY —
 * with an explicit confidence level and an honest estimate caveat.
 *
 * IMPORTANT: every signal here derives from ESTIMATED ceilings (see
 * src/config/limits.ts). Usage is measured by API-equivalent cost (`cost_usd`)
 * per rolling window — the unit Anthropic's limits scale with. The monthly
 * dollar deltas reuse tier monthly prices from src/config/subscription.ts
 * (DEFAULT_MONTHLY_USD); this engine computes NOTHING into cost_usd and reads no
 * per-model rate — it only compares already-summed window costs to estimated
 * ceilings.
 */

import type { SubscriptionTier } from "../types/config.js";
import type { TierLimitCeilings } from "../config/limits.js";
import {
  DEFAULT_TIER_LIMITS,
  PAID_TIER_ORDER,
  RECOMMENDATION_ESTIMATE_CAVEAT,
} from "../config/limits.js";
import { DEFAULT_MONTHLY_USD, SUBSCRIPTION_TIERS } from "../config/subscription.js";
import type { WindowStats } from "./windows.js";

/** Confidence band, ordered low < medium < high. */
export type Confidence = "low" | "medium" | "high";

/** The recommendation verdict (§5.4). */
export type Verdict = "upgrade" | "downgrade" | "stay" | "neutral";

// ---------------------------------------------------------------------------
// Thresholds (§5.2) — exact, named, all ESTIMATE-derived.
// ---------------------------------------------------------------------------

/** A 5h window is "near-limit" at ≥90% blended fill. */
export const NEAR_LIMIT_FILL = 0.9;
/** ≥15% of active 5h windows near-limit ⇒ upgrade lean. */
export const UPGRADE_NEAR_LIMIT_SHARE = 0.15;
/** OR weekly peak fill ≥90% ⇒ upgrade lean. */
export const UPGRADE_WEEKLY_PEAK = 0.9;
/** Both 5h & weekly peak < 70% of the tier-DOWN ceiling ⇒ downgrade lean. */
export const DOWNGRADE_FILL = 0.7;

/** Margin (distance-to-threshold) cutoffs for the confidence margin axis (§5.3). */
const MARGIN_HIGH = 0.15;
const MARGIN_MEDIUM = 0.05;

/** Confidence ordering for the `min(volume, margin)` combine. */
const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Raw peak usage observed across windows, re-expressible vs any tier ceiling. */
export interface ObservedPeakUsage {
  /** Max raw API-equivalent cost (USD) across 5h windows. */
  fiveHourPeakCostUSD: number;
  /** Max raw API-equivalent cost (USD) across weekly windows. */
  weeklyPeakCostUSD: number;
}

/** Data-volume / recency signals feeding the confidence axis (§5.3). */
export interface DataVolume {
  /** Distinct active UTC days in the period. */
  activeDays: number;
  /** Number of reconstructed 5h windows. */
  activeWindows: number;
  /** Whole days since the most recent activity. */
  recencyDays: number;
}

/** Pure input to {@link recommend}. */
export interface RecommendationInput {
  /** The user's current tier. */
  tier: SubscriptionTier;
  /** 5h window stats against the (calibrated) current-tier ceilings. */
  fiveHour: WindowStats;
  /** All-models weekly window stats against the current-tier ceilings. */
  weekly: WindowStats;
  /** Raw observed peaks (used to re-express usage vs a neighbour ceiling). */
  peaks: ObservedPeakUsage;
  /** The active (calibrated) ceilings for the current tier. */
  ceilings: TierLimitCeilings;
  /** Data-volume / recency signals. */
  volume: DataVolume;
}

/** The structured recommendation (§5.4). */
export interface Recommendation {
  verdict: Verdict;
  currentTier: SubscriptionTier;
  /** null for stay/neutral. */
  suggestedTier: SubscriptionTier | null;
  /** +extra for upgrade, −saved for downgrade, 0 otherwise. */
  monthlyDeltaUSD: number;
  confidence: Confidence;
  confidenceReason: string;
  /** Short headline, e.g. "Consider upgrading to MAX 20x". */
  headline: string;
  /** One-paragraph rationale; softened when confidence is low. */
  detail: string;
  /** Always {@link RECOMMENDATION_ESTIMATE_CAVEAT}. */
  caveat: string;
}

/** Lower of two confidence bands. */
function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER[a] <= CONFIDENCE_ORDER[b] ? a : b;
}

/** Human label for a tier (from the subscription SSOT), falling back to the id. */
function tierLabel(tier: SubscriptionTier): string {
  return SUBSCRIPTION_TIERS.find((t) => t.id === tier)?.label ?? tier;
}

/**
 * Re-express a peak raw window cost as a fill against a tier's cost ceiling:
 * `peakCostUSD / ceiling.{fiveHour|weekly}CostUSD`. Zero ceilings guard to 0
 * (never reached here since neighbours are always paid tiers).
 */
function peakFillVs(
  peakCostUSD: number,
  ceiling: TierLimitCeilings,
  span: "fiveHour" | "weekly",
): number {
  const ceil = span === "fiveHour" ? ceiling.fiveHourCostUSD : ceiling.weeklyCostUSD;
  return ceil > 0 ? peakCostUSD / ceil : 0;
}

/** Data-volume confidence axis (§5.3). Sparse data ⇒ low. */
function volumeConfidence(v: DataVolume): Confidence {
  if (v.activeDays >= 14 && v.activeWindows >= 20 && v.recencyDays <= 3) {
    return "high";
  }
  if (v.activeDays >= 5 && v.activeWindows >= 6) {
    return "medium";
  }
  return "low";
}

/** Margin confidence axis (§5.3) from a distance-to-threshold. */
function marginConfidence(margin: number): Confidence {
  if (margin >= MARGIN_HIGH) return "high";
  if (margin >= MARGIN_MEDIUM) return "medium";
  return "low";
}

/** First-letter uppercase for sentence-casing a joined reason fragment. */
function capitalize(s: string): string {
  return s.length === 0 ? s : (s[0] as string).toUpperCase() + s.slice(1);
}

/**
 * Phrase a blended fill fraction for human copy. Decision stats are measured
 * against the tier's ESTIMATED (default) ceilings, so a heavy user's fill can
 * run far past 100% — clamp the wording so copy never prints an absurd raw
 * percentage (e.g. "19166%"). At/under the limit shows the exact percent;
 * modestly over shows the percent flagged as over; far over is qualitative.
 */
export function describeFill(fill: number): string {
  const pct = Math.round(fill * 100);
  if (fill <= 1.0) return `~${pct}% of the estimated limit`;
  if (fill <= 1.5) return `~${pct}% of the estimated limit (over the estimate)`;
  return `well above the estimated limit`;
}

/** Build a short human reason explaining which axis bound the confidence. */
function confidenceReasonText(vol: Confidence, margin: Confidence, combined: Confidence): string {
  if (combined === "high") {
    return "Plenty of recent data and the signal is well clear of the decision threshold.";
  }
  if (vol === "low") {
    return "Confidence is limited by sparse usage data — re-check after more activity.";
  }
  if (margin === "low") {
    return "Your usage sits close to the decision threshold, so the signal is borderline.";
  }
  return "Moderate confidence — either the data volume or the margin to the threshold is middling.";
}

/**
 * The pure recommendation decision (§5).
 *
 * Precedence: evaluate UPGRADE first, then DOWNGRADE, else STAY (so an
 * at-limit signal wins any edge case). Tier "none" (API pay-as-you-go) is
 * always neutral — the payload still carries window stats for display.
 *
 * The downgrade test re-expresses observed peaks against the tier-DOWN tier's
 * **published default** ceilings (DEFAULT_TIER_LIMITS) — auto-calibration only
 * ever raises the CURRENT tier's ceilings, so the smaller tier's estimate is
 * the right yardstick for "would I fit there?".
 *
 * IMPORTANT — decision vs display: the `fiveHour`/`weekly` stats passed in here
 * are computed against the tier's ABSOLUTE (default) ceilings, NOT the
 * auto-calibrated display ceilings. Calibration exists only so the UI's fill%
 * is not pinned at a meaningless >100%; if the verdict read calibrated stats,
 * `weekly.peakFill` would be ~100% by construction and the upgrade triggers
 * would measure usage against the user's OWN peak instead of the tier limit.
 * Keeping decisions on the default yardstick makes UPGRADE and DOWNGRADE
 * symmetric. (The analyzer still returns the calibrated stats separately for
 * display.) Because default fills can far exceed 1.0, copy uses
 * {@link describeFill} to phrase over-limit usage without printing absurd %.
 *
 * @param input - Current tier, window stats, observed peaks, ceilings, volume.
 * @returns The structured {@link Recommendation}.
 */
export function recommend(input: RecommendationInput): Recommendation {
  const { tier, fiveHour, weekly, peaks, volume } = input;
  const caveat = RECOMMENDATION_ESTIMATE_CAVEAT;

  // §5.1: "none" is API pay-as-you-go → neutral, stats only.
  if (tier === "none") {
    return {
      verdict: "neutral",
      currentTier: tier,
      suggestedTier: null,
      monthlyDeltaUSD: 0,
      confidence: "low",
      confidenceReason:
        "You're on API pay-as-you-go (no subscription), so there's no tier to up/downgrade — showing usage stats only.",
      headline: "No subscription tier to evaluate",
      detail:
        "You're on API pay-as-you-go. The 5-hour and weekly usage stats are shown for reference, but there is no flat-rate tier to recommend up or down.",
      caveat,
    };
  }

  const idx = PAID_TIER_ORDER.indexOf(tier);
  const tierUp: SubscriptionTier | null =
    idx >= 0 && idx < PAID_TIER_ORDER.length - 1
      ? (PAID_TIER_ORDER[idx + 1] as SubscriptionTier)
      : null;
  const tierDown: SubscriptionTier | null =
    idx > 0 ? (PAID_TIER_ORDER[idx - 1] as SubscriptionTier) : null;

  const vol = volumeConfidence(volume);

  // §5.2 UPGRADE signal: near-limit share over active 5h windows, OR weekly peak.
  const nearLimitShare = fiveHour.nearLimitWindows / Math.max(fiveHour.activeWindows, 1);
  const shareTriggers = nearLimitShare >= UPGRADE_NEAR_LIMIT_SHARE;
  const weeklyTriggers = weekly.peakFill >= UPGRADE_WEEKLY_PEAK;

  if (tierUp && (shareTriggers || weeklyTriggers)) {
    // Deciding metric = whichever upgrade axis fired hardest (largest margin).
    const margin = Math.max(
      shareTriggers ? Math.abs(nearLimitShare - UPGRADE_NEAR_LIMIT_SHARE) : -Infinity,
      weeklyTriggers ? Math.abs(weekly.peakFill - UPGRADE_WEEKLY_PEAK) : -Infinity,
    );
    const marginConf = marginConfidence(margin);
    const confidence = minConfidence(vol, marginConf);
    const extraMonthlyUSD = DEFAULT_MONTHLY_USD[tierUp] - DEFAULT_MONTHLY_USD[tier];
    const upLabel = tierLabel(tierUp);
    const sharePct = Math.round(nearLimitShare * 100);
    const reasonBits: string[] = [];
    if (shareTriggers) {
      reasonBits.push(`${sharePct}% of your 5-hour windows hit ≥90% of the estimated limit`);
    }
    if (weeklyTriggers) {
      reasonBits.push(`your weekly usage was ${describeFill(weekly.peakFill)}`);
    }
    const detail =
      vol === "low"
        ? `Your data is sparse — this is a weak signal; consider re-checking after more usage. That said, ${reasonBits.join(
            " and ",
          )}, which leans toward ${upLabel} (about $${extraMonthlyUSD}/mo more).`
        : `${capitalize(
            reasonBits.join(" and "),
          )}. Upgrading to ${upLabel} would cost about $${extraMonthlyUSD}/mo more but give you meaningfully more headroom.`;
    return {
      verdict: "upgrade",
      currentTier: tier,
      suggestedTier: tierUp,
      monthlyDeltaUSD: extraMonthlyUSD,
      confidence,
      confidenceReason: confidenceReasonText(vol, marginConf, confidence),
      headline: `Consider upgrading to ${upLabel}`,
      detail,
      caveat,
    };
  }

  // §5.2 DOWNGRADE signal: comfortable headroom on BOTH windows vs the
  // tier-DOWN published ceilings.
  if (tierDown) {
    const down = DEFAULT_TIER_LIMITS[tierDown];
    const fiveHourPeakVsDown = peakFillVs(peaks.fiveHourPeakCostUSD, down, "fiveHour");
    const weeklyPeakVsDown = peakFillVs(peaks.weeklyPeakCostUSD, down, "weekly");
    if (fiveHourPeakVsDown < DOWNGRADE_FILL && weeklyPeakVsDown < DOWNGRADE_FILL) {
      // Deciding metric = the LARGER of the two (the binding constraint); margin
      // = how far below the threshold it sits.
      const binding = Math.max(fiveHourPeakVsDown, weeklyPeakVsDown);
      const marginConf = marginConfidence(Math.abs(DOWNGRADE_FILL - binding));
      const confidence = minConfidence(vol, marginConf);
      const savedMonthlyUSD = DEFAULT_MONTHLY_USD[tier] - DEFAULT_MONTHLY_USD[tierDown];
      const downLabel = tierLabel(tierDown);
      const peakPct = Math.round(binding * 100);
      const detail =
        vol === "low"
          ? `Your data is sparse — this is a weak signal; consider re-checking after more usage. Your peak usage looks like only ~${peakPct}% of what ${downLabel} allows, which leans toward downgrading (about $${savedMonthlyUSD}/mo saved).`
          : `Your peak usage reaches only ~${peakPct}% of the estimated ${downLabel} limit, so you'd likely be comfortable there and save about $${savedMonthlyUSD}/mo.`;
      return {
        verdict: "downgrade",
        currentTier: tier,
        suggestedTier: tierDown,
        monthlyDeltaUSD: -savedMonthlyUSD,
        confidence,
        confidenceReason: confidenceReasonText(vol, marginConf, confidence),
        headline: `You could downgrade to ${downLabel}`,
        detail,
        caveat,
      };
    }
  }

  // §5.2 STAY: the healthy band (and the default when a neighbour is missing).
  // Margin = distance to the NEARER of the two thresholds we tested.
  const upMargin = Math.abs(
    Math.max(nearLimitShare - UPGRADE_NEAR_LIMIT_SHARE, weekly.peakFill - UPGRADE_WEEKLY_PEAK),
  );
  const stayMargins: number[] = [upMargin];
  if (tierDown) {
    const down = DEFAULT_TIER_LIMITS[tierDown];
    const binding = Math.max(
      peakFillVs(peaks.fiveHourPeakCostUSD, down, "fiveHour"),
      peakFillVs(peaks.weeklyPeakCostUSD, down, "weekly"),
    );
    stayMargins.push(Math.abs(DOWNGRADE_FILL - binding));
  }
  const stayMarginConf = marginConfidence(Math.min(...stayMargins));
  const confidence = minConfidence(vol, stayMarginConf);
  const peakDesc = describeFill(fiveHour.peakFill);
  // Reaching STAY while the upgrade signal fired means there is no higher tier
  // to move to (a top-tier heavy user). Say that honestly rather than calling
  // heavy usage a "healthy band".
  const atTopHeavy = (shareTriggers || weeklyTriggers) && !tierUp;
  const sharePct = Math.round(nearLimitShare * 100);
  const detail = atTopHeavy
    ? `You're already on the highest tier (${tierLabel(
        tier,
      )}). Your usage is heavy — ${sharePct}% of your 5-hour windows reach the estimated limit and your 5-hour peak is ${peakDesc} — but there's no higher tier to move to.`
    : vol === "low"
      ? `Your data is sparse — this is a weak signal; consider re-checking after more usage. So far your usage (5-hour peak ${peakDesc}) sits in a healthy band for ${tierLabel(
          tier,
        )}.`
      : `Your usage sits in a healthy band for ${tierLabel(
          tier,
        )} — a 5-hour peak of ${peakDesc}, with neither a strong upgrade nor downgrade signal.`;
  return {
    verdict: "stay",
    currentTier: tier,
    suggestedTier: null,
    monthlyDeltaUSD: 0,
    confidence,
    confidenceReason: confidenceReasonText(vol, stayMarginConf, confidence),
    headline: `Stay on ${tierLabel(tier)}`,
    detail,
    caveat,
  };
}
