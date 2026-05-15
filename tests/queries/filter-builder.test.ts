/**
 * @module tests/queries/filter-builder
 *
 * Unit + lightweight integration tests for the filter-builder module.
 *
 * Locks in the SEM2-292 (F3-prompt) fix: the model filter must NOT drop user
 * rows from `conversation_turns`. User turns have `model IS NULL`, and
 * `NULL LIKE '%opus%'` evaluates to NULL (not TRUE) — so a bare
 * `AND model LIKE ...` silently discards every user turn. Prompt queries
 * pair a user turn with its assistant response(s), so dropping user rows
 * makes `?model=opus` return zero prompts even when prompts exist.
 *
 * The fix wraps the disjunct as `AND (role = 'user' OR model LIKE ...)`.
 * Other callers (cost / cache / time-series / tool-analyzer) already
 * constrain to `role = 'assistant'` or join through `tool_calls`, so the
 * extra `role = 'user'` disjunct is a no-op for them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildTurnFilters,
  buildSessionFilters,
} from "../../src/queries/filter-builder.js";
import {
  createTestDB,
  closeTestDB,
  type TestDB,
} from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";

describe("buildTurnFilters", () => {
  it("returns empty arrays when no filters are provided", () => {
    expect(buildTurnFilters(undefined, 1)).toEqual({ clauses: [], params: [] });
    expect(buildTurnFilters({}, 1)).toEqual({ clauses: [], params: [] });
  });

  describe("model filter (SEM2-292)", () => {
    it("wraps the model LIKE in (role = 'user' OR ...) so user turns pass through", () => {
      const result = buildTurnFilters({ model: "opus" }, 3);

      expect(result.clauses).toHaveLength(1);
      // The disjunct that lets user turns through is the load-bearing part of the fix.
      expect(result.clauses[0]).toMatch(/role\s*=\s*'user'\s+OR\s+model\s+LIKE/i);
      // And of course the LIKE on model must still be there.
      expect(result.clauses[0]).toContain("model LIKE '%' || $3 || '%'");
      // Regression guard: must NOT be the old bare form.
      expect(result.clauses[0]).not.toMatch(/^AND model LIKE/);
      expect(result.params).toEqual(["opus"]);
    });

    it("binds the model parameter at the requested $N index", () => {
      const result = buildTurnFilters({ model: "sonnet" }, 7);
      expect(result.clauses[0]).toContain("$7");
      expect(result.clauses[0]).not.toContain("$3");
      expect(result.params).toEqual(["sonnet"]);
    });
  });

  describe("project filter", () => {
    it("emits a sessions subquery and does not bring in role", () => {
      const result = buildTurnFilters({ project: "alpha" }, 3);
      expect(result.clauses).toHaveLength(1);
      expect(result.clauses[0]).toContain("session_id IN (SELECT session_id FROM sessions");
      expect(result.clauses[0]).toContain("project_path LIKE '%' || $3 || '%'");
      expect(result.params).toEqual(["alpha"]);
    });
  });

  describe("model + project combined", () => {
    it("emits both clauses with sequential bind indices", () => {
      const result = buildTurnFilters({ model: "opus", project: "beta" }, 3);
      expect(result.clauses).toHaveLength(2);
      expect(result.clauses[0]).toContain("$3");
      expect(result.clauses[1]).toContain("$4");
      expect(result.params).toEqual(["opus", "beta"]);
    });
  });
});

describe("buildSessionFilters", () => {
  it("returns empty arrays when no filters are provided", () => {
    expect(buildSessionFilters(undefined, 1)).toEqual({ clauses: [], params: [] });
  });

  it("uses the supplied alias on each column", () => {
    const result = buildSessionFilters({ model: "opus", project: "alpha" }, 3, "s");
    expect(result.clauses).toEqual([
      "AND s.model LIKE '%' || $3 || '%'",
      "AND s.project_path LIKE '%' || $4 || '%'",
    ]);
    expect(result.params).toEqual(["opus", "alpha"]);
  });

  it("defaults the alias to 's'", () => {
    const result = buildSessionFilters({ model: "opus" }, 3);
    expect(result.clauses[0]).toBe("AND s.model LIKE '%' || $3 || '%'");
  });
});

/**
 * Lightweight integration: run the produced SQL against an in-memory DuckDB
 * with user turns (model IS NULL) and assistant turns (model = 'claude-opus-4-7'),
 * mirroring the prompt-analyzer pattern. With the fix, `?model=opus` returns
 * both rows (the user row passes via `role = 'user'`, the assistant row via the
 * LIKE). Without the fix, the user row would be dropped, breaking the join in
 * the prompt query and producing zero prompts.
 */
describe("buildTurnFilters — integration against DuckDB", () => {
  let db: TestDB;
  let executor: QueryExecutor;

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    await db.connection.run(`
      INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model)
      VALUES ('sess-x', '2026-02-20 10:00:00', '2026-02-20 10:30:00', 1800, 'claude-opus-4-7')
    `);
    await db.connection.run(`
      INSERT INTO conversation_turns
        (turn_id, session_id, role, timestamp,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking, content_text)
      VALUES
        ('t-u', 'sess-x', 'user',      '2026-02-20 10:00:00',
         0, 0, 0, 0,
         0,    NULL,                NULL,      NULL, FALSE, FALSE, 'help me with this prompt'),
        ('t-a', 'sess-x', 'assistant', '2026-02-20 10:00:01',
         500, 200, 0, 0,
         0.02, 'claude-opus-4-7',   'end_turn','req-x', FALSE, FALSE, 'sure thing')
    `);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  it("?model=opus keeps the user turn (regression guard for SEM2-292)", async () => {
    const f = buildTurnFilters({ model: "opus" }, 3);
    expect(f.clauses).toHaveLength(1);

    const sql = `
      SELECT turn_id, role
      FROM conversation_turns
      WHERE timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      ORDER BY timestamp ASC
    `;
    const result = await executor.query<{ turn_id: string; role: string }>(sql, [
      new Date("2026-02-19T00:00:00Z"),
      new Date("2026-02-22T00:00:00Z"),
      ...f.params,
    ]);

    const rows = result.rows.map((r) => ({ turn_id: r.turn_id, role: r.role }));
    expect(rows).toEqual([
      { turn_id: "t-u", role: "user" },
      { turn_id: "t-a", role: "assistant" },
    ]);
  });

  it("?model=opus still excludes assistant turns from a different model", async () => {
    // Add a non-opus assistant turn to a separate session so the LIKE actually filters.
    await db.connection.run(`
      INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model)
      VALUES ('sess-y', '2026-02-20 11:00:00', '2026-02-20 11:30:00', 1800, 'claude-sonnet-4-5')
    `);
    await db.connection.run(`
      INSERT INTO conversation_turns
        (turn_id, session_id, role, timestamp,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking, content_text)
      VALUES
        ('t-a2', 'sess-y', 'assistant', '2026-02-20 11:00:01',
         500, 200, 0, 0,
         0.02, 'claude-sonnet-4-5', 'end_turn','req-y', FALSE, FALSE, 'different model')
    `);

    const f = buildTurnFilters({ model: "opus" }, 3);
    const sql = `
      SELECT turn_id
      FROM conversation_turns
      WHERE timestamp >= $1 AND timestamp < $2
        AND role = 'assistant'
        ${f.clauses.join("\n        ")}
      ORDER BY timestamp ASC
    `;
    const result = await executor.query<{ turn_id: string }>(sql, [
      new Date("2026-02-19T00:00:00Z"),
      new Date("2026-02-22T00:00:00Z"),
      ...f.params,
    ]);

    // Only the opus assistant turn survives — the sonnet one is filtered out,
    // confirming that the role='user' disjunct is a no-op when callers
    // already restrict to role='assistant'.
    expect(result.rows.map((r) => r.turn_id)).toEqual(["t-a"]);
  });
});
