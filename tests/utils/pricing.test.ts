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
  buildCacheWriteCostSql,
  cacheWriteCost,
  normalizeModelId,
  promptLengthPricedModels,
  reportUnknownModels,
  unpricedModels,
  type ModelPricing,
} from "../../src/utils/pricing.js";

const rateKeys = ["inputPerM", "outputPerM", "cacheCreationPerM", "cacheWrite1hPerM", "cacheReadPerM"] as const;

/** Rates in the pricing page's column order: input, 5m write, 1h write, read, output. */
const rates = (
  inputPerM: number,
  cacheCreationPerM: number,
  cacheWrite1hPerM: number,
  cacheReadPerM: number,
  outputPerM: number,
): ModelPricing => ({ inputPerM, outputPerM, cacheCreationPerM, cacheWrite1hPerM, cacheReadPerM });

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

describe("live rates (Anthropic pricing page, 2026-10-30)", () => {
  it.each([
    ["claude-fable-5-1", rates(10, 12.5, 20, 0.25, 50)],
    ["claude-mythos-5-1", rates(10, 12.5, 20, 0.25, 50)],
    ["claude-fable-5", rates(10, 12.5, 20, 1, 50)],
    ["claude-mythos-5", rates(10, 12.5, 20, 1, 50)],
    ["claude-opus-5-5", rates(4, 5, 8, 0.2, 20)],
    ["claude-opus-5", rates(5, 6.25, 10, 0.5, 25)],
    ["claude-sonnet-5-5", rates(2, 2.5, 4, 0.1, 10)],
    ["claude-sonnet-5", rates(2, 2.5, 4, 0.2, 10)],
    ["claude-opus-4-8", rates(5, 6.25, 10, 0.5, 25)],
    ["claude-opus-4-7", rates(5, 6.25, 10, 0.5, 25)],
    ["claude-opus-4-6", rates(5, 6.25, 10, 0.5, 25)],
    ["claude-opus-4-5", rates(5, 6.25, 10, 0.5, 25)],
    ["claude-opus-4-1", rates(15, 18.75, 30, 1.5, 75)],
    ["claude-opus-4", rates(15, 18.75, 30, 1.5, 75)],
    ["claude-sonnet-4-6", rates(3, 3.75, 6, 0.3, 15)],
    ["claude-sonnet-4-5", rates(3, 3.75, 6, 0.3, 15)],
    ["claude-sonnet-4", rates(3, 3.75, 6, 0.3, 15)],
    ["claude-haiku-5-5", rates(0.1, 0.125, 0.2, 0.01, 0.5)],
    ["claude-haiku-4-5", rates(1, 1.25, 2, 0.1, 5)],
  ])("prices %s", (model, expected) => {
    expect(getPricing(model)).toEqual(expected);
  });

  it("writes to the 1-hour cache at 2x input for every model", () => {
    for (const [id, p] of getPricingEntries()) {
      expect(p.cacheWrite1hPerM, id).toBeCloseTo(p.inputPerM * 2, 9);
    }
  });

  it("writes to cache at 1.25x input for every Claude 4 and 5 model", () => {
    // Retired Claude 3 Haiku wrote at $0.30 on $0.25 input (1.2x).
    for (const [id, p] of getPricingEntries().filter(([id]) => !id.startsWith("claude-3-"))) {
      expect(p.cacheCreationPerM, id).toBeCloseTo(p.inputPerM * 1.25, 9);
    }
  });
});

describe("prompt-length pricing (Haiku 5.5)", () => {
  const short = rates(0.1, 0.125, 0.2, 0.01, 0.5);
  const long = rates(0.5, 0.625, 1, 0.05, 2.5);

  it("charges the long-prompt rates only above 100,000 prompt tokens", () => {
    expect(getPricing("claude-haiku-5-5")).toEqual(short);
    expect(getPricing("claude-haiku-5-5", 100_000)).toEqual(short);
    expect(getPricing("claude-haiku-5-5", 100_001)).toEqual(long);
    expect(getPricing("CLAUDE-HAIKU-5-5", 100_001)).toEqual(long);
    expect(promptLengthPricedModels()).toEqual(["claude-haiku-5-5"]);
  });

  it("leaves flat-rate models alone at any prompt length", () => {
    expect(getPricing("claude-opus-5-5", 900_000)).toEqual(getPricing("claude-opus-5-5"));
    expect(getPricing("unknown-model", 900_000)).toEqual(getDefaultPricing());
  });

  it("measures the prompt as input + cache writes + cache reads, and prices output too", () => {
    // 100,000 prompt tokens: the short rates.
    expect(calculateCost("claude-haiku-5-5", 10_000, 1_000_000, 30_000, 60_000)).toBeCloseTo(
      (10_000 * 0.1 + 1_000_000 * 0.5 + 30_000 * 0.125 + 60_000 * 0.01) / 1_000_000,
      12,
    );
    // One cache-read token more: every category at the long rates.
    expect(calculateCost("claude-haiku-5-5", 10_000, 1_000_000, 30_000, 60_001, 20_000)).toBeCloseTo(
      (10_000 * 0.5 + 1_000_000 * 2.5 + 10_000 * 0.625 + 20_000 * 1 + 60_001 * 0.05) / 1_000_000,
      12,
    );
  });

  it("keeps the cache multipliers in the long-prompt tier", () => {
    expect(long.cacheCreationPerM).toBeCloseTo(long.inputPerM * 1.25, 9);
    expect(long.cacheWrite1hPerM).toBeCloseTo(long.inputPerM * 2, 9);
    expect(long.cacheReadPerM).toBeCloseTo(long.inputPerM * 0.1, 9);
  });

  it("picks the same tier per row in the generated SQL", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const c = await instance.connect();
    await c.run(`CREATE TABLE ct (model VARCHAR, input_tokens BIGINT, cache_creation_tokens BIGINT,
      cache_creation_1h_tokens BIGINT, cache_read_tokens BIGINT)`);
    const rows: [string, number, number, number | null, number][] = [
      ["claude-haiku-5-5", 10_000, 30_000, 5_000, 60_000],
      ["claude-haiku-5-5", 10_000, 30_000, 5_000, 60_001],
      ["claude-haiku-5-5", 400_000, 0, null, 0],
      ["claude-opus-5-5", 400_000, 0, null, 0],
    ];
    for (const [model, input, write, oneHour, read] of rows) {
      await c.run(`INSERT INTO ct VALUES ('${model}', ${input}, ${write}, ${oneHour ?? "NULL"}, ${read})`);
    }
    const reader = await c.runAndReadAll(`SELECT model, input_tokens, cache_creation_tokens,
      cache_creation_1h_tokens, cache_read_tokens,
      (${buildRateCaseSql("inputPerM", "ct.")})::DOUBLE AS input_rate,
      (${buildRateCaseSql("outputPerM", "ct.")})::DOUBLE AS output_rate,
      (${buildCacheSavingsRateCaseSql("ct.")})::DOUBLE AS savings_rate,
      (${buildCacheWriteCostSql("1h", "ct.")})::DOUBLE AS write_cost
      FROM ct`);
    for (const r of reader.getRowObjectsJS() as Record<string, string | number | bigint | null>[]) {
      const [input, write, read] = [r.input_tokens, r.cache_creation_tokens, r.cache_read_tokens].map(Number);
      const oneHour = r.cache_creation_1h_tokens === null ? write : Number(r.cache_creation_1h_tokens);
      const p = getPricing(r.model as string, input + write + read);
      const label = `${r.model} ${input + write + read}`;
      expect(r.input_rate, label).toBeCloseTo(p.inputPerM, 9);
      expect(r.output_rate, label).toBeCloseTo(p.outputPerM, 9);
      expect(r.savings_rate, label).toBeCloseTo(p.inputPerM - p.cacheReadPerM, 9);
      expect(r.write_cost, label).toBeCloseTo(cacheWriteCost(p, write, oneHour), 12);
    }
    c.closeSync();
    instance.closeSync();
  });
});

describe("1-hour cache writes", () => {
  it("prices the 1-hour share of the cache writes at the 1-hour rate", () => {
    // Opus 5.5: 5-minute writes $5, 1-hour writes $8 per MTok
    expect(calculateCost("claude-opus-5-5", 0, 0, 1_000_000, 0, 250_000)).toBeCloseTo(0.75 * 5 + 0.25 * 8, 9);
    expect(calculateCost("claude-opus-5-5", 0, 0, 1_000_000, 0)).toBeCloseTo(5, 9);
  });

  it("cacheWriteCost splits a total the same way", () => {
    const p = getPricing("claude-fable-5-1");
    expect(cacheWriteCost(p, 1_000_000, 1_000_000)).toBeCloseTo(20, 9);
    expect(cacheWriteCost(p, 1_000_000, 0)).toBeCloseTo(12.5, 9);
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
    await conn.run(
      "CREATE TABLE m (model VARCHAR, input_tokens BIGINT, cache_creation_tokens BIGINT, cache_read_tokens BIGINT)",
    );
    for (const model of sampleModels) {
      await conn.run(`INSERT INTO m VALUES ('${model}', 0, 0, 0)`);
    }
    await conn.run("INSERT INTO m VALUES (NULL, 0, 0, 0)");
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

  it("prices a row's cache writes by its split, or by the unrecorded default", async () => {
    await conn.run(
      `CREATE TABLE w (model VARCHAR, input_tokens BIGINT, cache_creation_tokens BIGINT,
        cache_creation_1h_tokens BIGINT, cache_read_tokens BIGINT)`,
    );
    await conn.run(`INSERT INTO w VALUES
      ('claude-opus-5-5', 0, 1000000, 250000, 0), ('claude-opus-5-5', 0, 1000000, NULL, 0), (NULL, 0, 1000000, NULL, 0)`);
    for (const unrecordedAs of ["1h", "5m"] as const) {
      const reader = await conn.runAndReadAll(
        `SELECT model, cache_creation_1h_tokens AS h, (${buildCacheWriteCostSql(unrecordedAs)})::DOUBLE AS cost FROM w`,
      );
      for (const r of reader.getRowObjectsJS() as { model: string | null; h: bigint | null; cost: number }[]) {
        const oneHour = r.h === null ? (unrecordedAs === "1h" ? 1_000_000 : 0) : Number(r.h);
        expect(r.cost, `${r.model} ${r.h} ${unrecordedAs}`).toBeCloseTo(
          cacheWriteCost(getPricing(r.model), 1_000_000, oneHour),
          9,
        );
      }
    }
    await conn.run("DROP TABLE w");
  });

  it("supports a table alias for joined queries", async () => {
    const sql = buildRateCaseSql("inputPerM", "ct.");
    expect(sql).toContain("lower(ct.model)");
    expect(sql).toContain("ct.cache_read_tokens");
    const reader = await conn.runAndReadAll(
      `SELECT (${sql})::DOUBLE AS rate FROM m AS ct WHERE ct.model = 'claude-opus-5-5'`,
    );
    expect((reader.getRowObjectsJS()[0] as { rate: number }).rate).toBe(4);
  });

  it("has one WHEN per entry and the default in the ELSE arm", () => {
    for (const key of rateKeys) {
      const sql = buildRateCaseSql(key);
      expect((sql.match(/WHEN '/g) ?? []).length).toBe(getPricingEntries().length);
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
    "claude-sonnet-5-5",
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
