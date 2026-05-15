/**
 * @module tests/queries/token-analyzer
 *
 * Integration tests for the TokenAnalyzer class (F1 — Total Tokens KPI).
 * Uses DuckDB :memory: mode for fast, isolated test execution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, seedTestData, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { TokenAnalyzer, getTotalTokens } from "../../src/queries/token-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

/**
 * Expected token sums for the seed assistant turns in `testRange`
 * (turn-002/004/006/008/010 — `seedTestData` in tests/helpers/db-setup.ts):
 *   input  = 500 + 500 + 2000 + 800 + 700  = 4500
 *   output = 200 + 300 + 800  + 300 + 300  = 1900
 *   cacheW = 200 + 0   + 100  + 300 + 0    = 600
 *   cacheR = 0   + 300 + 500  + 0   + 1200 = 2000
 *   total  = 4500 + 1900 + 600 + 2000      = 9000
 */
const EXPECTED_PERIOD = {
  inputTokens: 4500,
  outputTokens: 1900,
  cacheWriteTokens: 600,
  cacheReadTokens: 2000,
  totalTokens: 9000,
};

describe("TokenAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: TokenAnalyzer;

  const testRange: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new TokenAnalyzer(executor);
    await seedTestData(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  describe("getTotalTokens", () => {
    it("returns the correct period breakdown over the cost-row population", async () => {
      const { period } = await analyzer.getTotalTokens(testRange);
      expect(period.inputTokens).toBe(EXPECTED_PERIOD.inputTokens);
      expect(period.outputTokens).toBe(EXPECTED_PERIOD.outputTokens);
      expect(period.cacheWriteTokens).toBe(EXPECTED_PERIOD.cacheWriteTokens);
      expect(period.cacheReadTokens).toBe(EXPECTED_PERIOD.cacheReadTokens);
      expect(period.totalTokens).toBe(EXPECTED_PERIOD.totalTokens);
    });

    it("totalTokens equals the sum of the four token categories", async () => {
      const { period, allTime } = await analyzer.getTotalTokens(testRange);
      expect(period.totalTokens).toBe(
        period.inputTokens +
          period.outputTokens +
          period.cacheReadTokens +
          period.cacheWriteTokens,
      );
      expect(allTime.totalTokens).toBe(
        allTime.inputTokens +
          allTime.outputTokens +
          allTime.cacheReadTokens +
          allTime.cacheWriteTokens,
      );
    });

    it("excludes non-assistant (user) turns", async () => {
      // The seed data's user turns all carry 0 tokens, so add a user turn with
      // real token counts: it must NOT be picked up by the predicate.
      await db.connection.run(`
        INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
        VALUES
          ('turn-user-tok', 'sess-001', 'user', '2026-02-20 10:02:00',
           9999, 9999, 9999, 9999, 0, 'claude-sonnet-4-5', NULL, NULL, FALSE, FALSE)
      `);
      const { period } = await analyzer.getTotalTokens(testRange);
      // Unchanged from the assistant-only baseline.
      expect(period.totalTokens).toBe(EXPECTED_PERIOD.totalTokens);
    });

    it("excludes the <synthetic> placeholder model", async () => {
      await db.connection.run(`
        INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
        VALUES
          ('turn-synth', 'sess-001', 'assistant', '2026-02-20 10:03:00',
           5000, 5000, 5000, 5000, 0, '<synthetic>', 'end_turn', 'req-synth', FALSE, FALSE)
      `);
      const { period, allTime } = await analyzer.getTotalTokens(testRange);
      // The <synthetic> row is excluded from BOTH blocks.
      expect(period.totalTokens).toBe(EXPECTED_PERIOD.totalTokens);
      expect(allTime.totalTokens).toBe(EXPECTED_PERIOD.totalTokens);
    });

    it("also excludes assistant turns with a NULL model", async () => {
      await db.connection.run(`
        INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
        VALUES
          ('turn-nullmodel', 'sess-001', 'assistant', '2026-02-20 10:04:00',
           7000, 7000, 7000, 7000, 0, NULL, 'end_turn', 'req-nm', FALSE, FALSE)
      `);
      const { period } = await analyzer.getTotalTokens(testRange);
      expect(period.totalTokens).toBe(EXPECTED_PERIOD.totalTokens);
    });

    it("returns a zeroed period breakdown when the range has no data", async () => {
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const { period, allTime } = await analyzer.getTotalTokens(futureRange);
      expect(period).toEqual({
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // All-time is dataset-wide — still populated even for an empty period.
      expect(allTime.totalTokens).toBe(EXPECTED_PERIOD.totalTokens);
    });

    it("the period block respects the model filter", async () => {
      const { period } = await analyzer.getTotalTokens(testRange, { model: "opus" });
      // Only turn-006 (claude-opus-4): 2000 / 800 / 100 / 500.
      expect(period.inputTokens).toBe(2000);
      expect(period.outputTokens).toBe(800);
      expect(period.cacheWriteTokens).toBe(100);
      expect(period.cacheReadTokens).toBe(500);
      expect(period.totalTokens).toBe(3400);
    });

    it("the period block respects the project filter", async () => {
      const { period } = await analyzer.getTotalTokens(testRange, { project: "beta" });
      // /projects/beta is sess-002 only → turn-006.
      expect(period.totalTokens).toBe(3400);
    });

    it("the all-time block is filter-invariant (D7)", async () => {
      const unfiltered = await analyzer.getTotalTokens(testRange);
      const modelFiltered = await analyzer.getTotalTokens(testRange, { model: "opus" });
      const projectFiltered = await analyzer.getTotalTokens(testRange, { project: "beta" });
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const otherPeriod = await analyzer.getTotalTokens(futureRange);

      // allTime never moves with the period or any filter.
      expect(modelFiltered.allTime).toEqual(unfiltered.allTime);
      expect(projectFiltered.allTime).toEqual(unfiltered.allTime);
      expect(otherPeriod.allTime).toEqual(unfiltered.allTime);
      // But the period block clearly does.
      expect(modelFiltered.period.totalTokens).not.toBe(unfiltered.period.totalTokens);
    });

    it("the getTotalTokens convenience wrapper matches the class method", async () => {
      const viaClass = await analyzer.getTotalTokens(testRange);
      const viaWrapper = await getTotalTokens(executor, testRange);
      expect(viaWrapper).toEqual(viaClass);
    });

    it("falls back to a zeroed breakdown when a query yields no rows", async () => {
      // A bare SQL aggregate (SELECT SUM(...) FROM ...) always returns exactly
      // one row, so the `toBreakdown(undefined)` guard is unreachable through a
      // real DuckDB connection. Drive it with a stub executor that returns an
      // empty `rows` array — `getTotalTokens` is still genuinely invoked, only
      // the executor's transport is substituted.
      const emptyExecutor = {
        query: async () => ({ rows: [] as unknown[] }),
      } as unknown as QueryExecutor;
      const result = await new TokenAnalyzer(emptyExecutor).getTotalTokens(
        testRange,
      );
      const zeroed = {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      expect(result.period).toEqual(zeroed);
      expect(result.allTime).toEqual(zeroed);
    });
  });
});
