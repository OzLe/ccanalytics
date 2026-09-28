/**
 * @module scripts/check-indexes
 *
 * Read-only index integrity check for the analytics DuckDB file.
 *
 * DuckDB picks an index scan at run time for a selective filter, so an ART
 * index that lost entries makes a query silently return too few rows. That
 * happened here: DuckDB 1.4.4 dropped rows from the secondary indexes when it
 * replayed the WAL (docs/filtered-query-misses-2026-09-28.md). Migration 7
 * removed every secondary index; this script proves the remaining ones are
 * whole.
 *
 * For every single-column index it compares, key by key, the rows an index
 * scan returns (index scans forced) with the rows a full scan counts (GROUP BY
 * never uses an index). Columns with many keys are compared in sorted range
 * buckets, drilling into any bucket that disagrees. It also reports duplicate
 * PRIMARY KEY / UNIQUE values and any secondary index that exists at all.
 *
 * SAFETY: only SELECT and SET statements. It opens the database read-write
 * like every other script (so DuckDB can replay a WAL), which needs exclusive
 * access: stop the `com.ccanalytics.web` LaunchAgent first, or point it at a
 * copy of the .duckdb and .wal files.
 *
 * USAGE:
 *   npm run check:indexes [-- /path/to/analytics.duckdb]
 *   Env: DB_PATH overrides the default ~/.ccanalytics/analytics.duckdb.
 *
 * Exit code 0 when every index is whole and none are secondary, 1 otherwise.
 */

import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

/** Columns with more distinct keys than this are checked in range buckets. */
const EQUALITY_KEY_LIMIT = 20_000;
/** Keys per range bucket. */
const BUCKET_SIZE = 250;

type Conn = Awaited<ReturnType<InstanceType<typeof DuckDBInstance>["connect"]>>;

interface IndexTarget {
  table: string;
  columns: string[];
  label: string;
  unique: boolean;
}

interface IndexReport {
  label: string;
  table: string;
  rows: number;
  keys: number | null;
  duplicateKeys: number;
  keysMissingRows: number;
  rowsMissing: number;
  keysWithExtraRows: number;
}

/** Resolve the analytics DB path: CLI arg › DB_PATH env › default. */
function resolveDbPath(): string {
  const arg = process.argv[2];
  if (arg && arg.trim().length > 0) return path.resolve(arg.trim());
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  return path.join(os.homedir(), ".ccanalytics", "analytics.duckdb");
}

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

async function rows(conn: Conn, sql: string): Promise<Record<string, unknown>[]> {
  return (await conn.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
}

async function scalar(conn: Conn, sql: string): Promise<number> {
  const [row] = await rows(conn, sql);
  return Number(Object.values(row ?? {})[0] ?? 0);
}

async function setIndexScans(conn: Conn, forced: boolean): Promise<void> {
  await conn.run(`SET index_scan_percentage = ${forced ? 1.0 : 0}`);
  await conn.run(`SET index_scan_max_count = ${forced ? 1_000_000_000 : 0}`);
}

/** Every PRIMARY KEY / UNIQUE constraint, plus every secondary index. */
async function listTargets(conn: Conn): Promise<{ targets: IndexTarget[]; secondary: string[] }> {
  const targets: IndexTarget[] = [];
  for (const r of await rows(
    conn,
    `SELECT table_name, constraint_type, constraint_column_names
     FROM duckdb_constraints()
     WHERE constraint_type IN ('PRIMARY KEY', 'UNIQUE')
     ORDER BY table_name, constraint_type`,
  )) {
    const columns = (r.constraint_column_names as string[]).map(String);
    const kind = r.constraint_type === "UNIQUE" ? "unique" : "pk";
    targets.push({
      table: String(r.table_name),
      columns,
      label: `${r.table_name} ${kind}(${columns.join(", ")})`,
      unique: true,
    });
  }
  const secondary: string[] = [];
  for (const r of await rows(
    conn,
    `SELECT table_name, index_name, expressions FROM duckdb_indexes() ORDER BY 1, 2`,
  )) {
    secondary.push(`${r.table_name}.${r.index_name}`);
    // expressions looks like [session_id] or [session_id, '"timestamp"'].
    const columns = String(r.expressions)
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((c) => c.trim().replace(/^'?"?|"?'?$/g, ""));
    targets.push({
      table: String(r.table_name),
      columns,
      label: `${r.table_name} ${r.index_name}`,
      unique: false,
    });
  }
  return { targets, secondary };
}

async function checkTarget(conn: Conn, t: IndexTarget): Promise<IndexReport> {
  const table = ident(t.table);
  const total = await scalar(conn, `SELECT count(*) FROM ${table}`);
  const report: IndexReport = {
    label: t.label,
    table: t.table,
    rows: total,
    keys: null,
    duplicateKeys: 0,
    keysMissingRows: 0,
    rowsMissing: 0,
    keysWithExtraRows: 0,
  };

  if (t.columns.length > 1) {
    // DuckDB only scans single-column indexes, so a composite one can only be
    // checked for duplicates (a PRIMARY KEY that lost entries lets ON CONFLICT
    // insert a second copy).
    if (t.unique) {
      report.duplicateKeys = await scalar(
        conn,
        `SELECT count(*) FROM (SELECT 1 FROM ${table}
         GROUP BY ${t.columns.map(ident).join(", ")} HAVING count(*) > 1)`,
      );
    }
    return report;
  }

  const column = ident(t.columns[0]);
  const [typeRow] = await rows(
    conn,
    `SELECT data_type FROM duckdb_columns()
     WHERE table_name = ${quote(t.table)} AND column_name = ${quote(t.columns[0])}`,
  );
  const type = String(typeRow?.data_type ?? "VARCHAR");
  const literal = (k: string): string =>
    type === "VARCHAR" ? quote(k) : `CAST(${quote(k)} AS ${type})`;

  await setIndexScans(conn, false);
  const truth = (
    await rows(
      conn,
      `SELECT ${column}::VARCHAR AS k, count(*) AS n FROM ${table}
       WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY ${column}`,
    )
  ).map((r) => ({ k: String(r.k), n: Number(r.n) }));
  report.keys = truth.length;
  if (t.unique) {
    report.duplicateKeys = truth.filter((r) => r.n > 1).length;
  }

  await setIndexScans(conn, true);
  const checkKey = async (r: { k: string; n: number }): Promise<void> => {
    const viaIndex = await scalar(
      conn,
      `SELECT count(*) FROM ${table} WHERE ${column} = ${literal(r.k)}`,
    );
    if (viaIndex < r.n) {
      report.keysMissingRows++;
      report.rowsMissing += r.n - viaIndex;
    } else if (viaIndex > r.n) {
      report.keysWithExtraRows++;
    }
  };
  if (truth.length <= EQUALITY_KEY_LIMIT) {
    for (const r of truth) await checkKey(r);
  } else {
    for (let i = 0; i < truth.length; i += BUCKET_SIZE) {
      const bucket = truth.slice(i, i + BUCKET_SIZE);
      const want = bucket.reduce((sum, r) => sum + r.n, 0);
      const got = await scalar(
        conn,
        `SELECT count(*) FROM ${table} WHERE ${column}
         BETWEEN ${literal(bucket[0].k)} AND ${literal(bucket[bucket.length - 1].k)}`,
      );
      if (got !== want) {
        for (const r of bucket) await checkKey(r);
      }
    }
  }
  await setIndexScans(conn, false);
  return report;
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  console.log(`[check-indexes] database: ${dbPath}`);

  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(dbPath);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[check-indexes] cannot open the database: ${msg}`);
    if (msg.includes("lock")) {
      console.error(
        "[check-indexes] another process holds it — stop the com.ccanalytics.web LaunchAgent, or check a copy",
      );
    }
    process.exit(1);
  }
  const conn = await instance.connect();

  let problems = 0;
  try {
    const [version] = await rows(conn, "SELECT library_version FROM pragma_version()");
    console.log(`[check-indexes] DuckDB ${version?.library_version}`);

    const { targets, secondary } = await listTargets(conn);
    if (secondary.length > 0) {
      problems += secondary.length;
      console.log(
        `[check-indexes] FAIL: ${secondary.length} secondary index(es) exist; migration 7 removes them: ${secondary.join(", ")}`,
      );
    }

    for (const t of targets) {
      const r = await checkTarget(conn, t);
      const bad = r.duplicateKeys + r.keysMissingRows + r.keysWithExtraRows;
      problems += bad;
      const detail =
        r.keys === null
          ? `${r.rows} rows, duplicate keys ${r.duplicateKeys}`
          : `${r.rows} rows, ${r.keys} keys, duplicate keys ${r.duplicateKeys}, ` +
            `keys missing rows ${r.keysMissingRows} (${r.rowsMissing} rows), keys with extra rows ${r.keysWithExtraRows}`;
      console.log(`[check-indexes] ${bad === 0 ? "ok  " : "FAIL"} ${r.label}: ${detail}`);
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
  }

  if (problems > 0) {
    console.log(`[check-indexes] ${problems} problem(s) found`);
    process.exit(1);
  }
  console.log("[check-indexes] every index is whole");
}

main().catch((err) => {
  console.error(`[check-indexes] failed: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
