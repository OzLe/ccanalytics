/**
 * @module scripts/backfill-cache-ttl
 *
 * Fills `cache_creation_1h_tokens` (migration 8) from the transcripts on disk
 * for rows ingested before the column existed; see
 * `src/db/cache-ttl-backfill.ts`. Run `npm run backfill:costs` afterwards so
 * the stored costs use the recorded split.
 *
 * SAFETY: only fills `cache_creation_1h_tokens` where it is NULL and the
 * transcript's cache-write total equals the stored one; it applies pending
 * schema migrations first, as the dashboard does at start. It opens the
 * database read-write: stop the `com.ccanalytics.web` LaunchAgent and take a
 * backup first.
 *
 * USAGE:
 *   npm run backfill:cache-ttl [-- /path/to/analytics.duckdb]
 *   Env: DB_PATH overrides the default ~/.ccanalytics/analytics.duckdb;
 *        CLAUDE_DIR overrides the default ~/.claude.
 */

import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  applyCacheSplits,
  readAgentSplit,
  readTurnSplits,
  type CacheSplit,
} from "../src/db/cache-ttl-backfill.js";
import { SchemaManager } from "../src/db/schema.js";

/** Resolve the analytics DB path: CLI arg › DB_PATH env › default. */
function resolveDbPath(): string {
  const arg = process.argv[2];
  if (arg && arg.trim().length > 0) return path.resolve(arg.trim());
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  return path.join(os.homedir(), ".ccanalytics", "analytics.duckdb");
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const projectsDir = path.join(process.env.CLAUDE_DIR ?? path.join(os.homedir(), ".claude"), "projects");
  console.log(`[backfill-cache-ttl] database:    ${dbPath}`);
  console.log(`[backfill-cache-ttl] transcripts: ${projectsDir}`);

  const files = (await readdir(projectsDir, { recursive: true }))
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(projectsDir, name));
  const turns: CacheSplit[] = [];
  const agents: CacheSplit[] = [];
  for (const file of files) {
    if (file.split(path.sep).includes("subagents")) {
      const split = await readAgentSplit(file);
      if (split) agents.push(split);
    } else {
      turns.push(...(await readTurnSplits(file)));
    }
  }
  console.log(
    `[backfill-cache-ttl] ${files.length} transcripts: ${turns.length} requests and ` +
      `${agents.length} sub-agents with a recorded split`,
  );

  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  try {
    const applied = await new SchemaManager().migrate(conn);
    if (applied > 0) console.log(`[backfill-cache-ttl] applied ${applied} schema migration(s)`);

    const result = await applyCacheSplits(conn, turns, agents);
    const [left] = (
      await conn.runAndReadAll(
        `SELECT
           (SELECT COUNT(*) FROM conversation_turns
            WHERE role = 'assistant' AND cache_creation_tokens > 0 AND cache_creation_1h_tokens IS NULL) AS turns,
           (SELECT COUNT(*) FROM sub_agents
            WHERE cache_creation_tokens > 0 AND cache_creation_1h_tokens IS NULL) AS agents`,
      )
    ).getRowObjectsJS() as { turns: bigint; agents: bigint }[];

    console.log(
      `[backfill-cache-ttl] turns filled: ${result.turnsFilled} ` +
        `(${result.turnsMismatched} skipped: transcript total differs)`,
    );
    console.log(
      `[backfill-cache-ttl] sub-agents filled: ${result.agentsFilled} ` +
        `(${result.agentsMismatched} skipped: transcript total differs)`,
    );
    console.log(
      `[backfill-cache-ttl] still unrecorded (transcript gone): ${Number(left?.turns ?? 0)} turns ` +
        `priced as 1-hour writes, ${Number(left?.agents ?? 0)} sub-agents as 5-minute writes`,
    );
    console.log("[backfill-cache-ttl] next: npm run backfill:costs");
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

main().catch((err) => {
  console.error(`[backfill-cache-ttl] FAILED: ${(err as Error).stack ?? err}`);
  process.exitCode = 1;
});
