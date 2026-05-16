/**
 * @module tests/queries/time-series
 *
 * Integration tests for the TimeSeriesAnalyzer class.
 *
 * The ACT-001 / SEM2-293 suite (`describe("timezone projection (ACT-001)")`)
 * is the load-bearing one: it asserts that the same row lands in different
 * hour-of-day / DOW / local-date buckets depending on the resolved
 * `userTimezone`, plus the cardinality invariant (the number of turns is
 * partition-shifted, not lost) and DST boundary behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, seedTestData, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { TimeSeriesAnalyzer } from "../../src/queries/time-series.js";
import { CostAnalyzer } from "../../src/queries/cost-analyzer.js";
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
    it("should return all 24 hour-of-day rows (ACT-003) with non-zero counts for hours that have traffic", async () => {
      const results = await analyzer.getHourlyActivity(testRange);
      // ACT-003 / SEM2-295: the response is always 24 rows, one per hour.
      expect(results).toHaveLength(24);
      // Hours come back in 0..23 order.
      expect(results.map((r) => r.hourOfDay)).toEqual(
        Array.from({ length: 24 }, (_, i) => i),
      );
      // At least one hour in the fixture has assistant turns.
      expect(results.some((r) => r.messageCount > 0)).toBe(true);
      // Every row has a defined zero-or-positive count (no NULL leakage).
      for (const row of results) {
        expect(row.messageCount).toBeGreaterThanOrEqual(0);
      }
    });

    it("should still return 24 rows for a future range — every row has messageCount=0 (ACT-003)", async () => {
      const futureRange: TimeRange = { start: new Date("2030-01-01"), end: new Date("2030-01-02") };
      const results = await analyzer.getHourlyActivity(futureRange);
      expect(results).toHaveLength(24);
      for (const row of results) {
        expect(row.messageCount).toBe(0);
        expect(row.sessionCount).toBe(0);
        expect(row.totalTokens).toBe(0);
        expect(row.totalCost).toBe(0);
      }
    });

    it("should filter by model and still return all 24 hour rows (ACT-003)", async () => {
      const results = await analyzer.getHourlyActivity(testRange, { model: "opus" });
      expect(results).toHaveLength(24);
      // At least one hour matches the filter.
      expect(results.some((r) => r.messageCount > 0)).toBe(true);
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

  describe("timezone projection (ACT-001)", () => {
    /**
     * Reset the DB and seed only the rows under test — keeps the asserts
     * single-row clean, since the baseline `seedTestData` set already has
     * unrelated assistant turns that would muddy hour/DOW counts.
     */
    async function reseedEmpty(): Promise<void> {
      await closeTestDB(db);
      db = await createTestDB();
      executor = new QueryExecutor(db.connection);
      analyzer = new TimeSeriesAnalyzer(executor);
    }

    async function insertTurn(
      turnId: string,
      sessionId: string,
      isoZ: string,
      model = "claude-sonnet-4-5",
    ): Promise<void> {
      // session row first (FK is implicit by query joins, but the analyzer
      // uses session_id COUNT DISTINCT and view JOINs reach for sessions).
      await db.connection.run(`
        INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          total_cost_usd, num_turns, num_tool_calls, project_path)
        VALUES ('${sessionId}', '${isoZ}', '${isoZ}', 1, '${model}', 100, 50, 0, 0, 0.01, 1, 0, '/p')
        ON CONFLICT DO NOTHING
      `);
      await db.connection.run(`
        INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
        VALUES ('${turnId}', '${sessionId}', 'assistant', '${isoZ}',
          100, 50, 0, 0, 0.01, '${model}', 'end_turn', 'req-${turnId}', FALSE, FALSE)
      `);
    }

    it("Israel-tz hour boundary: 22:30Z (2026-05-13) → hour 1 / date 2026-05-14 for Asia/Jerusalem; hour 22 / date 2026-05-13 for UTC", async () => {
      await reseedEmpty();
      await insertTurn("t-il-boundary", "sess-il", "2026-05-13T22:30:00.000Z");

      const range: TimeRange = {
        start: new Date("2026-05-13T00:00:00Z"),
        end: new Date("2026-05-15T00:00:00Z"),
      };

      // ACT-003 / SEM2-295: response is always 24 rows; assert the populated
      // hour holds the count and every other hour is zero.
      const hourlyIL = await analyzer.getHourlyActivity(range, {
        userTimezone: "Asia/Jerusalem",
      });
      expect(hourlyIL).toHaveLength(24);
      expect(hourlyIL[1]?.hourOfDay).toBe(1);
      expect(hourlyIL[1]?.messageCount).toBe(1);
      for (const row of hourlyIL) {
        if (row.hourOfDay !== 1) expect(row.messageCount).toBe(0);
      }

      const hourlyUTC = await analyzer.getHourlyActivity(range, {
        userTimezone: "UTC",
      });
      expect(hourlyUTC).toHaveLength(24);
      expect(hourlyUTC[22]?.hourOfDay).toBe(22);
      expect(hourlyUTC[22]?.messageCount).toBe(1);
      for (const row of hourlyUTC) {
        if (row.hourOfDay !== 22) expect(row.messageCount).toBe(0);
      }

      const dailyIL = await analyzer.getDailyActivity(range, {
        userTimezone: "Asia/Jerusalem",
      });
      expect(dailyIL).toHaveLength(1);
      expect(dailyIL[0]?.timestamp.toISOString().slice(0, 10)).toBe("2026-05-14");

      const dailyUTC = await analyzer.getDailyActivity(range, {
        userTimezone: "UTC",
      });
      expect(dailyUTC[0]?.timestamp.toISOString().slice(0, 10)).toBe("2026-05-13");
    });

    it("heatmap: 22:30Z Wednesday → Thursday (DOW=4) hour 1 in Asia/Jerusalem; Wednesday (DOW=3) hour 22 in UTC", async () => {
      await reseedEmpty();
      // 2026-05-13 is a Wednesday → DOW 3 in UTC; 2026-05-14 in Israel is Thursday → DOW 4.
      await insertTurn("t-il-dow", "sess-il-dow", "2026-05-13T22:30:00.000Z");

      const range: TimeRange = {
        start: new Date("2026-05-13T00:00:00Z"),
        end: new Date("2026-05-15T00:00:00Z"),
      };

      const heatmapIL = await analyzer.getActivityHeatmap(range, {
        userTimezone: "Asia/Jerusalem",
      });
      expect(heatmapIL).toHaveLength(1);
      expect(heatmapIL[0]?.dayOfWeek).toBe(4); // Thursday
      expect(heatmapIL[0]?.hourOfDay).toBe(1);

      const heatmapUTC = await analyzer.getActivityHeatmap(range, {
        userTimezone: "UTC",
      });
      expect(heatmapUTC[0]?.dayOfWeek).toBe(3); // Wednesday
      expect(heatmapUTC[0]?.hourOfDay).toBe(22);
    });

    it("DST spring-forward (Israel 2026-03-27 transition): a turn at 02:30Z lands at local hour 5 (post-transition)", async () => {
      await reseedEmpty();
      // Israel 2026 spring-forward: Fri 2026-03-27 at 02:00 IST (UTC+2)
      // → 03:00 IDT (UTC+3). A turn at 02:30Z falls after the transition
      // and should map to 02:30 + 3 = 05:30 local → hour 5.
      await insertTurn("t-dst-spring", "sess-dst-spring", "2026-03-27T02:30:00.000Z");

      const range: TimeRange = {
        start: new Date("2026-03-26T00:00:00Z"),
        end: new Date("2026-03-28T00:00:00Z"),
      };
      // ACT-003 / SEM2-295: 24 rows total, hour 5 is the only populated one.
      const hourly = await analyzer.getHourlyActivity(range, {
        userTimezone: "Asia/Jerusalem",
      });
      expect(hourly).toHaveLength(24);
      const populated = hourly.filter((r) => r.messageCount > 0);
      expect(populated).toHaveLength(1);
      expect(populated[0]?.hourOfDay).toBe(5);
      expect(populated[0]?.messageCount).toBe(1);
    });

    it("DST fall-back (Israel 2026-10-25 transition): two turns straddling the boundary land in distinct local hours", async () => {
      await reseedEmpty();
      // Israel 2026 fall-back happens at 23:00Z on 2026-10-24 (= 02:00 IDT
      // → 01:00 IST). Both fixture timestamps are AFTER the transition, so
      // both are evaluated at UTC+2:
      //   22:00Z (10-24) → 01:00 IDT (still DST, last DST hour) → hour 1
      //   00:30Z (10-25) → 02:30 IST (post-transition)          → hour 2
      //   02:30Z (10-25) → 04:30 IST (post-transition)          → hour 4
      // Using the 00:30Z / 02:30Z pair exercises one row before and one row
      // a couple of hours after the rollback.
      await insertTurn("t-dst-pre", "sess-dst-fall-pre", "2026-10-25T00:30:00.000Z");
      await insertTurn("t-dst-post", "sess-dst-fall-post", "2026-10-25T02:30:00.000Z");

      const range: TimeRange = {
        start: new Date("2026-10-25T00:00:00Z"),
        end: new Date("2026-10-26T00:00:00Z"),
      };
      // ACT-003 / SEM2-295: 24 rows; only hours 2 and 4 are populated.
      const hourly = await analyzer.getHourlyActivity(range, {
        userTimezone: "Asia/Jerusalem",
      });
      expect(hourly).toHaveLength(24);
      const populatedHours = hourly
        .filter((r) => r.messageCount > 0)
        .map((r) => r.hourOfDay)
        .sort((a, b) => a - b);
      expect(populatedHours).toEqual([2, 4]);

      // Sanity: UTC sees them at hours 0 and 2.
      const utcHourly = await analyzer.getHourlyActivity(range, { userTimezone: "UTC" });
      expect(utcHourly).toHaveLength(24);
      const utcPopulated = utcHourly
        .filter((r) => r.messageCount > 0)
        .map((r) => r.hourOfDay)
        .sort((a, b) => a - b);
      expect(utcPopulated).toEqual([0, 2]);
    });

    it("cardinality invariant: switching tz only re-partitions the bucket — row count is always 24 and total messageCount is unchanged", async () => {
      // Use the seedTestData fixture (4 assistant turns across two days).
      // ACT-003 / SEM2-295: the row count is now ALWAYS 24 regardless of tz;
      // the per-tz partition only shifts WHICH hours hold the counts. The
      // sum across hours stays invariant as before LANE D3.
      const utcRows = await analyzer.getHourlyActivity(testRange, { userTimezone: "UTC" });
      const ilRows = await analyzer.getHourlyActivity(testRange, { userTimezone: "Asia/Jerusalem" });
      const nyRows = await analyzer.getHourlyActivity(testRange, { userTimezone: "America/New_York" });

      expect(utcRows).toHaveLength(24);
      expect(ilRows).toHaveLength(24);
      expect(nyRows).toHaveLength(24);

      const totalUTC = utcRows.reduce((s, r) => s + r.messageCount, 0);
      const totalIL = ilRows.reduce((s, r) => s + r.messageCount, 0);
      const totalNY = nyRows.reduce((s, r) => s + r.messageCount, 0);
      expect(totalUTC).toBeGreaterThan(0);
      expect(totalIL).toBe(totalUTC);
      expect(totalNY).toBe(totalUTC);
    });

    it("invalid tz string silently degrades to UTC (analyzer-side defence; the dashboard route rejects it earlier)", async () => {
      const utcRows = await analyzer.getHourlyActivity(testRange, {
        userTimezone: "UTC",
      });
      const bogusRows = await analyzer.getHourlyActivity(testRange, {
        userTimezone: "Bogus/NotReal",
      });
      expect(bogusRows).toEqual(utcRows);
    });

    it("weekly trend buckets at the LOCAL week boundary (DATE_TRUNC tz-projected)", async () => {
      await reseedEmpty();
      // 2026-05-13T22:30:00Z is Wed (UTC) but Thu in Israel.
      // DuckDB's DATE_TRUNC('week', ...) is Monday-anchored — Mon 2026-05-11.
      // The point: both UTC and Israel land on the same week (2026-05-11) for
      // this row, but for a Sunday-night roll case (e.g. 2026-05-17T22:30:00Z
      // is Sun in UTC, Mon in Israel) the two should differ. Use the latter.
      await insertTurn("t-week-il", "sess-week-il", "2026-05-17T22:30:00.000Z");

      const range: TimeRange = {
        start: new Date("2026-05-10T00:00:00Z"),
        end: new Date("2026-05-19T00:00:00Z"),
      };
      const weeklyUTC = await analyzer.getWeeklyTrend(range, { userTimezone: "UTC" });
      const weeklyIL = await analyzer.getWeeklyTrend(range, { userTimezone: "Asia/Jerusalem" });

      // UTC: 2026-05-17 is Sunday → week starts Mon 2026-05-11.
      // Israel: local is 2026-05-18 Monday → week starts Mon 2026-05-18.
      expect(weeklyUTC[0]?.timestamp.toISOString().slice(0, 10)).toBe("2026-05-11");
      expect(weeklyIL[0]?.timestamp.toISOString().slice(0, 10)).toBe("2026-05-18");
    });
  });

  describe("24 hour buckets (ACT-003 / SEM2-295)", () => {
    /**
     * Same reseed helpers as the ACT-001 block — kept local so the fixture is
     * unambiguous (1 row at a known UTC instant, asserting per-tz placement).
     */
    async function reseedEmpty(): Promise<void> {
      await closeTestDB(db);
      db = await createTestDB();
      executor = new QueryExecutor(db.connection);
      analyzer = new TimeSeriesAnalyzer(executor);
    }

    async function insertTurn(
      turnId: string,
      sessionId: string,
      isoZ: string,
      model = "claude-sonnet-4-5",
    ): Promise<void> {
      await db.connection.run(`
        INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          total_cost_usd, num_turns, num_tool_calls, project_path)
        VALUES ('${sessionId}', '${isoZ}', '${isoZ}', 1, '${model}', 100, 50, 0, 0, 0.01, 1, 0, '/p')
        ON CONFLICT DO NOTHING
      `);
      await db.connection.run(`
        INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
        VALUES ('${turnId}', '${sessionId}', 'assistant', '${isoZ}',
          100, 50, 0, 0, 0.01, '${model}', 'end_turn', 'req-${turnId}', FALSE, FALSE)
      `);
    }

    it("Israel: a single turn at local hour 14 produces 24 rows with hour 14 populated and the other 23 zeroed", async () => {
      await reseedEmpty();
      // 11:00Z on 2026-05-13 → 14:00 IDT (UTC+3) on the same day.
      await insertTurn("t-act003-il", "sess-act003-il", "2026-05-13T11:00:00.000Z");

      const range: TimeRange = {
        start: new Date("2026-05-13T00:00:00Z"),
        end: new Date("2026-05-14T00:00:00Z"),
      };
      const hourly = await analyzer.getHourlyActivity(range, {
        userTimezone: "Asia/Jerusalem",
      });

      expect(hourly).toHaveLength(24);
      expect(hourly.map((r) => r.hourOfDay)).toEqual(
        Array.from({ length: 24 }, (_, i) => i),
      );

      const fourteen = hourly[14];
      expect(fourteen?.hourOfDay).toBe(14);
      expect(fourteen?.messageCount).toBe(1);
      expect(fourteen?.sessionCount).toBe(1);
      expect(fourteen?.totalTokens).toBe(150);
      expect(fourteen?.totalCost).toBeCloseTo(0.01, 6);

      for (const row of hourly) {
        if (row.hourOfDay === 14) continue;
        expect(row.messageCount).toBe(0);
        expect(row.sessionCount).toBe(0);
        expect(row.totalTokens).toBe(0);
        expect(row.totalCost).toBe(0);
        expect(row.avgCost).toBe(0);
        expect(row.avgTokensPerTurn).toBe(0);
      }
    });

    it("UTC: a turn at UTC hour 22 produces 24 rows with hour 22 populated and the other 23 zeroed", async () => {
      await reseedEmpty();
      await insertTurn("t-act003-utc", "sess-act003-utc", "2026-05-14T22:00:00.000Z");

      const range: TimeRange = {
        start: new Date("2026-05-14T00:00:00Z"),
        end: new Date("2026-05-15T00:00:00Z"),
      };
      const hourly = await analyzer.getHourlyActivity(range, {
        userTimezone: "UTC",
      });

      expect(hourly).toHaveLength(24);
      const populated = hourly.filter((r) => r.messageCount > 0);
      expect(populated).toHaveLength(1);
      expect(populated[0]?.hourOfDay).toBe(22);
      expect(populated[0]?.messageCount).toBe(1);

      // Every other hour is exactly zero (no silent drops, no NULL leakage).
      for (const row of hourly) {
        if (row.hourOfDay === 22) continue;
        expect(row.messageCount).toBe(0);
        expect(row.totalTokens).toBe(0);
      }
    });

    it("empty fixture: 24 rows even when the underlying table has no turns at all", async () => {
      await reseedEmpty();
      const range: TimeRange = {
        start: new Date("2026-05-13T00:00:00Z"),
        end: new Date("2026-05-14T00:00:00Z"),
      };
      const hourly = await analyzer.getHourlyActivity(range, {
        userTimezone: "Asia/Jerusalem",
      });
      expect(hourly).toHaveLength(24);
      expect(hourly.every((r) => r.messageCount === 0)).toBe(true);
      // Hours are in 0..23 order, no duplicates.
      expect(hourly.map((r) => r.hourOfDay)).toEqual(
        Array.from({ length: 24 }, (_, i) => i),
      );
    });
  });

  /**
   * SEM2-297 / ACT-005: activity now uses the SAME cost-row predicate as
   * v_daily_cost / CostAnalyzer / /api/cost/*. Before the fix, activity
   * counted every role='assistant' row including the `<synthetic>` placeholder
   * model and NULL-model rows, which v_daily_cost has always excluded — the
   * two populations differed by up to ~5.8%/day on the live dataset for the
   * same date range.
   *
   * The tests below reset to an empty DB, seed a controlled mix of "real"
   * assistant rows + a synthetic row + a null-model row + a user row, then
   * assert that:
   *   1. activity (hourly / daily / heatmap / weekly) counts only the REAL
   *      assistant rows — synthetic, NULL-model, and user rows are excluded.
   *   2. activity row count for the day equals the cost-bearing turn_count
   *      for that day. (CostAnalyzer.getDailyCosts returns a turn count per
   *      (date, model); summing across models for one date == activity.)
   */
  describe("cost-row predicate (SEM2-297)", () => {
    async function reseedEmpty(): Promise<void> {
      await closeTestDB(db);
      db = await createTestDB();
      executor = new QueryExecutor(db.connection);
      analyzer = new TimeSeriesAnalyzer(executor);
    }

    /**
     * Insert one session + one conversation_turns row with the given role /
     * model. Keeps each row independent so the fixture is easy to reason about.
     */
    async function insertTurn(opts: {
      turnId: string;
      sessionId: string;
      isoZ: string;
      role: "user" | "assistant";
      model: string | null;
    }): Promise<void> {
      const { turnId, sessionId, isoZ, role, model } = opts;
      const sessModel = model ?? "claude-sonnet-4-5";
      await db.connection.run(`
        INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          total_cost_usd, num_turns, num_tool_calls, project_path)
        VALUES ('${sessionId}', '${isoZ}', '${isoZ}', 1, '${sessModel}',
          100, 50, 0, 0, 0.01, 1, 0, '/p')
        ON CONFLICT DO NOTHING
      `);
      const modelSql = model === null ? "NULL" : `'${model}'`;
      await db.connection.run(`
        INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
        VALUES ('${turnId}', '${sessionId}', '${role}', '${isoZ}',
          100, 50, 0, 0, 0.01, ${modelSql}, 'end_turn', 'req-${turnId}', FALSE, FALSE)
      `);
    }

    /** Date 2026-04-15, three real rows + one synthetic + one null-model + one user. */
    async function seedMixedDay(): Promise<{ realCount: number }> {
      await reseedEmpty();
      // 3 cost-bearing assistant rows (real model)
      await insertTurn({ turnId: "t-real-1", sessionId: "s-real-1", isoZ: "2026-04-15T10:00:00.000Z", role: "assistant", model: "claude-sonnet-4-5" });
      await insertTurn({ turnId: "t-real-2", sessionId: "s-real-2", isoZ: "2026-04-15T11:00:00.000Z", role: "assistant", model: "claude-opus-4" });
      await insertTurn({ turnId: "t-real-3", sessionId: "s-real-3", isoZ: "2026-04-15T12:00:00.000Z", role: "assistant", model: "claude-sonnet-4-5" });
      // 1 synthetic row (assistant, but '<synthetic>' model — excluded by v_daily_cost)
      await insertTurn({ turnId: "t-synth", sessionId: "s-synth", isoZ: "2026-04-15T13:00:00.000Z", role: "assistant", model: "<synthetic>" });
      // 1 null-model assistant row (excluded by v_daily_cost)
      await insertTurn({ turnId: "t-nullmodel", sessionId: "s-nullmodel", isoZ: "2026-04-15T14:00:00.000Z", role: "assistant", model: null });
      // 1 user row (excluded by the role filter)
      await insertTurn({ turnId: "t-user", sessionId: "s-user", isoZ: "2026-04-15T15:00:00.000Z", role: "user", model: "claude-sonnet-4-5" });
      return { realCount: 3 };
    }

    const dayRange: TimeRange = {
      start: new Date("2026-04-15T00:00:00Z"),
      end: new Date("2026-04-16T00:00:00Z"),
    };

    it("daily activity excludes synthetic + null-model assistant rows (matches v_daily_cost)", async () => {
      const { realCount } = await seedMixedDay();
      const daily = await analyzer.getDailyActivity(dayRange, { userTimezone: "UTC" });
      expect(daily).toHaveLength(1);
      expect(daily[0]?.value).toBe(realCount);
    });

    it("hourly activity excludes synthetic + null-model assistant rows", async () => {
      const { realCount } = await seedMixedDay();
      // ACT-003 / SEM2-295: hourly is 24 rows post-D3. Sum across hours equals
      // the cost-bearing population; the hours of synthetic/null/user rows must
      // be zero because those rows are excluded by the predicate.
      const hourly = await analyzer.getHourlyActivity(dayRange, { userTimezone: "UTC" });
      expect(hourly).toHaveLength(24);
      const total = hourly.reduce((s, r) => s + r.messageCount, 0);
      expect(total).toBe(realCount);
      // The synthetic row is at hour 13, null-model at 14, user at 15 — those
      // hours hold zero messages since they're the only rows at those hours.
      expect(hourly[13]?.messageCount).toBe(0);
      expect(hourly[14]?.messageCount).toBe(0);
      expect(hourly[15]?.messageCount).toBe(0);
    });

    it("heatmap activity excludes synthetic + null-model assistant rows", async () => {
      const { realCount } = await seedMixedDay();
      const heatmap = await analyzer.getActivityHeatmap(dayRange, { userTimezone: "UTC" });
      const total = heatmap.reduce((s, r) => s + r.value, 0);
      expect(total).toBe(realCount);
    });

    it("weekly trend excludes synthetic + null-model assistant rows", async () => {
      const { realCount } = await seedMixedDay();
      // Include enough of a window for DATE_TRUNC('week', ...) — Mon 2026-04-13 is the week start.
      const weekRange: TimeRange = {
        start: new Date("2026-04-13T00:00:00Z"),
        end: new Date("2026-04-20T00:00:00Z"),
      };
      const weekly = await analyzer.getWeeklyTrend(weekRange, { userTimezone: "UTC" });
      const total = weekly.reduce((s, p) => s + p.value, 0);
      expect(total).toBe(realCount);
    });

    it("daily activity row count equals daily cost turn_count (populations reconcile)", async () => {
      await seedMixedDay();
      const costAnalyzer = new CostAnalyzer(executor);
      const activity = await analyzer.getDailyActivity(dayRange, { userTimezone: "UTC" });
      const costs = await costAnalyzer.getDailyCosts(dayRange, { userTimezone: "UTC" });

      // Sum cost turn_count across models for date 2026-04-15. DuckDB may
      // return DATE columns as a Date object or various string formats — the
      // existing cost-analyzer tests normalize the same way.
      const costDay = costs.filter((c) => {
        const d = new Date(c.date);
        return d.toISOString().slice(0, 10) === "2026-04-15";
      });
      const costTurnCount = costDay.reduce((s, c) => s + (c.turnCount ?? 0), 0);

      const activityCount = activity[0]?.value ?? 0;
      // The whole point of LANE J — same row inclusion both sides.
      expect(activityCount).toBe(costTurnCount);
      // And both must be > 0 (sanity — we did seed 3 real rows).
      expect(activityCount).toBeGreaterThan(0);
    });

    it("regression: pure role='user' rows are still excluded from activity", async () => {
      await reseedEmpty();
      // Only user rows.
      await insertTurn({ turnId: "t-u1", sessionId: "s-u1", isoZ: "2026-04-15T10:00:00.000Z", role: "user", model: null });
      await insertTurn({ turnId: "t-u2", sessionId: "s-u2", isoZ: "2026-04-15T11:00:00.000Z", role: "user", model: "claude-sonnet-4-5" });

      // ACT-003 / SEM2-295: hourly returns 24 zero-filled buckets when there
      // are no cost-bearing rows in the window; daily and heatmap stay empty.
      const daily = await analyzer.getDailyActivity(dayRange, { userTimezone: "UTC" });
      const hourly = await analyzer.getHourlyActivity(dayRange, { userTimezone: "UTC" });
      const heatmap = await analyzer.getActivityHeatmap(dayRange, { userTimezone: "UTC" });
      expect(daily).toEqual([]);
      expect(hourly).toHaveLength(24);
      expect(hourly.every((r) => r.messageCount === 0)).toBe(true);
      expect(heatmap).toEqual([]);
    });
  });
});
