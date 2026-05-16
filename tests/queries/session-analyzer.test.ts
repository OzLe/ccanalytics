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

    /**
     * SEM2-281: long-tailed-distribution regression — surface MEDIAN as the
     * primary duration KPI, and a 12h-capped MEAN as the secondary one. The
     * raw arithmetic mean must stay in the response (as a sanity-check field
     * exposing the inflation) but must NOT be what the dashboard reads.
     *
     * Fixture: a single zombie session of ~37 days alongside 5 well-behaved
     * sessions of 30 min each — mirrors the live-data shape that drove the
     * headline avg_duration_minutes to 332 min in prod.
     *
     * The fixture lives in a dedicated date window (2026-03-01 .. 2026-03-05)
     * so it does not collide with the LANE A reconciliation fixture or the
     * existing `getSessionStats` row-count assertions above. The zombie sits
     * inside that window so the period AVG includes it.
     */
    describe("SEM2-281: duration KPI under zombie sessions", () => {
      const sem281Range: TimeRange = {
        start: new Date("2026-03-01T00:00:00Z"),
        end: new Date("2026-03-05T00:00:00Z"),
      };
      const NORMAL_DURATION_SECONDS = 30 * 60; // 30 min
      const ZOMBIE_DURATION_SECONDS = 37 * 24 * 60 * 60; // 37 days
      const CAP_SECONDS = 12 * 60 * 60; // mirrors SESSION_DURATION_CAP_SECONDS

      beforeEach(async () => {
        // 5 normal sessions @ 30 min + 1 zombie @ 37 days, all on 2026-03-02.
        // No conversation_turns / tool_calls — v_session_summary still emits
        // the row (LEFT JOIN), with num_turns / num_tool_calls coalesced to 0
        // and total_cost_usd to 0.0. duration_seconds is read straight off the
        // sessions row, which is what this test cares about.
        const rows: string[] = [];
        for (let i = 1; i <= 5; i++) {
          const id = `sem281-normal-${i}`;
          rows.push(
            `('${id}', '2026-03-02 10:0${i - 1}:00', '2026-03-02 10:3${i - 1}:00', ${NORMAL_DURATION_SECONDS}, 'claude-sonnet-4-5', 0, 0, 0, 0, 0.0, 0, 0, '/projects/sem281')`,
          );
        }
        rows.push(
          `('sem281-zombie', '2026-03-02 12:00:00', '2026-04-08 12:00:00', ${ZOMBIE_DURATION_SECONDS}, 'claude-sonnet-4-5', 0, 0, 0, 0, 0.0, 0, 0, '/projects/sem281')`,
        );
        await db.connection.run(
          `INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model,
             input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
             total_cost_usd, num_turns, num_tool_calls, project_path)
           VALUES ${rows.join(",\n")}`,
        );
      });

      it("MEDIAN equals the normal-session value, unaffected by the zombie", async () => {
        const stats = await analyzer.getSessionStats(sem281Range);
        expect(stats.totalSessions).toBe(6);
        // 6 sessions sorted by duration: [30, 30, 30, 30, 30, 53280] min.
        // Median = avg of 3rd and 4th = 30 min exactly.
        expect(stats.medianDurationMinutes).toBeCloseTo(
          NORMAL_DURATION_SECONDS / 60,
          6,
        );
      });

      it("capped MEAN clamps the zombie at 12h before averaging", async () => {
        const stats = await analyzer.getSessionStats(sem281Range);
        // Expected: (5 * 1800s + 1 * 43200s) / 6 / 60 = (9000 + 43200) / 6 / 60
        //        = 52200 / 360 ≈ 145 min.
        // That is, the zombie contributes exactly 12h (the cap), not 37 days.
        const expectedCappedMeanMin =
          (5 * NORMAL_DURATION_SECONDS + CAP_SECONDS) / 6 / 60;
        expect(stats.cappedMeanDurationMinutes).toBeCloseTo(expectedCappedMeanMin, 6);
        // Sanity bracket: the capped mean must sit between the normal value
        // and the cap (≤ 12h = 720 min), and must be > the median.
        expect(stats.cappedMeanDurationMinutes).toBeLessThanOrEqual(720);
        expect(stats.cappedMeanDurationMinutes).toBeGreaterThan(
          stats.medianDurationMinutes,
        );
      });

      it("raw MEAN still reflects the zombie inflation (sanity check)", async () => {
        const stats = await analyzer.getSessionStats(sem281Range);
        // Expected raw mean: (5 * 1800 + 1 * 3196800) / 6 / 60 ≈ 8908 min ≈ 6.2 days.
        // The exact ratio matters less than: raw mean >> capped mean >> median.
        // This is the structural-distortion signal that motivated SEM2-281.
        const expectedRawMeanMin =
          (5 * NORMAL_DURATION_SECONDS + ZOMBIE_DURATION_SECONDS) / 6 / 60;
        expect(stats.avgDurationMinutes).toBeCloseTo(expectedRawMeanMin, 6);
        // The whole point of the lane: raw mean is at least 10x the capped
        // mean on this distribution. (Actual ratio ≈ 61x — pick a loose
        // threshold so the assertion stays meaningful if anyone re-tunes the
        // fixture in the future.)
        expect(stats.avgDurationMinutes).toBeGreaterThan(
          stats.cappedMeanDurationMinutes * 10,
        );
      });
    });
  });
});
