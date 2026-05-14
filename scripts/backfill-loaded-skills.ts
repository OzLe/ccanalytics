/**
 * @module scripts/backfill-loaded-skills
 *
 * F2D — Optional, idempotent, ADDITIVE one-time backfill for the Skill
 * Analysis data layer (migration 5). Mirrors scripts/backfill-costs.ts.
 *
 * WHY this exists: ccanalytics ingests incrementally by byte offset. The
 * `skill_listing` attachment that lists a session's loaded skills sits near
 * the *head* of the JSONL file — almost always before the saved offset of an
 * already-ingested session. So after migration 5, the ~965 sessions that were
 * already at EOF have NO `session_skills` rows and NULL
 * `tool_calls.skill_name`/`skill_caller_type`, and incremental ingestion will
 * never re-read that head. This script back-populates them by re-streaming
 * each `sessions.source_file` once.
 *
 * WHAT it does, per distinct `sessions.source_file`:
 *   1. Streams the WHOLE file once and collects:
 *        - every `type:"attachment"` record with `attachment.type ==
 *          "skill_listing"` -> parsed via parseSkillListing()
 *        - every `Skill` tool_use block -> its `id`, `input.skill`, and
 *          `caller.type` (the caller is dropped at ingest, so it can only be
 *          recovered from the file)
 *   2. INSERT ... ON CONFLICT(session_skill_id) DO NOTHING into session_skills
 *      (deterministic PK per D4 -> re-runs insert 0 new rows)
 *   3. UPDATE tool_calls SET skill_name / skill_caller_type for `Skill` rows
 *      WHERE skill_name IS NULL — i.e. fills NULLs only, never overwrites a
 *      value a re-ingest already populated.
 *
 * SAFETY — this script is strictly ADDITIVE:
 *   - INSERT new session_skills rows (ON CONFLICT DO NOTHING).
 *   - UPDATE only the two new tool_calls columns, and only WHERE they are
 *     still NULL — pre-existing non-NULL values and every other column are
 *     untouched. Row counts cannot change; it asserts they did not.
 *   - It NEVER touches `ingestion_state`, never resets, never re-ingests, and
 *     issues NO DROP/DELETE/TRUNCATE/ALTER. Safe to re-run any number of
 *     times (a second run inserts 0 rows and updates 0 rows).
 *
 * PRE-REQ: the database must already be at schema version >= 5 (open it once
 * via the normal CLI/app so migration 5 runs, or run `ccanalytics ingest`).
 * This script refuses to run against a pre-migration-5 database.
 *
 * USAGE:
 *   # via npm (recommended — wires the right tsx):
 *   npm run backfill:loaded-skills
 *
 *   # or directly, with an explicit DB path:
 *   <tsx> scripts/backfill-loaded-skills.ts [/path/to/analytics.duckdb]
 *
 *   Env: DB_PATH (or CCANALYTICS_DB_PATH) overrides the default
 *   ~/.ccanalytics/analytics.duckdb.
 *
 * IMPORTANT: take a fresh backup of the .duckdb (and .wal if present) BEFORE
 * running, and stop any process holding the DB (e.g. the `ccanalytics web`
 * LaunchAgent) so this can acquire the write lock.
 */

import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { DuckDBInstance } from "@duckdb/node-api";
import { parseSkillListing } from "../src/ingestion/skill-listing-parser.js";
import { buildSessionSkillRows } from "../src/ingestion/adapters/skill-rows.js";
import type { ParsedLoadedSkillRecord } from "../src/ingestion/adapters/types.js";

/** Resolve the analytics DB path: CLI arg › DB_PATH › CCANALYTICS_DB_PATH › default. */
function resolveDbPath(): string {
  const arg = process.argv[2];
  if (arg && arg.trim().length > 0) return path.resolve(arg.trim());
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  if (process.env.CCANALYTICS_DB_PATH)
    return path.resolve(process.env.CCANALYTICS_DB_PATH);
  return path.join(os.homedir(), ".ccanalytics", "analytics.duckdb");
}

type Conn = Awaited<ReturnType<InstanceType<typeof DuckDBInstance>["connect"]>>;

/** Run a query and return the row objects. */
async function rows(conn: Conn, sql: string): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS() as Record<string, unknown>[];
}

/** Read a single numeric scalar (handles DuckDB BigInt). */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/** Escape a string for an inline SQL literal. */
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** A recovered `Skill` tool_use invocation from a JSONL file. */
interface RecoveredSkillCall {
  toolCallId: string;
  skillName: string | null;
  callerType: string | null;
}

/** What one source file yields when re-streamed. */
interface FileScanResult {
  loadedSkills: ParsedLoadedSkillRecord[];
  skillCalls: RecoveredSkillCall[];
}

/**
 * Stream a single JSONL source file once and recover both the loaded-skill
 * attachments and the `Skill` tool_use invocations (with their `caller`).
 * Tolerant — a malformed line is skipped, a missing file yields empty.
 */
async function scanSourceFile(filePath: string): Promise<FileScanResult> {
  const loadedSkills: ParsedLoadedSkillRecord[] = [];
  const skillCalls: RecoveredSkillCall[] = [];

  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: "utf-8" });
  } catch {
    return { loadedSkills, skillCalls };
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line || line.trim() === "") continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = raw.type as string | undefined;

      // --- skill_listing attachment ---
      if (type === "attachment") {
        const att = raw.attachment as
          | { type?: string; content?: string; skillCount?: number; isInitial?: boolean }
          | undefined;
        if (att && att.type === "skill_listing") {
          const skills = parseSkillListing(att.content ?? "");
          const sessionId =
            (raw.sessionId as string) ?? (raw.session_id as string) ?? "";
          if (sessionId) {
            loadedSkills.push({
              sessionId,
              recordUuid: (raw.uuid as string) ?? null,
              timestamp:
                (raw.timestamp as string) ??
                (raw._audit_timestamp as string) ??
                new Date().toISOString(),
              skillCount: Number(att.skillCount ?? skills.length),
              isInitial: att.isInitial !== false,
              skills,
            });
          }
        }
        continue;
      }

      // --- Skill tool_use blocks (to recover skill_name + caller.type) ---
      if (type === "assistant") {
        const message = raw.message as Record<string, unknown> | undefined;
        const content = (message?.content ?? raw.content) as unknown;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (
              block &&
              block.type === "tool_use" &&
              block.name === "Skill" &&
              typeof block.id === "string"
            ) {
              const input = block.input as Record<string, unknown> | undefined;
              const caller = block.caller as { type?: string } | undefined;
              skillCalls.push({
                toolCallId: block.id,
                skillName:
                  typeof input?.skill === "string" ? input.skill : null,
                callerType:
                  typeof caller?.type === "string" ? caller.type : null,
              });
            }
          }
        }
      }
    }
  } finally {
    rl.close();
  }

  return { loadedSkills, skillCalls };
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  console.log(`[backfill-loaded-skills] F2D loaded-skills backfill (additive, idempotent)`);
  console.log(`[backfill-loaded-skills] database: ${dbPath}`);

  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();

  try {
    // -----------------------------------------------------------------------
    // 0. Pre-flight: require schema >= 5, capture row counts so we can prove
    //    the backfill was additive.
    // -----------------------------------------------------------------------
    let schemaVersion = 0;
    try {
      const [v] = await rows(
        conn,
        "SELECT MAX(version) AS version FROM schema_migrations",
      );
      schemaVersion = num(v?.version);
    } catch {
      schemaVersion = 0;
    }
    if (schemaVersion < 5) {
      throw new Error(
        `[backfill-loaded-skills] ABORT: database is at schema version ` +
          `${schemaVersion}, need >= 5. Open the DB once via the normal CLI ` +
          `(e.g. \`ccanalytics ingest\`) so migration 5 runs, then re-run this.`,
      );
    }

    const [pre] = await rows(
      conn,
      `SELECT
         (SELECT COUNT(*) FROM session_skills)                                  AS session_skills,
         (SELECT COUNT(*) FROM tool_calls)                                      AS tool_calls,
         (SELECT COUNT(*) FROM tool_calls WHERE tool_name = 'Skill')            AS skill_calls,
         (SELECT COUNT(*) FROM tool_calls WHERE tool_name = 'Skill'
            AND skill_name IS NOT NULL)                                         AS skill_calls_named`,
    );
    const preSessionSkills = num(pre.session_skills);
    const preToolCalls = num(pre.tool_calls);
    const preSkillCalls = num(pre.skill_calls);
    const preSkillCallsNamed = num(pre.skill_calls_named);

    console.log(
      `[backfill-loaded-skills] BEFORE: ${preSessionSkills} session_skills rows; ` +
        `${preSkillCallsNamed}/${preSkillCalls} Skill tool_calls have skill_name`,
    );

    // -----------------------------------------------------------------------
    // 1. Collect every distinct source_file across all sessions.
    // -----------------------------------------------------------------------
    const fileRows = await rows(
      conn,
      `SELECT DISTINCT source_file
       FROM sessions
       WHERE source_file IS NOT NULL AND source_file <> ''`,
    );
    const sourceFiles = fileRows
      .map((r) => String(r.source_file))
      .filter((f) => f.length > 0);
    console.log(
      `[backfill-loaded-skills] scanning ${sourceFiles.length} distinct source file(s)...`,
    );

    // -----------------------------------------------------------------------
    // 2. Re-stream each file, then INSERT session_skills + UPDATE tool_calls.
    //    Everything runs inside one transaction for atomicity. Inserts are
    //    BATCHED into multi-row VALUES statements — issuing tens of thousands
    //    of single-row conn.run() calls inside one transaction can crash the
    //    DuckDB native binding under handle/memory pressure.
    // -----------------------------------------------------------------------
    let filesScanned = 0;
    let filesMissing = 0;
    let sessionSkillRowsSeen = 0;
    let skillCallsUpdated = 0;

    // Collect every parsed row first (file I/O), then write in batches.
    const allSessionSkillRows: ReturnType<typeof buildSessionSkillRows> = [];
    const allSkillCalls: RecoveredSkillCall[] = [];
    for (const file of sourceFiles) {
      let scan: FileScanResult;
      try {
        scan = await scanSourceFile(file);
      } catch {
        filesMissing++;
        continue;
      }
      filesScanned++;
      const ssRows = buildSessionSkillRows(scan.loadedSkills);
      sessionSkillRowsSeen += ssRows.length;
      allSessionSkillRows.push(...ssRows);
      for (const call of scan.skillCalls) {
        if (call.skillName === null && call.callerType === null) continue;
        allSkillCalls.push(call);
      }
    }

    /** Render one session_skills row as a `(...)` VALUES tuple. */
    function ssTuple(
      ss: ReturnType<typeof buildSessionSkillRows>[number],
    ): string {
      const captured =
        ss.captured_at instanceof Date
          ? sqlStr(ss.captured_at.toISOString())
          : "NULL";
      return (
        `(${sqlStr(ss.session_skill_id)}, ${sqlStr(ss.session_id)}, ` +
        `${ss.record_uuid === null ? "NULL" : sqlStr(ss.record_uuid)}, ` +
        `${sqlStr(ss.skill_name)}, ` +
        `${ss.skill_description === null ? "NULL" : sqlStr(ss.skill_description)}, ` +
        `${ss.skill_count === null ? "NULL" : String(ss.skill_count)}, ` +
        `${ss.is_initial ? "TRUE" : "FALSE"}, ${captured}, ${sqlStr(ss.source)})`
      );
    }

    // De-duplicate by the deterministic PK before batching — a single
    // skill_listing can list the same skill name twice, which would put two
    // rows with an identical PK into the same multi-row INSERT. First wins.
    const dedupedSsRows = (() => {
      const seen = new Set<string>();
      const out: typeof allSessionSkillRows = [];
      for (const ss of allSessionSkillRows) {
        if (seen.has(ss.session_skill_id)) continue;
        seen.add(ss.session_skill_id);
        out.push(ss);
      }
      return out;
    })();

    const INSERT_BATCH = 500;
    await conn.run("BEGIN TRANSACTION");

    // 2a. session_skills — batched multi-row INSERT ... ON CONFLICT DO NOTHING.
    //     The deterministic PK (D4, built by the shared helper) makes this
    //     idempotent: rows a previous run already inserted are no-ops.
    for (let i = 0; i < dedupedSsRows.length; i += INSERT_BATCH) {
      const chunk = dedupedSsRows.slice(i, i + INSERT_BATCH);
      const values = chunk.map(ssTuple).join(",\n");
      await conn.run(
        `INSERT INTO session_skills (
           session_skill_id, session_id, record_uuid, skill_name,
           skill_description, skill_count, is_initial, captured_at, source
         ) VALUES ${values}
         ON CONFLICT(session_skill_id) DO NOTHING`,
      );
    }

    // 2b. tool_calls — fill skill_name / skill_caller_type for the `Skill`
    //     rows recovered from the JSONL files, ONLY where skill_name is still
    //     NULL (never overwrite a value a re-ingest already set). These are
    //     few (one per recovered Skill invocation) so per-row UPDATEs keyed
    //     on the primary key are fine.
    for (const call of allSkillCalls) {
      await conn.run(
        `UPDATE tool_calls
           SET skill_name = COALESCE(skill_name, ${
             call.skillName === null ? "NULL" : sqlStr(call.skillName)
           }),
               skill_caller_type = COALESCE(skill_caller_type, ${
                 call.callerType === null ? "NULL" : sqlStr(call.callerType)
               })
         WHERE tool_call_id = ${sqlStr(call.toolCallId)}
           AND tool_name = 'Skill'
           AND skill_name IS NULL`,
      );
      skillCallsUpdated++;
    }

    // 2c. Belt-and-braces: any remaining `Skill` row whose JSONL we could not
    //     re-read (file moved/deleted) still gets skill_name from the already
    //     stored `parameters` JSON. Note: a flat
    //     `UPDATE ... WHERE json_extract_string(parameters,'$.skill') ...`
    //     mis-plans on this dataset (the tool_name filter is dropped when a
    //     JSON-extraction expression feeds the join), so instead we read the
    //     names with a CTE-scoped SELECT — which evaluates correctly — and
    //     issue per-row UPDATEs keyed on the primary key.
    const fallbackRows = await rows(
      conn,
      `WITH skill_rows AS (
         SELECT tool_call_id, parameters
         FROM tool_calls
         WHERE tool_name = 'Skill' AND skill_name IS NULL
       )
       SELECT tool_call_id,
              json_extract_string(parameters, '$.skill') AS skill
       FROM skill_rows
       WHERE json_extract_string(parameters, '$.skill') IS NOT NULL`,
    );
    let fallbackUpdated = 0;
    for (const r of fallbackRows) {
      const id = String(r.tool_call_id);
      const skill = r.skill;
      if (typeof skill !== "string" || skill.length === 0) continue;
      await conn.run(
        `UPDATE tool_calls
           SET skill_name = ${sqlStr(skill)}
         WHERE tool_call_id = ${sqlStr(id)}
           AND tool_name = 'Skill'
           AND skill_name IS NULL`,
      );
      fallbackUpdated++;
    }

    await conn.run("COMMIT");

    // -----------------------------------------------------------------------
    // 3. Post-flight: re-read counts, assert tool_calls count unchanged.
    // -----------------------------------------------------------------------
    const [post] = await rows(
      conn,
      `SELECT
         (SELECT COUNT(*) FROM session_skills)                                  AS session_skills,
         (SELECT COUNT(*) FROM tool_calls)                                      AS tool_calls,
         (SELECT COUNT(*) FROM tool_calls WHERE tool_name = 'Skill'
            AND skill_name IS NOT NULL)                                         AS skill_calls_named,
         (SELECT COUNT(DISTINCT session_id) FROM session_skills)                AS sessions_with_skills`,
    );
    const postSessionSkills = num(post.session_skills);
    const postToolCalls = num(post.tool_calls);
    const postSkillCallsNamed = num(post.skill_calls_named);
    const sessionsWithSkills = num(post.sessions_with_skills);

    if (postToolCalls !== preToolCalls) {
      throw new Error(
        `[backfill-loaded-skills] ABORT: tool_calls row count changed ` +
          `${preToolCalls} -> ${postToolCalls}. The backfill must be additive; ` +
          `restore from backup.`,
      );
    }

    // -----------------------------------------------------------------------
    // 4. Report.
    // -----------------------------------------------------------------------
    console.log("");
    console.log(`[backfill-loaded-skills] ====== RESULT ======`);
    console.log(
      `[backfill-loaded-skills] files: ${filesScanned} scanned, ${filesMissing} unreadable`,
    );
    console.log(
      `[backfill-loaded-skills] session_skills: ${preSessionSkills} -> ${postSessionSkills} ` +
        `(+${postSessionSkills - preSessionSkills}; ${sessionSkillRowsSeen} parsed rows seen, ` +
        `rest were ON CONFLICT no-ops)`,
    );
    console.log(
      `[backfill-loaded-skills] sessions with >=1 session_skills row: ${sessionsWithSkills}`,
    );
    console.log(
      `[backfill-loaded-skills] Skill tool_calls with skill_name: ` +
        `${preSkillCallsNamed} -> ${postSkillCallsNamed} ` +
        `(${skillCallsUpdated} file-recovered UPDATEs + ${fallbackUpdated} ` +
        `from-stored-parameters fallback UPDATEs issued)`,
    );
    console.log(
      `[backfill-loaded-skills] tool_calls row count unchanged: ${postToolCalls} (additive ✓)`,
    );
    console.log(`[backfill-loaded-skills] ====================`);
    console.log(
      `[backfill-loaded-skills] done. Safe to re-run — a second run inserts/updates 0 rows.`,
    );
  } catch (err) {
    try {
      await conn.run("ROLLBACK");
    } catch {
      // ignore — transaction may not be open
    }
    throw err;
  } finally {
    conn.closeSync();
  }
}

main().catch((err) => {
  console.error(
    `[backfill-loaded-skills] FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
