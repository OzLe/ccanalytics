/**
 * @module recommendation/engine
 *
 * The subscription-recommendation decision engine (§5), implemented as a PURE
 * function `recommend(input)` so it is trivially unit-testable with no DB.
 *
 * It answers one question: given local Claude Code usage, what should the user
 * do with their subscription — UPGRADE (usage presses the limits), DOWNGRADE
 * (a smaller tier or API pay-as-you-go would do), or STAY — with an explicit
 * confidence level and an honest estimate caveat.
 *
 * v2 design (robustness over the v1 single-threshold scheme):
 *   1. BEST-FIT TIER, not one-step moves: every paid tier is assessed against
 *      the SAME raw windows ("strained" = usage presses its limits, "fits" =
 *      comfortable headroom), and the suggestion is the smallest tier that is
 *      not strained / that fits — which may be two steps away.
 *   2. PERSISTENCE, not single spikes: an upgrade needs ≥2 near-limit 5h
 *      windows AND a ≥15% share (or repeated near-limit weeks). One anomalous
 *      window or week can no longer flip the verdict.
 *   3. OUTLIER-TOLERANT downgrade: the fit test reads the p90 fill (typical
 *      pressure) plus the absolute peak, so a single 80%-of-limit spike does
 *      not block a downgrade that 90% of windows justify.
 *   4. RECENCY: upgrade pressure must still exist in the recent half of the
 *      period (stale pressure → stay), and a usage TREND (rising/falling) is
 *      reported and caps confidence when it contradicts the verdict.
 *   5. PAY-AS-YOU-GO break-even: when the monthly API-equivalent run-rate is
 *      clearly below the Pro fee, the engine recommends dropping to "none";
 *      symmetrically, a heavy "none" user is told which tier would cost less
 *      than their current API spend (the v1 engine could do neither).
 *
 * IMPORTANT: every limit-derived signal here is an ESTIMATE (see
 * src/config/limits.ts). Usage is measured by API-equivalent cost (`cost_usd`)
 * per rolling window — the unit Anthropic's limits scale with. The engine
 * computes NOTHING into cost_usd and reads no per-model rate — it only
 * aggregates already-summed window costs against estimated ceilings. The
 * pay-as-you-go comparison is the one place API LIST prices are the right
 * frame: `cost_usd` is exactly the projected API bill.
 *
 * Decision vs display: all verdict math runs against the tiers' DEFAULT
 * (override-resolved) ceilings — never the auto-calibrated ones, which exist
 * only so the UI's fill% is not pinned at a meaningless >100% (see the §3.3
 * regression notes in src/queries/recommendation-analyzer.ts).
 */

import type { SubscriptionTier } from "../types/config.js";
import type { TierLimitCeilings, TierLimitOverrides } from "../config/limits.js";
import {
  PAID_TIER_ORDER,
  RECOMMENDATION_ESTIMATE_CAVEAT,
  resolveCeilings,
} from "../config/limits.js";
import { DEFAULT_MONTHLY_USD, SUBSCRIPTION_TIERS } from "../config/subscription.js";
import { percentile } from "./windows.js";

/** Confidence band, ordered low < medium < high. */
export type Confidence = "low" | "medium" | "high";

/** The recommendation verdict (§5.4). */
export type Verdict = "upgrade" | "downgrade" | "stay" | "neutral";

/** Direction of usage over the analysis period (recent half vs earlier half). */
export type UsageTrend = "rising" | "falling" | "flat" | "unknown";

// ---------------------------------------------------------------------------
// Thresholds (§5.2) — exact, named, all ESTIMATE-derived.
// ---------------------------------------------------------------------------

/** A window is "near-limit" at ≥90% fill of a tier's ceiling. */
export const NEAR_LIMIT_FILL = 0.9;
/** ≥15% of active 5h windows near-limit (with min support) ⇒ tier strained. */
export const UPGRADE_NEAR_LIMIT_SHARE = 0.15;
/** Minimum near-limit 5h windows backing the share trigger (persistence). */
export const STRAIN_MIN_NEAR_LIMIT_WINDOWS = 2;
/** ≥2 near-limit WEEKLY windows ⇒ tier strained (persistence)… */
export const WEEKLY_STRAIN_MIN_WINDOWS = 2;
/** …or ≥50% of weekly windows near-limit (short periods with 1–2 weeks). */
export const WEEKLY_STRAIN_SHARE = 0.5;
/** Typical (p90) fill must sit below 70% of a smaller tier to "fit" it. */
export const DOWNGRADE_FILL = 0.7;
/** …and even the PEAK window must not exceed the smaller tier's ceiling. */
export const DOWNGRADE_PEAK_FILL = 1.0;
/** Quantile used as "typical pressure" in the fit test (p90). */
export const FIT_QUANTILE = 0.9;
/** Run-rate ≤ 60% of the Pro fee ⇒ pay-as-you-go beats every subscription. */
export const PAYG_BREAK_EVEN_RATIO = 0.6;
/** Subscribing from "none" requires fee ≤ 80% of the API run-rate (clear win). */
export const SUBSCRIBE_FEE_SHARE = 0.8;
/** Trend detection: recent-half mean ≥1.35× earlier-half mean ⇒ rising. */
export const TREND_RISING_RATIO = 1.35;
/** Trend detection: recent-half mean ≤0.74× earlier-half mean ⇒ falling. */
export const TREND_FALLING_RATIO = 0.74;
/** Minimum 5h windows (total / per half) before a trend is claimed. */
export const TREND_MIN_WINDOWS = 6;
export const TREND_MIN_HALF_WINDOWS = 2;

/** Margin (distance-to-threshold) cutoffs for the confidence margin axis (§5.3). */
const MARGIN_HIGH = 0.15;
const MARGIN_MEDIUM = 0.05;

/** Confidence ordering for the `min(volume, margin)` combine. */
const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** One reconstructed rolling window the engine consumes (anchor + summed cost). */
export interface WindowSample {
  /** Epoch ms of the first turn that opened the window. */
  anchor: number;
  /** Summed API-equivalent cost (USD) across the window. */
  costUsd: number;
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
  /** Reconstructed 5h windows (chronological). */
  windows5h: WindowSample[];
  /** Reconstructed weekly windows (chronological). */
  windowsWeekly: WindowSample[];
  /** Total API-equivalent cost (USD) across the period. */
  totalCostUSD: number;
  /** Days spanned by the observed activity (first→last turn), ≥1 when any. */
  activitySpanDays: number;
  /** Data-volume / recency signals. */
  volume: DataVolume;
  /** Sparse per-tier ceiling overrides (config.recommendation.ceilings). */
  ceilingOverrides?: TierLimitOverrides;
}

/** Structured per-axis evidence behind the verdict (vs the CURRENT tier). */
export interface RecommendationSignals {
  /** Near-limit 5h windows / share vs the current tier's default ceilings. */
  nearLimitCount5h: number;
  nearLimitShare5h: number;
  activeWindows5h: number;
  /** Near-limit weekly windows vs the current tier's default ceilings. */
  nearLimitCountWeekly: number;
  weeklyWindows: number;
  /** Estimated monthly API-equivalent run-rate (USD); 0 when no data. */
  monthlyRunRateUSD: number;
  /** Usage direction over the period. */
  trend: UsageTrend;
  /** Whether near-limit pressure exists in the RECENT half of the period. */
  recentPressure: boolean;
  /** Smallest paid tier whose limits the usage does not strain (null = none fit). */
  bestFitTier: SubscriptionTier | null;
}

/** The structured recommendation (§5.4). */
export interface Recommendation {
  verdict: Verdict;
  currentTier: SubscriptionTier;
  /** null for stay/neutral. May be "none" (pay-as-you-go) for a downgrade. */
  suggestedTier: SubscriptionTier | null;
  /**
   * +extra for upgrade, −saved for downgrade, 0 otherwise. Tier-to-tier moves
   * use the flat fee gap; moves involving pay-as-you-go use the estimated net
   * monthly impact vs the API run-rate (rounded to whole dollars).
   */
  monthlyDeltaUSD: number;
  confidence: Confidence;
  confidenceReason: string;
  /** Short headline, e.g. "Consider upgrading to MAX 20x". */
  headline: string;
  /** One-paragraph rationale; softened when confidence is low. */
  detail: string;
  /** Usage direction over the period (recent half vs earlier half). */
  trend: UsageTrend;
  /** Structured per-axis evidence behind the verdict. */
  signals: RecommendationSignals;
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

// ---------------------------------------------------------------------------
// Per-tier assessment (the §5.2 v2 core)
// ---------------------------------------------------------------------------

/** Pressure view of one window span (5h or weekly) against one ceiling. */
interface SpanView {
  n: number;
  nearCount: number;
  nearShare: number;
  /** Typical pressure: p90 fill (nearest-rank; equals max for n ≤ 9). */
  p90Fill: number;
  peakFill: number;
}

/** Compute the pressure view of `windows` against a cost ceiling. */
function viewAgainst(windows: WindowSample[], ceilingCostUSD: number): SpanView {
  if (windows.length === 0 || ceilingCostUSD <= 0) {
    return { n: windows.length, nearCount: 0, nearShare: 0, p90Fill: 0, peakFill: 0 };
  }
  const fills = windows.map((w) => w.costUsd / ceilingCostUSD);
  let nearCount = 0;
  let peakFill = 0;
  for (const f of fills) {
    if (f >= NEAR_LIMIT_FILL) nearCount += 1;
    if (f > peakFill) peakFill = f;
  }
  return {
    n: windows.length,
    nearCount,
    nearShare: nearCount / windows.length,
    p90Fill: percentile(fills, FIT_QUANTILE),
    peakFill,
  };
}

/**
 * Effective weekly strain threshold in SHARE units for n weekly windows:
 * `nearShare ≥ min(0.5, 2/n)` is exactly "≥2 near-limit weeks, OR ≥50% of a
 * short period's weeks near-limit" — one formula for trigger and margin.
 */
function weeklyStrainThreshold(n: number): number {
  return Math.min(WEEKLY_STRAIN_SHARE, WEEKLY_STRAIN_MIN_WINDOWS / Math.max(n, 1));
}

/** How one paid tier relates to the observed usage. */
export interface TierAssessment {
  tier: SubscriptionTier;
  ceilings: TierLimitCeilings;
  fiveHour: SpanView;
  weekly: SpanView;
  /** The 5h persistence trigger fired (share ≥15% with ≥2 windows). */
  strained5h: boolean;
  /** The weekly persistence trigger fired (≥2 weeks or ≥50% of weeks). */
  strainedWeekly: boolean;
  /** Usage presses this tier's limits (persistent near-limit pressure). */
  strained: boolean;
  /** Usage sits comfortably inside this tier (typical ≤70%, peak ≤100%). */
  fits: boolean;
}

/** Assess one tier's ceilings against the raw windows (pure, §5.2). */
function assessTier(
  tier: SubscriptionTier,
  windows5h: WindowSample[],
  windowsWeekly: WindowSample[],
  overrides?: TierLimitOverrides,
): TierAssessment {
  const ceilings = resolveCeilings(tier, overrides);
  const fiveHour = viewAgainst(windows5h, ceilings.fiveHourCostUSD);
  const weekly = viewAgainst(windowsWeekly, ceilings.weeklyCostUSD);

  // Persistent pressure: the 5h share trigger needs BOTH a meaningful share
  // AND absolute support (≥2 windows); the weekly trigger needs repetition
  // (≥2 weeks) or a majority of a short period's weeks.
  const strained5h =
    fiveHour.nearCount >= STRAIN_MIN_NEAR_LIMIT_WINDOWS &&
    fiveHour.nearShare >= UPGRADE_NEAR_LIMIT_SHARE;
  const strainedWeekly =
    weekly.n > 0 && weekly.nearShare >= weeklyStrainThreshold(weekly.n);

  // Comfortable headroom: typical (p90) pressure under 70% on BOTH spans and
  // even the single worst window inside the ceiling. The p90 makes the test
  // tolerant of one outlier spike once there are ≥10 windows; for small
  // samples p90 = max, which degrades to the conservative v1 peak test.
  const fits =
    fiveHour.p90Fill <= DOWNGRADE_FILL &&
    weekly.p90Fill <= DOWNGRADE_FILL &&
    fiveHour.peakFill <= DOWNGRADE_PEAK_FILL &&
    weekly.peakFill <= DOWNGRADE_PEAK_FILL;

  return {
    tier,
    ceilings,
    fiveHour,
    weekly,
    strained5h,
    strainedWeekly,
    strained: strained5h || strainedWeekly,
    fits,
  };
}

// ---------------------------------------------------------------------------
// Trend + recency (§5.2 v2 axis 4)
// ---------------------------------------------------------------------------

/** Midpoint (epoch ms) of the observed 5h-window anchor span; null if empty. */
function anchorMidpoint(windows: WindowSample[]): number | null {
  if (windows.length === 0) return null;
  const first = windows[0] as WindowSample;
  const last = windows[windows.length - 1] as WindowSample;
  return (first.anchor + last.anchor) / 2;
}

/**
 * Usage trend: mean 5h-window cost in the recent half vs the earlier half of
 * the observed span. Needs ≥{@link TREND_MIN_WINDOWS} windows with at least
 * {@link TREND_MIN_HALF_WINDOWS} in each half, else "unknown" (never guessed).
 */
export function computeTrend(windows5h: WindowSample[]): UsageTrend {
  if (windows5h.length < TREND_MIN_WINDOWS) return "unknown";
  const mid = anchorMidpoint(windows5h);
  if (mid === null) return "unknown";
  const earlier: number[] = [];
  const recent: number[] = [];
  for (const w of windows5h) {
    (w.anchor < mid ? earlier : recent).push(w.costUsd);
  }
  if (earlier.length < TREND_MIN_HALF_WINDOWS || recent.length < TREND_MIN_HALF_WINDOWS) {
    return "unknown";
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const earlierMean = mean(earlier);
  const recentMean = mean(recent);
  if (earlierMean <= 0) return recentMean > 0 ? "rising" : "flat";
  const ratio = recentMean / earlierMean;
  if (ratio >= TREND_RISING_RATIO) return "rising";
  if (ratio <= TREND_FALLING_RATIO) return "falling";
  return "flat";
}

/**
 * Whether near-limit pressure (vs the given ceilings) exists in the RECENT
 * half of the observed span — the upgrade gate that retires stale pressure.
 */
function hasRecentPressure(
  windows5h: WindowSample[],
  windowsWeekly: WindowSample[],
  ceilings: TierLimitCeilings,
): boolean {
  const mid = anchorMidpoint(windows5h) ?? anchorMidpoint(windowsWeekly);
  if (mid === null) return false;
  const near = (w: WindowSample, ceil: number) =>
    ceil > 0 && w.costUsd / ceil >= NEAR_LIMIT_FILL;
  return (
    windows5h.some((w) => w.anchor >= mid && near(w, ceilings.fiveHourCostUSD)) ||
    windowsWeekly.some((w) => w.anchor >= mid && near(w, ceilings.weeklyCostUSD))
  );
}

// ---------------------------------------------------------------------------
// Confidence copy
// ---------------------------------------------------------------------------

/** Build a short human reason explaining which axis bound the confidence. */
function confidenceReasonText(
  vol: Confidence,
  margin: Confidence,
  combined: Confidence,
  trendCapped: boolean,
  trend: UsageTrend,
): string {
  if (trendCapped) {
    const dir = trend === "falling" ? "down" : "up";
    return `Your usage is trending ${dir}, which runs counter to this verdict, so confidence is capped.`;
  }
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

/** Combine volume + margin, then cap at medium when the trend contradicts. */
function combineConfidence(
  vol: Confidence,
  margin: number,
  verdict: Verdict,
  trend: UsageTrend,
): { confidence: Confidence; reason: string } {
  const marginConf = marginConfidence(margin);
  let combined = minConfidence(vol, marginConf);
  const contradicts =
    (verdict === "upgrade" && trend === "falling") ||
    (verdict === "downgrade" && trend === "rising");
  const trendCapped = contradicts && CONFIDENCE_ORDER[combined] > CONFIDENCE_ORDER.medium;
  if (trendCapped) combined = "medium";
  return {
    confidence: combined,
    reason: confidenceReasonText(vol, marginConf, combined, trendCapped, trend),
  };
}

/** The sparse-data softener prefix (gated on the VOLUME axis only). */
const SPARSE_PREFIX =
  "Your data is sparse — this is a weak signal; consider re-checking after more usage. ";

// ---------------------------------------------------------------------------
// The decision (§5)
// ---------------------------------------------------------------------------

/**
 * The pure recommendation decision (§5, v2).
 *
 * Precedence: UPGRADE (with the recent-pressure gate) → pay-as-you-go
 * break-even DOWNGRADE → tier-fit DOWNGRADE → STAY, so an at-limit signal
 * always wins. Tier "none" runs the subscribe break-even instead and is
 * otherwise neutral.
 *
 * All ceilings are the tiers' DEFAULT (override-resolved) values — calibrated
 * ceilings are display-only (§3.3; see the analyzer's regression notes).
 *
 * @param input - Current tier, raw windows, totals, volume, overrides.
 * @returns The structured {@link Recommendation}.
 */
export function recommend(input: RecommendationInput): Recommendation {
  const { tier, windows5h, windowsWeekly, totalCostUSD, activitySpanDays, volume } = input;
  const caveat = RECOMMENDATION_ESTIMATE_CAVEAT;
  const vol = volumeConfidence(volume);
  const trend = computeTrend(windows5h);

  // Monthly API-equivalent run-rate: what this usage would bill on the API.
  const monthlyRunRateUSD =
    activitySpanDays > 0 ? (totalCostUSD / activitySpanDays) * 30 : 0;

  // Assess every paid tier against the same raw windows (default ceilings).
  const assessments = new Map<SubscriptionTier, TierAssessment>();
  for (const t of PAID_TIER_ORDER) {
    assessments.set(t, assessTier(t, windows5h, windowsWeekly, input.ceilingOverrides));
  }
  const bestFitTier =
    PAID_TIER_ORDER.find((t) => !(assessments.get(t) as TierAssessment).strained) ?? null;

  // Current-tier evidence for the signals payload (zeros for tier "none").
  const current = tier === "none" ? null : (assessments.get(tier) as TierAssessment);
  const recentPressure = current
    ? hasRecentPressure(windows5h, windowsWeekly, current.ceilings)
    : false;
  const signals: RecommendationSignals = {
    nearLimitCount5h: current?.fiveHour.nearCount ?? 0,
    nearLimitShare5h: current?.fiveHour.nearShare ?? 0,
    activeWindows5h: windows5h.length,
    nearLimitCountWeekly: current?.weekly.nearCount ?? 0,
    weeklyWindows: windowsWeekly.length,
    monthlyRunRateUSD,
    trend,
    recentPressure,
    bestFitTier,
  };

  const base = {
    currentTier: tier,
    trend,
    signals,
    caveat,
  };

  // §5.1 tier "none" (API pay-as-you-go): subscribe break-even, else neutral.
  if (tier === "none") {
    // A subscription is recommended only when (a) there is enough data to
    // trust the run-rate, (b) some tier's limits FIT the usage profile, and
    // (c) that tier's flat fee undercuts the API run-rate with a clear margin.
    if (vol !== "low" && monthlyRunRateUSD > 0) {
      const candidate = PAID_TIER_ORDER.find((t) => {
        const a = assessments.get(t) as TierAssessment;
        return !a.strained && DEFAULT_MONTHLY_USD[t] <= SUBSCRIBE_FEE_SHARE * monthlyRunRateUSD;
      });
      if (candidate) {
        const fee = DEFAULT_MONTHLY_USD[candidate];
        const label = tierLabel(candidate);
        const savedUSD = Math.round(monthlyRunRateUSD - fee);
        const margin = SUBSCRIBE_FEE_SHARE - fee / monthlyRunRateUSD;
        const { confidence, reason } = combineConfidence(vol, margin, "upgrade", trend);
        return {
          ...base,
          verdict: "upgrade",
          suggestedTier: candidate,
          monthlyDeltaUSD: Math.round(fee - monthlyRunRateUSD),
          confidence,
          confidenceReason: reason,
          headline: `Consider subscribing to ${label}`,
          detail:
            `Your API usage runs about $${Math.round(monthlyRunRateUSD)}/mo at list prices, ` +
            `while ${label} costs $${fee}/mo flat and your usage profile sits within its ` +
            `estimated limits — switching could save about $${savedUSD}/mo.`,
          caveat,
        };
      }
    }
    const ratePhrase =
      monthlyRunRateUSD > 0
        ? ` Your API usage runs about $${Math.round(monthlyRunRateUSD)}/mo at list prices.`
        : "";
    return {
      ...base,
      verdict: "neutral",
      suggestedTier: null,
      monthlyDeltaUSD: 0,
      confidence: "low",
      confidenceReason:
        "You're on API pay-as-you-go (no subscription), so there's no tier to up/downgrade — showing usage stats only.",
      headline: "No subscription tier to evaluate",
      detail:
        "You're on API pay-as-you-go. The 5-hour and weekly usage stats are shown for reference; " +
        `no subscription tier currently beats your usage pattern.${ratePhrase}`,
      caveat,
    };
  }

  const cur = current as TierAssessment;
  const idx = PAID_TIER_ORDER.indexOf(tier);
  const fee = DEFAULT_MONTHLY_USD[tier];

  // §5.2 UPGRADE: the current tier is strained — but only if the pressure is
  // not stale (it must still exist in the recent half of the period).
  if (cur.strained) {
    const { strained5h, strainedWeekly } = cur;

    if (!recentPressure) {
      // Stale pressure: it happened, but not lately. Don't pay for headroom
      // that recent usage no longer needs.
      const { confidence, reason } = combineConfidence(vol, MARGIN_MEDIUM, "stay", trend);
      return {
        ...base,
        verdict: "stay",
        suggestedTier: null,
        monthlyDeltaUSD: 0,
        confidence,
        confidenceReason: reason,
        headline: `Stay on ${tierLabel(tier)}`,
        detail:
          `Earlier in this period your usage pressed the estimated ${tierLabel(tier)} limits, ` +
          `but your recent windows stay clear of them — no change needed now. ` +
          `Re-check if you start hitting limits again.`,
        caveat,
      };
    }

    // Smallest higher tier that would NOT be strained; if even the top tier is
    // strained, suggest the top tier anyway (most headroom available).
    const higher = PAID_TIER_ORDER.slice(idx + 1) as SubscriptionTier[];
    const target =
      higher.find((t) => !(assessments.get(t) as TierAssessment).strained) ??
      (higher.length > 0 ? (higher[higher.length - 1] as SubscriptionTier) : null);

    if (target) {
      const margin = Math.max(
        strained5h ? cur.fiveHour.nearShare - UPGRADE_NEAR_LIMIT_SHARE : -Infinity,
        strainedWeekly
          ? cur.weekly.nearShare - weeklyStrainThreshold(cur.weekly.n)
          : -Infinity,
      );
      const { confidence, reason } = combineConfidence(vol, margin, "upgrade", trend);
      const extraMonthlyUSD = DEFAULT_MONTHLY_USD[target] - fee;
      const upLabel = tierLabel(target);
      const reasonBits: string[] = [];
      if (strained5h) {
        reasonBits.push(
          `${cur.fiveHour.nearCount} of your ${cur.fiveHour.n} five-hour windows ` +
            `(${Math.round(cur.fiveHour.nearShare * 100)}%) hit ≥90% of the estimated limit`,
        );
      }
      if (strainedWeekly) {
        reasonBits.push(
          `${cur.weekly.nearCount} of ${cur.weekly.n} weekly window${cur.weekly.n === 1 ? "" : "s"} ` +
            `reached ≥90% of the estimated weekly limit`,
        );
      }
      const skipped = PAID_TIER_ORDER.slice(idx + 1, PAID_TIER_ORDER.indexOf(target));
      const skipNote =
        skipped.length > 0
          ? ` ${skipped.map(tierLabel).join(" and ")} would likely still be tight for this usage, so the suggestion skips ahead.`
          : "";
      const targetStrained = (assessments.get(target) as TierAssessment).strained;
      const topNote = targetStrained
        ? ` Note: your usage may press even the ${upLabel} limits.`
        : "";
      const trendNote = trend === "rising" ? " Your usage is also trending up." : "";
      const core = `${capitalize(reasonBits.join(" and "))}. Upgrading to ${upLabel} would cost about $${extraMonthlyUSD}/mo more but give you meaningfully more headroom.${skipNote}${topNote}${trendNote}`;
      return {
        ...base,
        verdict: "upgrade",
        suggestedTier: target,
        monthlyDeltaUSD: extraMonthlyUSD,
        confidence,
        confidenceReason: reason,
        headline: `Consider upgrading to ${upLabel}`,
        detail: vol === "low" ? `${SPARSE_PREFIX}${core}` : core,
        caveat,
      };
    }
    // No higher tier exists (already at the top): honest heavy-usage stay.
    const { confidence, reason } = combineConfidence(vol, MARGIN_MEDIUM, "stay", trend);
    return {
      ...base,
      verdict: "stay",
      suggestedTier: null,
      monthlyDeltaUSD: 0,
      confidence,
      confidenceReason: reason,
      headline: `Stay on ${tierLabel(tier)}`,
      detail:
        `You're already on the highest tier (${tierLabel(tier)}). Your usage is heavy — ` +
        `${cur.fiveHour.nearCount} of ${cur.fiveHour.n} five-hour windows reach the estimated ` +
        `limit and your 5-hour peak is ${describeFill(cur.fiveHour.peakFill)} — but there's ` +
        `no higher tier to move to.`,
      caveat,
    };
  }

  // §5.2 DOWNGRADE A — pay-as-you-go break-even: the run-rate is so far below
  // even the Pro fee that any subscription loses money. Gated on data volume
  // (cancelling a subscription deserves more evidence than a tier step).
  const proFee = DEFAULT_MONTHLY_USD[PAID_TIER_ORDER[0] as SubscriptionTier];
  if (
    vol !== "low" &&
    monthlyRunRateUSD >= 0 &&
    totalCostUSD > 0 &&
    monthlyRunRateUSD <= PAYG_BREAK_EVEN_RATIO * proFee
  ) {
    const savedUSD = Math.round(fee - monthlyRunRateUSD);
    const margin = PAYG_BREAK_EVEN_RATIO - monthlyRunRateUSD / proFee;
    const { confidence, reason } = combineConfidence(vol, margin, "downgrade", trend);
    return {
      ...base,
      verdict: "downgrade",
      suggestedTier: "none",
      monthlyDeltaUSD: -savedUSD,
      confidence,
      confidenceReason: reason,
      headline: "Pay-as-you-go would likely cost less",
      detail:
        `Your usage averages about $${Math.round(monthlyRunRateUSD)}/mo at API list prices — ` +
        `well under the $${fee}/mo ${tierLabel(tier)} subscription. Dropping to API ` +
        `pay-as-you-go would save about $${savedUSD}/mo at this usage level.`,
      caveat,
    };
  }

  // §5.2 DOWNGRADE B — tier fit: the SMALLEST cheaper tier whose limits the
  // usage fits comfortably (typical p90 ≤70% AND peak ≤100% on both spans).
  const lower = PAID_TIER_ORDER.slice(0, idx) as SubscriptionTier[];
  const fitTarget = lower.find((t) => (assessments.get(t) as TierAssessment).fits) ?? null;
  if (fitTarget) {
    const a = assessments.get(fitTarget) as TierAssessment;
    // Margin = distance of the BINDING constraint from its threshold.
    const margin = Math.min(
      DOWNGRADE_FILL - a.fiveHour.p90Fill,
      DOWNGRADE_FILL - a.weekly.p90Fill,
      DOWNGRADE_PEAK_FILL - a.fiveHour.peakFill,
      DOWNGRADE_PEAK_FILL - a.weekly.peakFill,
    );
    const { confidence, reason } = combineConfidence(vol, margin, "downgrade", trend);
    const savedMonthlyUSD = fee - DEFAULT_MONTHLY_USD[fitTarget];
    const downLabel = tierLabel(fitTarget);
    const typicalPct = Math.round(Math.max(a.fiveHour.p90Fill, a.weekly.p90Fill) * 100);
    const peakPct = Math.round(Math.max(a.fiveHour.peakFill, a.weekly.peakFill) * 100);
    const skipped = lower.slice(lower.indexOf(fitTarget) + 1);
    const skipNote =
      skipped.length > 0
        ? ` (Your usage even clears ${downLabel}, skipping past ${skipped.map(tierLabel).join(" and ")}.)`
        : "";
    const trendNote =
      trend === "falling" ? " Your usage has also been trending down." : "";
    const core =
      `Your typical usage reaches only ~${typicalPct}% of the estimated ${downLabel} limit ` +
      `(peak ~${peakPct}%), so you'd likely be comfortable there and save about ` +
      `$${savedMonthlyUSD}/mo.${skipNote}${trendNote}`;
    return {
      ...base,
      verdict: "downgrade",
      suggestedTier: fitTarget,
      monthlyDeltaUSD: -savedMonthlyUSD,
      confidence,
      confidenceReason: reason,
      headline: `You could downgrade to ${downLabel}`,
      detail: vol === "low" ? `${SPARSE_PREFIX}${core}` : core,
      caveat,
    };
  }

  // §5.2 STAY: the healthy band. Margin = distance to the NEARER of the
  // thresholds actually tested (upgrade share, weekly share, and — when a
  // lower tier exists — its binding fit constraint).
  const stayMargins: number[] = [
    Math.abs(cur.fiveHour.nearShare - UPGRADE_NEAR_LIMIT_SHARE),
    Math.abs(cur.weekly.nearShare - weeklyStrainThreshold(cur.weekly.n)),
  ];
  const firstLower = lower.length > 0 ? (lower[lower.length - 1] as SubscriptionTier) : null;
  if (firstLower) {
    const a = assessments.get(firstLower) as TierAssessment;
    stayMargins.push(
      Math.abs(
        Math.min(
          DOWNGRADE_FILL - a.fiveHour.p90Fill,
          DOWNGRADE_FILL - a.weekly.p90Fill,
          DOWNGRADE_PEAK_FILL - a.fiveHour.peakFill,
          DOWNGRADE_PEAK_FILL - a.weekly.peakFill,
        ),
      ),
    );
  }
  const stayMargin = Math.min(...stayMargins);
  const { confidence, reason } = combineConfidence(vol, stayMargin, "stay", trend);
  // Count-based phrasing matches the persistence rule the verdict actually
  // uses; quoting the raw peak here read contradictory when a single outlier
  // window spiked past the estimate inside an otherwise-healthy period.
  const pressureDesc =
    cur.fiveHour.n > 0
      ? `${cur.fiveHour.nearCount} of ${cur.fiveHour.n} five-hour windows came near the estimated limit`
      : `no usage windows in this period`;
  const trendNote =
    trend === "rising"
      ? " Usage is trending up — keep an eye on the 5-hour windows."
      : trend === "falling"
        ? " Usage is trending down."
        : "";
  const core =
    `Your usage sits in a healthy band for ${tierLabel(tier)} — ${pressureDesc}, ` +
    `with neither a strong upgrade nor downgrade signal.${trendNote}`;
  return {
    ...base,
    verdict: "stay",
    suggestedTier: null,
    monthlyDeltaUSD: 0,
    confidence,
    confidenceReason: reason,
    headline: `Stay on ${tierLabel(tier)}`,
    detail:
      vol === "low"
        ? `${SPARSE_PREFIX}So far your usage (${pressureDesc}) sits in a healthy band for ${tierLabel(tier)}.`
        : core,
    caveat,
  };
}
