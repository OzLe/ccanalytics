/**
 * Tests for the ClaudeCodeAdapter.
 * Verifies that the extracted adapter produces identical output
 * to the previous inline implementation in IngestionPipeline.
 */

import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "../../../src/ingestion/adapters/claude-code.js";
import type { DiscoveredFile } from "../../../src/ingestion/file-discovery.js";
import * as path from "node:path";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures");

function makeFile(filename: string, sessionId: string): DiscoveredFile {
  return {
    absolutePath: path.join(FIXTURES_DIR, filename),
    projectPath: "/test/project",
    sessionId,
    isSidechain: false,
    sizeBytes: 1024,
    modifiedAt: new Date("2026-02-20T10:00:00Z"),
  };
}

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter(path.resolve(process.cwd()));

  it("has correct name and sourceType", () => {
    expect(adapter.name).toBe("Claude Code CLI");
    expect(adapter.sourceType).toBe("claude-code");
  });

  it("parseFile returns normalized user and assistant messages", async () => {
    const file = makeFile("minimal-session.jsonl", "sess-minimal-001");
    const result = await adapter.parseFile(file, 0);

    expect(result.userMessages).toHaveLength(1);
    expect(result.assistantMessages).toHaveLength(1);
    expect(result.parseErrors).toBe(0);
    expect(result.bytesRead).toBeGreaterThan(0);
    expect(result.linesProcessed).toBeGreaterThan(0);

    // Check user message shape
    const user = result.userMessages[0];
    expect(user.sessionId).toBe("sess-minimal-001");
    expect(user.timestamp).toBe("2026-02-20T10:00:00.000Z");
    expect(user.uuid).toBe("uuid-user-001");

    // Check assistant message shape
    const asst = result.assistantMessages[0];
    expect(asst.sessionId).toBe("sess-minimal-001");
    expect(asst.requestId).toBe("req_minimal_001");
    expect(asst.model).toBe("claude-sonnet-4-5");
    expect(asst.usage.input_tokens).toBe(150);
    expect(asst.usage.output_tokens).toBe(28);
    expect(asst.stopReason).toBe("end_turn");
    expect(asst.metadata.version).toBe("1.0.35");
  });

  it("parseFile handles multi-turn sessions", async () => {
    const file = makeFile("multi-turn-session.jsonl", "sess-multi-001");
    const result = await adapter.parseFile(file, 0);

    expect(result.userMessages.length).toBeGreaterThan(0);
    expect(result.assistantMessages.length).toBeGreaterThan(0);
  });

  it("deduplicate removes streaming duplicates (last wins)", () => {
    const msgs = [
      {
        sessionId: "s1",
        timestamp: "2026-02-20T10:00:00Z",
        requestId: "req-1",
        content: [],
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        metadata: {},
      },
      {
        sessionId: "s1",
        timestamp: "2026-02-20T10:00:01Z",
        requestId: "req-1",
        content: [],
        usage: { input_tokens: 150, output_tokens: 28, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        metadata: {},
      },
      {
        sessionId: "s1",
        timestamp: "2026-02-20T10:00:02Z",
        requestId: "req-2",
        content: [],
        usage: { input_tokens: 200, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        metadata: {},
      },
    ];

    const result = adapter.deduplicate(msgs);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.unique).toHaveLength(2);
    // The last entry for req-1 should win
    const req1 = result.unique.find((m) => m.requestId === "req-1");
    expect(req1?.usage.input_tokens).toBe(150);
  });

  it("deduplicate keeps messages without requestId", () => {
    const msgs = [
      {
        sessionId: "s1",
        timestamp: "2026-02-20T10:00:00Z",
        content: [],
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        metadata: {},
      },
    ];

    const result = adapter.deduplicate(msgs);
    expect(result.duplicatesRemoved).toBe(0);
    expect(result.unique).toHaveLength(1);
  });

  it("buildInsertionBatch produces correct session rows with source_type", async () => {
    const file = makeFile("minimal-session.jsonl", "sess-minimal-001");
    const parsed = await adapter.parseFile(file, 0);
    const deduped = adapter.deduplicate(parsed.assistantMessages);
    const batch = adapter.buildInsertionBatch(file, deduped.unique, parsed.userMessages);

    expect(batch.sessions).toHaveLength(1);
    expect(batch.conversationTurns).toHaveLength(2); // 1 user + 1 assistant
    expect(batch.errors).toHaveLength(0);

    const session = batch.sessions[0];
    expect(session.session_id).toBe("sess-minimal-001");
    expect(session.source_type).toBe("claude-code");
    expect(session.model).toBe("claude-sonnet-4-5");
    expect(session.input_tokens).toBe(150);
    expect(session.output_tokens).toBe(28);
    expect(session.num_turns).toBe(2);
    expect(session.project_path).toBe("/test/project");
    expect(session.total_cost_usd).toBeGreaterThan(0);
  });

  it("buildInsertionBatch extracts tool calls", async () => {
    const file = makeFile("mcp-tools-session.jsonl", "sess-mcp-001");
    const parsed = await adapter.parseFile(file, 0);
    const deduped = adapter.deduplicate(parsed.assistantMessages);
    const batch = adapter.buildInsertionBatch(file, deduped.unique, parsed.userMessages);

    expect(batch.toolCalls.length).toBeGreaterThan(0);
    // Check that MCP tools are classified correctly
    const mcpCall = batch.toolCalls.find((tc) => tc.tool_type === "mcp");
    if (mcpCall) {
      expect(mcpCall.mcp_server).toBeTruthy();
    }
    // Non-Skill tool calls have NULL skill_name / skill_caller_type (S-04/S-05).
    for (const tc of batch.toolCalls) {
      if (tc.tool_name !== "Skill") {
        expect(tc.skill_name).toBeNull();
        expect(tc.skill_caller_type).toBeNull();
      }
    }
  });

  describe("skill_listing + Skill tool_use (P-05)", () => {
    it("parseFile collects skill_listing attachments into loadedSkills", async () => {
      const file = makeFile("skill-listing-session.jsonl", "sess-skill-001");
      const parsed = await adapter.parseFile(file, 0);

      expect(parsed.loadedSkills).toBeDefined();
      expect(parsed.loadedSkills).toHaveLength(1);

      const rec = parsed.loadedSkills![0];
      expect(rec.sessionId).toBe("sess-skill-001");
      expect(rec.recordUuid).toBe("uuid-att-001");
      expect(rec.isInitial).toBe(true);
      expect(rec.skillCount).toBe(4);
      // 4 skill lines; the TRIGGER/SKIP lines are continuations of claude-api.
      expect(rec.skills).toHaveLength(4);
      expect(rec.skills.map((s) => s.name)).toEqual([
        "simplify",
        "babysitter:babysit",
        "claude-api",
        "chrome-devtools-mcp:chrome-devtools",
      ]);
      const claudeApi = rec.skills.find((s) => s.name === "claude-api")!;
      expect(claudeApi.description).toContain("TRIGGER when:");
      expect(claudeApi.description).toContain("SKIP:");
    });

    it("buildInsertionBatch emits sessionSkills rows with deterministic PKs", async () => {
      const file = makeFile("skill-listing-session.jsonl", "sess-skill-001");
      const parsed = await adapter.parseFile(file, 0);
      const deduped = adapter.deduplicate(parsed.assistantMessages);
      const batch = adapter.buildInsertionBatch(
        file,
        deduped.unique,
        parsed.userMessages,
        parsed.loadedSkills,
      );

      expect(batch.sessionSkills).toHaveLength(4);
      const simplify = batch.sessionSkills.find((s) => s.skill_name === "simplify")!;
      // D4: session_id || ':' || (record_uuid ?? timestamp) || ':' || skill_name
      expect(simplify.session_skill_id).toBe(
        "sess-skill-001:uuid-att-001:simplify",
      );
      expect(simplify.session_id).toBe("sess-skill-001");
      expect(simplify.record_uuid).toBe("uuid-att-001");
      expect(simplify.is_initial).toBe(true);
      expect(simplify.skill_count).toBe(4);
      expect(simplify.source).toBe("skill_listing");
      expect(simplify.captured_at).toBeInstanceOf(Date);

      // PKs are unique across the batch.
      const ids = new Set(batch.sessionSkills.map((s) => s.session_skill_id));
      expect(ids.size).toBe(4);
    });

    it("buildInsertionBatch tags Skill tool_calls with skill_name + skill_caller_type", async () => {
      const file = makeFile("skill-listing-session.jsonl", "sess-skill-001");
      const parsed = await adapter.parseFile(file, 0);
      const deduped = adapter.deduplicate(parsed.assistantMessages);
      const batch = adapter.buildInsertionBatch(
        file,
        deduped.unique,
        parsed.userMessages,
        parsed.loadedSkills,
      );

      const skillCalls = batch.toolCalls.filter((tc) => tc.tool_name === "Skill");
      expect(skillCalls).toHaveLength(2);

      const babysit = skillCalls.find((tc) => tc.tool_call_id === "toolu_skill_01")!;
      expect(babysit.skill_name).toBe("babysitter:babysit");
      expect(babysit.skill_caller_type).toBe("direct");

      const simplify = skillCalls.find((tc) => tc.tool_call_id === "toolu_skill_02")!;
      expect(simplify.skill_name).toBe("simplify");
      expect(simplify.skill_caller_type).toBe("direct");

      // The non-Skill Read call in the same turn stays NULL on both columns.
      const read = batch.toolCalls.find((tc) => tc.tool_name === "Read")!;
      expect(read.skill_name).toBeNull();
      expect(read.skill_caller_type).toBeNull();
    });

    it("buildInsertionBatch with no loadedSkills yields an empty sessionSkills array", async () => {
      const file = makeFile("minimal-session.jsonl", "sess-minimal-001");
      const parsed = await adapter.parseFile(file, 0);
      const deduped = adapter.deduplicate(parsed.assistantMessages);
      const batch = adapter.buildInsertionBatch(
        file,
        deduped.unique,
        parsed.userMessages,
        parsed.loadedSkills,
      );

      expect(parsed.loadedSkills).toEqual([]);
      expect(batch.sessionSkills).toEqual([]);
    });
  });
});
