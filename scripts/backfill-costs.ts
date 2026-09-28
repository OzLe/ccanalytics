/**
 * @module scripts/backfill-costs
 *
 * COST-002 — Idempotent cost backfill migration.
 *
 * Recomputes the STORED cost columns in place from token counts × the current
 * per-model rates defined in `src/utils/pricing.ts` (the single shared rate
 * source). This corrects historical rows WITHOUT re-parsing any JSONL — the
 * sanctioned way to fix stored costs after a rate-table change.
 *
 *   1. UPDATE conversation_turns.cost_usd  = tokens × corrected per-model rate
 *   2. UPDATE sessions.total_cost_usd      = SUM(cost_usd) of its turns
 *      (this also reconciles COST-004's session-aggregate divergence)
 *   3. UPDATE sub_agents.cost_usd          = tokens × corrected per-model rate,
 *      for the models whose rates changed (mixed-model agents keep their
 *      per-turn cost otherwise; see src/db/cost-backfill.ts)
 *
 * The statements live in `src/db/cost-backfill.ts`, where they are tested.
 *
 * WHY a backfill is needed: `cost_usd` is computed at INGEST time by
 * `calculateCost()` and stored. Fixing `pricing.ts` / the SQL `CASE` does NOT
 * retroactively correct already-ingested rows; the daily/trend read paths sum
 * the stored column and would keep serving the old (wrong) total.
 *
 * IDEMPOTENT: the script computes `cost_usd` purely from the (immutable) token
 * columns × the current rates, so re-running it produces the exact same
 * result. Safe to re-run after any future rate change.
 *
 * SAFETY: this script ONLY issues `UPDATE` statements against the
 * `cost_usd` / `total_cost_usd` columns of existing rows. It NEVER drops,
 * deletes, truncates, or alters schema. Row counts cannot change. It refuses
 * to run if the row counts would differ before/after.
 *
 * USAGE:
 *   # via npm (recommended — wires the right tsx + DB path):
 *   npm run backfill:costs
 *
 *   # or directly, with an explicit DB path:
 *   <tsx> scripts/backfill-costs.ts [/path/to/analytics.duckdb]
 *
 *   Env: DB_PATH overrides the default ~/.ccanalytics/analytics.duckdb.
 *
 * IMPORTANT: take a fresh backup of the .duckdb (and .wal if present) BEFORE
 * running, and stop the `com.ccanalytics.web` LaunchAgent, which holds the
 * database lock.
 */

import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  sessionCostUpdateSql,
  subAgentCostUpdateSql,
  turnCostUpdateSql,
} from "../src/db/cost-backfill.js";

type Conn = Awaited<ReturnType<InstanceType<typeof DuckDBInstance>["connect"]>>;

/** Resolve the analytics DB path: CLI arg › DB_PATH env › default. */
function resolveDbPath(): string {
  const arg = process.argv[2];
  if (arg && arg.trim().length > 0) return path.resolve(arg.trim());
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  return path.join(os.homedir(), ".ccanalytics", "analytics.duckdb");
}

/** Run a query and return the row objects. */
async function rows(conn: Conn, sql: string): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS() as Record<string, unknown>[];
}

/** Read a single numeric scalar (handles DuckDB BigInt). */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/** Row counts and cost totals, captured before and after the updates. */
async function totals(conn: Conn): Promise<Record<string, number>> {
  const [r] = await rows(
    conn,
    `SELECT
       (SELECT COUNT(*) FROM conversation_turns)                   AS turns,
       (SELECT COUNT(*) FROM sessions)                             AS sessions,
       (SELECT COUNT(*) FROM tool_calls)                           AS tools,
       (SELECT COUNT(*) FROM sub_agents)                           AS sub_agents,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM conversation_turns) AS turns_cost,
       (SELECT COALESCE(SUM(total_cost_usd), 0) FROM sessions)     AS sessions_cost,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM sub_agents)         AS sub_agents_cost`,
  );
  return Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, num(v)]));
}

/** Cost per model in one table, for the before/after report. */
async function costByModel(
  conn: Conn,
  table: "conversation_turns" | "sub_agents",
): Promise<Map<string, { count: number; cost: number }>> {
  const where = table === "conversation_turns" ? "WHERE role = 'assistant'" : "";
  const result = await rows(
    conn,
    `SELECT model, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost
     FROM ${table} ${where}
     GROUP BY model ORDER BY cost DESC`,
  );
  return new Map(
    result.map((r) => [String(r.model), { count: num(r.n), cost: num(r.cost) }]),
  );
}

function reportByModel(
  label: string,
  unit: string,
  before: Map<string, { count: number; cost: number }>,
  after: Map<string, { count: number; cost: number }>,
): void {
  console.log(`[backfill-costs] per-model cost_usd (${label}):`);
  for (const [model, { count, cost }] of after) {
    const was = before.get(model)?.cost ?? 0;
    const delta = cost - was;
    const sign = delta > 0 ? "+" : "";
    console.log(
      `[backfill-costs]   ${model.padEnd(28)} ` +
        `${String(count).padStart(7)} ${unit}  ` +
        `$${was.toFixed(2).padStart(11)} -> $${cost.toFixed(2).padStart(11)}  ` +
        `(${sign}${delta.toFixed(2)})`,
    );
  }
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  console.log(`[backfill-costs] COST-002 idempotent cost backfill`);
  console.log(`[backfill-costs] database: ${dbPath}`);

  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();

  try {
    // 0. Pre-flight: row counts + cost totals, to prove the backfill left row
    //    counts unchanged and to report before/after.
    const pre = await totals(conn);
    console.log(
      `[backfill-costs] BEFORE: ${pre.turns} turns, ${pre.sessions} sessions, ` +
        `${pre.tools} tool_calls, ${pre.sub_agents} sub_agents`,
    );
    console.log(`[backfill-costs] BEFORE: SUM(conversation_turns.cost_usd) = $${pre.turns_cost.toFixed(2)}`);
    console.log(`[backfill-costs] BEFORE: SUM(sessions.total_cost_usd)     = $${pre.sessions_cost.toFixed(2)}`);
    console.log(`[backfill-costs] BEFORE: SUM(sub_agents.cost_usd)         = $${pre.sub_agents_cost.toFixed(2)}`);
    const turnsBefore = await costByModel(conn, "conversation_turns");
    const agentsBefore = await costByModel(conn, "sub_agents");

    // 1-3. The updates (src/db/cost-backfill.ts).
    console.log(`[backfill-costs] step 1/3: recomputing conversation_turns.cost_usd...`);
    await conn.run(turnCostUpdateSql());
    console.log(`[backfill-costs] step 2/3: recomputing sessions.total_cost_usd = SUM(conversation_turns.cost_usd)...`);
    await conn.run(sessionCostUpdateSql());
    console.log(`[backfill-costs] step 3/3: recomputing sub_agents.cost_usd for models whose rates changed...`);
    await conn.run(subAgentCostUpdateSql());

    // 4. Post-flight: re-read counts + totals, assert row counts unchanged.
    const post = await totals(conn);
    for (const key of ["turns", "sessions", "tools", "sub_agents"]) {
      if (post[key] !== pre[key]) {
        throw new Error(
          `[backfill-costs] ABORT: ${key} row count changed ${pre[key]} -> ${post[key]}. ` +
            `The backfill must be additive; restore from backup.`,
        );
      }
    }

    // Reconciliation: sessions.total_cost_usd must now equal SUM(turns).
    const [recon] = await rows(
      conn,
      `WITH turn_sums AS (
         SELECT session_id, SUM(cost_usd) AS turn_cost
         FROM conversation_turns GROUP BY session_id
       )
       SELECT
         COUNT(*) FILTER (
           WHERE ABS(s.total_cost_usd - COALESCE(ts.turn_cost, 0)) > 0.000001
         ) AS divergent_sessions,
         COALESCE(SUM(ABS(s.total_cost_usd - COALESCE(ts.turn_cost, 0))), 0) AS abs_diff
       FROM sessions s
       LEFT JOIN turn_sums ts ON ts.session_id = s.session_id`,
    );
    const turnsAfter = await costByModel(conn, "conversation_turns");
    const agentsAfter = await costByModel(conn, "sub_agents");

    // 5. Report.
    console.log("");
    console.log(`[backfill-costs] ====== RESULT ======`);
    console.log(
      `[backfill-costs] row counts unchanged: turns=${post.turns}, sessions=${post.sessions}, ` +
        `tool_calls=${post.tools}, sub_agents=${post.sub_agents}  (additive ✓)`,
    );
    console.log(`[backfill-costs] SUM(conversation_turns.cost_usd): $${pre.turns_cost.toFixed(2)} -> $${post.turns_cost.toFixed(2)}`);
    console.log(`[backfill-costs] SUM(sessions.total_cost_usd):     $${pre.sessions_cost.toFixed(2)} -> $${post.sessions_cost.toFixed(2)}`);
    console.log(`[backfill-costs] SUM(sub_agents.cost_usd):         $${pre.sub_agents_cost.toFixed(2)} -> $${post.sub_agents_cost.toFixed(2)}`);
    console.log(
      `[backfill-costs] session/turn reconciliation: ${num(recon?.divergent_sessions)} divergent ` +
        `session(s), $${num(recon?.abs_diff).toFixed(4)} abs diff  (COST-004)`,
    );
    reportByModel("assistant turns", "turns", turnsBefore, turnsAfter);
    reportByModel("sub-agents", "agents", agentsBefore, agentsAfter);
    console.log(`[backfill-costs] ====================`);
    console.log(`[backfill-costs] done.`);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

main().catch((err) => {
  console.error(
    `[backfill-costs] FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
