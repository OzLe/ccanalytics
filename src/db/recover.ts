/**
 * @module db/recover
 *
 * `ccanalytics db recover`: the explicit, backed-up path for a database that
 * will not open. It never deletes a file and never creates an empty database.
 *
 *   1. If the database opens, there is nothing to do.
 *   2. If another process holds the lock, or the file needs a different DuckDB
 *      version, stop: the file is fine.
 *   3. Otherwise copy the database, and its WAL if any, into the backups
 *      directory before changing anything.
 *   4. If the WAL failed to replay, rename it aside and open again. The next
 *      `ccanalytics ingest` re-reads the lost changes from the transcripts,
 *      because the ingestion offsets roll back together with the WAL.
 *   5. If the database file itself cannot be opened, put the WAL back and list
 *      the backups to restore from; restoring stays a manual step.
 */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { DatabaseOpenError } from "../errors.js";
import { ConnectionManager } from "./connection.js";

/** Files written by one recovery backup. */
export interface BackupFiles {
  db: string;
  wal: string | null;
}

/** A database backup that could be restored. */
export interface BackupEntry {
  path: string;
  walPath: string | null;
  sizeBytes: number;
  modified: Date;
}

export type RecoverOutcome =
  | { kind: "no-database"; dbPath: string }
  | { kind: "healthy"; dbPath: string }
  | { kind: "not-repairable"; dbPath: string; error: DatabaseOpenError }
  | {
      kind: "wal-set-aside";
      dbPath: string;
      error: DatabaseOpenError;
      backup: BackupFiles;
      setAsideWal: string;
    }
  | {
      kind: "needs-restore";
      dbPath: string;
      error: DatabaseOpenError;
      backup: BackupFiles;
      backups: BackupEntry[];
      stamp: string;
    };

export interface RecoverOptions {
  /** Where backups are written and looked for; default `<db dir>/backups`. */
  backupsDir?: string;
  /** Clock for backup names; default now. */
  now?: Date;
}

/** `20260928-140630`, the timestamp format of the existing backups. */
export function backupTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Recover a database that will not open, as described in the module header.
 *
 * @param dbPath - The database file
 * @returns What was found and done
 */
export async function recoverDatabase(
  dbPath: string,
  options: RecoverOptions = {},
): Promise<RecoverOutcome> {
  // Opening a missing path would create an empty database.
  if (!existsSync(dbPath)) return { kind: "no-database", dbPath };

  const error = await tryOpen(dbPath);
  if (!error) return { kind: "healthy", dbPath };
  if (error.reason === "locked" || error.reason === "version") {
    return { kind: "not-repairable", dbPath, error };
  }

  const stamp = backupTimestamp(options.now ?? new Date());
  const backupsDir =
    options.backupsDir ?? path.join(path.dirname(dbPath), "backups");
  const backup = backUp(dbPath, backupsDir, stamp);

  const walPath = `${dbPath}.wal`;
  let finalError = error;
  if (error.reason === "wal-replay" && existsSync(walPath)) {
    const setAsideWal = `${walPath}.quarantined-${stamp}`;
    renameSync(walPath, setAsideWal);
    const retryError = await tryOpen(dbPath);
    if (!retryError) {
      return { kind: "wal-set-aside", dbPath, error, backup, setAsideWal };
    }
    // The log was not the only problem: restore the original layout.
    renameSync(setAsideWal, walPath);
    finalError = retryError;
  }

  return {
    kind: "needs-restore",
    dbPath,
    error: finalError,
    backup,
    backups: listBackups(backupsDir),
    stamp,
  };
}

/** Open and close the database; returns the open error, if any. */
async function tryOpen(dbPath: string): Promise<DatabaseOpenError | null> {
  const cm = new ConnectionManager();
  try {
    await cm.open(dbPath);
    return null;
  } catch (err) {
    if (err instanceof DatabaseOpenError) return err;
    throw err;
  } finally {
    await cm.close();
  }
}

/** Copy the database and its WAL into `backupsDir` before anything changes. */
function backUp(dbPath: string, backupsDir: string, stamp: string): BackupFiles {
  mkdirSync(backupsDir, { recursive: true });
  const base = path.basename(dbPath).replace(/\.duckdb$/, "");
  const db = path.join(backupsDir, `${base}-pre-recover-${stamp}.duckdb`);
  copyVerified(dbPath, db);
  const walPath = `${dbPath}.wal`;
  if (!existsSync(walPath)) return { db, wal: null };
  const wal = `${db}.wal`;
  copyVerified(walPath, wal);
  return { db, wal };
}

/** Copy without overwriting anything, and never trust a short copy. */
function copyVerified(from: string, to: string): void {
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  if (statSync(to).size !== statSync(from).size) {
    throw new Error(`Backup ${to} is not a full copy of ${from}; nothing else was changed.`);
  }
}

/**
 * Restorable backups in `dir`, newest first. Copies taken by a recovery are
 * left out: they hold a database that did not open.
 */
export function listBackups(dir: string): BackupEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".duckdb") && !name.includes("-pre-recover-"))
    .map((name) => {
      const file = path.join(dir, name);
      const stat = statSync(file);
      return {
        path: file,
        walPath: existsSync(`${file}.wal`) ? `${file}.wal` : null,
        sizeBytes: stat.size,
        modified: stat.mtime,
      };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

const START_DASHBOARD =
  "Start the dashboard again afterwards (LaunchAgent: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccanalytics.web.plist`).";

/**
 * The report `ccanalytics db recover` prints, and its exit code: 0 when the
 * database opens afterwards, 2 when the user still has to act.
 */
export function describeRecoverOutcome(outcome: RecoverOutcome): {
  lines: string[];
  exitCode: number;
} {
  switch (outcome.kind) {
    case "no-database":
      return {
        lines: [
          `No database at ${outcome.dbPath}; nothing to recover.`,
          "The next `ccanalytics ingest` creates one.",
        ],
        exitCode: 0,
      };
    case "healthy":
      return {
        lines: [`The database ${outcome.dbPath} opens normally; nothing to recover.`],
        exitCode: 0,
      };
    case "not-repairable":
      return { lines: [outcome.error.message, outcome.error.hint], exitCode: 2 };
    case "wal-set-aside":
      return {
        lines: [
          "The database opens again without its write-ahead log.",
          `  Backup:         ${formatBackup(outcome.backup)}`,
          `  Log set aside:  ${outcome.setAsideWal}`,
          "Run `ccanalytics ingest` to re-read the changes the log held from the transcripts on disk.",
          START_DASHBOARD,
        ],
        exitCode: 0,
      };
    case "needs-restore":
      return { lines: describeRestore(outcome), exitCode: 2 };
  }
}

function describeRestore(
  outcome: Extract<RecoverOutcome, { kind: "needs-restore" }>,
): string[] {
  const { dbPath, error, backup, backups, stamp } = outcome;
  const lines = [
    error.message,
    `  Backup of the file as it is: ${formatBackup(backup)}`,
    "Nothing was deleted or replaced.",
  ];
  const walPath = `${dbPath}.wal`;
  const newest = backups[0];
  if (!newest) {
    lines.push(
      "No backups to restore from. Only the transcripts on disk (the last 30 days) remain:",
      "move the damaged file aside and run `ccanalytics ingest` to start a new database.",
      `  mv "${dbPath}" "${dbPath}.damaged-${stamp}"`,
    );
    if (existsSync(walPath)) lines.push(`  mv "${walPath}" "${walPath}.damaged-${stamp}"`);
    return lines;
  }

  lines.push("Backups to restore from, newest first:");
  for (const entry of backups) {
    const size = `${(entry.sizeBytes / 1024 / 1024).toFixed(1)} MB`.padStart(10);
    lines.push(
      `  ${formatLocal(entry.modified)}  ${size}  ${entry.path}${entry.walPath ? " (+ .wal)" : ""}`,
    );
  }
  lines.push("To restore the newest, with the dashboard stopped:");
  lines.push(`  cp "${newest.path}" "${dbPath}"`);
  if (newest.walPath) {
    lines.push(`  cp "${newest.walPath}" "${walPath}"`);
  } else if (existsSync(walPath)) {
    lines.push(`  mv "${walPath}" "${walPath}.damaged-${stamp}"`);
  }
  lines.push(
    "Then run `ccanalytics ingest` to re-read the transcripts on disk (the last 30 days).",
    START_DASHBOARD,
  );
  return lines;
}

function formatBackup(backup: BackupFiles): string {
  return backup.wal ? `${backup.db} (+ ${path.basename(backup.wal)})` : backup.db;
}

function formatLocal(date: Date): string {
  const stamp = backupTimestamp(date);
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}`;
}
