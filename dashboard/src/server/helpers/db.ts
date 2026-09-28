/**
 * @module server/helpers/db
 *
 * DuckDB connection helper for the API server.
 * Opens a read-only connection to ~/.ccanalytics/analytics.duckdb
 * and provides a query() method that returns JSON-serializable results.
 */

import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Result of a database query. */
export interface DbResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  columnNames: string[];
  durationMs: number;
}

/** The connected DuckDB connection type. */
type DuckDBConnection = Awaited<ReturnType<InstanceType<typeof DuckDBInstance>["connect"]>>;

/** Singleton database connection state. */
let connection: DuckDBConnection | null = null;
let dbPath: string | null = null;
/** Deduplicates concurrent getConnection() calls. */
let connectingPromise: Promise<DuckDBConnection> | null = null;

/**
 * Resolve the default database path.
 * Uses DB_PATH env var if set, otherwise ~/.ccanalytics/analytics.duckdb.
 */
function getDbPath(): string {
  if (process.env.DB_PATH) {
    return process.env.DB_PATH;
  }
  return path.join(os.homedir(), ".ccanalytics", "analytics.duckdb");
}

/** Error messages that indicate an unrecoverable corrupt database file. */
const CORRUPTION_PATTERNS = [
  "Failed to load metadata pointer",
  "Corrupt database",
  "INTERNAL Error",
  "IO Error: Could not read",
  "not a valid DuckDB database file",
  "Deserialization Error",
  "invalid file header",
];

function looksCorrupt(msg: string): boolean {
  return CORRUPTION_PATTERNS.some((p) => msg.includes(p));
}

/** Try to create a DuckDB instance and connect. */
async function openDb(p: string): Promise<DuckDBConnection> {
  const inst = await DuckDBInstance.create(p);
  const conn = await inst.connect();
  await applySessionDefaults(conn);
  return conn;
}

/**
 * Pin session defaults that every read path depends on (ACT-001 / SEM2-293).
 *
 * `SET TimeZone = 'UTC'` defends the storage invariant: ingest writes
 * `Date.toISOString()` (Z-suffixed) and DuckDB stores the wall-clock value as
 * if it were the UTC instant. If the session tz were ever flipped, the
 * `(ts AT TIME ZONE 'UTC') AT TIME ZONE $user_tz` projection would no longer
 * mean what we think.
 *
 * The ICU/AT TIME ZONE liveness probe asserts the projection primitive we use
 * everywhere actually works on this build. ICU is statically linked in
 * @duckdb/node-api 1.4.x, but the probe is cheap insurance — if it ever
 * regresses we want a loud, early error rather than silent UTC-labeled-as-
 * local readings in the dashboard.
 */
async function applySessionDefaults(conn: DuckDBConnection): Promise<void> {
  await conn.run("SET TimeZone = 'UTC'");
  try {
    await conn.run(
      "SELECT EXTRACT(HOUR FROM ('2026-01-01T12:00:00'::TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jerusalem')",
    );
  } catch (err) {
    throw new Error(
      `DuckDB AT TIME ZONE / ICU extension liveness check failed — local-time queries will not work correctly: ${(err as Error).message}`,
    );
  }
}

/**
 * Get or create the DuckDB connection.
 * The connection is lazily initialized and reused across requests.
 * Uses a promise mutex so concurrent callers wait for the first initialization.
 * Includes auto-recovery for corrupt WAL files and database files.
 */
async function getConnection() {
  if (connection) {
    return connection;
  }
  // Deduplicate concurrent calls — all waiters share the same promise.
  if (connectingPromise) {
    return connectingPromise;
  }
  connectingPromise = initConnection();
  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

async function initConnection() {
  dbPath = getDbPath();
  const walPath = `${dbPath}.wal`;

  try {
    connection = await openDb(dbPath);
  } catch (err) {
    const msg = (err as Error).message ?? "";

    // --- Stage 1: Corrupt WAL recovery ---
    if (msg.includes("replaying WAL") && fs.existsSync(walPath)) {
      console.warn(`[db] Corrupt WAL detected — removing ${walPath} and retrying`);
      fs.unlinkSync(walPath);
      try {
        connection = await openDb(dbPath);
      } catch (retryErr) {
        const retryMsg = (retryErr as Error).message ?? "";
        if (!looksCorrupt(retryMsg)) {
          throw retryErr;
        }
        // WAL removal wasn't enough — fall through to Stage 2
      }
    }

    // --- Stage 2: Corrupt database file recovery ---
    if (!connection && looksCorrupt(msg) && fs.existsSync(dbPath)) {
      console.warn(`[db] Corrupt database detected — removing ${dbPath} and recreating`);
      fs.unlinkSync(dbPath);
      if (fs.existsSync(walPath)) {
        fs.unlinkSync(walPath);
      }
      connection = await openDb(dbPath);
    }

    if (!connection) {
      throw err;
    }
  }

  // Apply pending schema migrations before the first query: migration 7 drops
  // the secondary indexes DuckDB 1.4.4 corrupted on WAL replay. A failure is
  // logged, not fatal — the next ingest runs the same migrations.
  try {
    await applyPendingMigrations(connection);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    console.warn(`[db] Schema migration failed: ${msg}`);
    // A FATAL error invalidates the DuckDB instance; reopen rather than keep a
    // dead connection.
    if (msg.includes("FATAL") || msg.includes("invalidated")) {
      try { connection.closeSync(); } catch { /* ignore */ }
      connection = null;
      connection = await openDb(dbPath);
    }
  }

  // Ensure analytical views are up-to-date on first connection.
  await initViews(connection);

  // Fold the startup writes, and any WAL replayed on open, into the database
  // file so the next start has little or nothing to replay.
  await checkpoint(connection);

  return connection;
}

/** The parts of the parent package's `SchemaManager` this module uses. */
interface SchemaManagerLike {
  getVersion(connection: unknown): Promise<number>;
  migrate(connection: unknown): Promise<number>;
}

/**
 * Apply the parent package's pending schema migrations, so a dashboard started
 * on an older database gets them before its first query rather than at the
 * next ingest (docs/filtered-query-misses-2026-09-28.md).
 *
 * Only a database that already carries the ccanalytics schema is migrated; an
 * empty one is left for the first ingest to initialize, as before. The module
 * path is resolved at runtime for the same reason as the ingest route's
 * `loadRunIngestion()`: it keeps the parent project out of this typecheck.
 */
async function applyPendingMigrations(conn: DuckDBConnection): Promise<void> {
  const modulePath = path.resolve(__dirname, "../../../../src/db/schema.ts");
  const { SchemaManager } = (await import(modulePath)) as {
    SchemaManager: new () => SchemaManagerLike;
  };
  const schema = new SchemaManager();
  if ((await schema.getVersion(conn)) === 0) {
    return;
  }
  const applied = await schema.migrate(conn);
  if (applied > 0) {
    console.log(`[db] Applied ${applied} schema migration(s).`);
  }
}

/** Run CHECKPOINT; a failure is logged, not thrown — the data stays in the WAL. */
async function checkpoint(conn: DuckDBConnection): Promise<void> {
  try {
    await conn.run("CHECKPOINT");
  } catch (err) {
    console.warn(`[db] CHECKPOINT failed: ${(err as Error).message}`);
  }
}

/**
 * Run the views.sql file to create/replace analytical views.
 * This ensures the dashboard always uses the latest view definitions.
 */
async function initViews(
  conn: Awaited<ReturnType<InstanceType<typeof DuckDBInstance>["connect"]>>,
): Promise<void> {
  // Resolve views.sql relative to known locations
  const thisDir = __dirname;
  const candidates = [
    path.resolve(thisDir, "../../../../sql/views.sql"),       // dev: src/server/helpers/ -> root
    path.resolve(thisDir, "../../../sql/views.sql"),          // built
    path.resolve(process.cwd(), "sql/views.sql"),              // cwd = project root
    path.resolve(process.cwd(), "../sql/views.sql"),           // cwd = dashboard/
  ];

  let viewsSql: string | null = null;
  for (const candidate of candidates) {
    try {
      viewsSql = fs.readFileSync(candidate, "utf-8");
      break;
    } catch {
      // Try next candidate
    }
  }

  if (!viewsSql) {
    console.warn("Warning: Could not find sql/views.sql — skipping view initialization");
    return;
  }

  // Strip comments before splitting so semicolons inside comments
  // (e.g. "-- rates above 80%; effective") don't cause incorrect splits
  const stripped = viewsSql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await conn.run(stmt);
    } catch (err) {
      console.warn(`Warning: Failed to execute view statement: ${(err as Error).message}`);
    }
  }

  console.log("Analytical views initialized.");
}

/**
 * Normalize a parameter value for DuckDB binding.
 * Converts Date objects to ISO strings.
 */
function normalizeParam(value: unknown): DuckDBValue {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value as DuckDBValue;
}

/**
 * Serializes statement execution on the single shared connection.
 *
 * `@duckdb/node-api` intermittently throws "Failed to execute prepared
 * statement" when two statements run concurrently on ONE connection. The whole
 * API server shares this singleton conn, so every statement must funnel through
 * this tail so at most one runs at a time — read `query()` calls AND the
 * ingestion write path, which would otherwise race reads during a manual
 * `POST /api/ingest` (see `getIngestConnection`). The tail is kept
 * non-rejecting so a failed statement can never wedge the queue behind it.
 */
let queryTail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` exclusively on the shared connection: it starts only after every
 * previously-enqueued statement has settled, and the next enqueued statement
 * waits for it. This is the single serialization point for the connection;
 * both the read path ({@link query}) and the ingestion write proxy
 * ({@link getIngestConnection}) go through it.
 */
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = queryTail.then(fn);
  // Advance the tail with a swallowed copy so the next task still runs even if
  // this one rejects; the real outcome is returned to this caller.
  queryTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Execute a parameterized SQL query and return typed results.
 *
 * Serialized against every other statement on the shared connection (see
 * {@link runExclusive}); concurrent callers are queued, not run in parallel.
 *
 * @param sql - SQL query with $1, $2, ... placeholders
 * @param params - Bind parameters
 * @returns Query result with typed rows
 */
export function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<DbResult<T>> {
  return runExclusive(() => execQuery<T>(sql, params));
}

/** The actual statement execution, run one-at-a-time via {@link query}. */
async function execQuery<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<DbResult<T>> {
  const conn = await getConnection();
  const start = performance.now();

  let reader;
  if (params && params.length > 0) {
    const stmt = await conn.prepare(sql);
    try {
      for (let i = 0; i < params.length; i++) {
        const value = normalizeParam(params[i]);
        if (value === null || value === undefined) {
          stmt.bindNull(i + 1);
        } else {
          stmt.bindValue(i + 1, value);
        }
      }
      reader = await stmt.runAndReadAll();
    } finally {
      stmt.destroySync();
    }
  } else {
    reader = await conn.runAndReadAll(sql);
  }

  const rows = reader.getRowObjectsJS() as T[];
  const durationMs = performance.now() - start;

  return {
    rows,
    rowCount: reader.currentRowCount,
    columnNames: reader.columnNames(),
    durationMs,
  };
}

/**
 * Close the database connection.
 * Safe to call multiple times. Used for graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  try {
    if (connection) {
      connection.closeSync();
      connection = null;
    }
    dbPath = null;
  } catch {
    connection = null;
    dbPath = null;
  }
}

/**
 * Get the current database path (for health checks).
 */
export function getDbPathInfo(): string {
  return dbPath ?? getDbPath();
}

/**
 * Wrap a connection so its statement-executing methods (`run` /
 * `runAndReadAll`) funnel through {@link runExclusive} — i.e. share the read
 * path's serialization queue — while every other member forwards to the real
 * connection untouched.
 *
 * The ingestion pipeline (batch-inserter, offset tracker, schema migrations)
 * executes SQL exclusively via those two methods, so wrapping them stops
 * ingestion writes from running concurrently with dashboard reads on the shared
 * connection during a `POST /api/ingest`. Reads still interleave BETWEEN
 * ingestion statements, so the dashboard stays responsive.
 *
 * Non-wrapped functions are bound to the REAL connection (not the proxy) so a
 * driver method that internally calls `this.run(...)` hits the real `run`, not
 * the wrapped one — otherwise a statement enqueued from inside another
 * enqueued statement would wait on the queue behind itself and deadlock.
 */
function serializedConnection(conn: DuckDBConnection): DuckDBConnection {
  const handler: ProxyHandler<DuckDBConnection> = {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "run" || prop === "runAndReadAll") {
        const method = value as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]): Promise<unknown> =>
          runExclusive(() => method.apply(target, args));
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  };
  return new Proxy(conn, handler);
}

/**
 * Get a `ConnectionLike` wrapper around the server's singleton DuckDB
 * connection, for handing to the shared `runIngestion()` orchestration.
 *
 * DuckDB is single-writer: the API server already holds a read-write
 * connection to `analytics.duckdb`, so the ingest route must reuse THIS
 * connection rather than opening a second one (which would deadlock on the
 * file lock). Reusing it keeps the whole ingestion pass in-process.
 *
 * The connection is returned wrapped by {@link serializedConnection} so every
 * ingestion statement shares the read path's serialization queue — see that
 * function for why the raw shared connection is unsafe here.
 */
export async function getIngestConnection(): Promise<{
  getConnection(): DuckDBConnection;
}> {
  const conn = await getConnection();
  const serialized = serializedConnection(conn);
  return { getConnection: () => serialized };
}
