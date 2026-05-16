/**
 * @module tests/server/route-tz-smoke
 *
 * Param-index regression smoke test sweep across every route the ACT-001 /
 * SEM2-293 patch shifted from `(filters, 3)` to `(filters, 4)`. The point is
 * *not* to assert business semantics — those are covered by the analyzer-
 * level tests and the activity route test. The point is to catch a miscounted
 * `$N` bind that would surface as a DuckDB "Bind error: parameter $N not
 * found" or wrong-row-count error.
 *
 * We exercise:
 *   /api/cost/{daily, trend}
 *   /api/cache/trend
 *   /api/tools/failure-trend
 *   /api/skills/trend
 *
 * with ?period + model/project filters AND a tz header, against a DuckDB
 * seeded with the minimum schema each route needs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express, { type Express } from "express";

interface Handle {
  baseUrl: string;
  close: () => Promise<void>;
}

async function bootRoutes(): Promise<Handle> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-smoke-"));
  const dbPath = path.join(tmpDir, "test.duckdb");
  process.env.DB_PATH = dbPath;

  const { default: costRouter } = await import(
    "../../dashboard/src/server/routes/cost.js"
  );
  const { default: cacheRouter } = await import(
    "../../dashboard/src/server/routes/cache.js"
  );
  const { default: toolsRouter } = await import(
    "../../dashboard/src/server/routes/tools.js"
  );
  const { default: skillsRouter } = await import(
    "../../dashboard/src/server/routes/skills.js"
  );
  const dbHelper = await import("../../dashboard/src/server/helpers/db.js");

  // Seed minimal schema. Each `query` call will trigger the helper's first-
  // run view-init / index-rebuild pre-flight, so order matters: create
  // tables BEFORE the first SELECT-style query runs.
  await dbHelper.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id VARCHAR PRIMARY KEY,
      start_time TIMESTAMP,
      end_time TIMESTAMP,
      duration_seconds INTEGER,
      model VARCHAR,
      input_tokens BIGINT,
      output_tokens BIGINT,
      cache_creation_tokens BIGINT,
      cache_read_tokens BIGINT,
      total_cost_usd DOUBLE,
      num_turns INTEGER,
      num_tool_calls INTEGER,
      project_path VARCHAR,
      project_name VARCHAR,
      source_type VARCHAR
    );
    CREATE TABLE IF NOT EXISTS conversation_turns (
      turn_id VARCHAR PRIMARY KEY,
      session_id VARCHAR,
      role VARCHAR,
      timestamp TIMESTAMP,
      input_tokens BIGINT,
      output_tokens BIGINT,
      cache_creation_tokens BIGINT,
      cache_read_tokens BIGINT,
      cost_usd DOUBLE,
      model VARCHAR,
      stop_reason VARCHAR,
      request_id VARCHAR,
      has_tool_use BOOLEAN,
      has_thinking BOOLEAN
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      tool_call_id VARCHAR PRIMARY KEY,
      session_id VARCHAR,
      turn_id VARCHAR,
      tool_name VARCHAR,
      tool_type VARCHAR,
      mcp_server VARCHAR,
      duration_ms INTEGER,
      success BOOLEAN,
      error_message VARCHAR,
      parameters JSON,
      skill_name VARCHAR,
      skill_caller_type VARCHAR
    );
    CREATE TABLE IF NOT EXISTS session_skills (
      session_skill_id VARCHAR PRIMARY KEY,
      session_id VARCHAR,
      record_uuid VARCHAR,
      skill_name VARCHAR,
      skill_description VARCHAR,
      skill_count INTEGER,
      is_initial BOOLEAN,
      captured_at TIMESTAMP,
      source VARCHAR
    );
  `);
  await dbHelper.query(`
    INSERT INTO sessions VALUES (
      's1', '2026-05-13 22:30:00', '2026-05-13 22:31:00', 60,
      'claude-sonnet-4-5', 100, 50, 0, 0, 0.01, 1, 0, '/projects/alpha', 'alpha', 'claude-code'
    );
    INSERT INTO conversation_turns VALUES (
      't1', 's1', 'assistant', '2026-05-13 22:30:00',
      100, 50, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'r1', TRUE, FALSE
    );
    INSERT INTO tool_calls VALUES (
      'tc1', 's1', 't1', 'Read', 'native', NULL, 50, TRUE, NULL, '{}'::JSON, NULL, NULL
    );
  `);

  const app: Express = express();
  app.use(express.json());
  app.use("/api/cost", costRouter);
  app.use("/api/cache", cacheRouter);
  app.use("/api/tools", toolsRouter);
  app.use("/api/skills", skillsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dbHelper.closeDb();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("route-tz-smoke — param-index regression after ACT-001 shift", () => {
  let h: Handle;
  let prevDbPath: string | undefined;

  beforeAll(async () => {
    prevDbPath = process.env.DB_PATH;
    h = await bootRoutes();
  });

  afterAll(async () => {
    await h.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
  });

  const headers = { "X-User-Timezone": "Asia/Jerusalem" };

  it.each([
    "/api/cost/daily?period=7d&model=sonnet&project=alpha",
    "/api/cost/trend?period=7d&bucket=day&model=sonnet&project=alpha",
    "/api/cache/trend?period=7d&model=sonnet&project=alpha",
    "/api/tools/failure-trend?period=7d&bucket=day&model=sonnet&project=alpha",
    "/api/skills/trend?period=7d&bucket=day&model=sonnet&project=alpha",
  ])("%s returns 200 with both header tz + filter params (no bind error)", async (endpoint) => {
    const res = await fetch(`${h.baseUrl}${endpoint}`, { headers });
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      throw new Error(`expected 200, got ${res.status}: ${body}`);
    }
    const body = (await res.json()) as { data: unknown };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("/api/cost/daily — UTC returns date 2026-05-13; Israel returns 2026-05-14 for the same row", async () => {
    const utc = (await (
      await fetch(`${h.baseUrl}/api/cost/daily?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      })
    ).json()) as { data: Array<{ date: string }> };
    const il = (await (
      await fetch(`${h.baseUrl}/api/cost/daily?period=all`, {
        headers: { "X-User-Timezone": "Asia/Jerusalem" },
      })
    ).json()) as { data: Array<{ date: string }> };

    expect(utc.data.map((r) => r.date)).toEqual(["2026-05-13"]);
    expect(il.data.map((r) => r.date)).toEqual(["2026-05-14"]);
  });

  it("/api/cache/trend — same row, different local date depending on tz", async () => {
    const utc = (await (
      await fetch(`${h.baseUrl}/api/cache/trend?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      })
    ).json()) as { data: Array<{ timestamp: string }> };
    const il = (await (
      await fetch(`${h.baseUrl}/api/cache/trend?period=all`, {
        headers: { "X-User-Timezone": "Asia/Jerusalem" },
      })
    ).json()) as { data: Array<{ timestamp: string }> };

    expect(utc.data[0]?.timestamp.slice(0, 10)).toBe("2026-05-13");
    expect(il.data[0]?.timestamp.slice(0, 10)).toBe("2026-05-14");
  });
});
