/**
 * @module scripts/backfill-costs
 *
 * COST-002 — Idempotent cost backfill migration.
 *
 * Recomputes the STORED cost columns in place from token counts × the current
 * per-model rates defined in `src/utils/pricing.ts` (the single shared rate
 * source). This corrects historical rows WITHOUT re-parsing any JSONL — the
 * sanctioned way to fix stored `cost_usd` after a rate-table change.
 *
 *   1. UPDATE conversation_turns.cost_usd  = tokens × corrected per-model rate
 *   2. UPDATE sessions.total_cost_usd      = SUM(cost_usd) of its turns
 *      (this also reconciles COST-004's session-aggregate divergence)
 *
 * WHY a backfill is needed: `conversation_turns.cost_usd` is computed at
 * INGEST time by `calculateCost()` and stored. Fixing `pricing.ts` / the SQL
 * `CASE` does NOT retroactively correct already-ingested rows; the daily/trend
 * read paths sum the stored column and would keep serving the old (wrong)
 * total. See `.a5c/.../audit-plan.md` §1a.
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
 * running. The COST-002 task did this; future runs should too.
 */

import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildRateCaseSql } from "../src/utils/pricing.js";

/** Resolve the analytics DB path: CLI arg › DB_PATH env › default. */
function resolveDbPath(): string {
  const arg = process.argv[2];
  if (arg && arg.trim().length > 0) return path.resolve(arg.trim());
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  return path.join(os.homedir(), ".ccanalytics", "analytics.duckdb");
}

/** Run a query and return the row objects. */
async function rows(
  conn: Awaited<ReturnType<InstanceType<typeof DuckDBInstance>["connect"]>>,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS() as Record<string, unknown>[];
}

/** Read a single numeric scalar (handles DuckDB BigInt). */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  console.log(`[backfill-costs] COST-002 idempotent cost backfill`);
  console.log(`[backfill-costs] database: ${dbPath}`);

  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();

  try {
    // -----------------------------------------------------------------------
    // 0. Pre-flight: capture row counts + cost totals so we can prove the
    //    migration was additive (row counts unchanged) and report before/after.
    // -----------------------------------------------------------------------
    const [pre] = await rows(
      conn,
      `SELECT
         (SELECT COUNT(*) FROM conversation_turns)            AS turns,
         (SELECT COUNT(*) FROM sessions)                      AS sessions,
         (SELECT COUNT(*) FROM tool_calls)                    AS tools,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM conversation_turns)       AS turns_cost,
         (SELECT COALESCE(SUM(total_cost_usd), 0) FROM sessions)           AS sessions_cost`,
    );
    const preTurns = num(pre.turns);
    const preSessions = num(pre.sessions);
    const preTools = num(pre.tools);
    const preTurnsCost = num(pre.turns_cost);
    const preSessionsCost = num(pre.sessions_cost);

    console.log(
      `[backfill-costs] BEFORE: ${preTurns} turns, ${preSessions} sessions, ` +
        `${preTools} tool_calls`,
    );
    console.log(
      `[backfill-costs] BEFORE: SUM(conversation_turns.cost_usd) = $${preTurnsCost.toFixed(2)}`,
    );
    console.log(
      `[backfill-costs] BEFORE: SUM(sessions.total_cost_usd)     = $${preSessionsCost.toFixed(2)}`,
    );

    // Per-model breakdown before (for the verification report).
    const beforeByModel = await rows(
      conn,
      `SELECT model, COUNT(*) AS turns, COALESCE(SUM(cost_usd), 0) AS cost
       FROM conversation_turns
       WHERE role = 'assistant'
       GROUP BY model ORDER BY cost DESC`,
    );

    // -----------------------------------------------------------------------
    // 1. Recompute conversation_turns.cost_usd in place from
    //    tokens × the corrected per-model rates. The four CASE expressions are
    //    GENERATED from the shared PRICING table in src/utils/pricing.ts, so
    //    this can never drift from ingest-time calculateCost().
    // -----------------------------------------------------------------------
    const inputCase = buildRateCaseSql("inputPerM");
    const outputCase = buildRateCaseSql("outputPerM");
    const cacheCreationCase = buildRateCaseSql("cacheCreationPerM");
    const cacheReadCase = buildRateCaseSql("cacheReadPerM");

    const turnsUpdateSql = `
      UPDATE conversation_turns
      SET cost_usd =
            input_tokens          * (${inputCase})         / 1000000.0
          + output_tokens         * (${outputCase})        / 1000000.0
          + cache_creation_tokens * (${cacheCreationCase}) / 1000000.0
          + cache_read_tokens     * (${cacheReadCase})     / 1000000.0
    `;
    console.log(
      `[backfill-costs] step 1/2: recomputing conversation_turns.cost_usd ` +
        `(tokens × corrected per-model rates)...`,
    );
    await conn.run(turnsUpdateSql);

    // -----------------------------------------------------------------------
    // 2. Recompute sessions.total_cost_usd as the SUM of its turns' cost_usd.
    //    This also resolves COST-004 (session aggregate stale vs child rows):
    //    sessions with no turns get 0.0. Correlated UPDATE — no row add/remove.
    // -----------------------------------------------------------------------
    const sessionsUpdateSql = `
      UPDATE sessions AS s
      SET total_cost_usd = COALESCE(
        (SELECT SUM(ct.cost_usd) FROM conversation_turns ct
         WHERE ct.session_id = s.session_id),
        0.0
      )
    `;
    console.log(
      `[backfill-costs] step 2/2: recomputing sessions.total_cost_usd ` +
        `= SUM(conversation_turns.cost_usd)...`,
    );
    await conn.run(sessionsUpdateSql);

    // -----------------------------------------------------------------------
    // 3. Post-flight: re-read counts + totals, assert row counts unchanged.
    // -----------------------------------------------------------------------
    const [post] = await rows(
      conn,
      `SELECT
         (SELECT COUNT(*) FROM conversation_turns)            AS turns,
         (SELECT COUNT(*) FROM sessions)                      AS sessions,
         (SELECT COUNT(*) FROM tool_calls)                    AS tools,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM conversation_turns)       AS turns_cost,
         (SELECT COALESCE(SUM(total_cost_usd), 0) FROM sessions)           AS sessions_cost`,
    );
    const postTurns = num(post.turns);
    const postSessions = num(post.sessions);
    const postTools = num(post.tools);
    const postTurnsCost = num(post.turns_cost);
    const postSessionsCost = num(post.sessions_cost);

    if (
      postTurns !== preTurns ||
      postSessions !== preSessions ||
      postTools !== preTools
    ) {
      throw new Error(
        `[backfill-costs] ABORT: row counts changed — turns ${preTurns}->${postTurns}, ` +
          `sessions ${preSessions}->${postSessions}, tools ${preTools}->${postTools}. ` +
          `The backfill must be additive; restore from backup.`,
      );
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
    const divergent = num(recon.divergent_sessions);
    const absDiff = num(recon.abs_diff);

    const afterByModel = await rows(
      conn,
      `SELECT model, COUNT(*) AS turns, COALESCE(SUM(cost_usd), 0) AS cost
       FROM conversation_turns
       WHERE role = 'assistant'
       GROUP BY model ORDER BY cost DESC`,
    );

    // -----------------------------------------------------------------------
    // 4. Report.
    // -----------------------------------------------------------------------
    console.log("");
    console.log(`[backfill-costs] ====== RESULT ======`);
    console.log(
      `[backfill-costs] row counts unchanged: turns=${postTurns}, ` +
        `sessions=${postSessions}, tool_calls=${postTools}  (additive ✓)`,
    );
    console.log(
      `[backfill-costs] SUM(conversation_turns.cost_usd): ` +
        `$${preTurnsCost.toFixed(2)} -> $${postTurnsCost.toFixed(2)}`,
    );
    console.log(
      `[backfill-costs] SUM(sessions.total_cost_usd):     ` +
        `$${preSessionsCost.toFixed(2)} -> $${postSessionsCost.toFixed(2)}`,
    );
    console.log(
      `[backfill-costs] session/turn reconciliation: ${divergent} divergent ` +
        `session(s), $${absDiff.toFixed(4)} abs diff  (COST-004)`,
    );

    const beforeMap = new Map(
      beforeByModel.map((r) => [String(r.model), num(r.cost)]),
    );
    console.log(`[backfill-costs] per-model cost_usd (assistant turns):`);
    for (const r of afterByModel) {
      const model = String(r.model);
      const before = beforeMap.get(model) ?? 0;
      const after = num(r.cost);
      const delta = after - before;
      const sign = delta > 0 ? "+" : "";
      console.log(
        `[backfill-costs]   ${model.padEnd(28)} ` +
          `${String(num(r.turns)).padStart(7)} turns  ` +
          `$${before.toFixed(2).padStart(11)} -> $${after.toFixed(2).padStart(11)}  ` +
          `(${sign}${delta.toFixed(2)})`,
      );
    }
    console.log(`[backfill-costs] ====================`);
    console.log(`[backfill-costs] done.`);
  } finally {
    conn.closeSync();
  }
}

main().catch((err) => {
  console.error(
    `[backfill-costs] FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
