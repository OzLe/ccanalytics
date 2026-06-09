/**
 * @module tests/config/limits
 *
 * Pure-unit tests for the ceilings SSOT (§3, §7.1): resolveCeilings deep-merge,
 * auto-calibration math, and the divide-by-zero-safe "none" sentinel. Ceilings
 * are now expressed in API-equivalent USD per rolling window — the unit
 * Anthropic's limits scale with.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIER_LIMITS,
  WEEKLY_WINDOWS_PER_WEEK,
  PAID_TIER_ORDER,
  RECOMMENDATION_ESTIMATE_CAVEAT,
  resolveCeilings,
  calibrateCeilings,
} from "../../src/config/limits.js";

describe("DEFAULT_TIER_LIMITS (SSOT estimates)", () => {
  it("scales the 5h cost ceiling 1x/5x/20x from a Pro base of $5", () => {
    expect(DEFAULT_TIER_LIMITS.pro.fiveHourCostUSD).toBe(5);
    expect(DEFAULT_TIER_LIMITS["max-5x"].fiveHourCostUSD).toBe(25);
    expect(DEFAULT_TIER_LIMITS["max-20x"].fiveHourCostUSD).toBe(100);
  });

  it("derives the weekly cost ceiling from fiveHourCostUSD × WEEKLY_WINDOWS_PER_WEEK", () => {
    expect(WEEKLY_WINDOWS_PER_WEEK).toBe(25);
    expect(DEFAULT_TIER_LIMITS.pro.weeklyCostUSD).toBe(5 * 25); // 125
    expect(DEFAULT_TIER_LIMITS["max-5x"].weeklyCostUSD).toBe(25 * 25); // 625
    expect(DEFAULT_TIER_LIMITS["max-20x"].weeklyCostUSD).toBe(100 * 25); // 2500
  });

  it("uses zero sentinels for 'none' (API pay-as-you-go)", () => {
    expect(DEFAULT_TIER_LIMITS.none).toEqual({
      fiveHourCostUSD: 0,
      weeklyCostUSD: 0,
    });
  });

  it("orders paid tiers ascending, excluding none", () => {
    expect(PAID_TIER_ORDER).toEqual(["pro", "max-5x", "max-20x"]);
  });

  it("exposes the estimate caveat string", () => {
    expect(RECOMMENDATION_ESTIMATE_CAVEAT).toContain("Estimate from local session data");
  });
});

describe("resolveCeilings (deep per-dimension merge)", () => {
  it("returns the defaults verbatim when no overrides are given", () => {
    expect(resolveCeilings("pro")).toEqual(DEFAULT_TIER_LIMITS.pro);
    // Defensive copy — not the same object reference.
    expect(resolveCeilings("pro")).not.toBe(DEFAULT_TIER_LIMITS.pro);
  });

  it("merges a single overridden dimension over the defaults", () => {
    const merged = resolveCeilings("pro", { pro: { fiveHourCostUSD: 9 } });
    expect(merged.fiveHourCostUSD).toBe(9); // overridden
    expect(merged.weeklyCostUSD).toBe(DEFAULT_TIER_LIMITS.pro.weeklyCostUSD); // default
  });

  it("ignores overrides for other tiers", () => {
    const merged = resolveCeilings("pro", { "max-5x": { fiveHourCostUSD: 999 } });
    expect(merged).toEqual(DEFAULT_TIER_LIMITS.pro);
  });

  it("drops NaN / negative / non-finite override values (falls back to default)", () => {
    const merged = resolveCeilings("max-5x", {
      "max-5x": {
        fiveHourCostUSD: -10,
        weeklyCostUSD: 1234,
      },
    });
    expect(merged.fiveHourCostUSD).toBe(DEFAULT_TIER_LIMITS["max-5x"].fiveHourCostUSD);
    expect(merged.weeklyCostUSD).toBe(1234); // the one valid override survives
  });

  it("drops NaN and Infinity overrides", () => {
    const merged = resolveCeilings("pro", {
      pro: { fiveHourCostUSD: Number.NaN, weeklyCostUSD: Infinity },
    });
    expect(merged).toEqual(DEFAULT_TIER_LIMITS.pro);
  });

  it("allows zero as a valid override (>= 0)", () => {
    const merged = resolveCeilings("pro", { pro: { fiveHourCostUSD: 0 } });
    expect(merged.fiveHourCostUSD).toBe(0);
  });
});

describe("calibrateCeilings (auto-calibration, §3.3)", () => {
  const base = DEFAULT_TIER_LIMITS.pro; // { fiveHourCostUSD: 5, weeklyCostUSD: 125 }

  it("raises a cost ceiling to the observed peak when the peak exceeds the default", () => {
    const result = calibrateCeilings(base, {
      fiveHourCostUSD: 12, // > 5 → raised
      weeklyCostUSD: base.weeklyCostUSD, // == default → not raised
    });
    expect(result.calibrated.fiveHourCostUSD).toBe(12);
    expect(result.calibratedFlags.fiveHourCostUSD).toBe(true);
    expect(result.calibratedFlags.weeklyCostUSD).toBe(false);
    expect(result.ceilingSource).toBe("calibrated");
    // Untouched dimensions keep the default.
    expect(result.calibrated.weeklyCostUSD).toBe(base.weeklyCostUSD);
  });

  it("leaves ceilings at default and reports source 'default' when no peak exceeds", () => {
    const result = calibrateCeilings(base, {
      fiveHourCostUSD: 2,
      weeklyCostUSD: 50,
    });
    expect(result.calibrated).toEqual(base);
    expect(result.ceilingSource).toBe("default");
    expect(Object.values(result.calibratedFlags).every((f) => f === false)).toBe(true);
  });

  it("does NOT raise when the peak exactly equals the default (strict >)", () => {
    const result = calibrateCeilings(base, {
      fiveHourCostUSD: 5, // == default → no raise
      weeklyCostUSD: 0,
    });
    expect(result.calibratedFlags.fiveHourCostUSD).toBe(false);
    expect(result.ceilingSource).toBe("default");
  });

  it("does not mutate the input default ceilings object", () => {
    const snapshot = { ...base };
    calibrateCeilings(base, {
      fiveHourCostUSD: 999,
      weeklyCostUSD: 999,
    });
    expect(base).toEqual(snapshot);
  });

  it("'none' ceilings stay zero (no divide-by-zero downstream)", () => {
    // With autoCalibrate the 'none' tier never produces a usable ceiling because
    // its peaks would be measured against a 0 denominator (fill 0). resolveCeilings
    // returns the zero sentinels; calibration only raises if a peak > 0 default,
    // which for a neutral 'none' verdict path is never used as a denominator.
    expect(resolveCeilings("none")).toEqual({
      fiveHourCostUSD: 0,
      weeklyCostUSD: 0,
    });
  });
});
