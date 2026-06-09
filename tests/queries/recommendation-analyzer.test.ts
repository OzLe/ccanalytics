/**
 * @module tests/queries/recommendation-analyzer
 *
 * Integration tests for {@link RecommendationAnalyzer} against a TEMP in-memory
 * DuckDB (§7.2). Seeds turns with KNOWN timestamps + tokens and asserts window
 * reconstruction, the per-model weekly split, auto-calibration provenance, and
 * the final verdict. NEVER touches the live ~/.ccanalytics DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { RecommendationAnalyzer } from "../../src/queries/recommendation-analyzer.js";
import { DEFAULT_TIER_LIMITS, RECOMMENDATION_ESTIMATE_CAVEAT } from "../../src/config/limits.js";
import type { TimeRange } from "../../src/types/index.js";

/**
 * Seed cost-bearing assistant turns directly (no reliance on the shared
 * seedTestData) so timestamps + tokens are fully controlled. All turns are
 * `role='assistant'` with a non-synthetic model so they pass costRowPredicate.
 *
 * Layout (all in Feb 2026, UTC):
 *   Day 20 10:00  sonnet  req-a  small tokens   ─┐ window A (5h)
 *   Day 20 12:00  sonnet  req-b  small tokens   ─┘ (2h after anchor → same window)
 *   Day 20 16:30  opus    req-c  small tokens   ──> window B (6.5h after A's anchor)
 *   Mar 05 11:00  opus    req-d  small tokens   ──> a clearly separate WEEK (>7d
 *                                                   after both the all-models and
 *                                                   the opus-only weekly anchors)
 *
 * Three distinct 5h windows total (A, B, and Mar-05). Across the set the
 * all-models pass yields two weekly windows (Feb-20 and Mar-05); sonnet appears
 * only in week 1; opus appears in both weeks (Feb-20 16:30 and Mar-05).
 */
async function seedWindowFixture(db: TestDB): Promise<void> {
  await db.connection.run(`
    INSERT INTO sessions (session_id, start_time, project_path, model)
    VALUES ('rs-1', '2026-02-20 10:00:00', '/p/alpha', 'claude-sonnet-4-5')
  `);
  await db.connection.run(`
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
    VALUES
      ('rt-1', 'rs-1', 'assistant', '2026-02-20 10:00:00', 1000, 500, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'req-a', FALSE, FALSE),
      ('rt-2', 'rs-1', 'assistant', '2026-02-20 12:00:00', 1000, 500, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'req-b', FALSE, FALSE),
      ('rt-3', 'rs-1', 'assistant', '2026-02-20 16:30:00', 1000, 500, 0, 0, 0.01, 'claude-opus-4',      'end_turn', 'req-c', FALSE, FALSE),
      ('rt-4', 'rs-1', 'assistant', '2026-03-05 11:00:00', 1000, 500, 0, 0, 0.01, 'claude-opus-4',      'end_turn', 'req-d', FALSE, FALSE)
  `);
}

/**
 * Seed a single 5-hour window whose summed tokens EXCEED the Pro 5h token
 * ceiling (45 × 35,000 = 1,575,000) so auto-calibration must raise the ceiling.
 * Three turns within ~1h, each 700k tokens → 2.1M > 1.575M.
 */
async function seedBurstFixture(db: TestDB): Promise<void> {
  await db.connection.run(`
    INSERT INTO sessions (session_id, start_time, project_path, model)
    VALUES ('bs-1', '2026-03-01 09:00:00', '/p/burst', 'claude-sonnet-4-5')
  `);
  await db.connection.run(`
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
    VALUES
      ('bt-1', 'bs-1', 'assistant', '2026-03-01 09:00:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'breq-1', FALSE, FALSE),
      ('bt-2', 'bs-1', 'assistant', '2026-03-01 09:30:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'breq-2', FALSE, FALSE),
      ('bt-3', 'bs-1', 'assistant', '2026-03-01 10:00:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'breq-3', FALSE, FALSE)
  `);
}

describe("RecommendationAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: RecommendationAnalyzer;

  // Wide range covering all fixtures + a fixed "now" so recency is deterministic.
  const fullRange: TimeRange = {
    start: new Date("2026-02-01T00:00:00Z"),
    end: new Date("2026-03-15T00:00:00Z"),
  };
  const NOW = new Date("2026-03-15T00:00:00Z").getTime();

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new RecommendationAnalyzer(executor);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  describe("window reconstruction", () => {
    it("splits two requests 6h apart into two separate 5h windows", async () => {
      await seedWindowFixture(db);
      const res = await analyzer.analyze("max-20x", fullRange, undefined, { nowMs: NOW });
      // Day-20 10:00 + 12:00 = window A; 16:30 = window B (6.5h after anchor);
      // Mar-05 11:00 = window C (far future). → 3 five-hour windows total.
      expect(res.windowStats5h.activeWindows).toBe(3);
      expect(res.totalTurns).toBe(4);
    });

    it("keeps the per-model weekly split (sonnet week-1 only, opus both weeks)", async () => {
      await seedWindowFixture(db);
      const res = await analyzer.analyze("max-20x", fullRange, undefined, { nowMs: NOW });
      // All models span two rolling weeks (Feb-20 and Mar-05) → 2 weekly windows.
      expect(res.perModelWeekly.all.activeWindows).toBe(2);
      // Sonnet only on the 20th → 1 weekly window.
      expect(res.perModelWeekly.sonnet.activeWindows).toBe(1);
      // Opus on Feb-20 (16:30) AND Mar-05 → 2 weekly windows.
      expect(res.perModelWeekly.opus.activeWindows).toBe(2);
    });

    it("counts distinct active UTC days", async () => {
      await seedWindowFixture(db);
      const res = await analyzer.analyze("max-20x", fullRange, undefined, { nowMs: NOW });
      // 2026-02-20 and 2026-03-05 → 2 active days.
      expect(res.activeDays).toBe(2);
    });

    it("always carries the estimate caveat", async () => {
      await seedWindowFixture(db);
      const res = await analyzer.analyze("max-20x", fullRange, undefined, { nowMs: NOW });
      expect(res.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
    });
  });

  describe("auto-calibration", () => {
    it("flips ceilingSource to 'calibrated' when a burst exceeds the default ceiling (Pro)", async () => {
      await seedBurstFixture(db);
      const res = await analyzer.analyze("pro", fullRange, undefined, {
        autoCalibrate: true,
        nowMs: NOW,
      });
      // 3 × 700k = 2.1M tokens in one 5h window > Pro 5h token ceiling 1.575M.
      expect(res.ceilingSource).toBe("calibrated");
      expect(res.ceilings.calibratedFlags.fiveHourTokens).toBe(true);
      expect(res.ceilings.calibrated.fiveHourTokens).toBe(2_100_000);
      // The default is preserved for transparency.
      expect(res.ceilings.default.fiveHourTokens).toBe(DEFAULT_TIER_LIMITS.pro.fiveHourTokens);
      // Fill is re-computed against the calibrated ceiling → not pinned > 1.
      expect(res.windowStats5h.peakFill).toBeLessThanOrEqual(1.0001);
    });

    it("keeps ceilingSource 'default' when autoCalibrate is off (even on a burst)", async () => {
      await seedBurstFixture(db);
      const res = await analyzer.analyze("pro", fullRange, undefined, {
        autoCalibrate: false,
        nowMs: NOW,
      });
      expect(res.ceilingSource).toBe("default");
      expect(res.ceilings.calibrated).toEqual(DEFAULT_TIER_LIMITS.pro);
      // With default ceilings, the burst blows past the estimate (>100% fill).
      expect(res.windowStats5h.peakFill).toBeGreaterThan(1);
    });
  });

  describe("verdict + filters", () => {
    it("returns a verdict and confidence for a seeded fixture", async () => {
      await seedBurstFixture(db);
      const res = await analyzer.analyze("pro", fullRange, undefined, { nowMs: NOW });
      expect(["upgrade", "downgrade", "stay", "neutral"]).toContain(res.recommendation.verdict);
      expect(["low", "medium", "high"]).toContain(res.recommendation.confidence);
      expect(res.recommendation.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
    });

    it("respects the model filter (opus-only narrows the population)", async () => {
      await seedWindowFixture(db);
      const res = await analyzer.analyze("max-20x", fullRange, { model: "opus" }, { nowMs: NOW });
      // Only the two opus turns (req-c on Feb-20, req-d on Mar-05) survive.
      expect(res.totalTurns).toBe(2);
      expect(res.perModelWeekly.opus.activeWindows).toBe(2);
      expect(res.perModelWeekly.sonnet.activeWindows).toBe(0);
    });

    it("respects the project filter", async () => {
      await seedWindowFixture(db);
      const res = await analyzer.analyze("max-20x", fullRange, { project: "alpha" }, { nowMs: NOW });
      expect(res.totalTurns).toBe(4); // all fixture turns are in /p/alpha
    });

    it("handles an empty range without throwing (neutral/stay, zero windows)", async () => {
      await seedWindowFixture(db);
      const emptyRange: TimeRange = {
        start: new Date("2030-01-01T00:00:00Z"),
        end: new Date("2030-01-02T00:00:00Z"),
      };
      const res = await analyzer.analyze("max-5x", emptyRange, undefined, { nowMs: NOW });
      expect(res.totalTurns).toBe(0);
      expect(res.windowStats5h.activeWindows).toBe(0);
      expect(res.windowStats5h.peakFill).toBe(0);
      // No usage → cannot be near-limit; with zero peaks it reads as a comfortable
      // downgrade candidate (max-5x → pro), or stay at the bottom. Either way it
      // must not throw and must carry the caveat.
      expect(["downgrade", "stay", "neutral"]).toContain(res.recommendation.verdict);
      expect(res.recommendation.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);
    });

    it("returns neutral for tier 'none' regardless of usage", async () => {
      await seedBurstFixture(db);
      const res = await analyzer.analyze("none", fullRange, undefined, { nowMs: NOW });
      expect(res.recommendation.verdict).toBe("neutral");
      expect(res.recommendation.suggestedTier).toBeNull();
    });
  });
});
