/**
 * @module tests/queries/skill-thresholds
 *
 * Unit tests for the pure helpers in `src/queries/skill-thresholds.ts` —
 * the constants module shared by the CLI analyzer and the dashboard API
 * (mirrored by `dashboard/src/lib/skillThresholds.ts`). No DB required.
 *
 * SEM2-287: `estimateSkillTokens` is the JS counterpart of the SQL expression
 *
 *     COALESCE(CEIL(LENGTH(skill_description) / 4.0), 45)
 *
 * used in `v_skill_loaded` and the inline skill SQL. These tests lock the
 * helper's contract so the CLI and the API can never disagree on per-skill
 * estimates, and so the flat fallback is preserved exactly where the spec
 * says it must be (NULL / empty description).
 */

import { describe, it, expect } from "vitest";
import {
  DEAD_WEIGHT_RATIO_THRESHOLD,
  LOADED_CONTEXT_SHARE_THRESHOLD,
  SKILL_THRASH_MIN,
  FLAT_SKILL_TOKEN_ESTIMATE,
  estimateSkillTokens,
  isKnownReentrantSkill,
  KNOWN_REENTRANT_SKILLS,
} from "../../src/queries/skill-thresholds.js";

describe("skill-thresholds constants", () => {
  it("exposes the locked D10/D11/D12 heuristic constants", () => {
    expect(DEAD_WEIGHT_RATIO_THRESHOLD).toBe(0.5);
    expect(LOADED_CONTEXT_SHARE_THRESHOLD).toBe(0.05);
    expect(SKILL_THRASH_MIN).toBe(2);
    // SEM2-287: kept exported as the documented fallback for null/empty
    // descriptions, no longer the default estimate.
    expect(FLAT_SKILL_TOKEN_ESTIMATE).toBe(45);
  });

  it("KNOWN_REENTRANT_SKILLS includes the locked R3 set", () => {
    expect(KNOWN_REENTRANT_SKILLS).toContain("babysitter:babysit");
    expect(KNOWN_REENTRANT_SKILLS).toContain("loop");
    expect(KNOWN_REENTRANT_SKILLS).toContain("schedule");
    expect(KNOWN_REENTRANT_SKILLS).toContain("handoff");
  });
});

describe("isKnownReentrantSkill", () => {
  it("returns true for a known re-entrant skill, case-insensitively", () => {
    expect(isKnownReentrantSkill("loop")).toBe(true);
    expect(isKnownReentrantSkill("Loop")).toBe(true);
    expect(isKnownReentrantSkill("BABYSITTER:BABYSIT")).toBe(true);
  });

  it("returns false for an unknown skill or for null / undefined", () => {
    expect(isKnownReentrantSkill("skill-alpha")).toBe(false);
    expect(isKnownReentrantSkill(null)).toBe(false);
    expect(isKnownReentrantSkill(undefined)).toBe(false);
    expect(isKnownReentrantSkill("")).toBe(false);
  });
});

describe("estimateSkillTokens (SEM2-287)", () => {
  it("computes CEIL(length/4) for non-empty descriptions", () => {
    // Exact-multiple lengths: CEIL is a no-op.
    expect(estimateSkillTokens("x".repeat(4))).toBe(1);
    expect(estimateSkillTokens("x".repeat(8))).toBe(2);
    expect(estimateSkillTokens("x".repeat(200))).toBe(50);
    expect(estimateSkillTokens("x".repeat(240))).toBe(60);
  });

  it("rounds UP for non-multiples of 4 (ceiling, not floor)", () => {
    // 1 char → CEIL(0.25) = 1, never 0.
    expect(estimateSkillTokens("x")).toBe(1);
    expect(estimateSkillTokens("xx")).toBe(1);
    expect(estimateSkillTokens("xxx")).toBe(1);
    // 5 chars → CEIL(1.25) = 2.
    expect(estimateSkillTokens("x".repeat(5))).toBe(2);
    // 11 chars → CEIL(2.75) = 3 (the old 'Alpha skill' fixture value).
    expect(estimateSkillTokens("Alpha skill")).toBe(3);
  });

  it("falls back to FLAT_SKILL_TOKEN_ESTIMATE for null / undefined / empty", () => {
    expect(estimateSkillTokens(null)).toBe(FLAT_SKILL_TOKEN_ESTIMATE);
    expect(estimateSkillTokens(undefined)).toBe(FLAT_SKILL_TOKEN_ESTIMATE);
    expect(estimateSkillTokens("")).toBe(FLAT_SKILL_TOKEN_ESTIMATE);
    expect(FLAT_SKILL_TOKEN_ESTIMATE).toBe(45);
  });

  it("never returns less than 1 for a non-empty description", () => {
    // Single-char description: still costs a token to load.
    expect(estimateSkillTokens("x")).toBeGreaterThanOrEqual(1);
  });

  it("matches the SQL expression COALESCE(CEIL(LENGTH(d)/4.0), 45) point-by-point", () => {
    // Mirror the SQL semantics for a sample of lengths so anyone changing
    // one side has to change the other.
    const samples: Array<[string | null, number]> = [
      [null, 45],
      ["", 45],
      ["x", 1], // CEIL(1/4) = 1
      ["xx", 1], // CEIL(2/4) = 1
      ["xxxx", 1], // CEIL(4/4) = 1
      ["x".repeat(7), 2], // CEIL(7/4) = 2
      ["x".repeat(100), 25], // CEIL(100/4) = 25
      ["x".repeat(180), 45], // CEIL(180/4) = 45 (coincidentally the flat)
    ];
    for (const [desc, expected] of samples) {
      expect(estimateSkillTokens(desc)).toBe(expected);
    }
  });
});
