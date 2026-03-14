/**
 * Tests for the ClaudeDesktopAdapter.
 * Verifies field mapping, discovery, parsing, no-op dedup,
 * and batch building with source_type.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ClaudeDesktopAdapter } from "../../../src/ingestion/adapters/claude-desktop.js";
import type { DiscoveredFile } from "../../../src/ingestion/file-discovery.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures");

function makeDesktopFile(auditPath: string, sessionId: string, metadata?: Record<string, unknown>): DiscoveredFile {
  return {
    absolutePath: auditPath,
    projectPath: sessionId,
    sessionId,
    isSidechain: false,
    sizeBytes: 1024,
    modifiedAt: new Date("2026-02-20T09:00:00Z"),
    sourceType: "claude-desktop",
    metadata: metadata ?? {},
  };
}

describe("ClaudeDesktopAdapter", () => {
  const adapter = new ClaudeDesktopAdapter("/nonexistent/path");

  it("has correct name and sourceType", () => {
    expect(adapter.name).toBe("Claude Desktop");
    expect(adapter.sourceType).toBe("claude-desktop");
  });

  it("discoverFiles returns empty array when directory doesn't exist", async () => {
    const files = await adapter.discoverFiles();
    expect(files).toHaveLength(0);
  });

  describe("parseFile", () => {
    it("parses Desktop audit.jsonl with correct field mapping", async () => {
      const file = makeDesktopFile(
        path.join(FIXTURES_DIR, "desktop-audit.jsonl"),
        "desktop-sess-001",
        { cwd: "/Users/testuser/projects/myapp" },
      );
      const result = await adapter.parseFile(file, 0);

      // Should have 2 user messages (the initial prompt + tool result)
      expect(result.userMessages).toHaveLength(2);
      // Should have 2 assistant messages
      expect(result.assistantMessages).toHaveLength(2);
      // system:init, system:permission_*, result:success should be skipped
      expect(result.parseErrors).toBe(0);

      // Check first user message
      const user1 = result.userMessages[0];
      expect(user1.sessionId).toBe("desktop-sess-001");
      expect(user1.timestamp).toBe("2026-02-20T09:00:01.000Z");
      expect(user1.uuid).toBe("uuid-user-d001");

      // Check first assistant message
      const asst1 = result.assistantMessages[0];
      expect(asst1.sessionId).toBe("desktop-sess-001");
      expect(asst1.timestamp).toBe("2026-02-20T09:00:03.500Z");
      expect(asst1.uuid).toBe("uuid-asst-d001");
      expect(asst1.requestId).toBe("req_desktop_001");
      expect(asst1.model).toBe("claude-sonnet-4-5");
      expect(asst1.usage.input_tokens).toBe(200);
      expect(asst1.usage.output_tokens).toBe(50);
      expect(asst1.usage.cache_creation_input_tokens).toBe(10);
      expect(asst1.usage.cache_read_input_tokens).toBe(100);
      expect(asst1.stopReason).toBe("tool_use");
      expect(asst1.metadata.cwd).toBe("/Users/testuser/projects/myapp");
    });

    it("skips system and permission types", async () => {
      const file = makeDesktopFile(
        path.join(FIXTURES_DIR, "desktop-audit.jsonl"),
        "desktop-sess-001",
      );
      const result = await adapter.parseFile(file, 0);

      // system:init (1), system:permission_request (1), system:permission_response (1), result:success (1) = 4 skipped
      // user (2) + assistant (2) = 4 parsed
      // Total lines = 8
      expect(result.linesProcessed).toBe(8);
      // Only user + assistant messages returned
      expect(result.userMessages.length + result.assistantMessages.length).toBe(4);
    });
  });

  describe("deduplicate", () => {
    it("is a no-op (Desktop doesn't produce streaming duplicates)", () => {
      const msgs = [
        {
          sessionId: "s1",
          timestamp: "2026-02-20T09:00:00Z",
          requestId: "req-1",
          content: [],
          usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          metadata: {},
        },
        {
          sessionId: "s1",
          timestamp: "2026-02-20T09:00:01Z",
          requestId: "req-2",
          content: [],
          usage: { input_tokens: 200, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          metadata: {},
        },
      ];

      const result = adapter.deduplicate(msgs);
      expect(result.duplicatesRemoved).toBe(0);
      expect(result.unique).toHaveLength(2);
    });
  });

  describe("buildInsertionBatch", () => {
    it("produces correct session rows with source_type=claude-desktop", async () => {
      const file = makeDesktopFile(
        path.join(FIXTURES_DIR, "desktop-audit.jsonl"),
        "desktop-sess-001",
        { cwd: "/Users/testuser/projects/myapp" },
      );
      const parsed = await adapter.parseFile(file, 0);
      const deduped = adapter.deduplicate(parsed.assistantMessages);
      const batch = adapter.buildInsertionBatch(file, deduped.unique, parsed.userMessages);

      expect(batch.sessions).toHaveLength(1);
      expect(batch.conversationTurns).toHaveLength(4); // 2 user + 2 assistant
      expect(batch.errors).toHaveLength(0);

      const session = batch.sessions[0];
      expect(session.session_id).toBe("desktop-sess-001");
      expect(session.source_type).toBe("claude-desktop");
      expect(session.model).toBe("claude-sonnet-4-5");
      expect(session.input_tokens).toBe(500); // 200 + 300
      expect(session.output_tokens).toBe(130); // 50 + 80
      expect(session.num_turns).toBe(4);
      // project_path comes from file.projectPath which makeDesktopFile sets to sessionId
      expect(session.project_path).toBe("desktop-sess-001");
      // Desktop projects get " (Desktop)" suffix to disambiguate from Code projects
      expect(session.project_name).toContain("(Desktop)");
    });

    it("uses result:success total_cost_usd when available", async () => {
      const file = makeDesktopFile(
        path.join(FIXTURES_DIR, "desktop-audit.jsonl"),
        "desktop-sess-001",
        { cwd: "/Users/testuser/projects/myapp" },
      );
      const parsed = await adapter.parseFile(file, 0);
      const deduped = adapter.deduplicate(parsed.assistantMessages);
      const batch = adapter.buildInsertionBatch(file, deduped.unique, parsed.userMessages);

      const session = batch.sessions[0];
      // Session cost is now computed from token counts using model-aware rates (not result:success value).
      // asst-d001: 200*3/1M + 50*15/1M + 10*3.75/1M + 100*0.3/1M = 0.0014175
      // asst-d002: 300*3/1M + 80*15/1M + 5*3.75/1M + 150*0.3/1M = 0.00216375
      // Total: 0.00358125
      expect(session.total_cost_usd).toBeCloseTo(0.00358125, 8);
    });

    it("extracts tool calls from assistant content blocks", async () => {
      const file = makeDesktopFile(
        path.join(FIXTURES_DIR, "desktop-audit.jsonl"),
        "desktop-sess-001",
      );
      const parsed = await adapter.parseFile(file, 0);
      const deduped = adapter.deduplicate(parsed.assistantMessages);
      const batch = adapter.buildInsertionBatch(file, deduped.unique, parsed.userMessages);

      expect(batch.toolCalls).toHaveLength(1);
      expect(batch.toolCalls[0].tool_name).toBe("Read");
      expect(batch.toolCalls[0].tool_type).toBe("builtin");
    });
  });

  describe("discoverFiles with real directory structure", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccanalytics-desktop-test-"));
      // Create a minimal Desktop-like directory structure
      const sessionDir = path.join(tempDir, "local-agent-mode-sessions", "group1", "test-session-001");
      await fs.mkdir(sessionDir, { recursive: true });
      // Copy fixture as audit.jsonl
      const fixture = await fs.readFile(path.join(FIXTURES_DIR, "desktop-audit.jsonl"), "utf-8");
      await fs.writeFile(path.join(sessionDir, "audit.jsonl"), fixture);
      // Write metadata
      const metadata = await fs.readFile(path.join(FIXTURES_DIR, "desktop-session-metadata.json"), "utf-8");
      await fs.writeFile(path.join(sessionDir, "test-session-001.json"), metadata);
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("discovers audit.jsonl files in Desktop directory structure", async () => {
      const testAdapter = new ClaudeDesktopAdapter(tempDir);
      const files = await testAdapter.discoverFiles();

      expect(files).toHaveLength(1);
      expect(files[0].sessionId).toBe("test-session-001");
      expect(files[0].sourceType).toBe("claude-desktop");
      expect(files[0].absolutePath).toContain("audit.jsonl");
      expect(files[0].metadata).toBeDefined();
      expect(files[0].metadata?.cwd).toBe("/Users/testuser/projects/myapp");
    });

    it("respects since filter", async () => {
      const testAdapter = new ClaudeDesktopAdapter(tempDir);
      // Future date — should find nothing
      const files = await testAdapter.discoverFiles({ since: "2099-01-01T00:00:00Z" });
      expect(files).toHaveLength(0);
    });
  });
});
