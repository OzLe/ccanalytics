/**
 * @module tests/queries/time-series
 *
 * Integration tests for the TimeSeriesAnalyzer class.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, seedTestData, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { TimeSeriesAnalyzer } from "../../src/queries/time-series.js";
import type { TimeRange } from "../../src/types/index.js";

describe("TimeSeriesAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: TimeSeriesAnalyzer;

  const testRange: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new TimeSeriesAnalyzer(executor);
    await seedTestData(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  describe("getHourlyActivity", () => {
    it("should return hourly activity data", async () => {
      const results = await analyzer.getHourlyActivity(testRange);
      expect(results.length).toBeGreaterThan(0);
      for (const row of results) {
        expect(row.hourOfDay).toBeGreaterThanOrEqual(0);
        expect(row.hourOfDay).toBeLessThanOrEqual(23);
        expect(row.messageCount).toBeGreaterThan(0);
      }
    });

    it("should return empty for future range", async () => {
      const futureRange: TimeRange = { start: new Date("2030-01-01"), end: new Date("2030-01-02") };
      const results = await analyzer.getHourlyActivity(futureRange);
      expect(results).toEqual([]);
    });

    it("should filter by model", async () => {
      const results = await analyzer.getHourlyActivity(testRange, { model: "opus" });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("getDailyActivity", () => {
    it("should return daily time series", async () => {
      const results = await analyzer.getDailyActivity(testRange);
      expect(results.length).toBeGreaterThan(0);
      for (const point of results) {
        expect(point.timestamp).toBeInstanceOf(Date);
        expect(point.value).toBeGreaterThan(0);
      }
    });
  });

  describe("getWeeklyTrend", () => {
    it("should return weekly aggregation", async () => {
      const results = await analyzer.getWeeklyTrend(testRange);
      expect(results.length).toBeGreaterThan(0);
      for (const point of results) {
        expect(point.timestamp).toBeInstanceOf(Date);
        expect(point.value).toBeGreaterThan(0);
      }
    });
  });

  describe("getActivityHeatmap", () => {
    it("should return heatmap cells with day/hour/count", async () => {
      const results = await analyzer.getActivityHeatmap(testRange);
      expect(results.length).toBeGreaterThan(0);
      for (const cell of results) {
        expect(cell.dayOfWeek).toBeGreaterThanOrEqual(0);
        expect(cell.dayOfWeek).toBeLessThanOrEqual(6);
        expect(cell.hourOfDay).toBeGreaterThanOrEqual(0);
        expect(cell.hourOfDay).toBeLessThanOrEqual(23);
        expect(cell.value).toBeGreaterThan(0);
      }
    });

    it("should return empty for future range", async () => {
      const futureRange: TimeRange = { start: new Date("2030-01-01"), end: new Date("2030-01-02") };
      const results = await analyzer.getActivityHeatmap(futureRange);
      expect(results).toEqual([]);
    });
  });
});
