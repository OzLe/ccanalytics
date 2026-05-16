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

    // ACT-003 / SEM2-295: response is always 24 rows per tz (LEFT JOIN
    // generate_series). Filter to populated hours to assert the tz pivot.
    expect(utc.data).toHaveLength(24);
    expect(il.data).toHaveLength(24);

    const utcHours = utc.data
      .filter((r) => r.messageCount > 0)
      .map((r) => r.hourOfDay)
      .sort((a, b) => a - b);
    const ilHours = il.data
      .filter((r) => r.messageCount > 0)
      .map((r) => r.hourOfDay)
      .sort((a, b) => a - b);

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
      data: Array<{ hourOfDay: number; messageCount: number }>;
    };
    // ACT-003 / SEM2-295: 24 rows; filter to the populated UTC hours.
    expect(body.data).toHaveLength(24);
    const hours = body.data
      .filter((r) => r.messageCount > 0)
      .map((r) => r.hourOfDay)
      .sort((a, b) => a - b);
    // Falls back to UTC → hours 3, 22.
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
    // ACT-003 / SEM2-295: even when the time window matches zero rows, the
    // response is still 24 hour buckets (LEFT JOIN generate_series). Previously
    // the body was an empty array, which was the silent-drop bug.
    expect(body.data).toHaveLength(24);
  });
});

/**
 * ACT-003 / SEM2-295 — explicit 24-bucket coverage.
 *
 * Boots a fresh router with a *single* fixture turn at the user-local hour 14
 * and asserts that every hour-of-day shows up (one with a count, 23 zeroed).
 * Mirrors the canonical case in the LANE D3 lane plan.
 *
 * Kept as its own describe block so the fixture is fully isolated from the
 * ACT-001 tests above — those need two assistant turns at 03:00Z and 22:30Z.
 */
async function bootRouterSingleTurn(isoZ: string): Promise<Handle> {
  // db.ts caches the connection at module scope; close any existing one so the
  // new DB_PATH actually takes effect on the next getConnection() call.
  try {
    const existing = await import("../../dashboard/src/server/helpers/db.js");
    await existing.closeDb();
  } catch {
    /* first call — no module yet */
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-act003-"));
  const dbPath = path.join(tmpDir, "test.duckdb");
  process.env.DB_PATH = dbPath;
  const { default: activityRouter } = await import(
    "../../dashboard/src/server/routes/activity.js"
  );
  const dbHelper = await import("../../dashboard/src/server/helpers/db.js");
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
  // Strip the trailing Z because the column is tz-naive (stored as UTC
  // wall-clock) and DuckDB rejects 'Z'-suffixed TIMESTAMPs.
  const naive = isoZ.replace("T", " ").replace(/Z$/, "");
  await dbHelper.query(`
    INSERT INTO sessions VALUES (
      'sess-act003', '${naive}', '${naive}', 60,
      'claude-sonnet-4-5', 100, 50, 0, 0, 0.01, 1, 0, '/p', 'p', 'claude-code'
    );
  `);
  await dbHelper.query(`
    INSERT INTO conversation_turns VALUES (
      'turn-act003', 'sess-act003', 'assistant', '${naive}',
      100, 50, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'req-act003', FALSE, FALSE
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

describe("activity route — 24 hour buckets (ACT-003 / SEM2-295)", () => {
  let h: Handle;
  let prevDbPath: string | undefined;

  beforeAll(async () => {
    prevDbPath = process.env.DB_PATH;
    // Pick a UTC timestamp so that:
    //   - hour 14 is populated in Asia/Jerusalem (UTC+3 in May)
    //   - hour 22 is populated in UTC
    // 11:00Z on a non-DST-Israel day → 14:00 IDT. We use 2026-05-13 (after
    // Israel's 2026-03-27 spring-forward) so the +3 offset is guaranteed.
    h = await bootRouterSingleTurn("2026-05-13T11:00:00Z");
  });

  afterAll(async () => {
    await h.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
  });

  it("Israel: a single turn at local hour 14 produces 24 rows with hour 14 populated and the other 23 zeroed", async () => {
    const res = await fetch(`${h.baseUrl}/api/activity/hourly?period=all`, {
      headers: { "X-User-Timezone": "Asia/Jerusalem" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        hourOfDay: number;
        messageCount: number;
        sessionCount: number;
        totalTokens: number;
        totalCost: number;
        avgCost: number;
        avgTokensPerTurn: number;
      }>;
    };

    // Exactly 24 rows, in hour-order 0..23.
    expect(body.data).toHaveLength(24);
    expect(body.data.map((r) => r.hourOfDay)).toEqual(
      Array.from({ length: 24 }, (_, i) => i),
    );

    // Hour 14 is populated.
    const fourteen = body.data[14];
    expect(fourteen).toBeDefined();
    expect(fourteen?.hourOfDay).toBe(14);
    expect(fourteen?.messageCount).toBe(1);
    expect(fourteen?.sessionCount).toBe(1);
    expect(fourteen?.totalTokens).toBe(150);
    expect(fourteen?.totalCost).toBeCloseTo(0.01, 6);

    // Every OTHER hour is zeroed (no nulls, no missing rows).
    for (const row of body.data) {
      if (row.hourOfDay === 14) continue;
      expect(row.messageCount).toBe(0);
      expect(row.sessionCount).toBe(0);
      expect(row.totalTokens).toBe(0);
      expect(row.totalCost).toBe(0);
      expect(row.avgCost).toBe(0);
      expect(row.avgTokensPerTurn).toBe(0);
    }
  });

  it("UTC: same fixture turn lands at UTC hour 11 — 24 rows, hour 11 populated, others zeroed", async () => {
    const res = await fetch(`${h.baseUrl}/api/activity/hourly?period=all`, {
      headers: { "X-User-Timezone": "UTC" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ hourOfDay: number; messageCount: number }>;
    };

    expect(body.data).toHaveLength(24);
    const populated = body.data.filter((r) => r.messageCount > 0);
    expect(populated).toHaveLength(1);
    expect(populated[0]?.hourOfDay).toBe(11);
    expect(populated[0]?.messageCount).toBe(1);
  });

  it("UTC: a turn at UTC hour 22 lands at hour 22 — 24 rows, hour 22 populated, others zeroed", async () => {
    // Switch the fixture for the 22:00Z case. Use a second isolated handle so
    // it doesn't conflict with the 11:00Z fixture above.
    const h2 = await bootRouterSingleTurn("2026-05-14T22:00:00Z");
    try {
      const res = await fetch(`${h2.baseUrl}/api/activity/hourly?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ hourOfDay: number; messageCount: number }>;
      };
      expect(body.data).toHaveLength(24);
      const populated = body.data.filter((r) => r.messageCount > 0);
      expect(populated).toHaveLength(1);
      expect(populated[0]?.hourOfDay).toBe(22);
      // All non-22 hours are exactly zero (no missing buckets).
      for (const row of body.data) {
        if (row.hourOfDay === 22) continue;
        expect(row.messageCount).toBe(0);
      }
    } finally {
      await h2.close();
    }
  });
});

/**
 * Boot a fresh router/db pair seeded with a controlled cost-row predicate
 * fixture: 3 real assistant rows + 1 synthetic + 1 NULL-model + 1 user row on
 * date 2026-04-15. Used by the SEM2-297 / ACT-005 suite below to assert that
 * the activity routes now exclude exactly the rows v_daily_cost excludes.
 *
 * The dashboard `db.ts` helper holds a module-singleton connection plus the
 * `dbPath` it was opened against. The ACT-001 suite's afterAll() calls
 * `closeDb()` which nulls the singleton — so when this boot runs in a new
 * describe block, `DB_PATH=<new temp>` + a fresh `getConnection()` opens a
 * second connection against the new file (same module, new state).
 */
async function bootRouterForPredicate(): Promise<Handle> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-act-pred-"));
  const dbPath = path.join(tmpDir, "test.duckdb");
  process.env.DB_PATH = dbPath;

  // Same module instance as the first describe block, but its singleton was
  // nulled in afterAll() — getConnection() will re-init against our DB_PATH.
  const { default: activityRouter } = await import(
    "../../dashboard/src/server/routes/activity.js"
  );
  const dbHelper = await import("../../dashboard/src/server/helpers/db.js");

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

  // 3 cost-bearing assistant rows.
  await dbHelper.query(`
    INSERT INTO sessions VALUES
      ('s-r1', '2026-04-15 10:00:00', '2026-04-15 10:01:00', 60, 'claude-sonnet-4-5', 100, 50, 0, 0, 0.01, 1, 0, '/p', 'p', 'claude-code'),
      ('s-r2', '2026-04-15 11:00:00', '2026-04-15 11:01:00', 60, 'claude-opus-4',     100, 50, 0, 0, 0.01, 1, 0, '/p', 'p', 'claude-code'),
      ('s-r3', '2026-04-15 12:00:00', '2026-04-15 12:01:00', 60, 'claude-sonnet-4-5', 100, 50, 0, 0, 0.01, 1, 0, '/p', 'p', 'claude-code'),
      ('s-syn','2026-04-15 13:00:00', '2026-04-15 13:01:00', 60, '<synthetic>',       100, 50, 0, 0, 0.00, 1, 0, '/p', 'p', 'claude-code'),
      ('s-nm', '2026-04-15 14:00:00', '2026-04-15 14:01:00', 60, NULL,                100, 50, 0, 0, 0.00, 1, 0, '/p', 'p', 'claude-code'),
      ('s-u',  '2026-04-15 15:00:00', '2026-04-15 15:01:00', 60, 'claude-sonnet-4-5', 0,   0,  0, 0, 0.00, 1, 0, '/p', 'p', 'claude-code');
    INSERT INTO conversation_turns VALUES
      ('t-r1',  's-r1', 'assistant', '2026-04-15 10:00:00', 100, 50, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'req-r1', FALSE, FALSE),
      ('t-r2',  's-r2', 'assistant', '2026-04-15 11:00:00', 100, 50, 0, 0, 0.01, 'claude-opus-4',     'end_turn', 'req-r2', FALSE, FALSE),
      ('t-r3',  's-r3', 'assistant', '2026-04-15 12:00:00', 100, 50, 0, 0, 0.01, 'claude-sonnet-4-5', 'end_turn', 'req-r3', FALSE, FALSE),
      ('t-syn', 's-syn','assistant', '2026-04-15 13:00:00', 100, 50, 0, 0, 0.00, '<synthetic>',       'end_turn', 'req-sy', FALSE, FALSE),
      ('t-nm',  's-nm', 'assistant', '2026-04-15 14:00:00', 100, 50, 0, 0, 0.00, NULL,                'end_turn', 'req-nm', FALSE, FALSE),
      ('t-u',   's-u',  'user',      '2026-04-15 15:00:00', 0,   0,  0, 0, 0.00, NULL,                NULL,       'req-u',  FALSE, FALSE);
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

describe("activity route — cost-row predicate (SEM2-297)", () => {
  let h: Handle;
  let prevDbPath: string | undefined;

  beforeAll(async () => {
    prevDbPath = process.env.DB_PATH;
    h = await bootRouterForPredicate();
  });

  afterAll(async () => {
    await h.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
  });

  // The fixture has 3 cost-bearing assistant rows + 1 synthetic + 1 null-model
  // + 1 user, all on 2026-04-15. Activity must count only the 3 real rows.
  const EXPECTED_REAL = 3;

  it("/api/activity/daily — counts only cost-bearing assistant rows (synthetic + null-model excluded)", async () => {
    const res = (await (
      await fetch(`${h.baseUrl}/api/activity/daily?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      })
    ).json()) as { data: Array<{ timestamp: string; value: number }> };

    // Single day in fixture; total turn count must equal the 3 real rows.
    const total = res.data.reduce((s, r) => s + r.value, 0);
    expect(total).toBe(EXPECTED_REAL);
    // And the only date present is 2026-04-15.
    expect(res.data.map((r) => r.timestamp.slice(0, 10))).toEqual([
      "2026-04-15",
    ]);
  });

  it("/api/activity/hourly — sum of messageCount equals the cost-bearing population", async () => {
    const res = (await (
      await fetch(`${h.baseUrl}/api/activity/hourly?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      })
    ).json()) as {
      data: Array<{ hourOfDay: number; messageCount: number }>;
    };

    // ACT-003 / SEM2-295: the response is always 24 rows (LEFT JOIN
    // generate_series). Sum equals the cost-bearing population; the hours
    // that held only excluded rows must be zero rather than absent.
    expect(res.data).toHaveLength(24);
    const total = res.data.reduce((s, r) => s + r.messageCount, 0);
    expect(total).toBe(EXPECTED_REAL);
    // Synthetic was at hour 13, NULL-model at hour 14, user at 15 — those
    // hour buckets must hold zero messages because their rows are the only
    // ones at those hours and the predicate excludes them.
    expect(res.data[13]?.messageCount).toBe(0);
    expect(res.data[14]?.messageCount).toBe(0);
    expect(res.data[15]?.messageCount).toBe(0);
  });

  it("/api/activity/heatmap — sum of value equals the cost-bearing population", async () => {
    const res = (await (
      await fetch(`${h.baseUrl}/api/activity/heatmap?period=all`, {
        headers: { "X-User-Timezone": "UTC" },
      })
    ).json()) as {
      data: Array<{ dayOfWeek: number; hourOfDay: number; value: number }>;
    };

    const total = res.data.reduce((s, r) => s + r.value, 0);
    expect(total).toBe(EXPECTED_REAL);
  });
});
