/**
 * @module tests/utils/pricing
 *
 * Unit tests for the pricing utility — cost calculation, the single shared
 * rate source, the generated SQL CASE expressions, model-coverage guards
 * (COST-001), the removed dead entry (COST-006) and the unknown-model
 * diagnostic (COST-007).
 */

import { describe, it, expect } from "vitest";
import {
  calculateCost,
  getPricing,
  hasKnownPricing,
  getPricingEntries,
  getDefaultPricing,
  buildRateCaseSql,
  buildCacheSavingsRateCaseSql,
  reportUnknownModels,
} from "../../src/utils/pricing.js";

describe("calculateCost", () => {
  it("should calculate cost for claude-sonnet-4-5", () => {
    // Sonnet: $3/MTok input, $15/MTok output
    const cost = calculateCost("claude-sonnet-4-5", 1_000_000, 100_000, 0, 0);
    // 1M input * $3/MTok + 100K output * $15/MTok = $3 + $1.5 = $4.5
    expect(cost).toBeCloseTo(4.5, 1);
  });

  it("should calculate cost for claude-opus-4", () => {
    // Opus 4: $15/MTok input, $75/MTok output
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

describe("COST-001: claude-opus-4-7 pricing", () => {
  it("prices claude-opus-4-7 at the official $5/$25/$6.25/$0.50 rates, NOT Opus-4 rates", () => {
    const p = getPricing("claude-opus-4-7");
    expect(p).toEqual({
      inputPerM: 5,
      outputPerM: 25,
      cacheCreationPerM: 6.25,
      cacheReadPerM: 0.5,
    });
  });

  it("does NOT fall through to the broad claude-opus-4 ($15/$75) prefix", () => {
    const opus47 = getPricing("claude-opus-4-7");
    const opus4 = getPricing("claude-opus-4");
    expect(opus47.inputPerM).toBe(5);
    expect(opus4.inputPerM).toBe(15);
    expect(opus47.inputPerM).not.toBe(opus4.inputPerM);
  });

  it("matches a dated claude-opus-4-7-* model id by prefix", () => {
    expect(getPricing("claude-opus-4-7-20260401")).toEqual(getPricing("claude-opus-4-7"));
  });

  it("computes a 3x-lower cost for opus-4-7 than the old (wrong) Opus-4 fallthrough", () => {
    const tokens = 10_000_000;
    const correct = calculateCost("claude-opus-4-7", tokens, 0, 0, 0);
    const wrongOld = calculateCost("claude-opus-4", tokens, 0, 0, 0);
    expect(correct).toBeCloseTo(50, 5); // 10M * $5/MTok
    expect(wrongOld).toBeCloseTo(150, 5); // 10M * $15/MTok
  });

  it("has an explicit claude-sonnet-4-6 entry (no longer resolves by accident)", () => {
    const entries = getPricingEntries();
    expect(entries.some(([prefix]) => prefix === "claude-sonnet-4-6")).toBe(true);
    // and it still resolves to the Sonnet 4.x rate
    expect(getPricing("claude-sonnet-4-6").inputPerM).toBe(3);
  });
});

describe("COST-008: Claude 5 family (Fable/Mythos) + Opus 4.8 pricing", () => {
  it("prices claude-fable-5 at the official $10/$50/$12.50/$1.00 rates", () => {
    expect(getPricing("claude-fable-5")).toEqual({
      inputPerM: 10,
      outputPerM: 50,
      cacheCreationPerM: 12.5,
      cacheReadPerM: 1,
    });
  });

  it("prices claude-mythos-5 identically to claude-fable-5 (same model)", () => {
    expect(getPricing("claude-mythos-5")).toEqual(getPricing("claude-fable-5"));
  });

  it("does NOT price Fable 5 at the DEFAULT (Sonnet) rates anymore", () => {
    expect(hasKnownPricing("claude-fable-5")).toBe(true);
    expect(getPricing("claude-fable-5")).not.toEqual(getDefaultPricing());
  });

  it("prices claude-opus-4-8 at $5/$25/$6.25/$0.50, NOT the broad Opus-4 fallthrough", () => {
    expect(getPricing("claude-opus-4-8")).toEqual({
      inputPerM: 5,
      outputPerM: 25,
      cacheCreationPerM: 6.25,
      cacheReadPerM: 0.5,
    });
    // The fallthrough this guards against: claude-opus-4 = $15/$75 (3x higher).
    expect(getPricing("claude-opus-4").inputPerM).toBe(15);
  });

  it("matches dated variants by prefix", () => {
    expect(getPricing("claude-fable-5-20260601")).toEqual(getPricing("claude-fable-5"));
    expect(getPricing("claude-opus-4-8-20260301")).toEqual(getPricing("claude-opus-4-8"));
  });

  it("orders claude-opus-4-8 BEFORE the broad claude-opus-4 prefix (first match wins)", () => {
    const prefixes = getPricingEntries().map(([p]) => p);
    expect(prefixes.indexOf("claude-opus-4-8")).toBeLessThan(prefixes.indexOf("claude-opus-4"));
  });

  it("emits the new entries in every generated SQL rate CASE", () => {
    const sql = buildRateCaseSql("outputPerM");
    expect(sql).toContain("claude-fable-5%' THEN 50");
    expect(sql).toContain("claude-mythos-5%' THEN 50");
    expect(sql).toContain("claude-opus-4-8%' THEN 25");
  });

  it("computes the correct cache-savings rates (input − cacheRead)", () => {
    const sql = buildCacheSavingsRateCaseSql();
    expect(sql).toContain("claude-fable-5%' THEN 9"); // 10 − 1
    expect(sql).toContain("claude-opus-4-8%' THEN 4.5"); // 5 − 0.5
  });
});

describe("COST-001/COST-003: shared rate source — SQL CASE cannot drift", () => {
  // The dashboard cost/cache routes GENERATE their SQL CASE from this table.
  // These tests assert the generator output matches the table exactly, so a
  // future rate edit in pricing.ts cannot leave the SQL stale.
  const rateKeys = [
    "inputPerM",
    "outputPerM",
    "cacheCreationPerM",
    "cacheReadPerM",
  ] as const;

  it("generates one WHEN branch per pricing entry plus an ELSE", () => {
    const entries = getPricingEntries();
    for (const key of rateKeys) {
      const sql = buildRateCaseSql(key);
      const whenCount = (sql.match(/WHEN /g) ?? []).length;
      expect(whenCount).toBe(entries.length);
      expect(sql).toContain("ELSE");
      expect(sql.trim().startsWith("CASE")).toBe(true);
      expect(sql.trim().endsWith("END")).toBe(true);
    }
  });

  it("emits each entry's exact rate in prefix order (first-match-wins parity with getPricing)", () => {
    const entries = getPricingEntries();
    for (const key of rateKeys) {
      const sql = buildRateCaseSql(key);
      const lines = sql
        .split("\n")
        .filter((l) => l.includes("WHEN "));
      expect(lines.length).toBe(entries.length);
      entries.forEach(([prefix, pricing], idx) => {
        expect(lines[idx]).toContain(`LIKE '${prefix}%'`);
        expect(lines[idx]).toContain(`THEN ${pricing[key]}`);
      });
      // ELSE arm uses DEFAULT_PRICING
      expect(sql).toContain(`ELSE ${getDefaultPricing()[key]}`);
    }
  });

  it("includes claude-opus-4-7 in every generated rate CASE", () => {
    for (const key of rateKeys) {
      expect(buildRateCaseSql(key)).toContain("claude-opus-4-7%");
    }
    // and BEFORE the broad claude-opus-4 branch
    const sql = buildRateCaseSql("inputPerM");
    expect(sql.indexOf("claude-opus-4-7%")).toBeLessThan(
      sql.indexOf("claude-opus-4%\n") >= 0
        ? sql.indexOf("claude-opus-4%\n")
        : sql.lastIndexOf("claude-opus-4%"),
    );
  });

  it("supports an aliased model column for joined queries", () => {
    const sql = buildRateCaseSql("inputPerM", "ct.model");
    expect(sql).toContain("ct.model LIKE 'claude-opus-4-7%'");
    expect(sql).not.toMatch(/[^.]model LIKE/);
  });

  it("the generated CASE evaluated by hand equals getPricing() for every known model", () => {
    // Simulate SQL first-match-wins evaluation of the generated CASE.
    const entries = getPricingEntries();
    const evalCase = (model: string, key: (typeof rateKeys)[number]): number => {
      const lower = model.toLowerCase();
      for (const [prefix, pricing] of entries) {
        if (lower.startsWith(prefix)) return pricing[key];
      }
      return getDefaultPricing()[key];
    };
    const sampleModels = [
      "claude-fable-5",
      "claude-mythos-5",
      "claude-opus-4-8",
      "claude-opus-4-7-20260401",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-opus-4",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-3-7-sonnet",
      "claude-3-5-haiku",
      "claude-3-opus",
      "totally-unknown-model",
    ];
    for (const model of sampleModels) {
      for (const key of rateKeys) {
        expect(evalCase(model, key)).toBe(getPricing(model)[key]);
      }
    }
  });

  it("generates a cache-savings CASE = inputPerM - cacheReadPerM per entry", () => {
    const entries = getPricingEntries();
    const sql = buildCacheSavingsRateCaseSql();
    entries.forEach(([prefix, pricing]) => {
      expect(sql).toContain(
        `LIKE '${prefix}%' THEN ${pricing.inputPerM - pricing.cacheReadPerM}`,
      );
    });
    // claude-opus-4-7 cache savings = 5 - 0.5 = 4.5 (not the old 13.5)
    expect(sql).toContain("claude-opus-4-7%' THEN 4.5");
  });
});

describe("COST-001: every model present in the DB has an exact pricing entry", () => {
  // Guard test: fails if a model id that exists in the analytics DB does NOT
  // match a known pricing prefix (i.e. would be silently priced at DEFAULT).
  // The list below mirrors the distinct assistant `model` values observed in
  // ~/.ccanalytics/analytics.duckdb at the time of the COST-001 audit. Keep it
  // in sync when new models appear — that is exactly the signal this guards.
  const MODELS_IN_DB = [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    // "<synthetic>" is an intentional placeholder (0 tokens) — excluded.
  ];

  it.each(MODELS_IN_DB)("model %s matches a known pricing prefix", (model) => {
    expect(hasKnownPricing(model)).toBe(true);
  });

  it("the <synthetic> placeholder is intentionally NOT a known model", () => {
    expect(hasKnownPricing("<synthetic>")).toBe(false);
  });
});

describe("COST-006: the dead, guessed-rate claude-haiku-4 entry was removed", () => {
  it("has no 'claude-haiku-4' catch-all entry separate from claude-haiku-4-5", () => {
    const prefixes = getPricingEntries().map(([p]) => p);
    expect(prefixes).not.toContain("claude-haiku-4");
    // claude-haiku-4-5 is still present and correct
    expect(prefixes).toContain("claude-haiku-4-5");
  });

  it("a hypothetical future haiku-4.x now falls through to DEFAULT (surfaced by COST-007), not a guessed rate", () => {
    expect(hasKnownPricing("claude-haiku-4-6")).toBe(false);
    expect(getPricing("claude-haiku-4-6")).toEqual(getDefaultPricing());
  });
});

describe("COST-007: unknown-model diagnostic", () => {
  it("reports model ids that fall through to DEFAULT pricing", () => {
    const warnings: string[] = [];
    const unknown = reportUnknownModels(
      ["claude-opus-4-7", "some-future-model", "another-unknown"],
      (m) => warnings.push(m),
    );
    expect(unknown).toEqual(["another-unknown", "some-future-model"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("some-future-model");
    expect(warnings[0]).toContain("another-unknown");
    expect(warnings[0]).toContain("DEFAULT");
  });

  it("does not warn when every model has an exact entry", () => {
    const warnings: string[] = [];
    const unknown = reportUnknownModels(
      ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"],
      (m) => warnings.push(m),
    );
    expect(unknown).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  it("treats the <synthetic> placeholder as expected (no warning)", () => {
    const warnings: string[] = [];
    const unknown = reportUnknownModels(["<synthetic>"], (m) => warnings.push(m));
    expect(unknown).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  it("ignores null/undefined model ids", () => {
    const warnings: string[] = [];
    const unknown = reportUnknownModels(
      [null, undefined, "claude-opus-4-7"],
      (m) => warnings.push(m),
    );
    expect(unknown).toEqual([]);
    expect(warnings).toHaveLength(0);
  });
});
