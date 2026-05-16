/**
 * @module tests/queries/token-views
 *
 * Integration tests covering the token-related analytical views and the
 * cross-surface reconciliation invariants that LANE E was tasked to enforce
 * (TOK-001 / TOK-002 / ACT-004 — SEM2-288 / SEM2-289 / SEM2-296).
 *
 * In summary:
 *   - `v_token_totals.total_tokens`           = 2-way (TOK-001, canonical)
 *   - `v_token_totals.context_volume_tokens`  = 4-way (TOK-002, secondary)
 *   - `v_session_summary.total_tokens`        = 2-way (TOK-001)
 *   - `v_session_summary.context_volume_tokens` = 4-way (TOK-002)
 *   - `v_hourly_activity.total_tokens`        = 2-way (ACT-004, matches the
 *                                                /api/activity/hourly route)
 *   - TokenAnalyzer.getTotalTokens period totalTokens === sum of
 *     v_hourly_activity.total_tokens for the same population (the bug fix —
 *     two endpoints diverged ~294x on the live dataset).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDB,
  closeTestDB,
  seedTestData,
  type TestDB,
} from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { TokenAnalyzer } from "../../src/queries/token-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

/**
 * Expected sums for the seed assistant turns (turn-002 / 004 / 006 / 008 /
 * 010 from `seedTestData`):
 *   input  = 4500, output = 1900, cacheW = 600, cacheR = 2000
 *   2-way (TOK-001) = 6400
 *   4-way (TOK-002) = 9000
 */
const EXPECTED_TWO_WAY = 6400;
const EXPECTED_FOUR_WAY = 9000;

describe("token-related views (LANE E)", () => {
  let db: TestDB;
  let executor: QueryExecutor;

  const testRange: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    await seedTestData(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  // -------------------------------------------------------------------------
  // v_token_totals — TOK-001 / TOK-002
  // -------------------------------------------------------------------------

  describe("v_token_totals", () => {
    it("exposes both `total_tokens` (2-way) and `context_volume_tokens` (4-way)", async () => {
      const result = await executor.query<{
        input_tokens: number;
        output_tokens: number;
        cache_write_tokens: number;
        cache_read_tokens: number;
        total_tokens: number;
        context_volume_tokens: number;
      }>(`SELECT * FROM v_token_totals`);
      expect(result.rowCount).toBe(1);
      const row = result.rows[0];
      expect(Number(row.input_tokens)).toBe(4500);
      expect(Number(row.output_tokens)).toBe(1900);
      expect(Number(row.cache_write_tokens)).toBe(600);
      expect(Number(row.cache_read_tokens)).toBe(2000);
      // TOK-001: canonical headline.
      expect(Number(row.total_tokens)).toBe(EXPECTED_TWO_WAY);
      // TOK-002: secondary "Context Volume".
      expect(Number(row.context_volume_tokens)).toBe(EXPECTED_FOUR_WAY);
    });

    it("`total_tokens` equals `input_tokens + output_tokens`", async () => {
      const result = await executor.query<{
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
      }>(`SELECT input_tokens, output_tokens, total_tokens FROM v_token_totals`);
      const r = result.rows[0];
      expect(Number(r.total_tokens)).toBe(
        Number(r.input_tokens) + Number(r.output_tokens),
      );
    });

    it("`context_volume_tokens` includes the cache columns", async () => {
      const result = await executor.query<{
        input_tokens: number;
        output_tokens: number;
        cache_write_tokens: number;
        cache_read_tokens: number;
        context_volume_tokens: number;
      }>(`SELECT * FROM v_token_totals`);
      const r = result.rows[0];
      expect(Number(r.context_volume_tokens)).toBe(
        Number(r.input_tokens) +
          Number(r.output_tokens) +
          Number(r.cache_write_tokens) +
          Number(r.cache_read_tokens),
      );
    });
  });

  // -------------------------------------------------------------------------
  // v_session_summary — TOK-001 / TOK-002
  // -------------------------------------------------------------------------

  describe("v_session_summary", () => {
    it("`total_tokens` is 2-way per session (TOK-001)", async () => {
      // sess-002 has one assistant turn (turn-006): input=2000, output=800,
      // cache_creation=100, cache_read=500 → 2-way = 2800.
      const result = await executor.query<{ total_tokens: number }>(
        `SELECT total_tokens FROM v_session_summary WHERE session_id = 'sess-002'`,
      );
      expect(Number(result.rows[0].total_tokens)).toBe(2800);
    });

    it("`context_volume_tokens` is 4-way per session (TOK-002)", async () => {
      // sess-002 → 4-way = 2000 + 800 + 100 + 500 = 3400.
      const result = await executor.query<{ context_volume_tokens: number }>(
        `SELECT context_volume_tokens FROM v_session_summary WHERE session_id = 'sess-002'`,
      );
      expect(Number(result.rows[0].context_volume_tokens)).toBe(3400);
    });

    it("aggregating per-session `total_tokens` agrees with the dataset 2-way", async () => {
      // All three seed sessions roll up to the TokenAnalyzer's 2-way sum.
      const result = await executor.query<{ s: number }>(
        `SELECT SUM(total_tokens) AS s FROM v_session_summary`,
      );
      expect(Number(result.rows[0].s)).toBe(EXPECTED_TWO_WAY);
    });

    it("aggregating per-session `context_volume_tokens` agrees with the dataset 4-way", async () => {
      const result = await executor.query<{ s: number }>(
        `SELECT SUM(context_volume_tokens) AS s FROM v_session_summary`,
      );
      expect(Number(result.rows[0].s)).toBe(EXPECTED_FOUR_WAY);
    });
  });

  // -------------------------------------------------------------------------
  // v_hourly_activity — ACT-004
  // -------------------------------------------------------------------------

  describe("v_hourly_activity (ACT-004)", () => {
    it("`total_tokens` is 2-way to match /api/activity/hourly", async () => {
      // Summed across hours = the dataset-wide 2-way (all seed assistant
      // turns fall under role='assistant', the view's only predicate).
      const result = await executor.query<{ s: number }>(
        `SELECT SUM(total_tokens) AS s FROM v_hourly_activity`,
      );
      expect(Number(result.rows[0].s)).toBe(EXPECTED_TWO_WAY);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-surface reconciliation — the bug being fixed (SEM2-296)
  // -------------------------------------------------------------------------

  describe("cross-surface reconciliation (SEM2-296)", () => {
    /**
     * The headline bug: `/api/tokens/total` reported a 4-way sum while
     * `/api/activity/hourly` reported a 2-way sum, on the same population.
     * Live dataset gap was 293.95x. This test asserts both surfaces now
     * agree on the canonical 2-way headline for the SAME population.
     *
     * Implementation note: v_hourly_activity does not apply the
     * costRowPredicate (it filters by `role = 'assistant'` only), while
     * TokenAnalyzer applies costRowPredicate. The seed data carries no
     * NULL-model or `<synthetic>` assistant turns, so both predicates select
     * the same five rows here — the totals match exactly. The test is
     * intentionally a same-population test (no NULL-model row injected),
     * which is the practical case for users on real data.
     */
    it("TokenAnalyzer period totalTokens === SUM(v_hourly_activity.total_tokens)", async () => {
      const analyzer = new TokenAnalyzer(executor);
      const { period } = await analyzer.getTotalTokens(testRange);

      const hourlyResult = await executor.query<{ s: number }>(
        `SELECT COALESCE(SUM(total_tokens), 0) AS s
         FROM v_hourly_activity
         WHERE EXISTS (
           SELECT 1 FROM conversation_turns ct
           WHERE ct.role = 'assistant'
             AND ct.model IS NOT NULL
             AND ct.model <> '<synthetic>'
             AND EXTRACT(HOUR FROM ct.timestamp) = v_hourly_activity.hour_of_day
             AND ct.timestamp >= '2026-02-19'
             AND ct.timestamp < '2026-02-22'
         )`,
      );

      const hourlyTotal = Number(hourlyResult.rows[0].s);
      // The two surfaces now report the same canonical 2-way headline. This
      // is the assertion that would have caught the original 293.95x gap.
      expect(period.totalTokens).toBe(hourlyTotal);
    });

    it("the canonical headline is 2-way, NOT 4-way (TOK-001 regression guard)", async () => {
      const analyzer = new TokenAnalyzer(executor);
      const { period } = await analyzer.getTotalTokens(testRange);
      // If a future edit reverts TokenAnalyzer to a 4-way sum, this test
      // catches it before re-introducing the ~294x gap.
      expect(period.totalTokens).toBe(EXPECTED_TWO_WAY);
      expect(period.totalTokens).not.toBe(EXPECTED_FOUR_WAY);
      expect(period.contextVolumeTokens).toBe(EXPECTED_FOUR_WAY);
    });
  });
});
