/**
 * @module tests/config/limits
 *
 * Pure-unit tests for the ceilings SSOT (§3, §7.1): resolveCeilings deep-merge,
 * auto-calibration math, and the divide-by-zero-safe "none" sentinel.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIER_LIMITS,
  AVG_TOKENS_PER_REQUEST,
  WEEKLY_WINDOWS_PER_WEEK,
  PAID_TIER_ORDER,
  RECOMMENDATION_ESTIMATE_CAVEAT,
  resolveCeilings,
  calibrateCeilings,
} from "../../src/config/limits.js";

describe("DEFAULT_TIER_LIMITS (SSOT estimates)", () => {
  it("derives token ceilings from request ceilings × AVG_TOKENS_PER_REQUEST", () => {
    expect(DEFAULT_TIER_LIMITS.pro.fiveHourRequests).toBe(45);
    expect(DEFAULT_TIER_LIMITS.pro.fiveHourTokens).toBe(45 * AVG_TOKENS_PER_REQUEST);
    expect(DEFAULT_TIER_LIMITS["max-5x"].fiveHourRequests).toBe(225);
    expect(DEFAULT_TIER_LIMITS["max-20x"].fiveHourRequests).toBe(900);
  });

  it("derives weekly requests from fiveHourRequests × WEEKLY_WINDOWS_PER_WEEK", () => {
    expect(WEEKLY_WINDOWS_PER_WEEK).toBe(25);
    expect(DEFAULT_TIER_LIMITS.pro.weeklyRequests).toBe(45 * 25); // 1125
    expect(DEFAULT_TIER_LIMITS["max-5x"].weeklyRequests).toBe(225 * 25); // 5625
    expect(DEFAULT_TIER_LIMITS["max-20x"].weeklyRequests).toBe(900 * 25); // 22500
    expect(DEFAULT_TIER_LIMITS["max-20x"].weeklyTokens).toBe(900 * 25 * AVG_TOKENS_PER_REQUEST);
  });

  it("uses zero sentinels for 'none' (API pay-as-you-go)", () => {
    expect(DEFAULT_TIER_LIMITS.none).toEqual({
      fiveHourRequests: 0,
      fiveHourTokens: 0,
      weeklyRequests: 0,
      weeklyTokens: 0,
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
    const merged = resolveCeilings("pro", { pro: { fiveHourRequests: 60 } });
    expect(merged.fiveHourRequests).toBe(60); // overridden
    expect(merged.fiveHourTokens).toBe(DEFAULT_TIER_LIMITS.pro.fiveHourTokens); // default
    expect(merged.weeklyRequests).toBe(DEFAULT_TIER_LIMITS.pro.weeklyRequests); // default
  });

  it("ignores overrides for other tiers", () => {
    const merged = resolveCeilings("pro", { "max-5x": { fiveHourRequests: 999 } });
    expect(merged).toEqual(DEFAULT_TIER_LIMITS.pro);
  });

  it("drops NaN / negative / non-finite override values (falls back to default)", () => {
    const merged = resolveCeilings("max-5x", {
      "max-5x": {
        fiveHourRequests: -10,
        fiveHourTokens: Number.NaN,
        weeklyRequests: Infinity,
        weeklyTokens: 1234,
      },
    });
    expect(merged.fiveHourRequests).toBe(DEFAULT_TIER_LIMITS["max-5x"].fiveHourRequests);
    expect(merged.fiveHourTokens).toBe(DEFAULT_TIER_LIMITS["max-5x"].fiveHourTokens);
    expect(merged.weeklyRequests).toBe(DEFAULT_TIER_LIMITS["max-5x"].weeklyRequests);
    expect(merged.weeklyTokens).toBe(1234); // the one valid override survives
  });

  it("allows zero as a valid override (>= 0)", () => {
    const merged = resolveCeilings("pro", { pro: { fiveHourRequests: 0 } });
    expect(merged.fiveHourRequests).toBe(0);
  });
});

describe("calibrateCeilings (auto-calibration, §3.3)", () => {
  const base = DEFAULT_TIER_LIMITS.pro; // 45 / 1.575M / 1125 / 39.375M

  it("raises a ceiling to the observed peak when the peak exceeds the default", () => {
    const result = calibrateCeilings(base, {
      fiveHourRequests: 80, // > 45 → raised
      fiveHourTokens: base.fiveHourTokens, // == default → not raised
      weeklyRequests: base.weeklyRequests,
      weeklyTokens: base.weeklyTokens,
    });
    expect(result.calibrated.fiveHourRequests).toBe(80);
    expect(result.calibratedFlags.fiveHourRequests).toBe(true);
    expect(result.calibratedFlags.fiveHourTokens).toBe(false);
    expect(result.ceilingSource).toBe("calibrated");
    // Untouched dimensions keep the default.
    expect(result.calibrated.weeklyRequests).toBe(base.weeklyRequests);
  });

  it("leaves ceilings at default and reports source 'default' when no peak exceeds", () => {
    const result = calibrateCeilings(base, {
      fiveHourRequests: 10,
      fiveHourTokens: 100,
      weeklyRequests: 50,
      weeklyTokens: 100,
    });
    expect(result.calibrated).toEqual(base);
    expect(result.ceilingSource).toBe("default");
    expect(Object.values(result.calibratedFlags).every((f) => f === false)).toBe(true);
  });

  it("does NOT raise when the peak exactly equals the default (strict >)", () => {
    const result = calibrateCeilings(base, {
      fiveHourRequests: 45, // == default → no raise
      fiveHourTokens: 0,
      weeklyRequests: 0,
      weeklyTokens: 0,
    });
    expect(result.calibratedFlags.fiveHourRequests).toBe(false);
    expect(result.ceilingSource).toBe("default");
  });

  it("does not mutate the input default ceilings object", () => {
    const snapshot = { ...base };
    calibrateCeilings(base, {
      fiveHourRequests: 999,
      fiveHourTokens: 999,
      weeklyRequests: 999,
      weeklyTokens: 999,
    });
    expect(base).toEqual(snapshot);
  });

  it("'none' ceilings stay zero (no divide-by-zero downstream)", () => {
    // With autoCalibrate the 'none' tier never produces a usable ceiling because
    // its peaks would be measured against a 0 denominator (fill 0). resolveCeilings
    // returns the zero sentinels; calibration only raises if a peak > 0 default,
    // which for a neutral 'none' verdict path is never used as a denominator.
    expect(resolveCeilings("none")).toEqual({
      fiveHourRequests: 0,
      fiveHourTokens: 0,
      weeklyRequests: 0,
      weeklyTokens: 0,
    });
  });
});
