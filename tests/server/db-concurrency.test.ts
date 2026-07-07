/**
 * @module tests/server/db-concurrency
 *
 * Regression for the F-SA `/api/agents/tree` CI flake. `@duckdb/node-api`
 * intermittently throws "Failed to execute prepared statement" when two
 * statements execute at once on the ONE shared connection the API server holds.
 * `/tree` was the only route firing multiple queries via `Promise.all`, so on
 * contended CI runners one would throw, the handler 500'd with Express's
 * default HTML error page, and the test's `.json()` blew up on
 * `Unexpected token '<'`. The helper's `query()` now serializes execution on
 * the shared connection so at most one statement runs at a time.
 *
 * The race is inherently load/timing dependent — it was root-caused and
 * reproduced deterministically with a standalone stress harness (one shared
 * connection, a sustained anchor query held in flight while a batch of light
 * queries is launched in the same tick → ~1/3 of unserialized rounds throw;
 * serialized, zero). That harness is CPU-heavy, so it is deliberately NOT
 * baked into the suite (it would risk making CI slow — the very thing this
 * fixes). These tests are the fast, deterministic guard: they assert the
 * observable contract of serialization — concurrent callers each get their own
 * correct result, and a failed query never wedges the queue.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type DbHelper = typeof import("../../dashboard/src/server/helpers/db.js");

let db: DbHelper;
let tmpDir: string;
let prevDbPath: string | undefined;
let prevConfigPath: string | undefined;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-dbconc-"));
  prevDbPath = process.env.DB_PATH;
  prevConfigPath = process.env.CCANALYTICS_CONFIG_PATH;
  process.env.DB_PATH = path.join(tmpDir, "test.duckdb");
  process.env.CCANALYTICS_CONFIG_PATH = path.join(tmpDir, "config.json");

  db = await import("../../dashboard/src/server/helpers/db.js");
  await db.query(`CREATE TABLE nums (id INTEGER, label VARCHAR)`);
  await db.query(
    `INSERT INTO nums VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')`,
  );
});

afterAll(async () => {
  await db.closeDb();
  if (prevDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = prevDbPath;
  if (prevConfigPath === undefined) delete process.env.CCANALYTICS_CONFIG_PATH;
  else process.env.CCANALYTICS_CONFIG_PATH = prevConfigPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("db helper — concurrent query serialization (F-SA regression)", () => {
  it("resolves the /tree-style trio of concurrent queries with correct data", async () => {
    // The exact shape /api/agents/tree used: 3 queries fired together via
    // Promise.all on the shared connection. Must all resolve, none reject.
    for (let round = 0; round < 5; round++) {
      const [a, b, c] = await Promise.all([
        db.query<{ n: number }>(`SELECT COUNT(*)::INTEGER AS n FROM nums`),
        db.query<{ id: number }>(
          `SELECT id FROM nums WHERE label = $1`,
          ["c"],
        ),
        db.query<{ s: number }>(`SELECT SUM(id)::INTEGER AS s FROM nums`),
      ]);
      expect(Number(a.rows[0]!.n)).toBe(5);
      expect(Number(b.rows[0]!.id)).toBe(3);
      expect(Number(c.rows[0]!.s)).toBe(15);
    }
  });

  it("gives each concurrent caller its own correct result (no cross-contamination)", async () => {
    // Distinct per-caller values: if the serialized queue ever let statements
    // interleave, a caller could observe another's result. A small anchor query
    // is held in flight each round to widen the concurrency window cheaply.
    const WIDTH = 32;
    for (let round = 0; round < 6; round++) {
      const anchor = db.query<{ s: number }>(
        `SELECT SUM(i)::BIGINT AS s FROM range(0, 2000000) t(i)`,
      );
      const calls = Array.from({ length: WIDTH }, (_, k) =>
        db
          .query<{ k: number }>(`SELECT $1::INTEGER AS k`, [k])
          .then((r) => ({ want: k, got: Number(r.rows[0]!.k) })),
      );
      const [, results] = await Promise.all([anchor, Promise.all(calls)]);
      for (const { want, got } of results) expect(got).toBe(want);
    }
  });

  it("keeps serving after a failing query (a rejection must not wedge the queue)", async () => {
    // The queue tail is kept non-rejecting so a query that throws cannot block
    // the callers behind it.
    await expect(db.query(`SELECT * FROM does_not_exist`)).rejects.toThrow();
    const ok = await db.query<{ n: number }>(
      `SELECT COUNT(*)::INTEGER AS n FROM nums`,
    );
    expect(Number(ok.rows[0]!.n)).toBe(5);

    // Interleave failures with good queries in one concurrent batch: every good
    // one must still resolve correctly, each bad one must reject.
    const settled = await Promise.allSettled([
      db.query(`SELECT COUNT(*)::INTEGER AS n FROM nums`),
      db.query(`SELECT * FROM does_not_exist`),
      db.query(`SELECT id FROM nums WHERE id = $1`, [2]),
      db.query(`SELECT bad syntax here`),
      db.query(`SELECT COUNT(*)::INTEGER AS n FROM nums`),
    ]);
    expect(settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
  });
});
