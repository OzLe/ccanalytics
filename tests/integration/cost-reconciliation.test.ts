/**
 * @module tests/integration/cost-reconciliation
 *
 * Regression guard for SEM2-280 / SEM2-278 (a.k.a. COST-004 / F1-session):
 * the session-stats endpoint and the cost-total endpoint must agree on
 * `totalCostUSD` when read against the same database.
 *
 * Root cause being guarded against: `sessions.total_cost_usd` is a STORED
 * aggregate that the ingestion upsert in batch-inserter.ts overwrites with
 * the LATEST batch's recomputed value. On incremental ingest it therefore
 * drifts below the true per-session totals, and reading it for /api/sessions/
 * stats produces a number that disagrees with /api/cost/total (which sums
 * conversation_turns.cost_usd, the canonical basis per CLAUDE.md). The fix
 * is a pure read swap: session-stats now reads from v_session_summary, which
 * derives total_cost_usd via SUM(ct.cost_usd) GROUP BY session_id.
 *
 * The test deliberately seeds a divergence between sessions.total_cost_usd
 * and SUM(conversation_turns.cost_usd) — the exact failure mode that
 * incremental ingest produces — and asserts both code paths return the
 * canonical (turn-derived) total.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { CostAnalyzer } from "../../src/queries/cost-analyzer.js";
import { SessionAnalyzer } from "../../src/queries/session-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

describe("cost reconciliation: session-stats === cost-total", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let sessionAnalyzer: SessionAnalyzer;
  let costAnalyzer: CostAnalyzer;

  const range: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    sessionAnalyzer = new SessionAnalyzer(executor);
    costAnalyzer = new CostAnalyzer(executor);

    // Seed two sessions with an INTENTIONAL drift between the stored
    // sessions.total_cost_usd column and SUM(conversation_turns.cost_usd).
    // This mimics what batch-inserter.ts does on incremental ingest: the
    // sessions row carries only the LAST batch's contribution while the
    // child turns accumulate all batches. The canonical truth is the turn
    // sum (see COST-004 in sql/views.sql).
    //
    //   sess-A: turns sum to 1.50; stored sessions.total_cost_usd = 0.40
    //           (drift = -1.10, i.e. stored under-reports by 73%)
    //   sess-B: turns sum to 0.50; stored sessions.total_cost_usd = 0.50
    //           (no drift — a fully ingested session)
    //
    // Canonical totalCostUSD across both sessions = 2.00.
    // Buggy code that reads SUM(sessions.total_cost_usd) would return 0.90.
    await db.connection.run(`
      INSERT INTO sessions (session_id, start_time, end_time, duration_seconds,
        model, total_cost_usd, num_turns, num_tool_calls, project_path)
      VALUES
        ('sess-A', '2026-02-20 10:00:00', '2026-02-20 10:30:00', 1800,
         'claude-sonnet-4-5', 0.40, 1, 0, '/projects/alpha'),
        ('sess-B', '2026-02-21 09:00:00', '2026-02-21 09:15:00', 900,
         'claude-sonnet-4-5', 0.50, 1, 0, '/projects/beta')
    `);

    await db.connection.run(`
      INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
      VALUES
        -- sess-A: three assistant turns totaling 1.50 (vs stored 0.40)
        ('t-A1', 'sess-A', 'assistant', '2026-02-20 10:00:01', 1000, 500, 0, 0,
         0.50, 'claude-sonnet-4-5', 'end_turn', 'req-A1', FALSE, FALSE),
        ('t-A2', 'sess-A', 'assistant', '2026-02-20 10:05:01', 1000, 500, 0, 0,
         0.60, 'claude-sonnet-4-5', 'end_turn', 'req-A2', FALSE, FALSE),
        ('t-A3', 'sess-A', 'assistant', '2026-02-20 10:10:01', 1000, 500, 0, 0,
         0.40, 'claude-sonnet-4-5', 'end_turn', 'req-A3', FALSE, FALSE),
        -- sess-B: one assistant turn totaling 0.50 (matches stored)
        ('t-B1', 'sess-B', 'assistant', '2026-02-21 09:00:01', 800, 300, 0, 0,
         0.50, 'claude-sonnet-4-5', 'end_turn', 'req-B1', FALSE, FALSE)
    `);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  it("sessions.stats.totalCostUSD === cost.total.totalCostUSD", async () => {
    const s = await sessionAnalyzer.getSessionStats(range);
    const c = await costAnalyzer.getTotalCost(range);

    // Both must equal the canonical SUM(conversation_turns.cost_usd) = 2.00,
    // NOT the drifted SUM(sessions.total_cost_usd) = 0.90.
    expect(c.totalCostUSD).toBeCloseTo(2.0, 6);
    expect(s.totalCostUSD).toBeCloseTo(2.0, 6);
    expect(s.totalCostUSD).toBeCloseTo(c.totalCostUSD, 6);
  });

  it("session-stats ignores the drifted stored aggregate (regression guard)", async () => {
    // Sanity check: confirm the fixture actually carries the drift this test
    // is designed to detect. Without the drift, the test passes trivially.
    const rawSessions = await executor.query<{ stored_total: number }>(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS stored_total FROM sessions`,
      [],
    );
    const rawTurns = await executor.query<{ turn_total: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS turn_total FROM conversation_turns`,
      [],
    );
    expect(Number(rawSessions.rows[0].stored_total)).toBeCloseTo(0.9, 6);
    expect(Number(rawTurns.rows[0].turn_total)).toBeCloseTo(2.0, 6);

    // The fix: getSessionStats must return the turn sum, not the stored sum.
    const s = await sessionAnalyzer.getSessionStats(range);
    expect(s.totalCostUSD).toBeCloseTo(2.0, 6);
    expect(s.totalCostUSD).not.toBeCloseTo(0.9, 6);
  });
});
