/**
 * @module tests/db/recover
 *
 * `ccanalytics db recover`: backs up before changing anything, sets a damaged
 * WAL aside, never deletes, and lists the backups to restore from.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConnectionManager } from "../../src/db/connection.js";
import { describeOpenFailure } from "../../src/db/open-failure.js";
import {
  backupTimestamp,
  describeRecoverOutcome,
  listBackups,
  recoverDatabase,
} from "../../src/db/recover.js";
import {
  CHECKPOINTED_ROWS,
  corruptWal,
  hashFile,
  holdOpen,
  makeDbWithWal,
  release,
  snapshotDir,
  writeGarbageDb,
} from "../helpers/damaged-db.js";

const NOW = new Date(2026, 8, 28, 14, 6, 30);
const STAMP = "20260928-140630";

let dir: string;
let dbPath: string;
let backupsDir: string;
let holder: ChildProcess | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-recover-"));
  dbPath = path.join(dir, "analytics.duckdb");
  backupsDir = path.join(dir, "backups");
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (holder) {
    await release(holder);
    holder = null;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function countRows(): Promise<number> {
  const cm = new ConnectionManager();
  await cm.open(dbPath);
  try {
    const reader = await cm.getConnection().runAndReadAll("SELECT COUNT(*)::INTEGER AS n FROM t");
    return Number((reader.getRowObjectsJS()[0] as { n: number }).n);
  } finally {
    await cm.close();
  }
}

describe("backupTimestamp", () => {
  it("matches the existing backup names", () => {
    expect(backupTimestamp(NOW)).toBe(STAMP);
  });
});

describe("recoverDatabase", () => {
  it("reports a missing database without creating one", async () => {
    const outcome = await recoverDatabase(dbPath, { backupsDir, now: NOW });
    expect(outcome.kind).toBe("no-database");
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(describeRecoverOutcome(outcome).exitCode).toBe(0);
  });

  it("leaves a database that opens alone", async () => {
    const cm = new ConnectionManager();
    await cm.open(dbPath);
    await cm.close();

    const outcome = await recoverDatabase(dbPath, { backupsDir, now: NOW });
    expect(outcome.kind).toBe("healthy");
    expect(fs.existsSync(backupsDir)).toBe(false);
  });

  it("backs up both files, then sets a damaged WAL aside so the database opens", async () => {
    makeDbWithWal(dbPath);
    corruptWal(dbPath);
    const dbHash = hashFile(dbPath);
    const walHash = hashFile(`${dbPath}.wal`);

    const outcome = await recoverDatabase(dbPath, { backupsDir, now: NOW });

    expect(outcome.kind).toBe("wal-set-aside");
    if (outcome.kind !== "wal-set-aside") return;
    expect(outcome.backup.db).toBe(path.join(backupsDir, `analytics-pre-recover-${STAMP}.duckdb`));
    expect(hashFile(outcome.backup.db)).toBe(dbHash);
    expect(hashFile(outcome.backup.wal!)).toBe(walHash);
    expect(outcome.setAsideWal).toBe(`${dbPath}.wal.quarantined-${STAMP}`);
    expect(hashFile(outcome.setAsideWal)).toBe(walHash);
    expect(fs.existsSync(`${dbPath}.wal`)).toBe(false);
    expect(await countRows()).toBe(CHECKPOINTED_ROWS);

    const report = describeRecoverOutcome(outcome);
    expect(report.exitCode).toBe(0);
    expect(report.lines.join("\n")).toContain("ccanalytics ingest");
  });

  it("backs up a damaged database file and lists restorable backups, newest first", async () => {
    writeGarbageDb(dbPath);
    fs.mkdirSync(backupsDir);
    const older = path.join(backupsDir, "analytics-pre-a-20260101-000000.duckdb");
    const newer = path.join(backupsDir, "analytics-pre-b-20260201-000000.duckdb");
    const earlierRecovery = path.join(backupsDir, "analytics-pre-recover-20250101-000000.duckdb");
    for (const file of [older, `${older}.wal`, newer, earlierRecovery]) {
      fs.writeFileSync(file, "x");
    }
    fs.utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
    fs.utimesSync(newer, new Date(2026, 1, 1), new Date(2026, 1, 1));
    const dbHash = hashFile(dbPath);

    const outcome = await recoverDatabase(dbPath, { backupsDir, now: NOW });

    expect(outcome.kind).toBe("needs-restore");
    if (outcome.kind !== "needs-restore") return;
    expect(hashFile(dbPath)).toBe(dbHash);
    expect(hashFile(outcome.backup.db)).toBe(dbHash);
    expect(outcome.backups.map((b) => b.path)).toEqual([newer, older]);
    expect(outcome.backups[1]!.walPath).toBe(`${older}.wal`);

    const report = describeRecoverOutcome(outcome);
    expect(report.exitCode).toBe(2);
    const text = report.lines.join("\n");
    expect(text).toContain(`cp "${newer}" "${dbPath}"`);
    expect(text).toContain("Nothing was deleted or replaced.");
  });

  it("tells the user how to start over when there are no backups", async () => {
    writeGarbageDb(dbPath);
    const outcome = await recoverDatabase(dbPath, { backupsDir, now: NOW });
    expect(outcome.kind).toBe("needs-restore");
    const text = describeRecoverOutcome(outcome).lines.join("\n");
    expect(text).toContain("No backups to restore from");
    expect(text).toContain(`mv "${dbPath}" "${dbPath}.damaged-${STAMP}"`);
  });

  it("puts the WAL back when the database still does not open without it", async () => {
    makeDbWithWal(dbPath);
    const walHash = hashFile(`${dbPath}.wal`);
    const walError = describeOpenFailure(dbPath, new Error("IO Error: Failure while replaying WAL file"));
    const fileError = describeOpenFailure(dbPath, new Error("IO Error: Could not read enough bytes"));
    vi.spyOn(ConnectionManager.prototype, "open")
      .mockRejectedValueOnce(walError)
      .mockRejectedValueOnce(fileError);

    const outcome = await recoverDatabase(dbPath, { backupsDir, now: NOW });

    expect(outcome.kind).toBe("needs-restore");
    if (outcome.kind !== "needs-restore") return;
    expect(outcome.error).toBe(fileError);
    expect(hashFile(`${dbPath}.wal`)).toBe(walHash);
    expect(fs.existsSync(`${dbPath}.wal.quarantined-${STAMP}`)).toBe(false);
  });

  it("stops at a lock held by another process without copying anything", async () => {
    const cm = new ConnectionManager();
    await cm.open(dbPath);
    await cm.close();
    holder = await holdOpen(dbPath);
    const before = snapshotDir(dir);

    const outcome = await recoverDatabase(dbPath, { backupsDir, now: NOW });

    expect(outcome.kind).toBe("not-repairable");
    if (outcome.kind !== "not-repairable") return;
    expect(outcome.error.reason).toBe("locked");
    expect(snapshotDir(dir)).toEqual(before);
    expect(fs.existsSync(backupsDir)).toBe(false);
    expect(describeRecoverOutcome(outcome).exitCode).toBe(2);
  });
});

describe("listBackups", () => {
  it("returns nothing for a missing directory", () => {
    expect(listBackups(path.join(os.tmpdir(), "ccanalytics-no-such-dir"))).toEqual([]);
  });
});
