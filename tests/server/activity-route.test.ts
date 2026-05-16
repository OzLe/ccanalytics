/**
 * @module tests/server/activity-route
 *
 * End-to-end integration tests for /api/activity/* (dashboard side). Mounts
 * the activity router on a real express app, drives it through a real http
 * listener, and asserts the SQL behaviour against a temp DuckDB file.
 *
 * This is the "Step F" integration sweep from the ACT-001 / SEM2-293 plan:
 *
 *   - /api/activity/hourly cardinality invariant — switching `?…&X-User-Timezone`
 *     re-partitions the bucket but preserves the total messageCount.
 *   - /api/activity/{hourly, daily, heatmap} all read the same row with the
 *     same hour/date depending on the requested zone (Israel vs UTC).
 *   - Param-index regression — every endpoint accepts ?period & filter
 *     params alongside the timezone header without throwing a SQL error
 *     (catches a miscounted `$N`).
 *
 * The dashboard `db.ts` helper uses a module-level singleton connection. We
 * set `DB_PATH=<temp>` BEFORE any helper import (via dynamic import) and seed
 * the schema + fixtures through the same connection the route handlers use,
 * so there's no cross-pollination between tests.
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

/**
 * Boot the activity router against a fresh DuckDB file, seeded with the
 * fixture rows the assertions below depend on. All ACT-001 cases here use a
 * single fixture row at 2026-05-13T22:30:00Z so the hour/date/DOW pivot is
 * unambiguous when the requested zone changes.
 */
async function bootRouter(): Promise<Handle> {
  // Fresh temp DB before importing the helper — the dashboard's db.ts caches
  // the connection at first call.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-act-"));
  const dbPath = path.join(tmpDir, "test.duckdb");
  process.env.DB_PATH = dbPath;

  // Dynamic import so the env var is honoured by initConnection().
  const { default: activityRouter } = await import(
    "../../dashboard/src/server/routes/activity.js"
  );
  const dbHelper = await import("../../dashboard/src/server/helpers/db.js");

  // Seed schema directly through the helper's singleton connection — that's
  // the SAME connection the route handlers will use, which guarantees the
  // route's view-init/index-rebuild pre-flight is already done.
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
  `);
  // Single, unambiguous fixture row: 22:30Z on Wed 2026-05-13.
  //   UTC      → date 2026-05-13, DOW 3 (Wed), hour 22
  //   Israel   → date 2026-05-14, DOW 4 (Thu), hour 1   (UTC+3 in May)
  //   NY (EDT) → date 2026-05-13, DOW 3 (Wed), hour 18  (UTC-4 in May)
  await dbHelper.query(`
    INSERT INTO sessions VALUES (
      'sess-1', '2026-05-13 22:30:00', '2026-05-13 22:31:00', 60,
      'claude-sonnet-4-5', 100, 50, 0, 0, 0.01, 1, 0, '/p', 'p', 'claude-code'
    );
  `);
  await dbHelper.query(`
    INSERT INTO conversation_turns VALUES (
      'turn-1', 'sess-1', 'assistant', '2026-05-13 22:30:00',
      100, 50, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'req-1', FALSE, FALSE
    );
    INSERT INTO conversation_turns VALUES (
      'turn-2', 'sess-1', 'assistant', '2026-05-13 03:00:00',
      80, 40, 0, 0, 0.005, 'claude-sonnet-4-5', 'end_turn', 'req-2', FALSE, FALSE
    );
  `);

  const app: Express = express();
  app.use(express.json());
  app.use("/api/activity", activityRouter);

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

describe("activity route — timezone projection (ACT-001)", () => {
  let h: Handle;
  let prevDbPath: string | undefined;

  beforeAll(async () => {
    prevDbPath = process.env.DB_PATH;
    h = await bootRouter();
  });

  afterAll(async () => {
    await h.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
  });

  it("/api/activity/hourly — UTC returns hour 22 (& 3); Israel returns hour 1 (& 6) for the same fixture rows", async () => {
    const utc = (await (
      await fetch(`${h.baseUrl}/api/activity/hourly?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      })
    ).json()) as { data: Array<{ hourOfDay: number; messageCount: number }> };
    const il = (await (
      await fetch(`${h.baseUrl}/api/activity/hourly?period=all`, {
        headers: { "X-User-Timezone": "Asia/Jerusalem" },
      })
    ).json()) as { data: Array<{ hourOfDay: number; messageCount: number }> };

    const utcHours = utc.data.map((r) => r.hourOfDay).sort((a, b) => a - b);
    const ilHours = il.data.map((r) => r.hourOfDay).sort((a, b) => a - b);

    // 03:00Z + 22:30Z → UTC hours 3 and 22; Israel hours 6 and 1.
    expect(utcHours).toEqual([3, 22]);
    expect(ilHours).toEqual([1, 6]);

    // Cardinality invariant: same total message count regardless of tz.
    const utcTotal = utc.data.reduce((s, r) => s + r.messageCount, 0);
    const ilTotal = il.data.reduce((s, r) => s + r.messageCount, 0);
    expect(utcTotal).toBe(2);
    expect(ilTotal).toBe(utcTotal);
  });

  it("/api/activity/daily — UTC returns 2026-05-13; Israel returns 2026-05-13 AND 2026-05-14 (22:30Z rolls over)", async () => {
    const utc = (await (
      await fetch(`${h.baseUrl}/api/activity/daily?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      })
    ).json()) as { data: Array<{ timestamp: string; value: number }> };
    const il = (await (
      await fetch(`${h.baseUrl}/api/activity/daily?period=all`, {
        headers: { "X-User-Timezone": "Asia/Jerusalem" },
      })
    ).json()) as { data: Array<{ timestamp: string; value: number }> };

    const utcDates = utc.data.map((r) => r.timestamp.slice(0, 10)).sort();
    const ilDates = il.data.map((r) => r.timestamp.slice(0, 10)).sort();

    expect(utcDates).toEqual(["2026-05-13"]);
    expect(ilDates).toEqual(["2026-05-13", "2026-05-14"]);

    // Cardinality: 2 turns total in both views.
    expect(utc.data.reduce((s, r) => s + r.value, 0)).toBe(2);
    expect(il.data.reduce((s, r) => s + r.value, 0)).toBe(2);
  });

  it("/api/activity/heatmap — Israel pivots the 22:30Z row from Wed (3) hour 22 to Thu (4) hour 1", async () => {
    const utc = (await (
      await fetch(`${h.baseUrl}/api/activity/heatmap?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      })
    ).json()) as {
      data: Array<{ dayOfWeek: number; hourOfDay: number; value: number }>;
    };
    const il = (await (
      await fetch(`${h.baseUrl}/api/activity/heatmap?period=all`, {
        headers: { "X-User-Timezone": "Asia/Jerusalem" },
      })
    ).json()) as {
      data: Array<{ dayOfWeek: number; hourOfDay: number; value: number }>;
    };

    // UTC: (Wed=3, hour=3) + (Wed=3, hour=22).
    expect(utc.data.map((r) => [r.dayOfWeek, r.hourOfDay]).sort()).toEqual([
      [3, 22],
      [3, 3],
    ].sort());

    // Israel: (Wed=3, hour=6) + (Thu=4, hour=1).
    expect(il.data.map((r) => [r.dayOfWeek, r.hourOfDay]).sort()).toEqual([
      [3, 6],
      [4, 1],
    ].sort());
  });

  it("config.json fallback path — invalid X-User-Timezone header degrades to UTC and the request still succeeds", async () => {
    const res = await fetch(`${h.baseUrl}/api/activity/hourly?period=all`, {
      headers: { "X-User-Timezone": "Bogus/NotReal" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ hourOfDay: number }>;
    };
    // Falls back to UTC → hours 3, 22.
    const hours = body.data.map((r) => r.hourOfDay).sort((a, b) => a - b);
    expect(hours).toEqual([3, 22]);
  });

  it("param-index regression — ?period=7d combined with header + filter args produces a valid SQL execution", async () => {
    // No filters defined for activity routes that use buildTurnFilterClauses
    // here (heatmap/daily don't read filters), but /hourly does. Pass model
    // and project to make sure the $4… index counting was updated.
    const res = await fetch(
      `${h.baseUrl}/api/activity/hourly?period=7d&model=sonnet&project=/p`,
      { headers: { "X-User-Timezone": "Asia/Jerusalem" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    // Just need to ensure no SQL error and a JSON response (no rows is OK
    // since the fixture timestamps fall outside the 7d window relative to
    // the test wall clock).
    expect(Array.isArray(body.data)).toBe(true);
  });
});
