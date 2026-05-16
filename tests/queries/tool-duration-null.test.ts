/**
 * @module tests/queries/tool-duration-null
 *
 * Regression tests for SEM2-282 (TOOL-001) — "Avg Time" surfaced as 0s for
 * every tool because COALESCE(AVG(tc.duration_ms), 0) pretended 0 was data
 * when in reality 100% of tool_calls.duration_ms is NULL (both ingestion
 * adapters set duration_ms = NULL — claude-code.ts:280, claude-desktop.ts:512).
 *
 * FIX — Drop the COALESCE-to-0 in the SQL, type avgDurationMs as
 * `number | null` end-to-end, and let the UI render "n/a" matching the
 * KPI-006 success_rate pattern.
 *
 * The fixtures below cover both cases:
 *   - "no data" sessions whose tool_calls all have duration_ms = NULL
 *     (the production reality today) → MUST come back as null.
 *   - sessions whose tool_calls have real durations → MUST average normally.
 * A mixed-population tool (some NULL, some populated) MUST return the
 * average over the populated rows only — NULLs are excluded from AVG by
 * SQL semantics, which is the correct "best-effort" answer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestDB, createTestDB, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { ToolAnalyzer } from "../../src/queries/tool-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

const RANGE: TimeRange = {
  start: new Date("2026-04-01T00:00:00Z"),
  end: new Date("2026-04-02T00:00:00Z"),
};

/**
 * Seed a single session with explicit tool_calls. Pass duration_ms = null for
 * the "no captured duration" case (mirrors the live adapters).
 */
async function seedSession(
  db: TestDB,
  sessionId: string,
  calls: Array<{
    toolCallId: string;
    turnId: string;
    toolName: string;
    toolType?: string;
    mcpServer?: string | null;
    durationMs: number | null;
    success?: boolean | null;
    timestamp?: string;
  }>,
): Promise<void> {
  await db.connection.run(`
    INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      total_cost_usd, num_turns, num_tool_calls, project_path)
    VALUES ('${sessionId}', '2026-04-01 10:00:00', '2026-04-01 10:00:00', 0,
      'claude-sonnet-4-5', 0, 0, 0, 0, 0, 1, ${calls.length}, '/projects/duration-null')
  `);

  // One assistant turn per unique turn_id. Prefixed with the session id so
  // turn primary keys don't collide across multiple seeded sessions.
  const turnKey = (c: { turnId: string }) => `${sessionId}-${c.turnId}`;
  const reqKey = (c: { turnId: string }) => `${sessionId}-${c.turnId}-req`;
  const seenTurns = new Set<string>();
  for (const c of calls) {
    const tid = turnKey(c);
    if (seenTurns.has(tid)) continue;
    seenTurns.add(tid);
    const ts = c.timestamp ?? "2026-04-01 10:00:00";
    await db.connection.run(`
      INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
      VALUES ('${tid}', '${sessionId}', 'assistant', '${ts}',
        0, 0, 0, 0, 0, 'claude-sonnet-4-5', 'tool_use', '${reqKey(c)}', TRUE, FALSE)
    `);
  }

  for (const c of calls) {
    const successSql =
      c.success === undefined || c.success === null
        ? "NULL"
        : c.success
          ? "TRUE"
          : "FALSE";
    const durationSql = c.durationMs === null ? "NULL" : String(c.durationMs);
    const toolType = c.toolType ?? "native";
    const mcpServerSql =
      c.mcpServer === undefined || c.mcpServer === null
        ? "NULL"
        : `'${c.mcpServer}'`;
    await db.connection.run(`
      INSERT INTO tool_calls (tool_call_id, session_id, turn_id, tool_name,
        tool_type, mcp_server, duration_ms, success)
      VALUES ('${c.toolCallId}', '${sessionId}', '${turnKey(c)}',
        '${c.toolName}', '${toolType}', ${mcpServerSql}, ${durationSql}, ${successSql})
    `);
  }
}

describe("Tool avg duration NULL coercion (SEM2-282 regression suite)", () => {
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

  // ---------------------------------------------------------------------------
  // getToolUsage — mirrors /api/tools/usage.
  // ---------------------------------------------------------------------------

  describe("getToolUsage / /api/tools/usage", () => {
    it("returns avgDurationMs = null when every row's duration_ms is NULL", async () => {
      // The production-reality case: both adapters write NULL today, so every
      // tool surfaces with no captured duration.
      await seedSession(db, "sess-null-only", [
        { toolCallId: "n-1", turnId: "t-1", toolName: "Read", durationMs: null, success: true },
        { toolCallId: "n-2", turnId: "t-2", toolName: "Read", durationMs: null, success: true },
        { toolCallId: "n-3", turnId: "t-3", toolName: "Edit", durationMs: null, success: true },
      ]);

      const rows = await analyzer.getToolUsage(RANGE);
      const read = rows.find((r) => r.toolName === "Read");
      const edit = rows.find((r) => r.toolName === "Edit");
      expect(read).toBeDefined();
      expect(edit).toBeDefined();
      // PRE-FIX: this came back as 0 (the COALESCE coerced NULL → 0 and the
      // UI rendered "0s"). POST-FIX it must be null so the UI can render "n/a".
      expect(read!.avgDurationMs).toBeNull();
      expect(edit!.avgDurationMs).toBeNull();
    });

    it("returns the numeric average when every row has a duration_ms", async () => {
      await seedSession(db, "sess-numeric", [
        { toolCallId: "p-1", turnId: "t-1", toolName: "Bash", durationMs: 100, success: true },
        { toolCallId: "p-2", turnId: "t-2", toolName: "Bash", durationMs: 200, success: true },
        { toolCallId: "p-3", turnId: "t-3", toolName: "Bash", durationMs: 300, success: true },
      ]);

      const rows = await analyzer.getToolUsage(RANGE);
      const bash = rows.find((r) => r.toolName === "Bash");
      expect(bash).toBeDefined();
      expect(bash!.avgDurationMs).toBe(200);
    });

    it("averages only over rows with a captured duration (mixed population)", async () => {
      // SQL semantics: AVG skips NULLs. The "best-effort" answer is the
      // average of the rows we DO have data for — 150 here, not 75.
      await seedSession(db, "sess-mixed", [
        { toolCallId: "m-1", turnId: "t-1", toolName: "Read", durationMs: 100, success: true },
        { toolCallId: "m-2", turnId: "t-2", toolName: "Read", durationMs: 200, success: true },
        { toolCallId: "m-3", turnId: "t-3", toolName: "Read", durationMs: null, success: true },
      ]);

      const rows = await analyzer.getToolUsage(RANGE);
      const read = rows.find((r) => r.toolName === "Read");
      expect(read).toBeDefined();
      expect(read!.avgDurationMs).toBe(150);
    });
  });

  // ---------------------------------------------------------------------------
  // getToolSuccessRates — mirrors /api/tools/success-rates.
  // ---------------------------------------------------------------------------

  describe("getToolSuccessRates / /api/tools/success-rates", () => {
    it("returns avgDurationMs = null when every row's duration_ms is NULL", async () => {
      await seedSession(db, "sess-sr-null", [
        { toolCallId: "s-1", turnId: "t-1", toolName: "Glob", durationMs: null, success: true },
        { toolCallId: "s-2", turnId: "t-2", toolName: "Glob", durationMs: null, success: true },
      ]);

      const rows = await analyzer.getToolSuccessRates(RANGE);
      const glob = rows.find((r) => r.toolName === "Glob");
      expect(glob).toBeDefined();
      expect(glob!.avgDurationMs).toBeNull();
    });

    it("returns the numeric average when at least one row has a duration_ms", async () => {
      await seedSession(db, "sess-sr-num", [
        { toolCallId: "g-1", turnId: "t-1", toolName: "Grep", durationMs: 50, success: true },
        { toolCallId: "g-2", turnId: "t-2", toolName: "Grep", durationMs: 150, success: true },
      ]);

      const rows = await analyzer.getToolSuccessRates(RANGE);
      const grep = rows.find((r) => r.toolName === "Grep");
      expect(grep).toBeDefined();
      expect(grep!.avgDurationMs).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // getMCPServerUsage — mirrors /api/tools/mcp-servers.
  // ---------------------------------------------------------------------------

  describe("getMCPServerUsage / /api/tools/mcp-servers", () => {
    it("returns avgDurationMs = null when every MCP row's duration_ms is NULL", async () => {
      await seedSession(db, "sess-mcp-null", [
        {
          toolCallId: "x-1",
          turnId: "t-1",
          toolName: "mcp__github__create_pr",
          toolType: "mcp",
          mcpServer: "github",
          durationMs: null,
          success: true,
        },
        {
          toolCallId: "x-2",
          turnId: "t-2",
          toolName: "mcp__github__list_issues",
          toolType: "mcp",
          mcpServer: "github",
          durationMs: null,
          success: true,
        },
      ]);

      const rows = await analyzer.getMCPServerUsage(RANGE);
      const github = rows.find((r) => r.serverName === "github");
      expect(github).toBeDefined();
      expect(github!.avgDurationMs).toBeNull();
    });

    it("returns the numeric average when MCP rows have durations", async () => {
      await seedSession(db, "sess-mcp-num", [
        {
          toolCallId: "y-1",
          turnId: "t-1",
          toolName: "mcp__linear__list_issues",
          toolType: "mcp",
          mcpServer: "linear",
          durationMs: 100,
          success: true,
        },
        {
          toolCallId: "y-2",
          turnId: "t-2",
          toolName: "mcp__linear__get_issue",
          toolType: "mcp",
          mcpServer: "linear",
          durationMs: 300,
          success: true,
        },
      ]);

      const rows = await analyzer.getMCPServerUsage(RANGE);
      const linear = rows.find((r) => r.serverName === "linear");
      expect(linear).toBeDefined();
      expect(linear!.avgDurationMs).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // getToolChains — mirrors /api/tools/chains.
  // ---------------------------------------------------------------------------

  describe("getToolChains / /api/tools/chains", () => {
    it("returns avgDurationMs = null when every chain instance has all-NULL legs", async () => {
      // 4 consecutive Bash calls → 2 distinct Bash³ windows. All legs NULL,
      // so total_duration_ms is NULL for both instances → AVG is NULL.
      await seedSession(db, "sess-chain-null", [
        { toolCallId: "c-1", turnId: "t-1", toolName: "Bash", durationMs: null, success: true, timestamp: "2026-04-01 10:00:01" },
        { toolCallId: "c-2", turnId: "t-2", toolName: "Bash", durationMs: null, success: true, timestamp: "2026-04-01 10:00:02" },
        { toolCallId: "c-3", turnId: "t-3", toolName: "Bash", durationMs: null, success: true, timestamp: "2026-04-01 10:00:03" },
        { toolCallId: "c-4", turnId: "t-4", toolName: "Bash", durationMs: null, success: true, timestamp: "2026-04-01 10:00:04" },
      ]);

      const chains = await analyzer.getToolChains(RANGE, 1);
      const bashCubed = chains.find(
        (c) => c.chain[0] === "Bash" && c.chain[1] === "Bash" && c.chain[2] === "Bash",
      );
      expect(bashCubed).toBeDefined();
      expect(bashCubed!.occurrences).toBe(2);
      expect(bashCubed!.avgDurationMs).toBeNull();
    });

    it("returns the numeric average when all chain legs have durations", async () => {
      // 3 Bash calls each 100ms → one Bash³ window with total_duration_ms 300.
      await seedSession(db, "sess-chain-num", [
        { toolCallId: "d-1", turnId: "t-1", toolName: "Bash", durationMs: 100, success: true, timestamp: "2026-04-01 10:00:01" },
        { toolCallId: "d-2", turnId: "t-2", toolName: "Bash", durationMs: 100, success: true, timestamp: "2026-04-01 10:00:02" },
        { toolCallId: "d-3", turnId: "t-3", toolName: "Bash", durationMs: 100, success: true, timestamp: "2026-04-01 10:00:03" },
      ]);

      const chains = await analyzer.getToolChains(RANGE, 1);
      const bashCubed = chains.find(
        (c) => c.chain[0] === "Bash" && c.chain[1] === "Bash" && c.chain[2] === "Bash",
      );
      expect(bashCubed).toBeDefined();
      expect(bashCubed!.occurrences).toBe(1);
      expect(bashCubed!.avgDurationMs).toBe(300);
    });

    it("sums known legs when a chain has partial-NULL legs", async () => {
      // 3 Bash calls: 100, NULL, 200 → total 300 (CASE WHEN ALL NULL only).
      await seedSession(db, "sess-chain-partial", [
        { toolCallId: "e-1", turnId: "t-1", toolName: "Bash", durationMs: 100, success: true, timestamp: "2026-04-01 10:00:01" },
        { toolCallId: "e-2", turnId: "t-2", toolName: "Bash", durationMs: null, success: true, timestamp: "2026-04-01 10:00:02" },
        { toolCallId: "e-3", turnId: "t-3", toolName: "Bash", durationMs: 200, success: true, timestamp: "2026-04-01 10:00:03" },
      ]);

      const chains = await analyzer.getToolChains(RANGE, 1);
      const bashCubed = chains.find(
        (c) => c.chain[0] === "Bash" && c.chain[1] === "Bash" && c.chain[2] === "Bash",
      );
      expect(bashCubed).toBeDefined();
      expect(bashCubed!.occurrences).toBe(1);
      expect(bashCubed!.avgDurationMs).toBe(300);
    });
  });
});
