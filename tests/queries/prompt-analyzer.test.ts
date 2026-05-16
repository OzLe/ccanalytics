/**
 * @module tests/queries/prompt-analyzer
 *
 * Integration tests for the PromptAnalyzer class.
 *
 * Primarily locks in SEM2-292 (F3-prompt): a `?model=X` filter on the prompt
 * path must NOT drop user rows from `conversation_turns`. User turns have
 * `model IS NULL`, and `NULL LIKE '%X%'` evaluates to NULL (not TRUE) — so
 * the strict form `AND model LIKE ...` silently discards every user row,
 * which makes `getPromptRanking({ model: "opus" })` return zero prompts even
 * when prompts exist. The narrow fix lives inside PromptAnalyzer.buildFilters
 * (not in the shared src/queries/filter-builder.ts, which other analyzers
 * rely on for strict behavior — see tests/queries/skill-analyzer.test.ts
 * for the strict-filter callers).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDB,
  closeTestDB,
  type TestDB,
} from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { PromptAnalyzer } from "../../src/queries/prompt-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

/**
 * Seed prompt-shaped fixtures: two sessions, each a single user→assistant
 * pair with real prompt text. Mirrors the real-world shape that triggered
 * SEM2-292 — user turns carry `model IS NULL` and `content_text` populated;
 * assistant turns carry `model = 'claude-opus-4'` or `'claude-sonnet-4-5'`.
 */
async function seedPromptData(db: TestDB): Promise<void> {
  await db.connection.run(`
    INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      total_cost_usd, num_turns, num_tool_calls, project_path)
    VALUES
      ('sess-opus', '2026-03-01 10:00:00', '2026-03-01 10:05:00', 300, 'claude-opus-4',
       500, 200, 0, 0, 0.10, 2, 0, '/projects/alpha'),
      ('sess-sonnet', '2026-03-01 11:00:00', '2026-03-01 11:05:00', 300, 'claude-sonnet-4-5',
       400, 150, 0, 0, 0.02, 2, 0, '/projects/beta')
  `);

  await db.connection.run(`
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking,
      content_text)
    VALUES
      -- Opus session: user turn (model IS NULL) → assistant turn (model = claude-opus-4)
      ('p-opus-u', 'sess-opus', 'user', '2026-03-01 10:00:00',
       0, 0, 0, 0, 0, NULL, NULL, NULL, FALSE, FALSE, 'How do I debug a memory leak in Node?'),
      ('p-opus-a', 'sess-opus', 'assistant', '2026-03-01 10:00:01',
       500, 200, 0, 0, 0.10, 'claude-opus-4', 'end_turn', 'req-opus-1', FALSE, FALSE,
       'Use --inspect and Chrome DevTools heap snapshots.'),
      -- Sonnet session: user → assistant (model = claude-sonnet-4-5)
      ('p-sonnet-u', 'sess-sonnet', 'user', '2026-03-01 11:00:00',
       0, 0, 0, 0, 0, NULL, NULL, NULL, FALSE, FALSE, 'Explain monads.'),
      ('p-sonnet-a', 'sess-sonnet', 'assistant', '2026-03-01 11:00:01',
       400, 150, 0, 0, 0.02, 'claude-sonnet-4-5', 'end_turn', 'req-sonnet-1', FALSE, FALSE,
       'A monad is a monoid in the category of endofunctors.')
  `);
}

describe("PromptAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: PromptAnalyzer;

  const testRange: TimeRange = {
    start: new Date("2026-02-28T00:00:00Z"),
    end: new Date("2026-03-02T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new PromptAnalyzer(executor);
    await seedPromptData(db);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  describe("getPromptRanking", () => {
    it("returns both prompts with no filter", async () => {
      const result = await analyzer.getPromptRanking({ period: testRange });
      expect(result.total).toBe(2);
      const previews = result.rows.map((r) => r.promptPreview);
      expect(previews).toContain("How do I debug a memory leak in Node?");
      expect(previews).toContain("Explain monads.");
    });

    describe("model filter (SEM2-292)", () => {
      it("?model=opus returns the opus prompt — the bare model LIKE form drops user rows and would return zero", async () => {
        const result = await analyzer.getPromptRanking({
          period: testRange,
          model: "opus",
        });
        // Regression guard: SEM2-292 — this was 0 before the fix.
        expect(result.total).toBe(1);
        expect(result.rows[0].promptPreview).toBe(
          "How do I debug a memory leak in Node?",
        );
        expect(result.rows[0].model).toBe("claude-opus-4");
      });

      it("?model=sonnet filters out the opus prompt (assistant side is strict)", async () => {
        const result = await analyzer.getPromptRanking({
          period: testRange,
          model: "sonnet",
        });
        expect(result.total).toBe(1);
        expect(result.rows[0].promptPreview).toBe("Explain monads.");
        expect(result.rows[0].model).toBe("claude-sonnet-4-5");
      });
    });
  });

  describe("getPromptStats", () => {
    it("?model=opus counts the opus prompt only — SEM2-292 regression guard", async () => {
      const stats = await analyzer.getPromptStats({
        period: testRange,
        model: "opus",
      });
      expect(stats.totalPrompts).toBe(1);
      // The opus response cost was 0.10 in the fixture.
      expect(stats.avgCost).toBeCloseTo(0.1, 5);
    });

    it("no filter counts both prompts", async () => {
      const stats = await analyzer.getPromptStats({ period: testRange });
      expect(stats.totalPrompts).toBe(2);
    });
  });
});
