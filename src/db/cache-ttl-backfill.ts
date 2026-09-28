/**
 * @module db/cache-ttl-backfill
 *
 * Fills `cache_creation_1h_tokens` (migration 8) for rows ingested before the
 * column existed, from the transcripts still on disk: `npm run
 * backfill:cache-ttl`. Claude Code keeps 30 days of transcripts, so older rows
 * stay NULL and are priced by `UnrecordedCacheTtl` (utils/pricing). A row is
 * only filled when the transcript's cache-write total equals the stored one,
 * so a transcript that changed since ingest cannot corrupt a row. Run
 * `npm run backfill:costs` afterwards to reprice.
 */

import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DuckDBConnection } from "@duckdb/node-api";

/** Cache writes of one API request, or of one sub-agent transcript. */
export interface CacheSplit {
  /** `requestId` for a turn, the transcript path for a sub-agent. */
  key: string;
  total: number;
  oneHour: number;
}

interface MessageSplit {
  total: number;
  /** Null when this entry does not record the split. */
  oneHour: number | null;
}

/**
 * The cache-write split of every assistant message in a transcript,
 * deduplicated like ingest does: the last entry per `requestId` wins, and
 * entries without one are kept.
 */
async function readMessageSplits(
  file: string,
): Promise<{ byRequest: Map<string, MessageSplit>; unkeyed: MessageSplit[] }> {
  const byRequest = new Map<string, MessageSplit>();
  const unkeyed: MessageSplit[] = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"assistant"')) continue;
    let entry: {
      type?: string;
      requestId?: string;
      message?: { usage?: UsageShape };
      usage?: UsageShape;
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // ingest skips malformed lines too
    }
    if (entry.type !== "assistant") continue;
    const usage = entry.message?.usage ?? entry.usage;
    if (!usage) continue;
    const split: MessageSplit = {
      total: usage.cache_creation_input_tokens ?? 0,
      oneHour: usage.cache_creation ? (usage.cache_creation.ephemeral_1h_input_tokens ?? 0) : null,
    };
    if (entry.requestId) byRequest.set(entry.requestId, split);
    else unkeyed.push(split);
  }
  return { byRequest, unkeyed };
}

interface UsageShape {
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
}

/** Recorded splits of a main-conversation transcript, one per request. */
export async function readTurnSplits(file: string): Promise<CacheSplit[]> {
  const { byRequest } = await readMessageSplits(file);
  const splits: CacheSplit[] = [];
  for (const [requestId, s] of byRequest) {
    if (s.oneHour !== null) splits.push({ key: requestId, total: s.total, oneHour: s.oneHour });
  }
  return splits;
}

/**
 * A sub-agent transcript's summed split, or null unless every message records
 * it (a partial sum would misprice the rest).
 */
export async function readAgentSplit(file: string): Promise<CacheSplit | null> {
  const { byRequest, unkeyed } = await readMessageSplits(file);
  let total = 0;
  let oneHour = 0;
  for (const s of [...byRequest.values(), ...unkeyed]) {
    if (s.oneHour === null) return null;
    total += s.total;
    oneHour += s.oneHour;
  }
  return { key: file, total, oneHour };
}

/** Rows filled, and rows whose transcript total no longer matched. */
export interface ApplyResult {
  turnsFilled: number;
  turnsMismatched: number;
  agentsFilled: number;
  agentsMismatched: number;
}

/**
 * Write the splits into rows whose `cache_creation_1h_tokens` is still NULL
 * and whose stored cache-write total matches the transcript's.
 */
export async function applyCacheSplits(
  conn: DuckDBConnection,
  turns: CacheSplit[],
  agents: CacheSplit[],
): Promise<ApplyResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccanalytics-ttl-"));
  try {
    await loadSplits(conn, dir, "ttl_turn_splits", turns);
    await loadSplits(conn, dir, "ttl_agent_splits", agents);
    const turnsFilled = (
      await conn.run(
        `UPDATE conversation_turns AS ct
         SET cache_creation_1h_tokens = s.one_hour
         FROM ttl_turn_splits AS s
         WHERE ct.request_id = s.key
           AND ct.cache_creation_1h_tokens IS NULL
           AND ct.cache_creation_tokens = s.total`,
      )
    ).rowsChanged;
    const agentsFilled = (
      await conn.run(
        `UPDATE sub_agents AS sa
         SET cache_creation_1h_tokens = s.one_hour
         FROM ttl_agent_splits AS s
         WHERE sa.source_file = s.key
           AND sa.cache_creation_1h_tokens IS NULL
           AND sa.cache_creation_tokens = s.total`,
      )
    ).rowsChanged;
    const [mismatch] = (
      await conn.runAndReadAll(
        `SELECT
           (SELECT COUNT(*) FROM conversation_turns ct JOIN ttl_turn_splits s ON ct.request_id = s.key
            WHERE ct.cache_creation_1h_tokens IS NULL AND ct.cache_creation_tokens <> s.total) AS turns,
           (SELECT COUNT(*) FROM sub_agents sa JOIN ttl_agent_splits s ON sa.source_file = s.key
            WHERE sa.cache_creation_1h_tokens IS NULL AND sa.cache_creation_tokens <> s.total) AS agents`,
      )
    ).getRowObjectsJS() as { turns: bigint; agents: bigint }[];
    return {
      turnsFilled,
      turnsMismatched: Number(mismatch?.turns ?? 0),
      agentsFilled,
      agentsMismatched: Number(mismatch?.agents ?? 0),
    };
  } finally {
    await conn.run("DROP TABLE IF EXISTS ttl_turn_splits");
    await conn.run("DROP TABLE IF EXISTS ttl_agent_splits");
    await rm(dir, { recursive: true, force: true });
  }
}

/** Load splits into a temporary table through a CSV file. */
async function loadSplits(
  conn: DuckDBConnection,
  dir: string,
  table: string,
  splits: CacheSplit[],
): Promise<void> {
  const csv = path.join(dir, `${table}.csv`);
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  await writeFile(
    csv,
    ["key,total,one_hour", ...splits.map((s) => `${quote(s.key)},${s.total},${s.oneHour}`)].join("\n") + "\n",
  );
  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${table} AS
     SELECT * FROM read_csv('${csv.replace(/'/g, "''")}', header = true, quote = '"', escape = '"',
       columns = {'key': 'VARCHAR', 'total': 'BIGINT', 'one_hour': 'BIGINT'})`,
  );
}
