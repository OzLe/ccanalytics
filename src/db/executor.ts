/**
 * @module db/executor
 *
 * Parameterized query execution with result mapping.
 * Wraps DuckDB's prepared statement API with type-safe result handling.
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import { QueryExecutionError } from "../errors.js";

/** Result of a query execution. */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  columnNames: string[];
  durationMs: number;
}

/**
 * Normalize a parameter value for DuckDB binding.
 * Converts Date objects to ISO strings so DuckDB can infer types
 * even on empty tables (avoids "Cannot create values of type ANY").
 */
function normalizeParam(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

/**
 * Bind an array of parameter values to a DuckDB prepared statement.
 * Uses bindValue for non-null values and bindNull for nulls.
 * Parameter indices are 1-based per DuckDB convention.
 *
 * Note: bindValue and bindNull are synchronous in @duckdb/node-api.
 */
function bindParams(
  stmt: { bindValue(index: number, value: unknown): void; bindNull(index: number): void },
  params: unknown[],
): void {
  for (let i = 0; i < params.length; i++) {
    const value = normalizeParam(params[i]);
    if (value === null || value === undefined) {
      stmt.bindNull(i + 1);
    } else {
      stmt.bindValue(i + 1, value);
    }
  }
}

/**
 * Executes parameterized SQL queries against a DuckDB connection.
 * Uses prepared statements to prevent SQL injection.
 *
 * Concurrency: a single `DuckDBConnection` is not safe for concurrent
 * `prepare → bind → run` cycles. Firing several `query()` calls in
 * parallel against the same connection (e.g. via `Promise.all`) races
 * on the underlying statement state and intermittently throws
 * "Failed to execute prepared statement" — observed flakily on Linux
 * Node 22 in CI and reproducible on macOS Node 22 (~2-4% of trials).
 *
 * To make concurrent callers safe, each `query()`/`run()` acquires a
 * per-executor FIFO lock so prepared-statement work runs serially.
 * Callers that need real parallelism should open separate connections.
 */
export class QueryExecutor {
  private connection: DuckDBConnection;
  /** FIFO mutex serializing prepared-statement work on `connection`. */
  private queryLock: Promise<unknown> = Promise.resolve();

  /**
   * Create a QueryExecutor bound to a DuckDB connection.
   * @param connection - Active DuckDB connection
   */
  constructor(connection: unknown) {
    this.connection = connection as DuckDBConnection;
  }

  /**
   * Run `fn` after any prior locked work completes, ensuring at most one
   * prepared-statement cycle is in flight on `this.connection` at a time.
   * Rejections of `fn` do not poison the lock — the next waiter still runs.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queryLock;
    let release!: () => void;
    this.queryLock = new Promise<void>((r) => (release = r));
    try {
      await prev;
    } catch {
      // Prior holder failed; we still take the lock.
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Execute a SQL statement that returns no results (DDL, INSERT, UPDATE).
   *
   * @param sql - SQL statement to execute
   * @param params - Bind parameters
   * @throws QueryExecutionError on failure
   */
  async run(sql: string, params?: unknown[]): Promise<void> {
    try {
      await this.withLock(async () => {
        if (params && params.length > 0) {
          const stmt = await this.connection.prepare(sql);
          try {
            bindParams(stmt, params);
            await stmt.run();
          } finally {
            stmt.destroySync();
          }
        } else {
          await this.connection.run(sql);
        }
      });
    } catch (err) {
      if (err instanceof QueryExecutionError) {
        throw err;
      }
      throw new QueryExecutionError(
        `Failed to execute SQL: ${(err as Error).message}`,
        sql,
        err as Error,
      );
    }
  }

  /**
   * Execute a parameterized SQL query and return typed results.
   *
   * @param sql - SQL query to execute
   * @param params - Bind parameters
   * @returns Query result with typed rows
   * @throws QueryExecutionError on failure
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const start = performance.now();
    try {
      return await this.withLock(async () => {
        let reader;
        if (params && params.length > 0) {
          const stmt = await this.connection.prepare(sql);
          try {
            bindParams(stmt, params);
            reader = await stmt.runAndReadAll();
          } finally {
            stmt.destroySync();
          }
        } else {
          reader = await this.connection.runAndReadAll(sql);
        }

        const rows = reader.getRowObjectsJS() as T[];
        const durationMs = performance.now() - start;

        return {
          rows,
          rowCount: reader.currentRowCount,
          columnNames: reader.columnNames(),
          durationMs,
        };
      });
    } catch (err) {
      if (err instanceof QueryExecutionError) {
        throw err;
      }
      throw new QueryExecutionError(
        `Failed to execute query: ${(err as Error).message}`,
        sql,
        err as Error,
      );
    }
  }

  /**
   * Execute a query and return a single scalar value.
   *
   * @param sql - SQL query expected to return a single value
   * @param params - Bind parameters
   * @returns The scalar value, or null if no rows
   * @throws QueryExecutionError on failure
   */
  async scalar<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null> {
    const result = await this.query(sql, params);
    if (result.rowCount === 0 || result.columnNames.length === 0) {
      return null;
    }
    const firstRow = result.rows[0] as Record<string, unknown>;
    const firstColumn = result.columnNames[0];
    const value = firstRow[firstColumn];
    return (value === undefined ? null : value) as T | null;
  }
}
