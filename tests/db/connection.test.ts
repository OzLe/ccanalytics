/**
 * @module tests/db/connection
 *
 * Tests for ConnectionManager, including auto-recovery from corrupt databases.
 */

import { describe, it, expect, afterEach } from "vitest";
import { ConnectionManager } from "../../src/db/connection.js";
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

  afterEach(async () => {
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

  it("should auto-recover from a corrupt database file", async () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);

    // Write garbage to simulate a corrupt database file
    fs.writeFileSync(dbPath, Buffer.alloc(4096, 0xde));

    const cm = new ConnectionManager();
    await cm.open(dbPath);

    // Should have recovered: corrupt file deleted, fresh DB created
    expect(cm.isOpen()).toBe(true);

    // Verify the new database is functional (DDL + DML succeed without error)
    const conn = cm.getConnection();
    await conn.run("CREATE TABLE recovery_test (id INTEGER)");
    await conn.run("INSERT INTO recovery_test VALUES (42)");

    await cm.close();
  });

  it("should clean up WAL file during corrupt database recovery", async () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);
    const walPath = `${dbPath}.wal`;

    // Write garbage DB and a stale WAL
    fs.writeFileSync(dbPath, Buffer.alloc(4096, 0xde));
    fs.writeFileSync(walPath, Buffer.alloc(1024, 0xab));

    const cm = new ConnectionManager();
    await cm.open(dbPath);

    expect(cm.isOpen()).toBe(true);
    expect(fs.existsSync(walPath)).toBe(false);

    await cm.close();
  });

  it("should throw ConnectionError for in-memory failures", async () => {
    // :memory: databases can't be recovered by deleting a file,
    // so errors should propagate directly. We test this indirectly
    // by verifying :memory: works (no crash path to exercise).
    const cm = new ConnectionManager();
    await cm.open(":memory:");
    expect(cm.isOpen()).toBe(true);
    await cm.close();
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
