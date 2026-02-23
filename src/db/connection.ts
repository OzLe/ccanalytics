/**
 * @module db/connection
 *
 * DuckDB connection lifecycle management.
 * Creates and manages a single DuckDB instance and connection.
 * All other modules access the database through this class.
 */

import type { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError, ConnectionError } from "../errors.js";

/**
 * Manages the DuckDB instance and connection lifecycle.
 * Enforces single-writer pattern: one instance, one connection per process.
 */
export class ConnectionManager {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private dbPath: string | null = null;

  /**
   * Open a DuckDB instance and connection.
   * Creates the database file and parent directories if they do not exist.
   *
   * @param dbPath - Path to the DuckDB database file, or ":memory:" for in-memory
   * @throws ConnectionError if the connection cannot be established
   */
  async open(dbPath: string): Promise<void> {
    // TODO: Implement DuckDB connection
    // 1. Ensure parent directory exists (if not :memory:)
    // 2. Create DuckDBInstance via @duckdb/node-api
    // 3. Create DuckDBConnection from instance
    // 4. Store references for later access
    try {
      const { DuckDBInstance: DuckDB } = await import("@duckdb/node-api");
      this.instance = await DuckDB.create(dbPath);
      this.connection = await this.instance.connect();
      this.dbPath = dbPath;
    } catch (err) {
      throw new ConnectionError(
        `Failed to connect to DuckDB at ${dbPath}`,
        err as Error,
      );
    }
  }

  /**
   * Get the active DuckDB connection.
   * @throws DatabaseError if not connected
   */
  getConnection(): DuckDBConnection {
    if (!this.connection) {
      throw new DatabaseError("Not connected to DuckDB. Call open() first.");
    }
    return this.connection;
  }

  /**
   * Get the active DuckDB instance.
   * @throws DatabaseError if not connected
   */
  getInstance(): DuckDBInstance {
    if (!this.instance) {
      throw new DatabaseError("Not connected to DuckDB. Call open() first.");
    }
    return this.instance;
  }

  /**
   * Check whether a connection is currently open.
   */
  isOpen(): boolean {
    return this.connection !== null;
  }

  /**
   * Get the database file path.
   */
  getDbPath(): string | null {
    return this.dbPath;
  }

  /**
   * Close the connection and instance.
   * Safe to call multiple times.
   */
  async close(): Promise<void> {
    try {
      if (this.connection) {
        this.connection.closeSync();
        this.connection = null;
      }
      // DuckDBInstance does not have an explicit close in all versions;
      // setting to null allows garbage collection
      this.instance = null;
      this.dbPath = null;
    } catch (err) {
      // Swallow close errors — shutdown should always succeed
      this.connection = null;
      this.instance = null;
      this.dbPath = null;
    }
  }
}
