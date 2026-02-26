/**
 * @module db/connection
 *
 * DuckDB connection lifecycle management.
 * Creates and manages a single DuckDB instance and connection.
 * All other modules access the database through this class.
 */

import { unlinkSync, existsSync } from "node:fs";
import type { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { DatabaseError, ConnectionError } from "../errors.js";

/** Error messages that indicate an unrecoverable corrupt database file. */
const CORRUPTION_PATTERNS = [
  "Failed to load metadata pointer",
  "Corrupt database",
  "INTERNAL Error",
  "IO Error: Could not read",
  "Deserialization Error",
  "invalid file header",
];

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
    try {
      const { DuckDBInstance: DuckDB } = await import("@duckdb/node-api");
      this.instance = await DuckDB.create(dbPath);
      this.connection = await this.instance.connect();
      this.dbPath = dbPath;
    } catch (err) {
      if (dbPath === ":memory:") {
        throw new ConnectionError(
          `Failed to connect to DuckDB at ${dbPath}`,
          err as Error,
        );
      }

      const msg = (err as Error).message ?? "";
      const walPath = `${dbPath}.wal`;

      // --- Corrupt WAL recovery ---
      if (msg.includes("replaying WAL") && existsSync(walPath)) {
        console.warn(
          `[db] Corrupt WAL detected — removing ${walPath} and retrying`,
        );
        unlinkSync(walPath);
        try {
          const { DuckDBInstance: DuckDB } = await import("@duckdb/node-api");
          this.instance = await DuckDB.create(dbPath);
          this.connection = await this.instance.connect();
          this.dbPath = dbPath;
          return;
        } catch (retryErr) {
          // WAL removal wasn't enough — fall through to corruption recovery
          const retryMsg = (retryErr as Error).message ?? "";
          if (!this.looksCorrupt(retryMsg)) {
            throw new ConnectionError(
              `Failed to connect to DuckDB at ${dbPath} after WAL recovery`,
              retryErr as Error,
            );
          }
        }
      }

      // --- Corrupt database file recovery ---
      if (this.looksCorrupt(msg) && existsSync(dbPath)) {
        console.warn(
          `[db] Corrupt database detected — removing ${dbPath} and recreating`,
        );
        unlinkSync(dbPath);
        if (existsSync(walPath)) {
          unlinkSync(walPath);
        }
        try {
          const { DuckDBInstance: DuckDB } = await import("@duckdb/node-api");
          this.instance = await DuckDB.create(dbPath);
          this.connection = await this.instance.connect();
          this.dbPath = dbPath;
          return;
        } catch (retryErr) {
          throw new ConnectionError(
            `Failed to connect to DuckDB at ${dbPath} after removing corrupt database`,
            retryErr as Error,
          );
        }
      }

      throw new ConnectionError(
        `Failed to connect to DuckDB at ${dbPath}`,
        err as Error,
      );
    }
  }

  /**
   * Check whether an error message indicates database file corruption.
   */
  private looksCorrupt(msg: string): boolean {
    return CORRUPTION_PATTERNS.some((p) => msg.includes(p));
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
