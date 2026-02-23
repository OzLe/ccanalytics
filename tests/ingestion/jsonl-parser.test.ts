/**
 * @module tests/ingestion/jsonl-parser
 *
 * Unit tests for the JSONLParser class.
 * Tests line parsing, type discrimination, and error handling.
 */

import { describe, it, expect } from "vitest";
import { JSONLParser } from "../../src/ingestion/jsonl-parser.js";

describe("JSONLParser", () => {
  const parser = new JSONLParser();

  describe("parseLine", () => {
    it("should parse a user message", () => {
      const line = JSON.stringify({
        type: "user",
        sessionId: "sess-001",
        timestamp: "2026-02-20T10:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        uuid: "uuid-001",
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("user");
      expect(result!.data.sessionId).toBe("sess-001");
      expect(result!.data.timestamp).toBe("2026-02-20T10:00:00.000Z");
    });

    it("should parse an assistant message with costUSD and usage", () => {
      const line = JSON.stringify({
        type: "assistant",
        sessionId: "sess-001",
        timestamp: "2026-02-20T10:00:02.500Z",
        costUSD: 0.0042,
        usage: {
          input_tokens: 150,
          output_tokens: 28,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        requestId: "req_001",
        model: "claude-sonnet-4-5",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "2 + 2 = 4." }],
          stop_reason: "end_turn",
          model: "claude-sonnet-4-5",
        },
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("assistant");
      if (result!.type === "assistant") {
        expect(result!.data.costUSD).toBe(0.0042);
        expect(result!.data.usage.input_tokens).toBe(150);
        expect(result!.data.usage.output_tokens).toBe(28);
        expect(result!.data.requestId).toBe("req_001");
        expect(result!.data.model).toBe("claude-sonnet-4-5");
      }
    });

    it("should return null for a corrupt/malformed JSON line", () => {
      const result = parser.parseLine('{"type":"assistant","broken');

      expect(result).toBeNull();
    });

    it("should return null for an empty line", () => {
      expect(parser.parseLine("")).toBeNull();
      expect(parser.parseLine("   ")).toBeNull();
    });

    it("should return null for a line with no type field", () => {
      const line = JSON.stringify({
        sessionId: "sess-001",
        timestamp: "2026-02-20T10:00:00.000Z",
      });

      expect(parser.parseLine(line)).toBeNull();
    });

    it("should return null for an unknown type (forward-compatible)", () => {
      const line = JSON.stringify({
        type: "future-message-type",
        sessionId: "sess-001",
        timestamp: "2026-02-20T10:00:00.000Z",
      });

      expect(parser.parseLine(line)).toBeNull();
    });

    it("should parse an assistant message with tool_use content blocks", () => {
      const line = JSON.stringify({
        type: "assistant",
        sessionId: "sess-001",
        timestamp: "2026-02-20T10:00:01.000Z",
        costUSD: 0.0068,
        usage: {
          input_tokens: 320,
          output_tokens: 85,
          cache_creation_input_tokens: 180,
          cache_read_input_tokens: 0,
        },
        requestId: "req_002",
        model: "claude-sonnet-4-5",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "I need to read the file",
              signature: "sig-001",
            },
            {
              type: "tool_use",
              id: "toolu_01ABC",
              name: "Read",
              input: { file_path: "src/main.ts" },
            },
          ],
          stop_reason: "tool_use",
          model: "claude-sonnet-4-5",
        },
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("assistant");
      if (result!.type === "assistant") {
        const content = result!.data.message.content;
        expect(content).toHaveLength(2);
        expect(content[0].type).toBe("thinking");
        expect(content[1].type).toBe("tool_use");
        if (content[1].type === "tool_use") {
          expect(content[1].name).toBe("Read");
          expect(content[1].id).toBe("toolu_01ABC");
        }
      }
    });

    it("should parse a file-history-snapshot message", () => {
      const line = JSON.stringify({
        type: "file-history-snapshot",
        sessionId: "sess-001",
        timestamp: "2026-02-20T10:05:00.000Z",
        files: { "src/main.ts": { hash: "abc123" } },
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("file-history-snapshot");
    });

    it("should parse a queue-operation message", () => {
      const line = JSON.stringify({
        type: "queue-operation",
        sessionId: "sess-001",
        timestamp: "2026-02-20T10:06:00.000Z",
        operation: "enqueue",
        data: { task: "lint" },
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("queue-operation");
    });
  });
});
