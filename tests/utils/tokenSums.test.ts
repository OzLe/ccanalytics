/**
 * @module tests/utils/tokenSums
 *
 * Unit tests for the `buildTokenSumSql()` helper — the SINGLE SOURCE OF TRUTH
 * for token-aggregation SQL across the CLI analyzers, dashboard routes, and
 * analytical views (TOK-001 / TOK-002, SEM2-288 / SEM2-289).
 *
 * These are pure-string tests: every consumer interpolates these expressions
 * verbatim, so if the canonical formulas change here they change EVERYWHERE in
 * one shot. That is the entire point of the helper — re-asserting the strings
 * is how we keep the four formulas that previously drifted (~294x gap on the
 * live dataset, SEM2-296) from drifting again.
 */

import { describe, it, expect } from "vitest";
import { buildTokenSumSql } from "../../src/utils/tokenSums.js";

describe("buildTokenSumSql", () => {
  it("returns the canonical 2-way `totalTokensSql` (TOK-001)", () => {
    const sums = buildTokenSumSql();
    expect(sums.totalTokensSql).toBe(
      "COALESCE(SUM(input_tokens + output_tokens), 0)",
    );
  });

  it("returns the 4-way `contextVolumeTokensSql` (TOK-002)", () => {
    const sums = buildTokenSumSql();
    expect(sums.contextVolumeTokensSql).toBe(
      "COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0)",
    );
  });

  it("returns the per-category SUM expressions", () => {
    const sums = buildTokenSumSql();
    expect(sums.inputTokensSql).toBe("COALESCE(SUM(input_tokens), 0)");
    expect(sums.outputTokensSql).toBe("COALESCE(SUM(output_tokens), 0)");
    expect(sums.cacheCreationTokensSql).toBe(
      "COALESCE(SUM(cache_creation_tokens), 0)",
    );
    expect(sums.cacheReadTokensSql).toBe("COALESCE(SUM(cache_read_tokens), 0)");
  });

  it("the canonical headline is 2-way — explicitly NOT 4-way", () => {
    // The whole point of TOK-001: `totalTokensSql` MUST NOT include the cache
    // columns. If a future edit accidentally adds them back, the dashboard's
    // "Tokens In/Out" KPI would re-acquire the ~98% cache_read replay bias
    // and drift back ~294x from /api/activity/hourly.
    const sums = buildTokenSumSql();
    expect(sums.totalTokensSql).not.toMatch(/cache_read_tokens/);
    expect(sums.totalTokensSql).not.toMatch(/cache_creation_tokens/);
  });

  it("the secondary context-volume metric IS 4-way", () => {
    const sums = buildTokenSumSql();
    expect(sums.contextVolumeTokensSql).toMatch(/cache_read_tokens/);
    expect(sums.contextVolumeTokensSql).toMatch(/cache_creation_tokens/);
    expect(sums.contextVolumeTokensSql).toMatch(/input_tokens/);
    expect(sums.contextVolumeTokensSql).toMatch(/output_tokens/);
  });

  it("returns a frozen object — consumers cannot mutate the canonical strings", () => {
    const sums = buildTokenSumSql();
    expect(Object.isFrozen(sums)).toBe(true);
  });
});
