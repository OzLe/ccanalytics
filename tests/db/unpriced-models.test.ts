/**
 * @module tests/db/unpriced-models
 *
 * The list behind the dashboard's fallback-rate banner and
 * `npm run check:pricing`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDB, closeTestDB, type TestDB } from "../helpers/db-setup.js";
import { MODEL_USAGE_SQL, findUnpricedModels } from "../../src/db/unpriced-models.js";

let db: TestDB;

beforeAll(async () => {
  db = await createTestDB();
  const c = db.connection;
  const turns: [string, string | null][] = [
    ["t1", "claude-opus-5-5"],
    ["t2", "claude-opus-6"],
    ["t3", "claude-opus-6"],
    ["t4", "<synthetic>"],
    ["t5", "claude-haiku-4-5-20251001"],
  ];
  for (const [id, model] of turns) {
    await c.run(
      `INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, model)
       VALUES ('${id}', 's1', 'assistant', '2026-09-01 10:00:00', '${model}')`,
    );
  }
  await c.run(
    `INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, model)
     VALUES ('u1', 's1', 'user', '2026-09-01 10:00:00', NULL)`,
  );
  await c.run(`INSERT INTO sub_agents (parent_session_id, agent_id, model) VALUES
    ('s1', 'a1', 'claude-opus-6'), ('s1', 'a2', 'claude-sonnet-6'), ('s1', 'a3', 'claude-sonnet-5')`);
});

afterAll(async () => {
  await closeTestDB(db);
});

describe("findUnpricedModels", () => {
  it("lists models without a pricing entry with their turns and sub-agents", async () => {
    const usage = (await db.connection.runAndReadAll(MODEL_USAGE_SQL)).getRowObjectsJS();
    expect(findUnpricedModels(usage)).toEqual([
      { model: "claude-opus-6", turns: 2, subAgents: 1 },
      { model: "claude-sonnet-6", turns: 0, subAgents: 1 },
    ]);
  });

  it("is empty when every model is priced", () => {
    expect(findUnpricedModels([{ model: "claude-opus-5-5", turns: 1n, sub_agents: 0n }])).toEqual([]);
  });
});
