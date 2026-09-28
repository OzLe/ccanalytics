/**
 * @module tests/db/cost-backfill
 *
 * The statements `npm run backfill:costs` runs: each stored cost must equal
 * what `calculateCost()` gives for the same tokens and model, for turns and
 * for sub-agents, and the sessions must sum their turns.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, type TestDB } from "../helpers/db-setup.js";
import {
  sessionCostUpdateSql,
  subAgentCostUpdateSql,
  turnCostUpdateSql,
} from "../../src/db/cost-backfill.js";
import { calculateCost } from "../../src/utils/pricing.js";

interface TokenRow {
  model: string | null;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const TURNS: TokenRow[] = [
  { model: "claude-opus-5-5", input: 12, output: 40_000, cacheWrite: 90_000, cacheRead: 2_500_000 },
  { model: "claude-fable-5-1", input: 3, output: 25_000, cacheWrite: 70_000, cacheRead: 1_900_000 },
  { model: "claude-opus-5", input: 7, output: 30_000, cacheWrite: 50_000, cacheRead: 800_000 },
  { model: "claude-haiku-4-5-20251001", input: 900, output: 1_200, cacheWrite: 4_000, cacheRead: 60_000 },
  { model: "claude-opus-6", input: 1, output: 10, cacheWrite: 100, cacheRead: 1_000 },
  { model: null, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
];

let db: TestDB;

async function scalar(sql: string): Promise<number> {
  const reader = await db.connection.runAndReadAll(sql);
  return Number(Object.values(reader.getRowObjectsJS()[0] as object)[0]);
}

beforeEach(async () => {
  db = await createTestDB();
  const c = db.connection;
  await c.run(`INSERT INTO sessions (session_id, start_time, total_cost_usd) VALUES
    ('s1', '2026-09-01 10:00:00', 999), ('s2', '2026-09-02 10:00:00', 999), ('empty', '2026-09-03 10:00:00', 5)`);
  for (const [i, t] of TURNS.entries()) {
    await c.run(
      `INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, input_tokens,
         output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, model)
       VALUES ('t${i}', '${i % 2 === 0 ? "s1" : "s2"}', 'assistant', '2026-09-01 10:00:00',
         ${t.input}, ${t.output}, ${t.cacheWrite}, ${t.cacheRead}, 123, ${t.model ? `'${t.model}'` : "NULL"})`,
    );
    await c.run(
      `INSERT INTO sub_agents (parent_session_id, agent_id, model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, cost_usd)
       VALUES ('s1', 'a${i}', ${t.model ? `'${t.model}'` : "NULL"},
         ${t.input}, ${t.output}, ${t.cacheWrite}, ${t.cacheRead}, 456)`,
    );
  }
});

afterEach(async () => {
  await closeTestDB(db);
});

describe("cost backfill statements", () => {
  it("recomputes every turn's cost as calculateCost() does", async () => {
    await db.connection.run(turnCostUpdateSql());
    for (const [i, t] of TURNS.entries()) {
      const stored = await scalar(`SELECT cost_usd FROM conversation_turns WHERE turn_id = 't${i}'`);
      expect(stored, String(t.model)).toBeCloseTo(
        calculateCost(t.model, t.input, t.output, t.cacheWrite, t.cacheRead),
        9,
      );
    }
  });

  it("recomputes the sub-agents of models whose stored costs are stale", async () => {
    await db.connection.run(subAgentCostUpdateSql());
    for (const [i, t] of TURNS.entries()) {
      const stored = await scalar(`SELECT cost_usd FROM sub_agents WHERE agent_id = 'a${i}'`);
      expect(stored, String(t.model)).toBeCloseTo(
        calculateCost(t.model, t.input, t.output, t.cacheWrite, t.cacheRead),
        9,
      );
    }
  });

  it("leaves a mixed-model agent alone when its model's rates did not change", async () => {
    // Three agents already at the current rates, one whose turns mixed models.
    const cost = calculateCost("claude-fable-5", 10, 1_000, 2_000, 30_000);
    for (const id of ["f1", "f2", "f3"]) {
      await db.connection.run(
        `INSERT INTO sub_agents (parent_session_id, agent_id, model, input_tokens, output_tokens,
           cache_creation_tokens, cache_read_tokens, cost_usd)
         VALUES ('s2', '${id}', 'claude-fable-5', 10, 1000, 2000, 30000, ${cost})`,
      );
    }
    await db.connection.run(
      `INSERT INTO sub_agents (parent_session_id, agent_id, model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, cost_usd)
       VALUES ('s2', 'mixed', 'claude-fable-5', 10, 1000, 2000, 30000, 0.0123)`,
    );

    await db.connection.run(subAgentCostUpdateSql());

    expect(await scalar(`SELECT cost_usd FROM sub_agents WHERE agent_id = 'mixed'`)).toBe(0.0123);
    expect(await scalar(`SELECT cost_usd FROM sub_agents WHERE agent_id = 'f1'`)).toBe(cost);
  });

  it("makes each session the sum of its turns, and 0 without turns", async () => {
    await db.connection.run(turnCostUpdateSql());
    await db.connection.run(sessionCostUpdateSql());
    for (const s of ["s1", "s2"]) {
      const total = await scalar(`SELECT total_cost_usd FROM sessions WHERE session_id = '${s}'`);
      const turns = await scalar(
        `SELECT SUM(cost_usd) FROM conversation_turns WHERE session_id = '${s}'`,
      );
      expect(total).toBeCloseTo(turns, 9);
    }
    expect(await scalar(`SELECT total_cost_usd FROM sessions WHERE session_id = 'empty'`)).toBe(0);
  });

  it("is idempotent and changes no row counts", async () => {
    const counts = `SELECT (SELECT COUNT(*) FROM conversation_turns) * 1000
      + (SELECT COUNT(*) FROM sub_agents) * 10 + (SELECT COUNT(*) FROM sessions)`;
    const before = await scalar(counts);
    for (let round = 0; round < 2; round++) {
      await db.connection.run(turnCostUpdateSql());
      await db.connection.run(sessionCostUpdateSql());
      await db.connection.run(subAgentCostUpdateSql());
    }
    const once = await scalar(`SELECT SUM(cost_usd) FROM conversation_turns`);
    await db.connection.run(turnCostUpdateSql());
    expect(await scalar(`SELECT SUM(cost_usd) FROM conversation_turns`)).toBe(once);
    expect(await scalar(counts)).toBe(before);
  });
});
