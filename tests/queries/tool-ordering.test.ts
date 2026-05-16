/**
 * @module tests/queries/tool-ordering
 *
 * Regression tests for SEM2-283 (TOOL-002), SEM2-284 (TOOL-003),
 * SEM2-285 (TOOL-004), SEM2-286 (TOOL-005).
 *
 * BUG (pre-fix) — ToolAnalyzer.getToolChains, ToolAnalyzer.getFailureChains,
 * the /api/tools/chains and /api/tools/failure-chains routes, and the
 * v_session_failure_chains view all used:
 *     ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY tc.tool_call_id)
 * `tool_call_id` is a random base62 string from the agent runtime — it has
 * no chronological relationship to call order. So adjacent rows in the
 * window were not adjacent in time, and:
 *   - `Bash -> Bash -> Bash` counts came in at ~half the real value
 *     (7,307 observed vs 13,656 actual in the production DB).
 *   - `max_failure_streak` undercounted (6 observed vs 8 actual).
 *
 * FIX — Order by `conversation_turns.timestamp` with `tc.tool_call_id` as a
 * stable tiebreaker for parallel `tool_use` blocks within the same assistant
 * turn (which share a timestamp).
 *
 * BUG (pre-fix, TOOL-005) — v_session_failure_chains dropped 0-failure
 * sessions because the final aggregation iterated `failure_streaks` (which
 * already filtered WHERE success = FALSE). The view was rewritten with a
 * LEFT JOIN against `sessions_in_scope` so 0-failure sessions stay in the
 * denominator with `max_failure_streak = 0`.
 *
 * The fixtures below are SYNTHETIC and designed so that lexical
 * (`tool_call_id`) ordering produces a different streak count than
 * chronological (`timestamp`) ordering — that contrast is what locks in
 * the fix.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestDB, createTestDB, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { ToolAnalyzer } from "../../src/queries/tool-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

interface ToolRow {
  toolCallId: string;
  turnId: string;
  toolName: string;
  success: boolean | null;
  /** Index into a per-test timestamps array — encodes the chronological order. */
  timeIdx: number;
}

const ORDERING_RANGE: TimeRange = {
  start: new Date("2026-03-01T00:00:00Z"),
  end: new Date("2026-03-02T00:00:00Z"),
};

const SESSION_START = "2026-03-01 10:00:00";

/**
 * Build the timestamp for a given step. One second per step within a minute,
 * then roll into the next minute. Supports up to 60*60 steps before hitting
 * an hour rollover (well beyond any fixture size used here).
 */
function tsAtStep(step: number): string {
  const totalSeconds = step + 1;
  const min = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const sec = (totalSeconds % 60).toString().padStart(2, "0");
  return `2026-03-01 10:${min}:${sec}`;
}

/**
 * Seed a single session with explicit (tool_call_id, timestamp) pairs. The
 * test author controls both the lexical and chronological orderings via the
 * `rows` array and `timeIdx` field.
 */
async function seedSession(
  db: TestDB,
  sessionId: string,
  rows: ToolRow[],
): Promise<void> {
  await db.connection.run(`
    INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      total_cost_usd, num_turns, num_tool_calls, project_path)
    VALUES ('${sessionId}', '${SESSION_START}', '${SESSION_START}', 0,
      'claude-sonnet-4-5', 0, 0, 0, 0, 0, 1, ${rows.length}, '/projects/order-test')
  `);

  // One assistant turn per unique turn_id seen in `rows`. Timestamps on the
  // turns are the timestamps the analyzer ORDER BYs against. turn_id is a
  // global primary key, so we prefix the per-test `row.turnId` with the
  // session_id to avoid collisions when the same logical turn label is
  // reused across sessions.
  const turnKey = (row: ToolRow) => `${sessionId}-${row.turnId}`;
  const reqKey = (row: ToolRow) => `${sessionId}-${row.turnId}-req`;
  const seenTurns = new Set<string>();
  for (const row of rows) {
    const tid = turnKey(row);
    if (seenTurns.has(tid)) continue;
    seenTurns.add(tid);
    const ts = tsAtStep(row.timeIdx);
    await db.connection.run(`
      INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
      VALUES ('${tid}', '${sessionId}', 'assistant', '${ts}',
        0, 0, 0, 0, 0, 'claude-sonnet-4-5', 'tool_use', '${reqKey(row)}', TRUE, FALSE)
    `);
  }

  for (const row of rows) {
    const successSql = row.success === null
      ? "NULL"
      : row.success ? "TRUE" : "FALSE";
    await db.connection.run(`
      INSERT INTO tool_calls (tool_call_id, session_id, turn_id, tool_name,
        tool_type, mcp_server, duration_ms, success)
      VALUES ('${row.toolCallId}', '${sessionId}', '${turnKey(row)}',
        '${row.toolName}', 'native', NULL, NULL, ${successSql})
    `);
  }
}

describe("Tool ordering (SEM2-283/284/285/286 regression suite)", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: ToolAnalyzer;

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new ToolAnalyzer(executor);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  // -------------------------------------------------------------------------
  // TOOL-003 (SEM2-284): getFailureChains uses chronological ordering.
  //
  // Fixture S-CHRONO has 7 tool calls in one session. tool_call_ids are
  // assigned so that LEXICAL order interleaves successes and failures, but
  // CHRONOLOGICAL order groups the 3 failures consecutively in the middle.
  //
  //   chrono step 0  tc_id "zz-0"  Read  success=TRUE
  //   chrono step 1  tc_id "zz-1"  Read  success=TRUE
  //   chrono step 2  tc_id "aa-0"  Bash  success=FALSE   <-- streak start
  //   chrono step 3  tc_id "aa-1"  Bash  success=FALSE
  //   chrono step 4  tc_id "aa-2"  Bash  success=FALSE   <-- streak end (len 3)
  //   chrono step 5  tc_id "zz-2"  Read  success=TRUE
  //   chrono step 6  tc_id "zz-3"  Read  success=TRUE
  //
  // Lexical order:        aa-0(F) aa-1(F) aa-2(F) zz-0(T) zz-1(T) zz-2(T) zz-3(T)
  //                       → max_failure_streak = 3 (same here, BUT see S-INTERLEAVE)
  //
  // For S-INTERLEAVE below, we engineer lexical order to interleave the
  // failures, so that the lexical streak is 1 while chronological is 3.
  // -------------------------------------------------------------------------

  it("getFailureChains: chronological ordering groups consecutive failures", async () => {
    await seedSession(db, "sess-chrono", [
      { toolCallId: "zz-0", turnId: "t-1", toolName: "Read", success: true, timeIdx: 0 },
      { toolCallId: "zz-1", turnId: "t-2", toolName: "Read", success: true, timeIdx: 1 },
      { toolCallId: "aa-0", turnId: "t-3", toolName: "Bash", success: false, timeIdx: 2 },
      { toolCallId: "aa-1", turnId: "t-4", toolName: "Bash", success: false, timeIdx: 3 },
      { toolCallId: "aa-2", turnId: "t-5", toolName: "Bash", success: false, timeIdx: 4 },
      { toolCallId: "zz-2", turnId: "t-6", toolName: "Read", success: true, timeIdx: 5 },
      { toolCallId: "zz-3", turnId: "t-7", toolName: "Read", success: true, timeIdx: 6 },
    ]);

    const result = await analyzer.getFailureChains(ORDERING_RANGE);

    expect(result.sessionsWithToolCalls).toBe(1);
    expect(result.worstStreak).toBe(3);
    // Streak length 3 → counted as both 2plus and 3plus.
    const s = result.topSessions[0];
    expect(s.sessionId).toBe("sess-chrono");
    expect(s.maxFailureStreak).toBe(3);
    expect(s.failureChains2Plus).toBe(1);
    expect(s.failureChains3Plus).toBe(1);
    expect(s.totalFailedInChains).toBe(3);
  });

  it("getFailureChains: lexical-vs-chronological divergence (numeric regression)", async () => {
    // S-INTERLEAVE — designed so the two orderings produce DIFFERENT streak
    // counts. Chronological order: 5 consecutive failures in the middle.
    // Lexical (tool_call_id) order: failures interleaved with successes, so
    // the longest lexical failure streak is 1.
    //
    //   chrono step 0  tc "aa-1"  Read  TRUE
    //   chrono step 1  tc "bb-1"  Read  TRUE
    //   chrono step 2  tc "cc-1"  Bash  FALSE
    //   chrono step 3  tc "cc-3"  Bash  FALSE
    //   chrono step 4  tc "cc-5"  Bash  FALSE
    //   chrono step 5  tc "cc-7"  Bash  FALSE
    //   chrono step 6  tc "cc-9"  Bash  FALSE
    //   chrono step 7  tc "dd-1"  Read  TRUE
    //
    // Lexical order would be: aa-1(T) bb-1(T) cc-1(F) cc-3(F) cc-5(F) cc-7(F)
    //   cc-9(F) dd-1(T) — which happens to also be chronological here, so
    //   we need to interleave the tool_call_ids more aggressively.
    //
    // Real divergence design: between every failure, insert a SUCCESS that
    // sorts BETWEEN two failure tcs lexically but AFTER all failures
    // chronologically.
    //
    //   chrono step 0  tc "f1"  Bash  FALSE
    //   chrono step 1  tc "f2"  Bash  FALSE
    //   chrono step 2  tc "f3"  Bash  FALSE
    //   chrono step 3  tc "f4"  Bash  FALSE
    //   chrono step 4  tc "f5"  Bash  FALSE        → chrono streak = 5
    //   chrono step 5  tc "g1"  Read  TRUE
    //   chrono step 6  tc "g2"  Read  TRUE
    //   chrono step 7  tc "g3"  Read  TRUE
    //   chrono step 8  tc "g4"  Read  TRUE
    //
    //   Lexical: f1(F) f2(F) f3(F) f4(F) f5(F) g1(T)... → streak still 5.
    //
    // To make lexical streak < chronological streak we must make a SUCCESS
    // sort BETWEEN two failures lexically:
    //
    //   chrono step 0  tc "f-a"  Bash  FALSE
    //   chrono step 1  tc "f-c"  Bash  FALSE
    //   chrono step 2  tc "f-e"  Bash  FALSE
    //   chrono step 3  tc "f-g"  Bash  FALSE
    //   chrono step 4  tc "f-i"  Bash  FALSE   → chrono streak = 5
    //   chrono step 5  tc "f-b"  Read  TRUE
    //   chrono step 6  tc "f-d"  Read  TRUE
    //   chrono step 7  tc "f-f"  Read  TRUE
    //   chrono step 8  tc "f-h"  Read  TRUE
    //
    //   Lexical: f-a(F) f-b(T) f-c(F) f-d(T) f-e(F) f-f(T) f-g(F) f-h(T)
    //            f-i(F)  → max lexical failure streak = 1
    await seedSession(db, "sess-interleave", [
      { toolCallId: "f-a", turnId: "t-1", toolName: "Bash", success: false, timeIdx: 0 },
      { toolCallId: "f-c", turnId: "t-2", toolName: "Bash", success: false, timeIdx: 1 },
      { toolCallId: "f-e", turnId: "t-3", toolName: "Bash", success: false, timeIdx: 2 },
      { toolCallId: "f-g", turnId: "t-4", toolName: "Bash", success: false, timeIdx: 3 },
      { toolCallId: "f-i", turnId: "t-5", toolName: "Bash", success: false, timeIdx: 4 },
      { toolCallId: "f-b", turnId: "t-6", toolName: "Read", success: true, timeIdx: 5 },
      { toolCallId: "f-d", turnId: "t-7", toolName: "Read", success: true, timeIdx: 6 },
      { toolCallId: "f-f", turnId: "t-8", toolName: "Read", success: true, timeIdx: 7 },
      { toolCallId: "f-h", turnId: "t-9", toolName: "Read", success: true, timeIdx: 8 },
    ]);

    const result = await analyzer.getFailureChains(ORDERING_RANGE);

    // POST-FIX: chronological ordering → streak of 5.
    // PRE-FIX (with ORDER BY tc.tool_call_id) the lexical streak was 1, so
    // worstStreak would have come back as 1 here. This is the load-bearing
    // numeric regression assertion.
    expect(result.worstStreak).toBe(5);
    expect(result.topSessions[0].maxFailureStreak).toBe(5);
    expect(result.topSessions[0].failureChains2Plus).toBe(1);
    expect(result.topSessions[0].failureChains3Plus).toBe(1);
  });

  // -------------------------------------------------------------------------
  // TOOL-002 (SEM2-283): getToolChains uses chronological ordering.
  //
  // Same trick: design tool_call_ids so the lexical 3-tool window picks a
  // DIFFERENT 3-tool sequence than the chronological window. The
  // chronological chain Bash->Bash->Bash appears MORE often than the
  // lexical one — mirrors the production observation of ~half.
  // -------------------------------------------------------------------------

  it("getToolChains: chronological ordering recovers Bash->Bash->Bash chains", async () => {
    // Chronological order: B B B R B B B   → two Bash³ chains starting at
    //   steps 0 and 1, plus zero starting at steps 2 (gap), 3 (R), 4 (B B B
    //   continues), 5. So Bash³ occurrences = 2.
    //
    // Actually let me build a 6-step pure-Bash run, which yields 4 windows
    // a..(a+2) of consecutive Bashes (windows at chrono start 0, 1, 2, 3):
    //
    //   chrono step 0  tc "b-a"  Bash
    //   chrono step 1  tc "b-c"  Bash
    //   chrono step 2  tc "b-e"  Bash
    //   chrono step 3  tc "b-g"  Bash
    //   chrono step 4  tc "b-i"  Bash
    //   chrono step 5  tc "b-k"  Bash
    //   chrono step 6  tc "b-b"  Read
    //   chrono step 7  tc "b-d"  Read
    //   chrono step 8  tc "b-f"  Read
    //   chrono step 9  tc "b-h"  Read
    //   chrono step 10 tc "b-j"  Read
    //
    // Chronological 3-windows: 4 Bash³ + then mixed/Read chains.
    // Lexical order (alphabetical on tc_id):
    //   b-a(B) b-b(R) b-c(B) b-d(R) b-e(B) b-f(R) b-g(B) b-h(R) b-i(B)
    //   b-j(R) b-k(B)
    //   → No three consecutive Bash. Bash³ occurrences in lexical view = 0.
    //
    // minOccurrences default is 3; we pass 1 so even a single Bash³ shows up.
    await seedSession(db, "sess-chains", [
      { toolCallId: "b-a", turnId: "t-1", toolName: "Bash", success: true, timeIdx: 0 },
      { toolCallId: "b-c", turnId: "t-2", toolName: "Bash", success: true, timeIdx: 1 },
      { toolCallId: "b-e", turnId: "t-3", toolName: "Bash", success: true, timeIdx: 2 },
      { toolCallId: "b-g", turnId: "t-4", toolName: "Bash", success: true, timeIdx: 3 },
      { toolCallId: "b-i", turnId: "t-5", toolName: "Bash", success: true, timeIdx: 4 },
      { toolCallId: "b-k", turnId: "t-6", toolName: "Bash", success: true, timeIdx: 5 },
      { toolCallId: "b-b", turnId: "t-7", toolName: "Read", success: true, timeIdx: 6 },
      { toolCallId: "b-d", turnId: "t-8", toolName: "Read", success: true, timeIdx: 7 },
      { toolCallId: "b-f", turnId: "t-9", toolName: "Read", success: true, timeIdx: 8 },
      { toolCallId: "b-h", turnId: "t-10", toolName: "Read", success: true, timeIdx: 9 },
      { toolCallId: "b-j", turnId: "t-11", toolName: "Read", success: true, timeIdx: 10 },
    ]);

    const chains = await analyzer.getToolChains(ORDERING_RANGE, 1);

    // POST-FIX: 6 consecutive Bash calls → 4 distinct 3-call windows
    //   (windows starting at chrono steps 0, 1, 2, 3).
    const bashCubed = chains.find(
      (c) => c.chain[0] === "Bash" && c.chain[1] === "Bash" && c.chain[2] === "Bash",
    );
    expect(bashCubed).toBeDefined();
    expect(bashCubed!.occurrences).toBe(4);

    // PRE-FIX (lexical) would have found ZERO Bash³ here, because lexical
    // order interleaves Bash with Read tool_call_ids.
  });

  // -------------------------------------------------------------------------
  // TOOL-004 (SEM2-285): tiebreaker is stable for same-turn tool calls.
  //
  // When an assistant turn dispatches multiple tool_use blocks in parallel,
  // every resulting tool_calls row shares the hosting turn's timestamp.
  // tc.tool_call_id is the secondary ORDER BY key, guaranteeing
  // deterministic row numbering across runs. This test runs the same query
  // 5 times and asserts the streak result is identical every time.
  // -------------------------------------------------------------------------

  it("getFailureChains: same-turn tiebreaker is stable across runs", async () => {
    // All 4 tool calls share the SAME turn (and therefore the same
    // timestamp). The tiebreaker on tool_call_id makes the ordering
    // deterministic: alphabetically aa, bb, cc, dd → F, F, T, F.
    //   Streak: max = 2 (aa, bb), then T breaks it, then dd = streak of 1.
    //   failure_chains_2plus = 1, failure_chains_3plus = 0.
    await seedSession(db, "sess-tiebreak", [
      { toolCallId: "aa", turnId: "t-1", toolName: "Bash", success: false, timeIdx: 0 },
      { toolCallId: "bb", turnId: "t-1", toolName: "Bash", success: false, timeIdx: 0 },
      { toolCallId: "cc", turnId: "t-1", toolName: "Read", success: true, timeIdx: 0 },
      { toolCallId: "dd", turnId: "t-1", toolName: "Bash", success: false, timeIdx: 0 },
    ]);

    const runs = await Promise.all(
      [0, 1, 2, 3, 4].map(() => analyzer.getFailureChains(ORDERING_RANGE)),
    );
    const first = runs[0];
    for (const r of runs.slice(1)) {
      expect(r.worstStreak).toBe(first.worstStreak);
      expect(r.topSessions.map((s) => s.maxFailureStreak)).toEqual(
        first.topSessions.map((s) => s.maxFailureStreak),
      );
    }
    // Concrete values for the documented tiebreaker order.
    expect(first.worstStreak).toBe(2);
    expect(first.topSessions[0].failureChains2Plus).toBe(1);
    expect(first.topSessions[0].failureChains3Plus).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TOOL-005 (SEM2-286): v_session_failure_chains preserves 0-failure sessions.
  //
  // The view's denominator was previously the COUNT of rows in the result,
  // which dropped 0-failure sessions because they never appeared in the
  // WHERE success = FALSE subquery. After the LEFT JOIN rewrite, every
  // session with at least one evaluated tool call appears in the view with
  // COALESCE'd zero values.
  // -------------------------------------------------------------------------

  it("v_session_failure_chains: 0-failure sessions remain with failure_count = 0", async () => {
    // Two sessions:
    //   sess-clean   — 3 successful Read calls, ZERO failures.
    //   sess-dirty   — 2 successful + 2 consecutive failures (streak 2).
    await seedSession(db, "sess-clean", [
      { toolCallId: "ok-1", turnId: "t-1", toolName: "Read", success: true, timeIdx: 0 },
      { toolCallId: "ok-2", turnId: "t-2", toolName: "Read", success: true, timeIdx: 1 },
      { toolCallId: "ok-3", turnId: "t-3", toolName: "Read", success: true, timeIdx: 2 },
    ]);
    await seedSession(db, "sess-dirty", [
      { toolCallId: "d-1", turnId: "t-1", toolName: "Read", success: true, timeIdx: 0 },
      { toolCallId: "d-2", turnId: "t-2", toolName: "Read", success: true, timeIdx: 1 },
      { toolCallId: "d-3", turnId: "t-3", toolName: "Bash", success: false, timeIdx: 2 },
      { toolCallId: "d-4", turnId: "t-4", toolName: "Bash", success: false, timeIdx: 3 },
    ]);

    const result = await db.connection.runAndReadAll(`
      SELECT session_id, max_failure_streak, failure_chains_2plus,
             failure_chains_3plus, total_failed_in_chains
      FROM v_session_failure_chains
      ORDER BY session_id
    `);
    const rows = result.getRowObjectsJS() as Array<{
      session_id: string;
      max_failure_streak: number | bigint;
      failure_chains_2plus: number | bigint;
      failure_chains_3plus: number | bigint;
      total_failed_in_chains: number | bigint;
    }>;

    // BOTH sessions must appear — sess-clean had ZERO failures but is still
    // in the view (TOOL-005 / SEM2-286 denominator fix).
    expect(rows.length).toBe(2);
    const clean = rows.find((r) => r.session_id === "sess-clean")!;
    const dirty = rows.find((r) => r.session_id === "sess-dirty")!;
    expect(clean).toBeDefined();
    expect(Number(clean.max_failure_streak)).toBe(0);
    expect(Number(clean.failure_chains_2plus)).toBe(0);
    expect(Number(clean.failure_chains_3plus)).toBe(0);
    expect(Number(clean.total_failed_in_chains)).toBe(0);
    expect(Number(dirty.max_failure_streak)).toBe(2);
    expect(Number(dirty.failure_chains_2plus)).toBe(1);
    expect(Number(dirty.failure_chains_3plus)).toBe(0);
  });

  it("v_session_failure_chains: uses chronological ordering (matches inline query)", async () => {
    // Same fixture as the inline-query interleave test. The view must
    // produce the same streak result.
    await seedSession(db, "sess-view-interleave", [
      { toolCallId: "f-a", turnId: "t-1", toolName: "Bash", success: false, timeIdx: 0 },
      { toolCallId: "f-c", turnId: "t-2", toolName: "Bash", success: false, timeIdx: 1 },
      { toolCallId: "f-e", turnId: "t-3", toolName: "Bash", success: false, timeIdx: 2 },
      { toolCallId: "f-g", turnId: "t-4", toolName: "Bash", success: false, timeIdx: 3 },
      { toolCallId: "f-i", turnId: "t-5", toolName: "Bash", success: false, timeIdx: 4 },
      { toolCallId: "f-b", turnId: "t-6", toolName: "Read", success: true, timeIdx: 5 },
      { toolCallId: "f-d", turnId: "t-7", toolName: "Read", success: true, timeIdx: 6 },
      { toolCallId: "f-f", turnId: "t-8", toolName: "Read", success: true, timeIdx: 7 },
      { toolCallId: "f-h", turnId: "t-9", toolName: "Read", success: true, timeIdx: 8 },
    ]);

    const result = await db.connection.runAndReadAll(`
      SELECT max_failure_streak, failure_chains_2plus, failure_chains_3plus
      FROM v_session_failure_chains
      WHERE session_id = 'sess-view-interleave'
    `);
    const rows = result.getRowObjectsJS() as Array<{
      max_failure_streak: number | bigint;
      failure_chains_2plus: number | bigint;
      failure_chains_3plus: number | bigint;
    }>;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].max_failure_streak)).toBe(5);
    expect(Number(rows[0].failure_chains_2plus)).toBe(1);
    expect(Number(rows[0].failure_chains_3plus)).toBe(1);
  });
});
