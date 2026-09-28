/**
 * @module tests/db/connection
 *
 * Tests for ConnectionManager, including that a failed open never modifies
 * the database or its WAL.
 */

import { describe, it, expect, afterEach } from "vitest";
import { ConnectionManager } from "../../src/db/connection.js";
import {
  corruptWal,
  holdOpen,
  makeDbWithWal,
  release,
  snapshotDir,
  writeGarbageDb,
} from "../helpers/damaged-db.js";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-test-"));
  return path.join(dir, "test.duckdb");
}

function cleanup(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    fs.rmSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

describe("ConnectionManager", () => {
  const paths: string[] = [];
  let holder: ChildProcess | null = null;

  afterEach(async () => {
    if (holder) {
      await release(holder);
      holder = null;
    }
    for (const p of paths) {
      cleanup(p);
    }
    paths.length = 0;
  });

  it("should open a fresh database successfully", async () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);
    const cm = new ConnectionManager();
    await cm.open(dbPath);
    expect(cm.isOpen()).toBe(true);
    expect(cm.getDbPath()).toBe(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    await cm.close();
  });

  it("should open an in-memory database", async () => {
    const cm = new ConnectionManager();
    await cm.open(":memory:");
    expect(cm.isOpen()).toBe(true);
    await cm.close();
  });

  it("refuses a file that is not a DuckDB database and leaves it and its WAL untouched", async () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);
    writeGarbageDb(dbPath);
    fs.writeFileSync(`${dbPath}.wal`, Buffer.alloc(1024, 0xab));
    const before = snapshotDir(path.dirname(dbPath));

    const cm = new ConnectionManager();
    await expect(cm.open(dbPath)).rejects.toMatchObject({
      name: "DatabaseOpenError",
      reason: "unreadable",
      walPresent: true,
    });

    expect(cm.isOpen()).toBe(false);
    expect(snapshotDir(path.dirname(dbPath))).toEqual(before);
  });

  it("refuses to replay a damaged WAL and leaves both files untouched", async () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);
    makeDbWithWal(dbPath);
    corruptWal(dbPath);
    const before = snapshotDir(path.dirname(dbPath));

    const cm = new ConnectionManager();
    await expect(cm.open(dbPath)).rejects.toMatchObject({
      name: "DatabaseOpenError",
      reason: "wal-replay",
    });

    expect(snapshotDir(path.dirname(dbPath))).toEqual(before);
  });

  it("reports a database another process holds open as locked", async () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);
    const first = new ConnectionManager();
    await first.open(dbPath);
    await first.close();
    holder = await holdOpen(dbPath);

    const cm = new ConnectionManager();
    await expect(cm.open(dbPath)).rejects.toMatchObject({
      name: "DatabaseOpenError",
      reason: "locked",
    });
  });

  it("should close cleanly and allow re-open", async () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);
    const cm = new ConnectionManager();

    await cm.open(dbPath);
    expect(cm.isOpen()).toBe(true);
    await cm.close();
    expect(cm.isOpen()).toBe(false);

    // Re-open the same path
    await cm.open(dbPath);
    expect(cm.isOpen()).toBe(true);
    await cm.close();
  });
});
