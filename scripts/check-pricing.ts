/**
 * @module scripts/check-pricing
 *
 * Lists the models in the analytics database that have no entry in
 * `src/utils/pricing.ts` and are therefore costed at the Sonnet fallback
 * rates. After adding them, run `npm run backfill:costs`.
 *
 * SAFETY: SELECT statements only. It opens the database read-write like every
 * other script (so DuckDB can replay a WAL), which needs exclusive access:
 * stop the `com.ccanalytics.web` LaunchAgent first, or point it at a copy of
 * the .duckdb and .wal files. The running dashboard shows the same list via
 * /api/health.
 *
 * USAGE:
 *   npm run check:pricing [-- /path/to/analytics.duckdb]
 *   Env: DB_PATH overrides the default ~/.ccanalytics/analytics.duckdb.
 *
 * Exit code 0 when every model is priced, 1 otherwise.
 */

import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { MODEL_USAGE_SQL, findUnpricedModels } from "../src/db/unpriced-models.js";

/** Resolve the analytics DB path: CLI arg › DB_PATH env › default. */
function resolveDbPath(): string {
  const arg = process.argv[2];
  if (arg && arg.trim().length > 0) return path.resolve(arg.trim());
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  return path.join(os.homedir(), ".ccanalytics", "analytics.duckdb");
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  console.log(`[check-pricing] database: ${dbPath}`);

  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  try {
    const usage = (await conn.runAndReadAll(MODEL_USAGE_SQL)).getRowObjectsJS();
    const unpriced = findUnpricedModels(usage);
    console.log(`[check-pricing] ${usage.length} model(s) in use`);
    if (unpriced.length === 0) {
      console.log("[check-pricing] every model has a pricing entry");
      return;
    }
    for (const u of unpriced) {
      console.log(
        `[check-pricing] FAIL ${u.model}: ${u.turns} turns, ${u.subAgents} sub-agents at fallback rates`,
      );
    }
    console.log(
      "[check-pricing] add them to PRICING in src/utils/pricing.ts, then run `npm run backfill:costs`",
    );
    process.exitCode = 1;
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

main().catch((err) => {
  console.error(`[check-pricing] failed: ${(err as Error).stack ?? err}`);
  process.exitCode = 1;
});
