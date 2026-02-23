/**
 * @module tests/queries/cost-analyzer
 *
 * Integration tests for the CostAnalyzer class.
 * Uses DuckDB :memory: mode for fast, isolated test execution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, seedTestData, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { CostAnalyzer } from "../../src/queries/cost-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

describe("CostAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: CostAnalyzer;

  const testRange: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new CostAnalyzer(executor);
    await seedTestData(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  describe("getDailyCosts", () => {
    it("should return daily cost aggregation for a time range", async () => {
      const results = await analyzer.getDailyCosts(testRange);
      expect(results.length).toBeGreaterThan(0);
      // We have data on 2026-02-20 and 2026-02-21
      // DuckDB may return dates as Date objects or various string formats
      const dateStrings = results.map((r) => {
        const d = new Date(r.date);
        return d.toISOString().slice(0, 10);
      });
      const uniqueDates = [...new Set(dateStrings)];
      expect(uniqueDates).toContain("2026-02-20");
      expect(uniqueDates).toContain("2026-02-21");
    });

    it("should break down costs by model", async () => {
      const results = await analyzer.getDailyCosts(testRange);
      const models = results.map((r) => r.model);
      expect(models).toContain("claude-sonnet-4-5");
      expect(models).toContain("claude-opus-4");
    });

    it("should return empty array for a time range with no data", async () => {
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const results = await analyzer.getDailyCosts(futureRange);
      expect(results).toEqual([]);
    });

    it("should filter by model", async () => {
      const results = await analyzer.getDailyCosts(testRange, { model: "opus" });
      expect(results.length).toBeGreaterThan(0);
      for (const row of results) {
        expect(row.model.toLowerCase()).toContain("opus");
      }
    });

    it("should filter by project", async () => {
      const results = await analyzer.getDailyCosts(testRange, { project: "alpha" });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("getCostByModel", () => {
    it("should aggregate costs per model", async () => {
      const results = await analyzer.getCostByModel(testRange);
      expect(results.length).toBe(2);

      const sonnet = results.find((r) => r.model === "claude-sonnet-4-5");
      const opus = results.find((r) => r.model === "claude-opus-4");
      expect(sonnet).toBeDefined();
      expect(opus).toBeDefined();
      expect(sonnet!.totalInputTokens).toBeGreaterThan(0);
      expect(opus!.totalCostUSD).toBe(0.25);
    });
  });

  describe("getTotalCost", () => {
    it("should return correct token breakdown totals", async () => {
      const result = await analyzer.getTotalCost(testRange);
      // Sum of all assistant turns: 0.02 + 0.03 + 0.25 + 0.04 + 0.04 = 0.38
      expect(result.totalCostUSD).toBeCloseTo(0.38, 2);
      expect(result.totalInputTokens).toBeGreaterThan(0);
      expect(result.totalOutputTokens).toBeGreaterThan(0);
    });

    it("should return zero values when no data exists", async () => {
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const result = await analyzer.getTotalCost(futureRange);
      expect(result.totalCostUSD).toBe(0);
      expect(result.totalInputTokens).toBe(0);
      expect(result.totalOutputTokens).toBe(0);
    });

    it("should respect model filter", async () => {
      const result = await analyzer.getTotalCost(testRange, { model: "opus" });
      expect(result.totalCostUSD).toBe(0.25);
    });
  });

  describe("getCostByProject", () => {
    it("should aggregate costs per project path", async () => {
      const results = await analyzer.getCostByProject(testRange);
      expect(results.length).toBe(2);

      const alpha = results.find((r) => r.projectPath === "/projects/alpha");
      const beta = results.find((r) => r.projectPath === "/projects/beta");
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      expect(alpha!.sessionCount).toBe(2);
      expect(beta!.sessionCount).toBe(1);
    });
  });

  describe("getCostTrend", () => {
    it("should return daily cost trend", async () => {
      const results = await analyzer.getCostTrend(testRange, "day");
      expect(results.length).toBeGreaterThan(0);
      for (const point of results) {
        expect(point.timestamp).toBeInstanceOf(Date);
        expect(point.costUSD).toBeGreaterThanOrEqual(0);
        expect(point.inputTokens).toBeGreaterThanOrEqual(0);
      }
    });

    it("should reject invalid bucket", async () => {
      await expect(analyzer.getCostTrend(testRange, "invalid" as any)).rejects.toThrow("Invalid time bucket");
    });
  });
});
