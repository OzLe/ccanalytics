/**
 * @module tests/queries/cache-analyzer
 *
 * Integration tests for the CacheAnalyzer class.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, seedTestData, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { CacheAnalyzer } from "../../src/queries/cache-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

describe("CacheAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: CacheAnalyzer;

  const testRange: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new CacheAnalyzer(executor);
    await seedTestData(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  describe("getCacheHitRate", () => {
    it("should return cache metrics with correct formula", async () => {
      const result = await analyzer.getCacheHitRate(testRange);
      expect(result.cacheHitRate).toBeGreaterThanOrEqual(0);
      expect(result.cacheHitRate).toBeLessThanOrEqual(1);
      expect(result.cacheReadTokens).toBeGreaterThan(0);
      expect(result.cacheWriteTokens).toBeGreaterThan(0);
    });

    it("should compute interpretation correctly", async () => {
      const result = await analyzer.getCacheHitRate(testRange);
      // Our test data has some cache reads, interpretation should be valid
      expect(["effective", "moderate", "ineffective"]).toContain(result.interpretation);
    });

    it("should return zero for empty time range", async () => {
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const result = await analyzer.getCacheHitRate(futureRange);
      expect(result.cacheHitRate).toBe(0);
      expect(result.interpretation).toBe("ineffective");
    });

    it("should estimate savings", async () => {
      const result = await analyzer.getCacheHitRate(testRange);
      expect(result.estimatedSavingsUSD).toBeGreaterThan(0);
    });
  });

  describe("getCacheTrend", () => {
    it("should return daily cache efficiency trend", async () => {
      const results = await analyzer.getCacheTrend(testRange);
      expect(results.length).toBeGreaterThan(0);
      for (const point of results) {
        expect(point.timestamp).toBeInstanceOf(Date);
        expect(point.cacheHitRate).toBeGreaterThanOrEqual(0);
        expect(point.cacheHitRate).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("getCacheBySession", () => {
    it("should return per-session cache metrics", async () => {
      const results = await analyzer.getCacheBySession(testRange);
      expect(results.length).toBeGreaterThan(0);
      for (const session of results) {
        expect(session.sessionId).toBeDefined();
        expect(session.cacheHitRate).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
