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
 */
export class QueryExecutor {
  private connection: DuckDBConnection;

  /**
   * Create a QueryExecutor bound to a DuckDB connection.
   * @param connection - Active DuckDB connection
   */
  constructor(connection: unknown) {
    this.connection = connection as DuckDBConnection;
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
