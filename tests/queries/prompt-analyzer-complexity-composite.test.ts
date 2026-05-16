/**
 * @module tests/queries/prompt-analyzer-complexity-composite
 *
 * LANE F (SEM2-290 F1-prompt, SEM2-291 F2-prompt): the complexity composite
 * used to be the average of four PERCENT_RANK terms — `tool_call_count`,
 * `total_tokens`, `multi_turn_depth`, and `has_thinking`. Two failures:
 *
 *   F1-prompt: `has_thinking` was a 25-pt step. 98.8% of prompts in the wild
 *              scored 0/25 on this term, so it behaved like an "always zero"
 *              constant for nearly every prompt.
 *   F2-prompt: `tool_call_count` and `multi_turn_depth` correlate r=0.995 —
 *              the composite was effectively triple-weighting one signal
 *              (tool activity) with one weight nominally on tokens.
 *
 * Q-003 resolution: drop `has_thinking` from the score (surface as a
 * categorical badge in the UI), add `COUNT(DISTINCT tc.tool_name) AS
 * distinct_tools_used` as the 4th dimension. distinct_tools_used
 * decollinearizes from tool_call_count — a 30-call `Read` loop and a 5-tool
 * fan-out score very differently on this axis.
 *
 * Two assertions in this file:
 *
 *   1. Numeric regression: the dropped `has_thinking` 25-pt step is gone.
 *      A prompt with `has_thinking=1` but distinct_tools_used at the bottom
 *      of the population must not get a free 25-pt boost.
 *
 *   2. Re-rank: a 5-tool fan-out scores HIGHER than a 30-call `Read` loop
 *      on the complexity composite, even though the loop has more total
 *      tool calls. Under the old formula the loop scored higher (tool_count
 *      and multi_turn_depth both maxed); under the new formula the fan-out
 *      wins on the distinct_tools_used axis.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDB,
  closeTestDB,
  type TestDB,
} from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { PromptAnalyzer } from "../../src/queries/prompt-analyzer.js";

/**
 * Seed three deliberately-constructed prompts inside a single session.
 * The detail is the 4-prompt population from which PERCENT_RANK draws.
 *
 *   prompt    tool_calls  distinct  tokens  depth  thinking   notes
 *   ────────  ──────────  ────────  ──────  ─────  ────────   ─────
 *   thinker      1           1        100    1       YES      F1 regression
 *   loop        30           1        500    3       NO       30 Reads
 *   fanout      10           5        500    3       NO       1 each of 5 tools
 *   baseline     1           1         50    1       NO       low everything
 *
 * Re-rank assertion compares loop vs fanout on the composite.
 * F1 regression compares the thinker's score to what it would be if it got
 * a free 25-pt step (it must not be the highest, because three other prompts
 * have higher distinct_tools_used / tool_call_count / tokens / depth).
 */
async function seedCompositeFixture(db: TestDB): Promise<void> {
  await db.connection.run(`
    INSERT INTO sessions (session_id, start_time, end_time, duration_seconds,
      model, input_tokens, output_tokens, cache_creation_tokens,
      cache_read_tokens, total_cost_usd, num_turns, num_tool_calls, project_path)
    VALUES
      ('f-sess-001', '2026-03-01 10:00:00', '2026-03-01 11:00:00', 3600,
       'claude-sonnet-4-5', 0, 0, 0, 0, 0.0, 0, 0, '/projects/laneF')
  `);

  // 4 prompts; each user turn is paired with the subsequent assistant turn(s)
  // by the prompt_pairs CTE based on (session_id, ordered rn).
  //
  // Layout (turns are ordered by timestamp):
  //   f-001 user
  //   f-002 assistant  (thinker — 1 call,  has_thinking=TRUE,  100 tokens)
  //   f-003 user
  //   f-004 assistant  (loop    — 30 calls, has_thinking=FALSE, 500 tokens)
  //   f-005 assistant  (loop    — continues, depth=2)
  //   f-006 assistant  (loop    — continues, depth=3)
  //   f-007 user
  //   f-008 assistant  (fanout — depth=1, 500 tokens)
  //   f-009 assistant  (fanout — depth=2)
  //   f-010 assistant  (fanout — depth=3)
  //   f-011 user
  //   f-012 assistant  (baseline — 1 call, low everything)
  await db.connection.run(`
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking,
      content_text)
    VALUES
      ('f-001','f-sess-001','user',     '2026-03-01 10:00:00',   0,   0, 0, 0, 0.00, NULL, NULL, NULL, FALSE, FALSE, 'thinker prompt'),
      ('f-002','f-sess-001','assistant','2026-03-01 10:00:01',  60,  40, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'f-req-002', TRUE, TRUE, NULL),

      ('f-003','f-sess-001','user',     '2026-03-01 10:05:00',   0,   0, 0, 0, 0.00, NULL, NULL, NULL, FALSE, FALSE, 'loop prompt'),
      ('f-004','f-sess-001','assistant','2026-03-01 10:05:01', 200, 100, 0, 0, 0.02, 'claude-sonnet-4-5', 'tool_use', 'f-req-004', TRUE, FALSE, NULL),
      ('f-005','f-sess-001','assistant','2026-03-01 10:05:02', 100,  50, 0, 0, 0.01, 'claude-sonnet-4-5', 'tool_use', 'f-req-005', TRUE, FALSE, NULL),
      ('f-006','f-sess-001','assistant','2026-03-01 10:05:03',  50,   0, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'f-req-006', TRUE, FALSE, NULL),

      ('f-007','f-sess-001','user',     '2026-03-01 10:10:00',   0,   0, 0, 0, 0.00, NULL, NULL, NULL, FALSE, FALSE, 'fanout prompt'),
      ('f-008','f-sess-001','assistant','2026-03-01 10:10:01', 200, 100, 0, 0, 0.02, 'claude-sonnet-4-5', 'tool_use', 'f-req-008', TRUE, FALSE, NULL),
      ('f-009','f-sess-001','assistant','2026-03-01 10:10:02', 100,  50, 0, 0, 0.01, 'claude-sonnet-4-5', 'tool_use', 'f-req-009', TRUE, FALSE, NULL),
      ('f-010','f-sess-001','assistant','2026-03-01 10:10:03',  50,   0, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'f-req-010', TRUE, FALSE, NULL),

      ('f-011','f-sess-001','user',     '2026-03-01 10:15:00',   0,   0, 0, 0, 0.00, NULL, NULL, NULL, FALSE, FALSE, 'baseline prompt'),
      ('f-012','f-sess-001','assistant','2026-03-01 10:15:01',  30,  20, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'f-req-012', FALSE, FALSE, NULL)
  `);

  // Tool calls.
  //   thinker (f-002):  1 Read
  //   loop    (f-004..006): 30 Read calls — distinct=1, tool_call_count=30
  //   fanout  (f-008..010): 10 calls of 5 distinct tools (2 each) — distinct=5, count=10
  //   baseline (f-012): 1 Read
  const loopRows: string[] = [];
  for (let i = 1; i <= 30; i++) {
    // spread the loop calls across the three assistant turns so the LATERAL
    // UNNEST → tool_calls join hits each turn
    const turn = i <= 10 ? "f-004" : i <= 20 ? "f-005" : "f-006";
    loopRows.push(
      `('f-loop-${i.toString().padStart(2, "0")}','f-sess-001','${turn}','Read','native',NULL,10,TRUE)`,
    );
  }
  const fanoutTools = [
    "Read",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
  ];
  const fanoutRows: string[] = [];
  let n = 0;
  for (const tool of fanoutTools) {
    for (let j = 0; j < 2; j++) {
      n++;
      const turn = n <= 4 ? "f-008" : n <= 7 ? "f-009" : "f-010";
      fanoutRows.push(
        `('f-fan-${n.toString().padStart(2, "0")}','f-sess-001','${turn}','${tool}','native',NULL,15,TRUE)`,
      );
    }
  }

  await db.connection.run(`
    INSERT INTO tool_calls (tool_call_id, session_id, turn_id, tool_name, tool_type, mcp_server, duration_ms, success)
    VALUES
      ('f-thk-01','f-sess-001','f-002','Read','native',NULL,20,TRUE),
      ${loopRows.join(",\n      ")},
      ${fanoutRows.join(",\n      ")},
      ('f-bsl-01','f-sess-001','f-012','Read','native',NULL,20,TRUE)
  `);
}

describe("PromptAnalyzer — complexity composite (LANE F)", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: PromptAnalyzer;

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new PromptAnalyzer(executor);
    await seedCompositeFixture(db);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  it("raw dimensions are read correctly off the new tool_counts CTE", async () => {
    // Sanity check: the LATERAL UNNEST → tool_calls join is wired correctly,
    // so the composite has the right inputs before we assert on the score.
    const { rows } = await analyzer.getPromptRanking({
      period: {
        start: new Date("2026-03-01T00:00:00Z"),
        end: new Date("2026-03-02T00:00:00Z"),
      },
      sort: "timestamp",
      order: "asc",
      limit: 50,
    });

    expect(rows).toHaveLength(4);

    const byId = new Map(rows.map((r) => [r.turnId, r]));
    const thinker = byId.get("f-001")!;
    const loop = byId.get("f-003")!;
    const fanout = byId.get("f-007")!;
    const baseline = byId.get("f-011")!;

    expect(thinker.toolCallCount).toBe(1);
    expect(thinker.hasThinking).toBe(true);

    expect(loop.toolCallCount).toBe(30);
    expect(loop.multiTurnDepth).toBe(3);
    expect(loop.hasThinking).toBe(false);

    expect(fanout.toolCallCount).toBe(10);
    expect(fanout.multiTurnDepth).toBe(3);
    expect(fanout.hasThinking).toBe(false);

    expect(baseline.toolCallCount).toBe(1);
    expect(baseline.hasThinking).toBe(false);
  });

  it("F1-prompt regression: has_thinking does NOT give a 25-pt step boost", async () => {
    // Under the OLD formula the thinker (`has_thinking=1`, distinct=1,
    // tool_count=1, tokens=100, depth=1) got +25 just for the thinking step
    // term — it would have scored 25 / 4 = 6.25 minimum on the thinking axis
    // alone, on top of its (low) percentile ranks on the other 3 axes.
    //
    // Under the NEW formula thinking is dropped from the score, replaced by
    // PERCENT_RANK(distinct_tools_used). The thinker's distinct_tools_used
    // is 1, tied at the bottom with the loop and baseline (distinct=1) — so
    // PERCENT_RANK = 0 on that axis. There is no free 25-pt boost.
    //
    // Concrete bound: thinker's per-axis percentile ranks must all be at the
    // *low* end of the 4-prompt population (it's the smallest on tokens,
    // tied-lowest on tool_count, tied-lowest on depth, tied-lowest on
    // distinct). The composite score must therefore be NO HIGHER than any of
    // the prompts that beat it on every raw dimension. Specifically: fanout
    // beats the thinker on all 4 axes (count=10>1, tokens=500>100, depth=3>1,
    // distinct=5>1) so fanout.complexityScore must be strictly greater than
    // thinker.complexityScore. Under the old formula the thinker's free 25-pt
    // step could have tied or beaten fanout — that bug is gone.
    const { rows } = await analyzer.getPromptRanking({
      period: {
        start: new Date("2026-03-01T00:00:00Z"),
        end: new Date("2026-03-02T00:00:00Z"),
      },
      sort: "timestamp",
      order: "asc",
      limit: 50,
    });
    const byId = new Map(rows.map((r) => [r.turnId, r]));
    const thinker = byId.get("f-001")!;
    const fanout = byId.get("f-007")!;
    const loop = byId.get("f-003")!;
    const baseline = byId.get("f-011")!;

    // Fanout dominates thinker on every dimension — must score strictly
    // higher even though only the thinker has has_thinking=TRUE.
    expect(fanout.complexityScore).toBeGreaterThan(thinker.complexityScore);
    // Loop also dominates the thinker on tool_count / tokens / depth (loses
    // only on the now-dropped thinking step) — must score strictly higher.
    expect(loop.complexityScore).toBeGreaterThan(thinker.complexityScore);

    // Tightly bound the thinker's score: the OLD 25-pt step gave it a
    // guaranteed +25/4 = +6.25 contribution from the thinking axis. With
    // 4 prompts of which exactly one (thinker) has has_thinking=TRUE, the
    // thinking step contributed 25/4 = 6.25 to the thinker's score and 0
    // to every other prompt's score.
    //
    //   thinker PR per axis (with 4 prompts, ties at the lower rank):
    //     tool_count       = 0     (tied-lowest at 1 with baseline)
    //     total_tokens     = 1/3   (rank 2 of 4 unique: 50<100<500=500)
    //     multi_turn_depth = 0     (tied-lowest at 1 with baseline)
    //     distinct_tools   = 0     (tied-lowest at 1 with loop & baseline)
    //   NEW composite = (0 + 33.3 + 0 + 0) / 4 = 8.3
    //   OLD composite = (0 + 33.3 + 0 + 100) / 4 = 33.3
    //
    // Pin the new score to the percentile-on-tokens-only contribution.
    // It must be strictly below the OLD score (no free 25-pt step).
    expect(thinker.complexityScore).toBeLessThan(33.3);
    expect(thinker.complexityScore).toBeCloseTo(8.3, 1);
    // And the baseline (no thinking, everything-lowest) is the strict floor
    // — its score is 0 because every PERCENT_RANK term is at the bottom.
    expect(baseline.complexityScore).toBe(0);
  });

  it("F2-prompt re-rank: 5-tool fan-out scores higher than a 30-call Read loop", async () => {
    // Fanout vs loop, on the 4-prompt population:
    //
    //   axis              loop     fanout    winner on the axis
    //   ──────────────    ────     ──────    ───────────────────
    //   tool_call_count   30  (PR=1.0)   10 (PR=2/3)  loop +33pp
    //   total_tokens     500 tied with fanout → tied PR        no winner
    //   multi_turn_depth   3 tied with fanout → tied PR        no winner
    //   distinct_tools     1  (tied-low, PR=0)   5 (PR=1.0)    fanout +100pp
    //
    // So fanout has a +100pp advantage on the distinct axis vs loop's +33pp
    // advantage on the tool_count axis. Net: fanout's composite must be
    // strictly higher.
    //
    // Under the OLD formula (has_thinking step instead of distinct):
    //   loop:   tool=100, tokens-PR, depth-PR, thinking=0 → 4-term avg
    //   fanout: tool=PR(2/3)*100, tokens-PR (same), depth-PR (same), thinking=0
    //   → loop strictly > fanout. The bug.
    const { rows } = await analyzer.getPromptRanking({
      period: {
        start: new Date("2026-03-01T00:00:00Z"),
        end: new Date("2026-03-02T00:00:00Z"),
      },
      sort: "complexity_score",
      order: "desc",
      limit: 50,
    });
    const byId = new Map(rows.map((r) => [r.turnId, r]));
    const loop = byId.get("f-003")!;
    const fanout = byId.get("f-007")!;

    // Fan-out wins.
    expect(fanout.complexityScore).toBeGreaterThan(loop.complexityScore);
  });

  it("equal-weight composite math (sanity check on the formula)", async () => {
    // With 4 prompts and the per-axis values above, the math is exact:
    //   PR over 4 values = {0, 1/3, 2/3, 1} where ties take the lower rank
    //
    //   axis            thinker  loop   fanout  baseline
    //   tool_call_count   1      30     10      1            ranks: 1=tied (0), 10 (2/3), 30 (1)
    //   → PR             0      1.0    2/3≈.667 0
    //   total_tokens   100     500    500     50            ranks: 50 (0), 100 (1/3), 500=tied (2/3)
    //   → PR             1/3    2/3    2/3     0
    //   multi_turn_depth  1     3      3       1            ranks: 1=tied (0), 3=tied (2/3)
    //   → PR             0      2/3    2/3     0
    //   distinct_tools    1     1      5       1            ranks: 1=tied (0), 5 (1)
    //   → PR             0      0      1.0     0
    //
    // Composite = (PR_tool + PR_tokens + PR_depth + PR_distinct) / 4 * 100
    //   thinker  = (0 + 0.333 + 0 + 0) / 4 * 100  ≈ 8.3   → ROUNDED 8.3
    //   loop     = (1.0 + 0.667 + 0.667 + 0) / 4 * 100  ≈ 58.3
    //   fanout   = (0.667 + 0.667 + 0.667 + 1.0) / 4 * 100  ≈ 75.0
    //   baseline = (0 + 0 + 0 + 0) / 4 * 100  = 0
    //
    // The contract: the composite must be (a) bounded in [0, 100], (b) using
    // 4 equal weights, (c) the new distinct_tools_used input drives the
    // fanout above the loop. Assert the ORDER and that no score exceeds 100.
    const { rows } = await analyzer.getPromptRanking({
      period: {
        start: new Date("2026-03-01T00:00:00Z"),
        end: new Date("2026-03-02T00:00:00Z"),
      },
      sort: "complexity_score",
      order: "desc",
      limit: 50,
    });

    expect(rows[0].turnId).toBe("f-007"); // fanout
    expect(rows[1].turnId).toBe("f-003"); // loop
    // thinker (f-001) and baseline (f-011) tied for last; ORDER BY breaks
    // the tie with timestamp DESC, so f-011 (later) comes before f-001.
    expect([rows[2].turnId, rows[3].turnId].sort()).toEqual([
      "f-001",
      "f-011",
    ]);

    for (const r of rows) {
      expect(r.complexityScore).toBeGreaterThanOrEqual(0);
      expect(r.complexityScore).toBeLessThanOrEqual(100);
    }

    // Exact-ish numeric bound on fanout vs loop, to detect formula drift.
    // Difference is ≈ 16.6pp on the new formula (75.0 - 58.3).
    expect(fanoutToLoopGap(rows)).toBeGreaterThan(10);
  });
});

/** Helper — fanout score minus loop score, both from a ranked list. */
function fanoutToLoopGap(
  rows: { turnId: string; complexityScore: number }[],
): number {
  const fanout = rows.find((r) => r.turnId === "f-007")!.complexityScore;
  const loop = rows.find((r) => r.turnId === "f-003")!.complexityScore;
  return fanout - loop;
}
