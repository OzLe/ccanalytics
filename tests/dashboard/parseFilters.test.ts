/**
 * @module tests/dashboard/parseFilters
 *
 * Unit tests for the dashboard's parseFilters helper.
 *
 * Locks in the SEM2-292 (F3-prompt) fix on the dashboard side: the model
 * filter must NOT drop user rows from `conversation_turns`. The CLI module
 * (src/queries/filter-builder.ts) and this dashboard module are parallel
 * copies — they must stay in sync.
 */

import { describe, it, expect } from "vitest";
import { buildTurnFilterClauses } from "../../dashboard/src/server/helpers/parseFilters.js";

describe("buildTurnFilterClauses (dashboard mirror of buildTurnFilters)", () => {
  it("returns empty arrays when no filters are set", () => {
    const result = buildTurnFilterClauses(
      { range: { start: new Date(), end: new Date() }, period: "7d" },
      1,
    );
    expect(result).toEqual({ clauses: [], params: [] });
  });

  describe("model filter (SEM2-292)", () => {
    it("wraps the model LIKE in (role = 'user' OR ...) so user turns pass through", () => {
      const result = buildTurnFilterClauses(
        { range: { start: new Date(), end: new Date() }, period: "7d", model: "opus" },
        3,
      );

      expect(result.clauses).toHaveLength(1);
      expect(result.clauses[0]).toMatch(/role\s*=\s*'user'\s+OR\s+model\s+LIKE/i);
      expect(result.clauses[0]).toContain("model LIKE '%' || $3 || '%'");
      // Regression guard: must NOT be the old bare form.
      expect(result.clauses[0]).not.toMatch(/^AND model LIKE/);
      expect(result.params).toEqual(["opus"]);
    });
  });

  describe("project and source filters", () => {
    it("emits sessions subqueries with sequential bind indices when both are set", () => {
      const result = buildTurnFilterClauses(
        {
          range: { start: new Date(), end: new Date() },
          period: "7d",
          project: "alpha",
          source: "claude-code",
        },
        3,
      );

      expect(result.clauses).toHaveLength(2);
      expect(result.clauses[0]).toContain("project_path LIKE '%' || $3 || '%'");
      expect(result.clauses[1]).toContain("source_type = $4");
      expect(result.params).toEqual(["alpha", "claude-code"]);
    });
  });

  describe("model + project + source combined", () => {
    it("emits three clauses with sequential bind indices starting at startIndex", () => {
      const result = buildTurnFilterClauses(
        {
          range: { start: new Date(), end: new Date() },
          period: "7d",
          model: "opus",
          project: "alpha",
          source: "claude-code",
        },
        3,
      );

      expect(result.clauses).toHaveLength(3);
      expect(result.clauses[0]).toContain("$3");
      expect(result.clauses[1]).toContain("$4");
      expect(result.clauses[2]).toContain("$5");
      expect(result.params).toEqual(["opus", "alpha", "claude-code"]);
    });
  });
});
