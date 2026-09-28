/**
 * @module tests/db/cache-ttl-backfill
 *
 * `npm run backfill:cache-ttl`: reading the recorded cache-write split from
 * transcripts, and filling only rows that are unrecorded and whose stored
 * total matches the transcript.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestDB, closeTestDB, type TestDB } from "../helpers/db-setup.js";
import {
  applyCacheSplits,
  readAgentSplit,
  readTurnSplits,
} from "../../src/db/cache-ttl-backfill.js";

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/cache-ttl-session.jsonl");

function assistant(requestId: string | null, total: number, oneHour: number | null): string {
  const usage: Record<string, unknown> = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: total,
    cache_read_input_tokens: 0,
  };
  if (oneHour !== null) {
    usage.cache_creation = { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: total - oneHour };
  }
  return JSON.stringify({
    type: "assistant",
    ...(requestId ? { requestId } : {}),
    message: { role: "assistant", model: "claude-opus-5-5", content: [], usage },
  });
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-ttl-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("readTurnSplits", () => {
  it("returns the recorded split per request and skips unrecorded ones", async () => {
    expect(await readTurnSplits(FIXTURE)).toEqual([{ key: "req_ttl_001", total: 40_000, oneHour: 30_000 }]);
  });

  it("keeps the last entry of a request, like ingest, and skips malformed lines", async () => {
    const file = writeTranscript("main.jsonl", [
      assistant("req_a", 100, 10),
      "{not json",
      assistant("req_a", 100, 20),
    ]);
    expect(await readTurnSplits(file)).toEqual([{ key: "req_a", total: 100, oneHour: 20 }]);
  });
});

describe("readAgentSplit", () => {
  it("sums a sub-agent transcript whose every message records the split", async () => {
    const file = writeTranscript("agent-x.jsonl", [
      assistant("req_1", 100, 0),
      assistant("req_1", 100, 0),
      assistant("req_2", 50, 0),
      assistant(null, 25, 5),
    ]);
    expect(await readAgentSplit(file)).toEqual({ key: file, total: 175, oneHour: 5 });
  });

  it("gives up when any message lacks the split", async () => {
    const file = writeTranscript("agent-y.jsonl", [assistant("req_1", 100, 0), assistant("req_2", 50, null)]);
    expect(await readAgentSplit(file)).toBeNull();
  });
});

describe("applyCacheSplits", () => {
  let db: TestDB;

  beforeEach(async () => {
    db = await createTestDB();
    await db.connection.run(
      `INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, request_id,
         cache_creation_tokens, cache_creation_1h_tokens) VALUES
         ('t1', 's1', 'assistant', '2026-09-20 10:00:00', 'req_fill', 1000, NULL),
         ('t2', 's1', 'assistant', '2026-09-20 10:00:00', 'req_changed', 999, NULL),
         ('t3', 's1', 'assistant', '2026-09-20 10:00:00', 'req_known', 1000, 5),
         ('t4', 's1', 'assistant', '2026-09-20 10:00:00', 'req_gone', 1000, NULL)`,
    );
    await db.connection.run(
      `INSERT INTO sub_agents (parent_session_id, agent_id, source_file, cache_creation_tokens) VALUES
         ('s1', 'a1', '/p/agent-a1.jsonl', 500), ('s1', 'a2', '/p/it''s agent-a2.jsonl', 400)`,
    );
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  async function oneHour(table: string, where: string): Promise<number | null> {
    const reader = await db.connection.runAndReadAll(
      `SELECT cache_creation_1h_tokens AS h FROM ${table} WHERE ${where}`,
    );
    const h = (reader.getRowObjectsJS()[0] as { h: bigint | null }).h;
    return h === null ? null : Number(h);
  }

  it("fills unrecorded rows whose total matches, and counts the rest", async () => {
    const result = await applyCacheSplits(
      db.connection,
      [
        { key: "req_fill", total: 1000, oneHour: 800 },
        { key: "req_changed", total: 1000, oneHour: 800 },
        { key: "req_known", total: 1000, oneHour: 800 },
      ],
      [
        { key: "/p/agent-a1.jsonl", total: 500, oneHour: 0 },
        { key: "/p/it's agent-a2.jsonl", total: 401, oneHour: 0 },
      ],
    );

    expect(result).toEqual({ turnsFilled: 1, turnsMismatched: 1, agentsFilled: 1, agentsMismatched: 1 });
    expect(await oneHour("conversation_turns", "turn_id = 't1'")).toBe(800);
    expect(await oneHour("conversation_turns", "turn_id = 't2'")).toBeNull();
    expect(await oneHour("conversation_turns", "turn_id = 't3'")).toBe(5);
    expect(await oneHour("conversation_turns", "turn_id = 't4'")).toBeNull();
    expect(await oneHour("sub_agents", "agent_id = 'a1'")).toBe(0);
    expect(await oneHour("sub_agents", "agent_id = 'a2'")).toBeNull();
  });

  it("does nothing with no splits", async () => {
    expect(await applyCacheSplits(db.connection, [], [])).toEqual({
      turnsFilled: 0,
      turnsMismatched: 0,
      agentsFilled: 0,
      agentsMismatched: 0,
    });
  });
});
