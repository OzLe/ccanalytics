/**
 * @module tests/utils/pricing
 *
 * Unit tests for the pricing utility — cost calculation, the single shared
 * rate source, exact model-id matching, the generated SQL CASE expressions
 * (evaluated in DuckDB), model-coverage guards (COST-001), the removed dead
 * entry (COST-006) and the unknown-model diagnostic (COST-007).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  calculateCost,
  getPricing,
  hasKnownPricing,
  getPricingEntries,
  getDefaultPricing,
  buildRateCaseSql,
  buildCacheSavingsRateCaseSql,
  normalizeModelId,
  reportUnknownModels,
  unpricedModels,
  type ModelPricing,
} from "../../src/utils/pricing.js";

const rateKeys = ["inputPerM", "outputPerM", "cacheCreationPerM", "cacheReadPerM"] as const;

const rates = (
  inputPerM: number,
  outputPerM: number,
  cacheCreationPerM: number,
  cacheReadPerM: number,
): ModelPricing => ({ inputPerM, outputPerM, cacheCreationPerM, cacheReadPerM });

describe("calculateCost", () => {
  it("should calculate cost for claude-sonnet-4-5", () => {
    // Sonnet 4.5: $3/MTok input, $15/MTok output
    const cost = calculateCost("claude-sonnet-4-5", 1_000_000, 100_000, 0, 0);
    expect(cost).toBeCloseTo(4.5, 6);
  });

  it("should calculate cost for claude-opus-4", () => {
    // Opus 4: $15/MTok input, $75/MTok output
    const cost = calculateCost("claude-opus-4", 1_000_000, 100_000, 0, 0);
    expect(cost).toBeCloseTo(22.5, 6);
  });

  it("prices each token category at its own rate", () => {
    // Opus 5.5: 4 / 20 / 5 / 0.20
    const cost = calculateCost("claude-opus-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(4 + 20 + 5 + 0.2, 9);
  });

  it("should return 0 for zero tokens", () => {
    expect(calculateCost("claude-sonnet-4-5", 0, 0, 0, 0)).toBe(0);
  });

  it("should use default pricing for unknown model", () => {
    expect(calculateCost("unknown-model", 1_000_000, 0, 0, 0)).toBe(3);
  });
});

describe("live rates (Anthropic pricing page, 2026-09-28)", () => {
  it.each([
    ["claude-fable-5-1", rates(10, 50, 12.5, 0.25)],
    ["claude-mythos-5-1", rates(10, 50, 12.5, 0.25)],
    ["claude-fable-5", rates(10, 50, 12.5, 1)],
    ["claude-mythos-5", rates(10, 50, 12.5, 1)],
    ["claude-opus-5-5", rates(4, 20, 5, 0.2)],
    ["claude-opus-5", rates(5, 25, 6.25, 0.5)],
    ["claude-sonnet-5", rates(2, 10, 2.5, 0.2)],
    ["claude-opus-4-8", rates(5, 25, 6.25, 0.5)],
    ["claude-opus-4-7", rates(5, 25, 6.25, 0.5)],
    ["claude-opus-4-6", rates(5, 25, 6.25, 0.5)],
    ["claude-opus-4-5", rates(5, 25, 6.25, 0.5)],
    ["claude-opus-4-1", rates(15, 75, 18.75, 1.5)],
    ["claude-opus-4", rates(15, 75, 18.75, 1.5)],
    ["claude-sonnet-4-6", rates(3, 15, 3.75, 0.3)],
    ["claude-sonnet-4-5", rates(3, 15, 3.75, 0.3)],
    ["claude-sonnet-4", rates(3, 15, 3.75, 0.3)],
    ["claude-haiku-4-5", rates(1, 5, 1.25, 0.1)],
  ])("prices %s", (model, expected) => {
    expect(getPricing(model)).toEqual(expected);
  });

  it("writes to cache at 1.25x input for every Claude 4 and 5 model", () => {
    // Retired Claude 3 Haiku wrote at $0.30 on $0.25 input (1.2x).
    for (const [id, p] of getPricingEntries().filter(([id]) => !id.startsWith("claude-3-"))) {
      expect(p.cacheCreationPerM, id).toBeCloseTo(p.inputPerM * 1.25, 9);
    }
  });
});

describe("D4: exact model-id matching", () => {
  it("normalizes case and a trailing release date only", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("Claude-Opus-4-7")).toBe("claude-opus-4-7");
    expect(normalizeModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizeModelId("claude-3-5-sonnet-latest")).toBe("claude-3-5-sonnet-latest");
  });

  it("matches dated ids to their model", () => {
    expect(getPricing("claude-opus-4-5-20251101")).toEqual(getPricing("claude-opus-4-5"));
    expect(getPricing("claude-sonnet-4-5-20250929")).toEqual(getPricing("claude-sonnet-4-5"));
    expect(getPricing("claude-opus-4-20250514")).toEqual(getPricing("claude-opus-4"));
  });

  it("does not let a point release inherit its sibling's rates", () => {
    // Under prefix matching Fable 5.1 took Fable 5's $1 cache read.
    expect(getPricing("claude-fable-5-1").cacheReadPerM).toBe(0.25);
    expect(getPricing("claude-opus-5-5")).not.toEqual(getPricing("claude-opus-5"));
    expect(getPricing("claude-opus-4-7")).not.toEqual(getPricing("claude-opus-4"));
  });

  it("treats an unseen point release as unknown instead of guessing", () => {
    for (const model of ["claude-opus-5-6", "claude-fable-5-2", "claude-sonnet-4-7", "claude-haiku-4-6"]) {
      expect(hasKnownPricing(model), model).toBe(false);
      expect(getPricing(model), model).toEqual(getDefaultPricing());
    }
  });

  it("keys every entry by a unique, already-normalized id", () => {
    const ids = getPricingEntries().map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(normalizeModelId(id)).toBe(id);
  });
});

describe("generated SQL CASE — evaluated in DuckDB", () => {
  let instance: DuckDBInstance;
  let conn: DuckDBConnection;

  const sampleModels = [
    ...getPricingEntries().map(([id]) => id),
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    "CLAUDE-OPUS-4-7",
    "claude-opus-5-6",
    "totally-unknown-model",
    "<synthetic>",
  ];

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run("CREATE TABLE m (model VARCHAR)");
    for (const model of sampleModels) {
      await conn.run(`INSERT INTO m VALUES ('${model}')`);
    }
    await conn.run("INSERT INTO m VALUES (NULL)");
  });

  afterAll(() => {
    conn.closeSync();
    instance.closeSync();
  });

  async function evaluate(caseSql: string): Promise<Map<string | null, number>> {
    const reader = await conn.runAndReadAll(`SELECT model, (${caseSql})::DOUBLE AS rate FROM m`);
    const rows = reader.getRowObjectsJS() as { model: string | null; rate: number }[];
    return new Map(rows.map((r) => [r.model, r.rate]));
  }

  it.each(rateKeys)("matches getPricing() for every sample model: %s", async (key) => {
    const result = await evaluate(buildRateCaseSql(key));
    for (const model of sampleModels) {
      expect(result.get(model), model).toBeCloseTo(getPricing(model)[key], 9);
    }
    expect(result.get(null)).toBeCloseTo(getDefaultPricing()[key], 9);
  });

  it("computes cache savings as input minus cache read", async () => {
    const result = await evaluate(buildCacheSavingsRateCaseSql());
    for (const model of sampleModels) {
      const p = getPricing(model);
      expect(result.get(model), model).toBeCloseTo(p.inputPerM - p.cacheReadPerM, 9);
    }
    expect(result.get("claude-opus-5-5")).toBeCloseTo(3.8, 9);
    expect(result.get("claude-fable-5-1")).toBeCloseTo(9.75, 9);
  });

  it("supports an aliased model column for joined queries", async () => {
    const sql = buildRateCaseSql("inputPerM", "ct.model");
    expect(sql).toContain("lower(ct.model)");
    const reader = await conn.runAndReadAll(
      `SELECT (${sql})::DOUBLE AS rate FROM m AS ct WHERE ct.model = 'claude-opus-5-5'`,
    );
    expect((reader.getRowObjectsJS()[0] as { rate: number }).rate).toBe(4);
  });

  it("has one WHEN per entry and the default in the ELSE arm", () => {
    for (const key of rateKeys) {
      const sql = buildRateCaseSql(key);
      expect((sql.match(/WHEN /g) ?? []).length).toBe(getPricingEntries().length);
      expect(sql).toContain(`ELSE ${getDefaultPricing()[key]}`);
    }
  });
});

describe("COST-001: every model present in the DB has a pricing entry", () => {
  // Guard test: the distinct assistant `model` values observed in
  // ~/.ccanalytics/analytics.duckdb on 2026-09-28. Keep it in sync when new
  // models appear — that is exactly the signal this guards.
  const MODELS_IN_DB = [
    "claude-opus-4-7",
    "claude-fable-5",
    "claude-opus-4-6",
    "claude-opus-4-8",
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-opus-4-5-20251101",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    // "<synthetic>" is an intentional placeholder (0 tokens) — excluded.
  ];

  it.each(MODELS_IN_DB)("model %s has a pricing entry", (model) => {
    expect(hasKnownPricing(model)).toBe(true);
  });

  it("the <synthetic> placeholder is intentionally NOT a known model", () => {
    expect(hasKnownPricing("<synthetic>")).toBe(false);
  });
});

describe("COST-006: the dead, guessed-rate claude-haiku-4 entry stays removed", () => {
  it("has no 'claude-haiku-4' catch-all entry separate from claude-haiku-4-5", () => {
    const ids = getPricingEntries().map(([id]) => id);
    expect(ids).not.toContain("claude-haiku-4");
    expect(ids).toContain("claude-haiku-4-5");
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
    expect(warnings[0]).toContain("npm run backfill:costs");
  });

  it("does not warn when every model has an entry", () => {
    const warnings: string[] = [];
    const unknown = reportUnknownModels(
      ["claude-opus-4-7", "claude-opus-5-5", "claude-haiku-4-5-20251001"],
      (m) => warnings.push(m),
    );
    expect(unknown).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  it("treats the <synthetic> placeholder and missing ids as expected", () => {
    expect(unpricedModels(["<synthetic>", null, undefined, ""])).toEqual([]);
  });

  it("lists each unknown id once", () => {
    expect(unpricedModels(["claude-opus-6", "claude-opus-6", "claude-opus-5-5"])).toEqual([
      "claude-opus-6",
    ]);
  });
});
