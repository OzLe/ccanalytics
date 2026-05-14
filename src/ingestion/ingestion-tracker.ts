/**
 * @module ingestion/ingestion-tracker
 *
 * Tracks byte-offset ingestion state per JSONL file.
 * Uses the ingestion_state table to enable incremental ingestion,
 * so only new data is processed on subsequent runs.
 */

import type { IngestionState } from "../types/index.js";
import type { ConnectionLike } from "../db/connection.js";

/**
 * Tracks the ingestion progress for each JSONL file.
 * Persists state in the ingestion_state table for incremental reads.
 */
export class IngestionTracker {
  constructor(private db: ConnectionLike) {}

  /**
   * Get the raw DuckDB connection for direct SQL execution.
   */
  private get conn(): any {
    return this.db.getConnection() as any;
  }

  /**
   * Escape a string for SQL by doubling single quotes.
   */
  private escapeStr(v: string): string {
    return v.replace(/'/g, "''");
  }

  /**
   * Get the last ingestion state for a file.
   * Returns null if the file has never been ingested.
   *
   * @param filePath - Absolute path to the JSONL file
   * @returns Ingestion state, or null if not previously ingested
   */
  async getState(filePath: string): Promise<IngestionState | null> {
    const sql = `SELECT * FROM ingestion_state WHERE file_path = '${this.escapeStr(filePath)}'`;
    const reader = await this.conn.runAndReadAll(sql);
    const rows = reader.getRowObjectsJS();
    if (!rows || rows.length === 0) {
      return null;
    }
    const row = rows[0] as Record<string, unknown>;
    return {
      file_path: row.file_path as string,
      last_byte_offset: Number(row.last_byte_offset),
      last_line_number: Number(row.last_line_number),
      last_ingested_at: row.last_ingested_at instanceof Date
        ? row.last_ingested_at
        : new Date(row.last_ingested_at as string),
      file_checksum: (row.file_checksum as string) ?? null,
      file_size_bytes: row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
    };
  }

  /**
   * Update the ingestion state for a file after a successful pass.
   * Uses UPSERT (INSERT ... ON CONFLICT) for idempotency.
   *
   * @param filePath - Absolute path to the JSONL file
   * @param offset - New byte offset after successful ingestion
   * @param lineNumber - New line number after successful ingestion
   */
  async updateState(
    filePath: string,
    offset: number,
    lineNumber: number,
  ): Promise<void> {
    const sql = `INSERT INTO ingestion_state (file_path, last_byte_offset, last_line_number, last_ingested_at)
      VALUES ('${this.escapeStr(filePath)}', ${offset}, ${lineNumber}, NOW())
      ON CONFLICT(file_path) DO UPDATE SET
        last_byte_offset = ${offset},
        last_line_number = ${lineNumber},
        last_ingested_at = NOW()`;
    await this.conn.run(sql);
  }

  /**
   * Get all tracked file states. Useful for status reporting.
   *
   * @returns Map of file path to ingestion state
   */
  async getAllStates(): Promise<Map<string, IngestionState>> {
    const sql = "SELECT * FROM ingestion_state";
    const reader = await this.conn.runAndReadAll(sql);
    const rows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
    const map = new Map<string, IngestionState>();
    for (const row of rows) {
      const state: IngestionState = {
        file_path: row.file_path as string,
        last_byte_offset: Number(row.last_byte_offset),
        last_line_number: Number(row.last_line_number),
        last_ingested_at: row.last_ingested_at instanceof Date
          ? row.last_ingested_at
          : new Date(row.last_ingested_at as string),
        file_checksum: (row.file_checksum as string) ?? null,
        file_size_bytes: row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
      };
      map.set(state.file_path, state);
    }
    return map;
  }

  /**
   * Reset state for a file (used with --force flag).
   * Deletes the ingestion state record, causing full re-ingestion on next run.
   *
   * @param filePath - Absolute path to the JSONL file
   */
  async resetState(filePath: string): Promise<void> {
    const sql = `DELETE FROM ingestion_state WHERE file_path = '${this.escapeStr(filePath)}'`;
    await this.conn.run(sql);
  }

  /**
   * Reset state for all files.
   * Used with `ingest --full` to force complete re-ingestion.
   */
  async resetAll(): Promise<void> {
    await this.conn.run("DELETE FROM ingestion_state");
  }
}
