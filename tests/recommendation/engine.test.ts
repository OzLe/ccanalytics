/**
 * @module tests/recommendation/engine
 *
 * Pure-unit tests for the v2 recommendation engine (§5, §7.1). No DB.
 *
 * Usage is measured by API-equivalent cost (`cost_usd`) per rolling window.
 * The engine receives RAW reconstructed windows and assesses EVERY paid tier
 * against its own DEFAULT (override-resolved) ceilings, so fixtures choose
 * window dollar amounts relative to the known defaults
 * (pro $5/$125, max-5x $25/$625, max-20x $100/$2500 per 5h/week).
 */

import { describe, it, expect } from "vitest";
import {
  recommend,
  describeFill,
  computeTrend,
  NEAR_LIMIT_FILL,
  UPGRADE_NEAR_LIMIT_SHARE,
  STRAIN_MIN_NEAR_LIMIT_WINDOWS,
  WEEKLY_STRAIN_MIN_WINDOWS,
  WEEKLY_STRAIN_SHARE,
  DOWNGRADE_FILL,
  DOWNGRADE_PEAK_FILL,
  PAYG_BREAK_EVEN_RATIO,
  SUBSCRIBE_FEE_SHARE,
  type RecommendationInput,
  type WindowSample,
  type DataVolume,
} from "../../src/recommendation/engine.js";
import { RECOMMENDATION_ESTIMATE_CAVEAT } from "../../src/config/limits.js";
import { DEFAULT_MONTHLY_USD } from "../../src/config/subscription.js";
import type { SubscriptionTier } from "../../src/types/config.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const BASE = Date.UTC(2026, 0, 5);

/** Build windows from costs: one window per `gapMs` starting at BASE. */
function win(
  costs: number[],
  opts: { startMs?: number; gapMs?: number } = {},
): WindowSample[] {
  const start = opts.startMs ?? BASE;
  const gap = opts.gapMs ?? DAY;
  return costs.map((costUsd, i) => ({ anchor: start + i * gap, costUsd }));
}

/** High-volume signal (drives volumeConfidence to "high"). */
const HIGH_VOLUME: DataVolume = { activeDays: 20, activeWindows: 30, recencyDays: 1 };
/** Sparse signal (drives volumeConfidence to "low"). */
const SPARSE_VOLUME: DataVolume = { activeDays: 1, activeWindows: 1, recencyDays: 40 };

/** Build a full input; totals/span derive from the 5h windows unless given. */
function input(
  over: Partial<RecommendationInput> & { tier?: SubscriptionTier },
): RecommendationInput {
  const windows5h = over.windows5h ?? [];
  const windowsWeekly = over.windowsWeekly ?? [];
  const totalCostUSD =
    over.totalCostUSD ?? windows5h.reduce((s, w) => s + w.costUsd, 0);
  const first = windows5h[0];
  const last = windows5h[windows5h.length - 1];
  const activitySpanDays =
    over.activitySpanDays ??
    (first && last ? Math.max((last.anchor - first.anchor) / DAY, 1) : 0);
  return {
    tier: over.tier ?? "max-5x",
    windows5h,
    windowsWeekly,
    totalCostUSD,
    activitySpanDays,
    volume: over.volume ?? HIGH_VOLUME,
    ...(over.ceilingOverrides ? { ceilingOverrides: over.ceilingOverrides } : {}),
  };
}

describe("recommend — UPGRADE (persistent pressure)", () => {
  it("upgrades on a persistent 5h near-limit share (count ≥2, share ≥15%)", () => {
    // Pro: 5 of 10 windows at $4.80 (96% of the $5 ceiling), interleaved so
    // pressure exists in the recent half too.
    const costs = [4.8, 1, 4.8, 1, 4.8, 1, 4.8, 1, 4.8, 1];
    const r = recommend(input({ tier: "pro", windows5h: win(costs) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("max-5x");
    expect(r.monthlyDeltaUSD).toBe(DEFAULT_MONTHLY_USD["max-5x"] - DEFAULT_MONTHLY_USD["pro"]);
    expect(r.monthlyDeltaUSD).toBe(80);
    expect(r.confidence).toBe("high"); // share 0.5 vs 0.15 → big margin; high volume
    expect(r.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
  });

  it("upgrades on repeated near-limit WEEKLY windows even when 5h is calm", () => {
    // Pro weekly ceiling $125 → ≥$112.50 is near-limit. 2 of 3 weeks near.
    const r = recommend(
      input({
        tier: "pro",
        windows5h: win(Array(10).fill(1)),
        windowsWeekly: win([115, 120, 30], { gapMs: WEEK }),
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("max-5x");
  });

  it("does NOT upgrade on a SINGLE anomalous weekly spike (v1 regression)", () => {
    // v1 triggered on weekly PEAK ≥90% — one heavy week flipped the verdict.
    // v2 needs ≥2 near-limit weeks (or ≥50% of a short period's weeks).
    const r = recommend(
      input({
        tier: "pro",
        windows5h: win(Array(10).fill(2)), // run-rate well above PAYG cutoff
        windowsWeekly: win([113, 30, 30, 30], { gapMs: WEEK }),
      }),
    );
    expect(r.verdict).toBe("stay");
    expect(r.signals.nearLimitCountWeekly).toBe(1);
    expect(r.signals.weeklyWindows).toBe(4);
  });

  it("does NOT upgrade on a single near-limit 5h window (count < 2)", () => {
    // 1 of 4 windows near-limit = 25% share, but no absolute support.
    const r = recommend(input({ tier: "pro", windows5h: win([4.8, 1, 1, 1]) }));
    expect(r.verdict).toBe("stay");
    expect(r.signals.nearLimitCount5h).toBe(1);
  });

  it("skips PAST a tier that would also be strained (multi-step upgrade)", () => {
    // Pro windows at $30: 6× the Pro ceiling AND 120% of MAX 5x's $25 — but
    // only 30% of MAX 20x's $100. v1 would have suggested the still-too-small
    // MAX 5x; v2 goes straight to MAX 20x.
    const r = recommend(input({ tier: "pro", windows5h: win([30, 30, 30, 30, 30]) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("max-20x");
    expect(r.monthlyDeltaUSD).toBe(180); // 200 − 20
    expect(r.detail).toContain("MAX 5x");
    expect(r.detail.toLowerCase()).toContain("skip");
  });

  it("still suggests the TOP tier when even it would be strained (most headroom)", () => {
    const r = recommend(input({ tier: "pro", windows5h: win([150, 150, 150, 150, 150]) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("max-20x");
    expect(r.detail).toContain("may press even");
  });

  it("stays (honestly) at the top tier under heavy usage", () => {
    // MAX 20x: $95 windows ≥ 90% of the $100 ceiling, no higher tier exists.
    const r = recommend(
      input({ tier: "max-20x", windows5h: win([95, 95, 95, 95, 95, 95]) }),
    );
    expect(r.verdict).toBe("stay");
    expect(r.suggestedTier).toBeNull();
    expect(r.monthlyDeltaUSD).toBe(0);
    expect(r.detail).toContain("highest tier");
  });

  it("wins precedence over the pay-as-you-go downgrade (at-limit signal first)", () => {
    // Two near-limit windows 60 days apart with a long activity span: the
    // run-rate ($9.60/mo) qualifies for PAYG, but the strain must win.
    const r = recommend(
      input({
        tier: "max-5x",
        windows5h: win([24, 24], { gapMs: 60 * DAY }),
        activitySpanDays: 150,
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("max-20x");
  });
});

describe("recommend — recency gate (stale pressure)", () => {
  it("stays when all near-limit pressure sits in the EARLIER half of the period", () => {
    // First five windows pressed the Pro limit; the recent five are light.
    const costs = [4.8, 4.8, 4.8, 4.8, 4.8, 0.5, 0.5, 0.5, 0.5, 0.5];
    const r = recommend(input({ tier: "pro", windows5h: win(costs) }));
    expect(r.verdict).toBe("stay");
    expect(r.detail).toContain("Earlier in this period");
    expect(r.signals.recentPressure).toBe(false);
  });

  it("upgrades when the pressure IS recent (light early, heavy late)", () => {
    const costs = [0.5, 0.5, 0.5, 0.5, 0.5, 4.8, 4.8, 4.8, 4.8, 4.8];
    const r = recommend(input({ tier: "pro", windows5h: win(costs) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.signals.recentPressure).toBe(true);
  });
});

describe("recommend — DOWNGRADE (tier fit)", () => {
  it("downgrades when typical AND peak usage fit the smaller tier", () => {
    // MAX 5x → Pro: $2 windows are 40% of Pro's $5; weekly 32% of $125.
    const r = recommend(
      input({
        tier: "max-5x",
        windows5h: win(Array(10).fill(2)),
        windowsWeekly: win([35, 40], { gapMs: WEEK }),
      }),
    );
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("pro");
    expect(r.monthlyDeltaUSD).toBe(-(DEFAULT_MONTHLY_USD["max-5x"] - DEFAULT_MONTHLY_USD["pro"]));
    expect(r.monthlyDeltaUSD).toBe(-80);
  });

  it("tolerates a single outlier spike via the p90 typical test (v1 regression)", () => {
    // 19 windows at $2 (40% of Pro) + ONE at $4.50 (90% of Pro). v1's
    // peak-only test (peak < 70%) blocked this downgrade; v2 reads p90 = 40%
    // and peak 90% ≤ 100% → still fits.
    const costs = [...Array(10).fill(2), 4.5, ...Array(9).fill(2)];
    const r = recommend(
      input({
        tier: "max-5x",
        windows5h: win(costs),
        windowsWeekly: win([40, 45], { gapMs: WEEK }),
      }),
    );
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("pro");
  });

  it("does NOT downgrade when even one window would exceed the smaller tier", () => {
    // One $5.50 window is 110% of Pro's ceiling — peak gate fails.
    const costs = [...Array(10).fill(2), 5.5, ...Array(9).fill(2)];
    const r = recommend(input({ tier: "max-5x", windows5h: win(costs) }));
    expect(r.verdict).toBe("stay");
  });

  it("does NOT downgrade when TYPICAL usage is too high for the smaller tier", () => {
    // $4 windows = 80% of Pro typical (p90 > 70%), even though peak ≤ 100%.
    const r = recommend(input({ tier: "max-5x", windows5h: win(Array(20).fill(4)) }));
    expect(r.verdict).toBe("stay");
  });

  it("downgrades TWO steps when usage clears the smallest tier (max-20x → pro)", () => {
    const r = recommend(
      input({
        tier: "max-20x",
        windows5h: win(Array(10).fill(2)),
        windowsWeekly: win([35, 40], { gapMs: WEEK }),
      }),
    );
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("pro");
    expect(r.monthlyDeltaUSD).toBe(-180); // 200 − 20
  });

  it("downgrades one step when usage fits max-5x but not pro", () => {
    // $15 windows: 60% of MAX 5x (fits) but 300% of Pro (does not).
    const r = recommend(
      input({
        tier: "max-20x",
        windows5h: win(Array(10).fill(15)),
        windowsWeekly: win([300, 320], { gapMs: WEEK }),
      }),
    );
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("max-5x");
    expect(r.monthlyDeltaUSD).toBe(-100); // 200 − 100
  });

  it("respects per-tier ceiling OVERRIDES in the fit test (v1 inconsistency fix)", () => {
    // $4.80 windows are 96% of Pro's DEFAULT $5 ceiling → no fit. With the
    // user's own Pro override at $50, the same usage is 9.6% → fits.
    const windows5h = win(Array(10).fill(4.8));
    const without = recommend(input({ tier: "max-5x", windows5h }));
    expect(without.verdict).toBe("stay");
    const withOverride = recommend(
      input({
        tier: "max-5x",
        windows5h,
        ceilingOverrides: { pro: { fiveHourCostUSD: 50, weeklyCostUSD: 1250 } },
      }),
    );
    expect(withOverride.verdict).toBe("downgrade");
    expect(withOverride.suggestedTier).toBe("pro");
  });
});

describe("recommend — pay-as-you-go break-even", () => {
  it("recommends dropping to API pay-as-you-go when the run-rate is far below the Pro fee", () => {
    // $0.20/day × 20 days → ~$6.30/mo run-rate ≤ 60% of Pro's $20.
    const r = recommend(input({ tier: "pro", windows5h: win(Array(20).fill(0.2)) }));
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("none");
    expect(r.monthlyDeltaUSD).toBeLessThan(0);
    expect(r.headline).toContain("Pay-as-you-go");
    expect(r.detail).toContain("API list prices");
  });

  it("beats the tier-fit downgrade when PAYG is the cheapest option (max-5x → none)", () => {
    const r = recommend(input({ tier: "max-5x", windows5h: win(Array(20).fill(0.2)) }));
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("none"); // not "pro"
    // saves ≈ $100 − ~$6 run-rate.
    expect(r.monthlyDeltaUSD).toBeLessThanOrEqual(-90);
  });

  it("falls back to the tier-fit downgrade when the run-rate is above the PAYG cutoff", () => {
    // $1/day × 20 days → ~$31.60/mo run-rate > $12 cutoff, but fits Pro.
    const r = recommend(input({ tier: "max-5x", windows5h: win(Array(20).fill(1)) }));
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("pro");
  });

  it("is GATED on data volume — sparse data never suggests cancelling", () => {
    const r = recommend(
      input({ tier: "pro", windows5h: win(Array(20).fill(0.2)), volume: SPARSE_VOLUME }),
    );
    expect(r.verdict).toBe("stay"); // pro has no smaller paid tier
    expect(r.suggestedTier).toBeNull();
    expect(r.detail.toLowerCase()).toContain("sparse");
  });
});

describe("recommend — tier 'none' (subscribe break-even)", () => {
  it("suggests the smallest tier that FITS the usage and undercuts the API run-rate", () => {
    // $40 windows daily → run-rate ≈ $1,263/mo. Pro and MAX 5x would both be
    // strained; MAX 20x fits and costs $200 ≤ 80% of the run-rate.
    const r = recommend(input({ tier: "none", windows5h: win(Array(20).fill(40)) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("max-20x");
    expect(r.headline).toContain("subscribing");
    expect(r.monthlyDeltaUSD).toBeLessThan(0); // flat fee saves vs API spend
  });

  it("suggests Pro for a moderate API user whose usage fits Pro's limits", () => {
    // $2/day → run-rate ≈ $62/mo; Pro $20 ≤ 80% of that and unstrained.
    const r = recommend(input({ tier: "none", windows5h: win(Array(30).fill(2)) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("pro");
    expect(r.monthlyDeltaUSD).toBeLessThan(0);
  });

  it("stays neutral for a light API user (no tier beats the run-rate)", () => {
    const r = recommend(input({ tier: "none", windows5h: win(Array(10).fill(0.2)) }));
    expect(r.verdict).toBe("neutral");
    expect(r.suggestedTier).toBeNull();
    expect(r.monthlyDeltaUSD).toBe(0);
    expect(r.detail).toContain("/mo");
  });

  it("stays neutral on sparse data regardless of a heavy run-rate", () => {
    const r = recommend(
      input({ tier: "none", windows5h: win(Array(10).fill(40)), volume: SPARSE_VOLUME }),
    );
    expect(r.verdict).toBe("neutral");
  });

  it("stays neutral with zero usage", () => {
    const r = recommend(input({ tier: "none" }));
    expect(r.verdict).toBe("neutral");
    expect(r.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
  });
});

describe("recommend — STAY (healthy band)", () => {
  it("stays when neither strained nor fitting a smaller tier", () => {
    // MAX 5x: $4 windows = 16% of the tier (calm) but 80% of Pro (no fit).
    const r = recommend(input({ tier: "max-5x", windows5h: win(Array(10).fill(4)) }));
    expect(r.verdict).toBe("stay");
    expect(r.suggestedTier).toBeNull();
    expect(r.monthlyDeltaUSD).toBe(0);
    expect(r.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
  });
});

describe("computeTrend", () => {
  it("detects rising usage (recent half ≥1.35× earlier)", () => {
    expect(computeTrend(win([1, 1, 1, 8, 8, 8]))).toBe("rising");
  });

  it("detects falling usage (recent half ≤0.74× earlier)", () => {
    expect(computeTrend(win([8, 8, 8, 1, 1, 1]))).toBe("falling");
  });

  it("reports flat for steady usage", () => {
    expect(computeTrend(win([2, 2, 2, 2.2, 2, 2]))).toBe("flat");
  });

  it("reports unknown with fewer than 6 windows", () => {
    expect(computeTrend(win([1, 1, 8, 8, 8]))).toBe("unknown");
  });

  it("reports unknown when one half has too few windows (degenerate split)", () => {
    const skewed = [
      ...win([1, 1, 1, 1, 1], { gapMs: HOUR * 6 }),
      ...win([9], { startMs: BASE + 100 * DAY }),
    ];
    expect(computeTrend(skewed)).toBe("unknown");
  });
});

describe("recommend — confidence (volume × margin × trend)", () => {
  it("is HIGH when volume is high AND the margin is large", () => {
    const costs = [4.8, 1, 4.8, 1, 4.8, 1, 4.8, 1, 4.8, 1]; // share 0.5 ≫ 0.15
    const r = recommend(input({ tier: "pro", windows5h: win(costs) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.confidence).toBe("high");
  });

  it("is LOW (and softens the detail) when data is sparse, even with a big margin", () => {
    const r = recommend(
      input({
        tier: "pro",
        windows5h: win([4.8, 4.8, 4.8]),
        volume: SPARSE_VOLUME,
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.confidence).toBe("low");
    expect(r.detail.toLowerCase()).toContain("sparse");
    expect(r.confidenceReason.toLowerCase()).toContain("sparse");
  });

  it("is LOW when the margin is tiny even with high volume (borderline signal)", () => {
    // Exactly 3 of 20 near-limit = 15.0% — right at the threshold.
    const costs = Array(20).fill(1) as number[];
    costs[0] = 4.8;
    costs[10] = 4.8;
    costs[19] = 4.8;
    const r = recommend(input({ tier: "pro", windows5h: win(costs) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.confidence).toBe("low");
    expect(r.confidenceReason.toLowerCase()).toContain("threshold");
  });

  it("caps confidence at MEDIUM when the trend contradicts the verdict", () => {
    // Strong upgrade signal but usage falling hard: $20 windows early,
    // $4.60 (still near-limit) recently → upgrade with capped confidence.
    const costs = [20, 20, 20, 20, 20, 4.6, 4.6, 4.6, 4.6, 4.6];
    const r = recommend(input({ tier: "pro", windows5h: win(costs) }));
    expect(r.verdict).toBe("upgrade");
    expect(r.trend).toBe("falling");
    expect(r.confidence).toBe("medium");
    expect(r.confidenceReason.toLowerCase()).toContain("trending down");
  });

  it("does NOT say 'sparse' when confidence is low only because the margin is borderline", () => {
    const costs = Array(20).fill(1) as number[];
    costs[0] = 4.8;
    costs[10] = 4.8;
    costs[19] = 4.8;
    const r = recommend(input({ tier: "pro", windows5h: win(costs) }));
    expect(r.confidence).toBe("low");
    expect(r.detail).not.toContain("sparse");
  });
});

describe("recommend — signals payload (transparency)", () => {
  it("exposes the per-axis evidence behind the verdict", () => {
    const r = recommend(
      input({
        tier: "pro",
        windows5h: win(Array(10).fill(2)),
        windowsWeekly: win([113, 30, 30, 30], { gapMs: WEEK }),
      }),
    );
    expect(r.signals.activeWindows5h).toBe(10);
    expect(r.signals.weeklyWindows).toBe(4);
    expect(r.signals.nearLimitCount5h).toBe(0);
    expect(r.signals.nearLimitCountWeekly).toBe(1);
    expect(r.signals.monthlyRunRateUSD).toBeGreaterThan(0);
    expect(r.signals.bestFitTier).toBe("pro");
    expect(["rising", "falling", "flat", "unknown"]).toContain(r.signals.trend);
  });

  it("reports the best-fit tier as the smallest unstrained tier", () => {
    // $30 windows strain pro AND max-5x; max-20x is the smallest that copes.
    const r = recommend(input({ tier: "pro", windows5h: win(Array(5).fill(30)) }));
    expect(r.signals.bestFitTier).toBe("max-20x");
  });
});

describe("recommend — threshold constants are the spec values", () => {
  it("exposes the exact §5.2 v2 thresholds", () => {
    expect(NEAR_LIMIT_FILL).toBe(0.9);
    expect(UPGRADE_NEAR_LIMIT_SHARE).toBe(0.15);
    expect(STRAIN_MIN_NEAR_LIMIT_WINDOWS).toBe(2);
    expect(WEEKLY_STRAIN_MIN_WINDOWS).toBe(2);
    expect(WEEKLY_STRAIN_SHARE).toBe(0.5);
    expect(DOWNGRADE_FILL).toBe(0.7);
    expect(DOWNGRADE_PEAK_FILL).toBe(1.0);
    expect(PAYG_BREAK_EVEN_RATIO).toBe(0.6);
    expect(SUBSCRIBE_FEE_SHARE).toBe(0.8);
  });
});

describe("describeFill — graceful over-limit copy", () => {
  it("shows the exact percent at or under the estimated limit", () => {
    expect(describeFill(0)).toBe("~0% of the estimated limit");
    expect(describeFill(0.5)).toBe("~50% of the estimated limit");
    expect(describeFill(1)).toBe("~100% of the estimated limit");
  });

  it("flags modestly-over usage but still shows the percent", () => {
    expect(describeFill(1.25)).toBe("~125% of the estimated limit (over the estimate)");
  });

  it("goes qualitative far over the limit (never prints an absurd %)", () => {
    expect(describeFill(191.66)).toBe("well above the estimated limit");
    expect(describeFill(9.58)).toBe("well above the estimated limit");
  });
});
