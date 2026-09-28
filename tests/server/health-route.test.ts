/**
 * @module tests/server/health-route
 *
 * GET /api/health reports the models costed at fallback rates, which the
 * dashboard shows as a banner.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import healthRouter from "../../dashboard/src/server/routes/health.js";

type DbHelper = typeof import("../../dashboard/src/server/helpers/db.js");

let db: DbHelper;
let tmpDir: string;
let server: http.Server;
let baseUrl: string;
let prevDbPath: string | undefined;
let prevConfigPath: string | undefined;

interface HealthBody {
  status: string;
  pricing?: { unpricedModels: { model: string; turns: number; subAgents: number }[] };
}

async function health(): Promise<{ status: number; body: HealthBody }> {
  const response = await fetch(`${baseUrl}/api/health`);
  return { status: response.status, body: (await response.json()) as HealthBody };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-health-"));
  prevDbPath = process.env.DB_PATH;
  prevConfigPath = process.env.CCANALYTICS_CONFIG_PATH;
  process.env.DB_PATH = path.join(tmpDir, "test.duckdb");
  process.env.CCANALYTICS_CONFIG_PATH = path.join(tmpDir, "config.json");

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

describe("GET /api/health — pricing coverage", () => {
  it("reports no unpriced models before the tables exist", async () => {
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.pricing?.unpricedModels).toEqual([]);
  });

  it("lists the models that have no pricing entry", async () => {
    await db.query(`CREATE TABLE conversation_turns (role VARCHAR, model VARCHAR)`);
    await db.query(`CREATE TABLE sub_agents (model VARCHAR)`);
    await db.query(`INSERT INTO conversation_turns VALUES
      ('assistant', 'claude-opus-5-5'), ('assistant', 'claude-opus-6'), ('user', NULL)`);
    await db.query(`INSERT INTO sub_agents VALUES ('claude-opus-6'), ('claude-sonnet-5')`);

    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.pricing?.unpricedModels).toEqual([
      { model: "claude-opus-6", turns: 1, subAgents: 1 },
    ]);
  });
});
