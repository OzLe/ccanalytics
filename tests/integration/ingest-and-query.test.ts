/**
 * @module tests/integration/ingest-and-query
 *
 * Integration test: parse fixture file -> insert into DB -> query -> verify.
 * Tests the full pipeline from JSONL to query results.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { CostAnalyzer } from "../../src/queries/cost-analyzer.js";
import { SessionAnalyzer } from "../../src/queries/session-analyzer.js";
import { CacheAnalyzer } from "../../src/queries/cache-analyzer.js";
import { JSONLParser } from "../../src/ingestion/jsonl-parser.js";
import { Deduplicator } from "../../src/ingestion/deduplicator.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, UserMessage } from "../../src/types/index.js";

// Helper to simulate minimal ingestion into the test DB
async function ingestFixture(
  executor: QueryExecutor,
  fixturePath: string,
): Promise<{ sessions: number; turns: number }> {
  const parser = new JSONLParser();
  const deduplicator = new Deduplicator();
  const content = await fs.readFile(fixturePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  const userMessages: UserMessage[] = [];
  const assistantMessages: AssistantMessage[] = [];

  for (const line of lines) {
    const entry = parser.parseLine(line);
    if (!entry) continue;
    // parseLine returns ParsedEntry = { type, data }
    if (entry.type === "user") userMessages.push(entry.data as UserMessage);
    else if (entry.type === "assistant") assistantMessages.push(entry.data as AssistantMessage);
  }

  // Deduplicate assistant messages
  const { unique } = deduplicator.deduplicate(assistantMessages);
  const allParsed = [
    ...userMessages.map((m) => ({ role: "user" as const, msg: m })),
    ...unique.map((m) => ({ role: "assistant" as const, msg: m })),
  ].sort(
    (a, b) => new Date(a.msg.timestamp).getTime() - new Date(b.msg.timestamp).getTime(),
  );

  // Track sessions
  const sessionIds = new Set<string>();
  let turnCount = 0;

  for (const { role, msg } of allParsed) {
    sessionIds.add(msg.sessionId);
    const turnId = `turn-${turnCount++}`;
    const ts = msg.timestamp; // Already an ISO string from JSONL

    if (role === "user") {
      await executor.run(
        `INSERT INTO conversation_turns (turn_id, session_id, role, timestamp) VALUES ($1, $2, 'user', $3)`,
        [turnId, msg.sessionId, ts],
      );
    } else {
      const am = msg as AssistantMessage;
      const usage = (am as any).usage ?? am.message?.usage;
      const inputTokens = usage?.input_tokens ?? 0;
      const outputTokens = usage?.output_tokens ?? 0;
      const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
      const cacheRead = usage?.cache_read_input_tokens ?? 0;
      const cost = (am as any).costUSD ?? 0;
      const model = am.model ?? (am.message as any)?.model ?? null;

      await executor.run(
        `INSERT INTO conversation_turns
          (turn_id, session_id, role, timestamp, input_tokens, output_tokens,
           cache_creation_tokens, cache_read_tokens, cost_usd, model, request_id)
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8, $9, $10)`,
        [turnId, msg.sessionId, ts, inputTokens, outputTokens, cacheCreate, cacheRead, cost, model, am.requestId ?? null],
      );
    }
  }

  // Insert session records
  for (const sessionId of sessionIds) {
    await executor.run(
      `INSERT INTO sessions (session_id, start_time, model, num_turns)
       SELECT $1, MIN(timestamp), MAX(model), COUNT(*)
       FROM conversation_turns WHERE session_id = $1`,
      [sessionId],
    );
  }

  return { sessions: sessionIds.size, turns: turnCount };
}

describe("Ingest and Query Integration", () => {
  let db: TestDB;
  let executor: QueryExecutor;

  const testRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  it("should ingest minimal session and query cost", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests/fixtures/minimal-session.jsonl");
    const { sessions, turns } = await ingestFixture(executor, fixturePath);
    expect(sessions).toBe(1);
    expect(turns).toBe(2);

    const costAnalyzer = new CostAnalyzer(executor);
    const total = await costAnalyzer.getTotalCost(testRange);
    expect(total.totalCostUSD).toBeGreaterThan(0);
  });

  it("should ingest multi-turn session and query sessions", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests/fixtures/multi-turn-session.jsonl");
    const { sessions } = await ingestFixture(executor, fixturePath);
    expect(sessions).toBe(1);

    const sessionAnalyzer = new SessionAnalyzer(executor);
    const stats = await sessionAnalyzer.getSessionStats(testRange);
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalTurns).toBeGreaterThan(0);
  });

  it("should deduplicate streaming entries", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests/fixtures/streaming-duplicates.jsonl");
    const { turns } = await ingestFixture(executor, fixturePath);
    // 1 user + 1 deduplicated assistant = 2 turns
    expect(turns).toBe(2);
  });

  it("should handle cache-heavy session and compute cache metrics", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests/fixtures/cache-heavy-session.jsonl");
    await ingestFixture(executor, fixturePath);

    const cacheAnalyzer = new CacheAnalyzer(executor);
    const metrics = await cacheAnalyzer.getCacheHitRate(testRange);
    // This fixture has high cache_read values
    expect(metrics.cacheReadTokens).toBeGreaterThan(0);
    expect(metrics.cacheHitRate).toBeGreaterThan(0);
  });

  it("should handle corrupt lines gracefully", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests/fixtures/corrupt-lines.jsonl");
    // Corrupt lines should be skipped; valid lines should be ingested
    const { sessions, turns } = await ingestFixture(executor, fixturePath);
    expect(sessions).toBe(1); // Only one valid session
    expect(turns).toBeGreaterThan(0);
  });
});
