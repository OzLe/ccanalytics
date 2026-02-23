/**
 * @module tests/ingestion/deduplicator
 *
 * Unit tests for the Deduplicator class.
 */

import { describe, it, expect } from "vitest";
import { Deduplicator } from "../../src/ingestion/deduplicator.js";
import type { AssistantMessage } from "../../src/types/index.js";

function makeAssistant(overrides: Partial<AssistantMessage> & { requestId?: string }): AssistantMessage {
  return {
    type: "assistant",
    sessionId: "sess-001",
    timestamp: "2026-02-20T10:00:00.000Z",
    requestId: overrides.requestId ?? undefined,
    message: {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "hello" }],
      stop_reason: "end_turn",
    },
    ...overrides,
  } as AssistantMessage;
}

describe("Deduplicator", () => {
  const deduplicator = new Deduplicator();

  it("should keep last entry per requestId (last-wins)", () => {
    const messages = [
      makeAssistant({ requestId: "req-1", costUSD: 0.01 } as any),
      makeAssistant({ requestId: "req-1", costUSD: 0.02 } as any),
      makeAssistant({ requestId: "req-1", costUSD: 0.03 } as any),
    ];

    const result = deduplicator.deduplicate(messages);
    expect(result.unique.length).toBe(1);
    expect(result.duplicatesRemoved).toBe(2);
    expect((result.unique[0] as any).costUSD).toBe(0.03);
  });

  it("should keep all entries without requestId", () => {
    const messages = [
      makeAssistant({ requestId: undefined }),
      makeAssistant({ requestId: undefined }),
    ];

    const result = deduplicator.deduplicate(messages);
    expect(result.unique.length).toBe(2);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it("should handle unique request IDs", () => {
    const messages = [
      makeAssistant({ requestId: "req-1" }),
      makeAssistant({ requestId: "req-2" }),
      makeAssistant({ requestId: "req-3" }),
    ];

    const result = deduplicator.deduplicate(messages);
    expect(result.unique.length).toBe(3);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it("should handle empty input", () => {
    const result = deduplicator.deduplicate([]);
    expect(result.unique).toEqual([]);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it("should handle mixed requestId and no-requestId messages", () => {
    const messages = [
      makeAssistant({ requestId: "req-1" }),
      makeAssistant({ requestId: undefined }),
      makeAssistant({ requestId: "req-1" }),
      makeAssistant({ requestId: undefined }),
    ];

    const result = deduplicator.deduplicate(messages);
    // 1 unique req-1 (last wins) + 2 without requestId = 3
    expect(result.unique.length).toBe(3);
    expect(result.duplicatesRemoved).toBe(1);
  });
});
