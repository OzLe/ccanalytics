/**
 * @module tests/queries/session-analyzer
 *
 * Integration tests for the SessionAnalyzer class.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, seedTestData, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { SessionAnalyzer } from "../../src/queries/session-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

describe("SessionAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: SessionAnalyzer;

  const testRange: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new SessionAnalyzer(executor);
    await seedTestData(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  describe("getSessions", () => {
    it("should return sessions within the time range", async () => {
      const results = await analyzer.getSessions({ range: testRange });
      expect(results.length).toBe(3);
    });

    it("should sort by cost descending", async () => {
      const results = await analyzer.getSessions({ range: testRange, sortBy: "cost", order: "desc" });
      expect(results.length).toBe(3);
      expect(results[0].totalCostUSD).toBeGreaterThanOrEqual(results[1].totalCostUSD);
    });

    it("should respect limit", async () => {
      const results = await analyzer.getSessions({ range: testRange, limit: 1 });
      expect(results.length).toBe(1);
    });

    it("should return empty for future range", async () => {
      const futureRange: TimeRange = { start: new Date("2030-01-01"), end: new Date("2030-01-02") };
      const results = await analyzer.getSessions({ range: futureRange });
      expect(results).toEqual([]);
    });

    it("should filter by model", async () => {
      const results = await analyzer.getSessions({ range: testRange, filters: { model: "opus" } });
      expect(results.length).toBe(1);
      expect(results[0].model.toLowerCase()).toContain("opus");
    });
  });

  describe("getSessionDetail", () => {
    it("should return full session detail with turns and tool calls", async () => {
      const detail = await analyzer.getSessionDetail("sess-001");
      expect(detail).not.toBeNull();
      expect(detail!.sessionId).toBe("sess-001");
      expect(detail!.turns.length).toBeGreaterThan(0);
      expect(detail!.toolCalls.length).toBeGreaterThan(0);
    });

    it("should return null for non-existent session", async () => {
      const detail = await analyzer.getSessionDetail("non-existent");
      expect(detail).toBeNull();
    });
  });

  describe("getSessionStats", () => {
    it("should return aggregate statistics", async () => {
      const stats = await analyzer.getSessionStats(testRange);
      expect(stats.totalSessions).toBe(3);
      expect(stats.totalTurns).toBeGreaterThan(0);
      expect(stats.avgTurnsPerSession).toBeGreaterThan(0);
      expect(stats.uniqueModels.length).toBe(2);
    });

    it("should return zero stats for empty range", async () => {
      const futureRange: TimeRange = { start: new Date("2030-01-01"), end: new Date("2030-01-02") };
      const stats = await analyzer.getSessionStats(futureRange);
      expect(stats.totalSessions).toBe(0);
      expect(stats.totalTurns).toBe(0);
    });

    it("should filter by model", async () => {
      const stats = await analyzer.getSessionStats(testRange, { model: "opus" });
      expect(stats.totalSessions).toBe(1);
    });
  });
});
