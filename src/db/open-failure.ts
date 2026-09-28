/**
 * @module db/open-failure
 *
 * Explains why DuckDB could not open the ccanalytics database, without
 * touching the files. Used by the CLI's `ConnectionManager` and, loaded at
 * runtime, by the dashboard API server.
 *
 * Until 2026-09 both paths "recovered" from an open failure by deleting the
 * WAL, and for some error messages the whole database file (commits 8b3881a,
 * f347ff6). Claude Code keeps transcripts for 30 days, so the database is the
 * only copy of older history: an open failure is now reported, never repaired
 * implicitly. `ccanalytics db recover` (db/recover) is the explicit,
 * backed-up path.
 */

import { existsSync } from "node:fs";
import { DatabaseOpenError, type DatabaseOpenReason } from "../errors.js";

/**
 * Classify a DuckDB open error by its message. The substrings match what
 * DuckDB 1.4.5 reports for each case:
 *   - locked:     `Could not set lock on file "…": Conflicting lock is held in …`
 *   - wal-replay: `Failure while replaying WAL file "…": Corrupt WAL file: …`
 *   - version:    `Trying to read a database file with version number 68, but
 *                 we can only read versions between 64 and 67`
 *   - unreadable: anything else, e.g. `… is not a valid DuckDB database file!`
 *                 or `Could not read enough bytes from file …`
 */
export function classifyOpenFailure(message: string): DatabaseOpenReason {
  if (message.includes("Could not set lock on file")) return "locked";
  if (message.includes("replaying WAL")) return "wal-replay";
  if (message.includes("database file with version number")) return "version";
  return "unreadable";
}

const STOP_DASHBOARD =
  "stop the dashboard (LaunchAgent: `launchctl bootout gui/$(id -u)/com.ccanalytics.web`)";

const HINTS: Record<DatabaseOpenReason, string> = {
  locked:
    "Another process has the database open: the dashboard, `ccanalytics watch` or another command. " +
    "Stop it or let it finish, then retry.",
  "wal-replay":
    `The write-ahead log could not be replayed; nothing was changed. ${capitalize(STOP_DASHBOARD)}, ` +
    "then run `ccanalytics db recover`: it backs up both files and sets the log aside, " +
    "and `ccanalytics ingest` re-reads the lost changes from the transcripts.",
  version:
    "The file was written by a DuckDB version this build cannot read; nothing was changed. " +
    "Use a ccanalytics build whose DuckDB can read it, and do not restore a backup over it.",
  unreadable:
    `The database file could not be read; nothing was changed. ${capitalize(STOP_DASHBOARD)}, ` +
    "then run `ccanalytics db recover`: it backs the file up and lists the backups you can restore.",
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Build the error to throw when DuckDB fails to open `dbPath`. Never touches
 * the files. An in-memory database has no files, so it gets no hint.
 */
export function describeOpenFailure(dbPath: string, err: Error): DatabaseOpenError {
  const reason = classifyOpenFailure(err.message ?? "");
  const inMemory = dbPath === ":memory:";
  return new DatabaseOpenError(
    {
      dbPath,
      walPresent: !inMemory && existsSync(`${dbPath}.wal`),
      reason,
      hint: inMemory ? "" : HINTS[reason],
    },
    err,
  );
}
