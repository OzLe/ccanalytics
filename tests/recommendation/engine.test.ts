/**
 * @module tests/recommendation/engine
 *
 * Pure-unit tests for the recommendation engine (§5, §7.1). No DB.
 *
 * The engine re-expresses observed peaks against the tier-DOWN tier's PUBLISHED
 * default ceilings (DEFAULT_TIER_LIMITS), so the test fixtures choose peak
 * request/token counts relative to those known numbers.
 */

import { describe, it, expect } from "vitest";
import {
  recommend,
  describeFill,
  NEAR_LIMIT_FILL,
  UPGRADE_NEAR_LIMIT_SHARE,
  UPGRADE_WEEKLY_PEAK,
  DOWNGRADE_FILL,
  type RecommendationInput,
} from "../../src/recommendation/engine.js";
import {
  DEFAULT_TIER_LIMITS,
  RECOMMENDATION_ESTIMATE_CAVEAT,
} from "../../src/config/limits.js";
import { DEFAULT_MONTHLY_USD } from "../../src/config/subscription.js";
import type { WindowStats } from "../../src/recommendation/windows.js";
import type { SubscriptionTier } from "../../src/types/config.js";
import type { ObservedPeakUsage, DataVolume } from "../../src/recommendation/engine.js";

/** Build a WindowStats with sensible defaults, overriding a few fields. */
function stats(partial: Partial<WindowStats> = {}): WindowStats {
  return {
    activeWindows: 0,
    peakFill: 0,
    p95Fill: 0,
    medianFill: 0,
    nearLimitWindows: 0,
    peakRequests: 0,
    peakTokens: 0,
    ...partial,
  };
}

/** Build raw observed peaks, defaulting every field to 0. */
function peaks(partial: Partial<ObservedPeakUsage> = {}): ObservedPeakUsage {
  return {
    fiveHourPeakRequests: 0,
    fiveHourPeakTokens: 0,
    weeklyPeakRequests: 0,
    weeklyPeakTokens: 0,
    ...partial,
  };
}

/** High-volume signal (drives volumeConfidence to "high"). */
const HIGH_VOLUME: DataVolume = { activeDays: 20, activeWindows: 30, recencyDays: 1 };
/** Sparse signal (drives volumeConfidence to "low"). */
const SPARSE_VOLUME: DataVolume = { activeDays: 1, activeWindows: 1, recencyDays: 40 };

function input(over: Partial<RecommendationInput>): RecommendationInput {
  const tier: SubscriptionTier = over.tier ?? "max-5x";
  return {
    tier,
    fiveHour: stats(),
    weekly: stats(),
    peaks: peaks(),
    ceilings: DEFAULT_TIER_LIMITS[tier],
    volume: HIGH_VOLUME,
    ...over,
  };
}

describe("recommend — UPGRADE", () => {
  it("upgrades when near-limit share ≥ 0.15 (5h axis)", () => {
    // 4 of 20 windows near-limit = 0.20 ≥ 0.15.
    const r = recommend(
      input({
        tier: "max-5x",
        fiveHour: stats({ activeWindows: 20, nearLimitWindows: 4, peakFill: 0.95 }),
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("max-20x");
    // $ delta = price gap from the SSOT.
    expect(r.monthlyDeltaUSD).toBe(
      DEFAULT_MONTHLY_USD["max-20x"] - DEFAULT_MONTHLY_USD["max-5x"],
    );
    expect(r.monthlyDeltaUSD).toBe(100); // 200 − 100
    expect(r.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
  });

  it("upgrades when the weekly peak fill ≥ 0.90 even if 5h share is low", () => {
    const r = recommend(
      input({
        tier: "pro",
        fiveHour: stats({ activeWindows: 20, nearLimitWindows: 0 }),
        weekly: stats({ peakFill: 0.93 }),
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.suggestedTier).toBe("max-5x");
    expect(r.monthlyDeltaUSD).toBe(DEFAULT_MONTHLY_USD["max-5x"] - DEFAULT_MONTHLY_USD["pro"]);
    expect(r.monthlyDeltaUSD).toBe(80); // 100 − 20
  });

  it("does NOT upgrade at the top tier (max-20x); falls through to stay/downgrade", () => {
    const r = recommend(
      input({
        tier: "max-20x",
        fiveHour: stats({ activeWindows: 20, nearLimitWindows: 10, peakFill: 1.5 }),
        weekly: stats({ peakFill: 1.2 }),
        // High raw peaks so it cannot downgrade either → stay.
        peaks: peaks({
          fiveHourPeakRequests: 900,
          weeklyPeakRequests: 22500,
        }),
      }),
    );
    expect(r.verdict).toBe("stay");
    expect(r.suggestedTier).toBeNull();
    expect(r.monthlyDeltaUSD).toBe(0);
  });
});

describe("recommend — DOWNGRADE", () => {
  it("downgrades only when BOTH 5h & weekly peak < 0.70 of the tier-DOWN ceiling", () => {
    // max-5x → pro. Pro 5h req ceiling = 45 (×0.70 = 31.5), weekly = 1125 (×0.70 = 787.5).
    const r = recommend(
      input({
        tier: "max-5x",
        peaks: peaks({
          fiveHourPeakRequests: 20, // 20/45 = 0.44 < 0.70
          weeklyPeakRequests: 300, // 300/1125 = 0.27 < 0.70
        }),
      }),
    );
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("pro");
    // $ delta is NEGATIVE (savings) = current − down.
    expect(r.monthlyDeltaUSD).toBe(
      -(DEFAULT_MONTHLY_USD["max-5x"] - DEFAULT_MONTHLY_USD["pro"]),
    );
    expect(r.monthlyDeltaUSD).toBe(-80);
  });

  it("does NOT downgrade when the WEEKLY peak alone exceeds the headroom band", () => {
    // 5h fits pro, but weekly peak 1000/1125 = 0.89 ≥ 0.70 → not both < 0.70 → stay.
    const r = recommend(
      input({
        tier: "max-5x",
        peaks: peaks({ fiveHourPeakRequests: 10, weeklyPeakRequests: 1000 }),
      }),
    );
    expect(r.verdict).toBe("stay");
  });

  it("does NOT downgrade at the bottom tier (pro); stays", () => {
    const r = recommend(
      input({
        tier: "pro",
        peaks: peaks({ fiveHourPeakRequests: 1, weeklyPeakRequests: 1 }),
      }),
    );
    expect(r.verdict).toBe("stay");
    expect(r.suggestedTier).toBeNull();
  });

  it("can downgrade on the TOKEN dimension (low requests, high tokens still fits)", () => {
    // max-20x → max-5x. max-5x token ceil 5h = 225*35000 = 7,875,000 (×0.7 = 5,512,500).
    // weekly token ceil = 5625*35000 = 196,875,000 (×0.7 = 137,812,500).
    const r = recommend(
      input({
        tier: "max-20x",
        peaks: peaks({
          fiveHourPeakRequests: 50, // 50/225 = 0.22
          fiveHourPeakTokens: 1_000_000, // 1e6/7.875e6 = 0.13
          weeklyPeakRequests: 1000, // 1000/5625 = 0.18
          weeklyPeakTokens: 50_000_000, // 5e7/1.96875e8 = 0.25
        }),
      }),
    );
    expect(r.verdict).toBe("downgrade");
    expect(r.suggestedTier).toBe("max-5x");
    expect(r.monthlyDeltaUSD).toBe(-(DEFAULT_MONTHLY_USD["max-20x"] - DEFAULT_MONTHLY_USD["max-5x"]));
  });
});

describe("recommend — STAY", () => {
  it("stays in the healthy band (neither up nor down signal)", () => {
    // max-5x: not near-limit, but peak vs pro is ≥ 0.70 so cannot downgrade.
    const r = recommend(
      input({
        tier: "max-5x",
        fiveHour: stats({ activeWindows: 20, nearLimitWindows: 1, peakFill: 0.5 }),
        weekly: stats({ peakFill: 0.5 }),
        peaks: peaks({ fiveHourPeakRequests: 40, weeklyPeakRequests: 1000 }),
      }),
    );
    expect(r.verdict).toBe("stay");
    expect(r.suggestedTier).toBeNull();
    expect(r.monthlyDeltaUSD).toBe(0);
    expect(r.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
  });
});

describe("recommend — NEUTRAL (tier none)", () => {
  it("returns neutral with no suggestion for API pay-as-you-go", () => {
    const r = recommend(
      input({
        tier: "none",
        ceilings: DEFAULT_TIER_LIMITS.none,
        fiveHour: stats({ activeWindows: 10, nearLimitWindows: 10, peakFill: 9 }),
        weekly: stats({ peakFill: 9 }),
        peaks: peaks({ fiveHourPeakRequests: 5000 }),
      }),
    );
    expect(r.verdict).toBe("neutral");
    expect(r.suggestedTier).toBeNull();
    expect(r.monthlyDeltaUSD).toBe(0);
    expect(r.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
  });
});

describe("recommend — confidence (§5.3: min of volume & margin)", () => {
  it("is HIGH when volume is high AND the margin is large", () => {
    // Upgrade: share 0.50 vs 0.15 → margin 0.35 ≥ 0.15 → high; volume high → high.
    const r = recommend(
      input({
        tier: "max-5x",
        volume: HIGH_VOLUME,
        fiveHour: stats({ activeWindows: 20, nearLimitWindows: 10, peakFill: 1.0 }),
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.confidence).toBe("high");
  });

  it("is LOW (and softens the detail) when data is sparse, even with a big margin", () => {
    const r = recommend(
      input({
        tier: "max-5x",
        volume: SPARSE_VOLUME, // → low volume axis
        fiveHour: stats({ activeWindows: 1, nearLimitWindows: 1, peakFill: 1.0 }),
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.confidence).toBe("low"); // min(low, high) = low
    expect(r.detail.toLowerCase()).toContain("sparse");
    expect(r.confidenceReason.toLowerCase()).toContain("sparse");
  });

  it("is MEDIUM when volume is medium and margin is high", () => {
    // medium volume: activeDays 5, activeWindows 6 (not high), recency large.
    const r = recommend(
      input({
        tier: "max-5x",
        volume: { activeDays: 5, activeWindows: 6, recencyDays: 10 },
        fiveHour: stats({ activeWindows: 6, nearLimitWindows: 6, peakFill: 1.0 }),
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.confidence).toBe("medium"); // min(medium, high) = medium
  });

  it("is LOW when the margin is tiny even with high volume (borderline signal)", () => {
    // Upgrade share exactly at threshold → margin ~0 → low margin axis.
    // 3 of 20 = 0.15 exactly ≥ 0.15 triggers; margin = 0 → low.
    const r = recommend(
      input({
        tier: "max-5x",
        volume: HIGH_VOLUME,
        fiveHour: stats({ activeWindows: 20, nearLimitWindows: 3, peakFill: 0.95 }),
      }),
    );
    expect(r.verdict).toBe("upgrade");
    expect(r.confidence).toBe("low"); // min(high, low) = low
    expect(r.confidenceReason.toLowerCase()).toContain("threshold");
  });
});

describe("recommend — threshold constants are the spec values", () => {
  it("exposes the exact §5.2 thresholds", () => {
    expect(NEAR_LIMIT_FILL).toBe(0.9);
    expect(UPGRADE_NEAR_LIMIT_SHARE).toBe(0.15);
    expect(UPGRADE_WEEKLY_PEAK).toBe(0.9);
    expect(DOWNGRADE_FILL).toBe(0.7);
  });

  it("evaluates UPGRADE before DOWNGRADE (at-limit wins edge cases)", () => {
    // Construct a row where the 5h near-limit fires AND raw peaks look small vs
    // the down tier. Upgrade must win.
    const r = recommend(
      input({
        tier: "max-5x",
        fiveHour: stats({ activeWindows: 20, nearLimitWindows: 5, peakFill: 1.0 }),
        weekly: stats({ peakFill: 0.1 }),
        peaks: peaks({ fiveHourPeakRequests: 1, weeklyPeakRequests: 1 }),
      }),
    );
    expect(r.verdict).toBe("upgrade");
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
    // Decision stats use absolute ceilings, so a heavy user's fill can be huge
    // (e.g. 191.66 → 19166%); copy must not print that.
    expect(describeFill(191.66)).toBe("well above the estimated limit");
    expect(describeFill(9.58)).toBe("well above the estimated limit");
  });
});
