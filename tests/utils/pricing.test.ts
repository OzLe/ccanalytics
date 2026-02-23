/**
 * @module tests/utils/pricing
 *
 * Unit tests for the calculateCost utility.
 */

import { describe, it, expect } from "vitest";
import { calculateCost } from "../../src/utils/pricing.js";

describe("calculateCost", () => {
  it("should calculate cost for claude-sonnet-4-5", () => {
    // Sonnet: $3/MTok input, $15/MTok output
    const cost = calculateCost("claude-sonnet-4-5", 1_000_000, 100_000, 0, 0);
    // 1M input * $3/MTok + 100K output * $15/MTok = $3 + $1.5 = $4.5
    expect(cost).toBeCloseTo(4.5, 1);
  });

  it("should calculate cost for claude-opus-4", () => {
    // Opus: $15/MTok input, $75/MTok output
    const cost = calculateCost("claude-opus-4", 1_000_000, 100_000, 0, 0);
    // 1M input * $15/MTok + 100K output * $75/MTok = $15 + $7.5 = $22.5
    expect(cost).toBeCloseTo(22.5, 1);
  });

  it("should handle cache tokens", () => {
    const cost = calculateCost("claude-sonnet-4-5", 500_000, 100_000, 200_000, 300_000);
    expect(cost).toBeGreaterThan(0);
  });

  it("should return 0 for zero tokens", () => {
    const cost = calculateCost("claude-sonnet-4-5", 0, 0, 0, 0);
    expect(cost).toBe(0);
  });

  it("should use default pricing for unknown model", () => {
    const cost = calculateCost("unknown-model", 1_000_000, 0, 0, 0);
    expect(cost).toBeGreaterThan(0);
  });

  it("should match model by prefix (case insensitive)", () => {
    const cost1 = calculateCost("claude-sonnet-4-5-20260101", 1_000_000, 0, 0, 0);
    const cost2 = calculateCost("claude-sonnet-4-5", 1_000_000, 0, 0, 0);
    expect(cost1).toBe(cost2);
  });
});
