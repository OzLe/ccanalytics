/**
 * @module tests/server/db-open-failure
 *
 * The dashboard API server never deletes the database when it cannot open it
 * (it used to delete the WAL, and on some errors the whole file). It reports
 * the reason and the next step through /api/health, and opens the database on
 * a later request once the file is fixed, without a restart.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import healthRouter from "../../dashboard/src/server/routes/health.js";
import { snapshotDir, writeGarbageDb } from "../helpers/damaged-db.js";

type DbHelper = typeof import("../../dashboard/src/server/helpers/db.js");

let db: DbHelper;
let tmpDir: string;
let dbFile: string;
let server: http.Server;
let baseUrl: string;
let prevDbPath: string | undefined;
let prevConfigPath: string | undefined;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-openfail-"));
  dbFile = path.join(tmpDir, "test.duckdb");
  prevDbPath = process.env.DB_PATH;
  prevConfigPath = process.env.CCANALYTICS_CONFIG_PATH;
  process.env.DB_PATH = dbFile;
  process.env.CCANALYTICS_CONFIG_PATH = path.join(tmpDir, "config.json");
  writeGarbageDb(dbFile);

  db = await import("../../dashboard/src/server/helpers/db.js");
  const app = express();
  app.use("/api/health", healthRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.closeDb();
  if (prevDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = prevDbPath;
  if (prevConfigPath === undefined) delete process.env.CCANALYTICS_CONFIG_PATH;
  else process.env.CCANALYTICS_CONFIG_PATH = prevConfigPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("dashboard db helper — open failure", () => {
  it("rejects queries with the reason and leaves the file untouched", async () => {
    const before = snapshotDir(tmpDir);
    await expect(db.query("SELECT 1")).rejects.toMatchObject({
      name: "DatabaseOpenError",
      reason: "unreadable",
    });
    expect(snapshotDir(tmpDir)).toEqual(before);
  });

  it("answers /api/health with 503, the reason and the next step", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      status: string;
      database: { connected: boolean; reason?: string; hint?: string; error?: string };
    };
    expect(body.status).toBe("degraded");
    expect(body.database.connected).toBe(false);
    expect(body.database.reason).toBe("unreadable");
    expect(body.database.hint).toContain("ccanalytics db recover");
    expect(body.database.error).toContain("not a valid DuckDB database file");
  });

  it("opens the database on a later request once the file is fixed", async () => {
    fs.rmSync(dbFile);
    const result = await db.query<{ ok: number }>("SELECT 1 AS ok");
    expect(Number(result.rows[0]!.ok)).toBe(1);
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
  });
});
