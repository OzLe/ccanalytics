/**
 * @module server/helpers/db
 *
 * DuckDB connection helper for the API server.
 * Opens a read-only connection to ~/.ccanalytics/analytics.duckdb
 * and provides a query() method that returns JSON-serializable results.
 */

import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import path from "node:path";
import os from "node:os";

/** Result of a database query. */
export interface DbResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  columnNames: string[];
  durationMs: number;
}

/** Singleton database connection state. */
let instance: InstanceType<typeof DuckDBInstance> | null = null;
let connection: Awaited<ReturnType<InstanceType<typeof DuckDBInstance>["connect"]>> | null = null;
let dbPath: string | null = null;

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

/**
 * Get or create the DuckDB connection.
 * The connection is lazily initialized and reused across requests.
 */
async function getConnection() {
  if (connection) {
    return connection;
  }

  dbPath = getDbPath();
  instance = await DuckDBInstance.create(dbPath);
  connection = await instance.connect();
  return connection;
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
 * Execute a parameterized SQL query and return typed results.
 *
 * @param sql - SQL query with $1, $2, ... placeholders
 * @param params - Bind parameters
 * @returns Query result with typed rows
 */
export async function query<T = Record<string, unknown>>(
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
 * Close the database connection and instance.
 * Safe to call multiple times. Used for graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  try {
    if (connection) {
      connection.closeSync();
      connection = null;
    }
    instance = null;
    dbPath = null;
  } catch {
    connection = null;
    instance = null;
    dbPath = null;
  }
}

/**
 * Get the current database path (for health checks).
 */
export function getDbPathInfo(): string {
  return dbPath ?? getDbPath();
}
