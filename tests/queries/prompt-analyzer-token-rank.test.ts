/**
 * @module tests/queries/prompt-analyzer-token-rank
 *
 * LANE E bonus (SEM2-291 partial / F6-prompt): the complexity-score
 * PERCENT_RANK now feeds on the canonical 2-way `total_tokens` (TOK-001), not
 * the 4-way sum. This removes the "long sessions with warm caches score
 * artificially high" bias documented at docs/METRICS_STORE.md:1230.
 *
 * The seed dataset (tests/helpers/db-setup.ts) gives us five prompts that
 * re-rank meaningfully when the formula changes:
 *
 *   prompt      input  output  cacheW  cacheR  4-way  2-way
 *   ─────────── ─────  ──────  ──────  ──────  ─────  ─────
 *   turn-002    500    200     200     0       900    700
 *   turn-004    500    300     0       300    1100    800
 *   turn-006    2000   800     100     500    3400   2800
 *   turn-008    800    300     300     0     1400   1100
 *   turn-010    700    300     0      1200    2200   1000   ← warm-cache row
 *
 * 4-way ordering (DESC): turn-006, turn-010, turn-008, turn-004, turn-002
 * 2-way ordering (DESC): turn-006, turn-008, turn-010, turn-004, turn-002
 *                                    ^^^^^^^^   ^^^^^^^^
 *                                    rank 2     rank 3 (swapped)
 *
 * turn-010 carries 1200 cache_read — the warm-cache replay that previously
 * inflated its complexity rank above turn-008. With 2-way, turn-008's higher
 * input+output (1100 vs 1000) places it ahead, as it should.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDB,
  closeTestDB,
  seedTestData,
  type TestDB,
} from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { PromptAnalyzer } from "../../src/queries/prompt-analyzer.js";

describe("PromptAnalyzer — token semantics (LANE E)", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: PromptAnalyzer;

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new PromptAnalyzer(executor);
    await seedTestData(db.connection);
    // The seed user turns all carry content_text = NULL; the prompt-pair CTE
    // filters them out. Inject plausible prompt text on each user turn so they
    // surface as ranked prompts. We do NOT touch any token / cost field —
    // this is a text-only patch so the existing token / cost / cache test
    // assertions on this fixture remain valid.
    await db.connection.run(`
      UPDATE conversation_turns
      SET content_text = CASE turn_id
        WHEN 'turn-001' THEN 'first prompt'
        WHEN 'turn-003' THEN 'second prompt'
        WHEN 'turn-005' THEN 'big prompt'
        WHEN 'turn-007' THEN 'tool prompt'
        WHEN 'turn-009' THEN 'warm-cache prompt'
      END
      WHERE turn_id IN ('turn-001','turn-003','turn-005','turn-007','turn-009')
    `);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  it("`total_tokens` per ranked prompt is the 2-way headline (TOK-001)", async () => {
    const { rows } = await analyzer.getPromptRanking({
      period: {
        start: new Date("2026-02-19T00:00:00Z"),
        end: new Date("2026-02-22T00:00:00Z"),
      },
      sort: "total_tokens",
      order: "desc",
      limit: 50,
    });

    // Per-prompt 2-way totals:
    const expected: Record<string, number> = {
      "turn-001": 700, // 500 + 200
      "turn-003": 800, // 500 + 300
      "turn-005": 2800, // 2000 + 800
      "turn-007": 1100, // 800 + 300
      "turn-009": 1000, // 700 + 300
    };
    for (const row of rows) {
      const want = expected[row.turnId];
      expect(want, `unexpected turnId ${row.turnId}`).toBeDefined();
      expect(row.totalTokens).toBe(want);
    }
  });

  it("ranking by total_tokens places the high-output prompt above the warm-cache prompt", async () => {
    // 2-way ordering places turn-007 (1100, high output) above turn-009
    // (1000, dominated by cache_read=1200). 4-way ordering inverted this.
    const { rows } = await analyzer.getPromptRanking({
      period: {
        start: new Date("2026-02-19T00:00:00Z"),
        end: new Date("2026-02-22T00:00:00Z"),
      },
      sort: "total_tokens",
      order: "desc",
      limit: 50,
    });

    const orderedIds = rows.map((r) => r.turnId);
    expect(orderedIds).toEqual([
      "turn-005", // 2800
      "turn-007", // 1100 (was rank 3 under 4-way: 1400)
      "turn-009", // 1000 (was rank 2 under 4-way: 2200 — warm-cache inflated)
      "turn-003", // 800
      "turn-001", // 700
    ]);
  });

  it("complexity_score now ranks turn-007 above turn-009 on the token axis (TOK-001)", async () => {
    // Tokens is one of four equal-weighted percentile inputs to
    // complexity_score. The two prompts whose ranking is sensitive to the
    // headline change are turn-007 and turn-009:
    //
    //   prompt    2-way  4-way  tool_count  thinking
    //   turn-007  1100   1400   1           0
    //   turn-009  1000   2200   2           1
    //
    // Under the OLD 4-way headline turn-009's `total_tokens` PR ranked it
    // ahead of turn-007 (2200 vs 1400 → PR 1.0 vs 0.75). Under the NEW
    // 2-way headline turn-007 has the higher PR on the token axis (1100 vs
    // 1000 → PR 0.75 vs 0.5). This is the F6-prompt fix: warm caches no
    // longer inflate complexity.
    const { rows } = await analyzer.getPromptRanking({
      period: {
        start: new Date("2026-02-19T00:00:00Z"),
        end: new Date("2026-02-22T00:00:00Z"),
      },
      sort: "total_tokens",
      order: "desc",
      limit: 50,
    });
    const turn7 = rows.find((r) => r.turnId === "turn-007")!;
    const turn9 = rows.find((r) => r.turnId === "turn-009")!;
    expect(turn7.totalTokens).toBe(1100);
    expect(turn9.totalTokens).toBe(1000);
    // The headline ordering on the token axis is now 7 > 9, not 9 > 7.
    expect(turn7.totalTokens).toBeGreaterThan(turn9.totalTokens);
  });

  it("complexity_score for the seed prompts is in non-increasing order when sorted DESC", async () => {
    const { rows } = await analyzer.getPromptRanking({
      period: {
        start: new Date("2026-02-19T00:00:00Z"),
        end: new Date("2026-02-22T00:00:00Z"),
      },
      sort: "complexity_score",
      order: "desc",
      limit: 50,
    });

    // All five seed prompts have responses → all are returned.
    expect(rows).toHaveLength(5);

    // Sanity: complexity scores must be in non-increasing order.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].complexityScore).toBeLessThanOrEqual(
        rows[i - 1].complexityScore,
      );
    }
  });

  it("`getPromptDetail.totalTokens` is the 2-way sum (matches the ranked-list row)", async () => {
    // turn-001 → turn-002 (the response that falls in the [user, next-user)
    // window for sess-001). turn-002: input=500, output=200, cacheW=200,
    // cacheR=0 → 2-way = 700, 4-way would be 900.
    const detail = await analyzer.getPromptDetail("turn-001");
    expect(detail).not.toBeNull();
    // TOK-001: 2-way headline.
    expect(detail!.totalTokens).toBe(700);
    // Per-category fields are still the raw values — only the headline is
    // 2-way; cache columns are preserved for downstream consumers.
    expect(detail!.inputTokens).toBe(500);
    expect(detail!.outputTokens).toBe(200);
    expect(detail!.cacheCreationTokens).toBe(200);
    expect(detail!.cacheReadTokens).toBe(0);
  });
});
