/**
 * @module tests/utils/sqlPredicates
 *
 * Unit tests for the shared SQL predicate helper (LANE J / SEM2-297).
 *
 * These tests assert the SHAPE of the emitted fragment — the integration
 * tests in tests/queries/time-series.test.ts and tests/server/activity-route.test.ts
 * assert the behavioural consequence (activity now counts the same rows as
 * v_daily_cost). The shape tests live here so any drift in the canonical
 * predicate is caught at the cheapest possible level.
 */

import { describe, it, expect } from "vitest";
import { costRowPredicateSql } from "../../src/utils/sqlPredicates.js";

describe("costRowPredicateSql", () => {
  it("defaults to the 'ct' table alias", () => {
    expect(costRowPredicateSql()).toBe(
      "(ct.role = 'assistant' AND ct.model <> '<synthetic>' AND ct.model IS NOT NULL)",
    );
  });

  it("emits all three clauses (role, synthetic exclusion, NULL exclusion)", () => {
    const sql = costRowPredicateSql("ct");
    expect(sql).toContain("ct.role = 'assistant'");
    expect(sql).toContain("ct.model <> '<synthetic>'");
    expect(sql).toContain("ct.model IS NOT NULL");
  });

  it("honours a custom alias", () => {
    expect(costRowPredicateSql("turns")).toBe(
      "(turns.role = 'assistant' AND turns.model <> '<synthetic>' AND turns.model IS NOT NULL)",
    );
  });

  it("emits bare column form when alias is the empty string", () => {
    expect(costRowPredicateSql("")).toBe(
      "(role = 'assistant' AND model <> '<synthetic>' AND model IS NOT NULL)",
    );
  });

  it("wraps the fragment in parentheses so it can be AND-ed safely", () => {
    expect(costRowPredicateSql()).toMatch(/^\(.+\)$/);
  });

  it("uses AND (not OR) — populations are an intersection, not a union", () => {
    const sql = costRowPredicateSql();
    expect(sql).toContain(" AND ");
    expect(sql).not.toContain(" OR ");
  });

  it("matches the literal predicate of v_daily_cost (the reference)", () => {
    // v_daily_cost: ct.role = 'assistant' AND ct.model IS NOT NULL AND ct.model <> '<synthetic>'
    // Helper:      ct.role = 'assistant' AND ct.model <> '<synthetic>' AND ct.model IS NOT NULL
    // Same conjuncts; AND-commutative.
    const sql = costRowPredicateSql("ct");
    expect(sql).toContain("ct.role = 'assistant'");
    expect(sql).toContain("ct.model IS NOT NULL");
    expect(sql).toContain("ct.model <> '<synthetic>'");
  });

  it("contains no bind-param placeholders so AND-ing it does not shift $N", () => {
    // Activity surfaces (post-D2) reserve $1=start, $2=end, $3=userTz; filter
    // binds start at $4. The helper MUST add zero binds — if a $N ever
    // appears here it would silently shift the param index in every caller.
    expect(costRowPredicateSql()).not.toMatch(/\$\d+/);
    expect(costRowPredicateSql("ct")).not.toMatch(/\$\d+/);
    expect(costRowPredicateSql("turns")).not.toMatch(/\$\d+/);
  });
});
