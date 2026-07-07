/**
 * @module tests/db/migration-6
 *
 * Tests for schema migration 6 (Sub-Agent & Workflow Attribution / F-SA —
 * SA-01..SA-04).
 *
 * Builds an in-memory database that looks like a real schema-version-5 database
 * (base sessions / conversation_turns tables + schema_migrations seeded to 5,
 * but WITHOUT sub_agents / sub_agent_tool_calls / workflow_runs or the three
 * new views), then runs SchemaManager.migrate() and asserts:
 *   - all migration-6 objects now exist
 *   - SELECT MAX(version) FROM schema_migrations === 6
 *   - migrate() is a no-op on an already-migrated DB (idempotent, no error)
 *   - the COMPOSITE (parent_session_id, agent_id) PK is honoured: two agents
 *     that share an agent_id under different sessions are distinct rows, and a
 *     byte-identical duplicate collapses via composite ON CONFLICT — this is the
 *     `integration-safe`-REFUTED regression guard AND a live check that DuckDB
 *     supports a composite ON CONFLICT target (spec Risk #1)
 *   - the three views are queryable and v_session_orchestration blends
 *     main + sub-agent cost WITHOUT changing SUM(conversation_turns.cost_usd)
 *     (the cost SSOT invariant)
 */

import { describe, it, expect } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { SchemaManager } from "../../src/db/schema.js";

/**
 * Stand up an in-memory DB at "schema version 5": the base sessions /
 * conversation_turns tables the migration-6 views read, plus schema_migrations
 * seeded to version 5. Deliberately does NOT create sub_agents,
 * sub_agent_tool_calls, workflow_runs, or the three new views — that is exactly
 * what migration 6 must add.
 */
async function createV5Db(): Promise<{
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  await connection.run(`
    CREATE TABLE sessions (
      session_id VARCHAR PRIMARY KEY,
      start_time TIMESTAMP NOT NULL,
      project_name VARCHAR
    )`);
  await connection.run(`
    CREATE TABLE conversation_turns (
      turn_id VARCHAR PRIMARY KEY,
      session_id VARCHAR NOT NULL,
      role VARCHAR NOT NULL,
      timestamp TIMESTAMP NOT NULL,
      cost_usd DOUBLE DEFAULT 0.0
    )`);
  await connection.run(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      description VARCHAR
    )`);
  await connection.run(`
    INSERT INTO schema_migrations (version, description) VALUES
      (1, 'Initial schema'),
      (2, 'Add source_type column to sessions'),
      (3, 'Add content_text column to conversation_turns'),
      (4, 'Add Desktop suffix to desktop project names'),
      (5, 'Skill Analysis')`);

  // A main-thread session + one assistant turn carrying cost. This is the SSOT
  // baseline: SUM(conversation_turns.cost_usd) must never change when sub-agent
  // rows are added below.
  await connection.run(`
    INSERT INTO sessions (session_id, start_time, project_name)
    VALUES ('sess-A', '2026-06-01 00:00:00', 'proj-A')`);
  await connection.run(`
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, cost_usd)
    VALUES ('turn-A1', 'sess-A', 'assistant', '2026-06-01 00:01:00', 1.0)`);

  return { instance, connection };
}

async function objectExists(
  conn: DuckDBConnection,
  name: string,
): Promise<boolean> {
  const reader = await conn.runAndReadAll(
    `SELECT COUNT(*) AS n FROM duckdb_tables() WHERE table_name = '${name}'
     UNION ALL
     SELECT COUNT(*) AS n FROM duckdb_views() WHERE view_name = '${name}'`,
  );
  const rows = reader.getRowObjectsJS() as Array<{ n: unknown }>;
  return rows.some((r) => Number(r.n) > 0);
}

async function indexExists(
  conn: DuckDBConnection,
  name: string,
): Promise<boolean> {
  const reader = await conn.runAndReadAll(
    `SELECT COUNT(*) AS n FROM duckdb_indexes() WHERE index_name = '${name}'`,
  );
  const rows = reader.getRowObjectsJS() as Array<{ n: unknown }>;
  return Number(rows[0]?.n ?? 0) > 0;
}

async function maxVersion(conn: DuckDBConnection): Promise<number> {
  const reader = await conn.runAndReadAll(
    "SELECT MAX(version) AS v FROM schema_migrations",
  );
  const rows = reader.getRowObjectsJS() as Array<{ v: unknown }>;
  return Number(rows[0]?.v ?? 0);
}

async function scalar(conn: DuckDBConnection, sql: string): Promise<number> {
  const reader = await conn.runAndReadAll(sql);
  const rows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
  return Number(Object.values(rows[0] ?? { x: 0 })[0]);
}

describe("schema migration 6 (Sub-Agent & Workflow Attribution / F-SA)", () => {
  it("migrate() on a v5 DB applies migration 6 and bumps version to 6", async () => {
    const { connection } = await createV5Db();
    const mgr = new SchemaManager();

    expect(await maxVersion(connection)).toBe(5);

    const applied = await mgr.migrate(connection);

    // Only migration 6 is pending on a v5 DB.
    expect(applied).toBe(1);
    expect(await maxVersion(connection)).toBe(6);

    connection.closeSync();
  });

  it("creates all migration-6 schema objects (3 tables, indexes, 3 views)", async () => {
    const { connection } = await createV5Db();
    await new SchemaManager().migrate(connection);

    // SA-01..SA-03: tables
    expect(await objectExists(connection, "sub_agents")).toBe(true);
    expect(await objectExists(connection, "sub_agent_tool_calls")).toBe(true);
    expect(await objectExists(connection, "workflow_runs")).toBe(true);
    // indexes
    expect(await indexExists(connection, "idx_sub_agents_session")).toBe(true);
    expect(await indexExists(connection, "idx_sub_agents_workflow")).toBe(true);
    expect(await indexExists(connection, "idx_sub_agents_type")).toBe(true);
    expect(await indexExists(connection, "idx_sub_tools_agent")).toBe(true);
    expect(await indexExists(connection, "idx_sub_tools_name")).toBe(true);
    expect(await indexExists(connection, "idx_workflow_runs_session")).toBe(true);
    // views
    expect(await objectExists(connection, "v_subagent_usage")).toBe(true);
    expect(await objectExists(connection, "v_workflow_summary")).toBe(true);
    expect(await objectExists(connection, "v_session_orchestration")).toBe(true);
    // SA-04: schema_migrations row for version 6
    expect(
      await scalar(
        connection,
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6",
      ),
    ).toBe(1);

    connection.closeSync();
  });

  it("re-running migrate() on an already-migrated DB is a no-op", async () => {
    const { connection } = await createV5Db();
    const mgr = new SchemaManager();

    await mgr.migrate(connection); // v5 -> v6
    expect(await maxVersion(connection)).toBe(6);

    const appliedAgain = await mgr.migrate(connection);
    expect(appliedAgain).toBe(0);
    expect(await maxVersion(connection)).toBe(6);

    // applyMigration6's statements are idempotent — a third run neither throws
    // nor duplicates the v6 row.
    await mgr.migrate(connection);
    expect(
      await scalar(
        connection,
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6",
      ),
    ).toBe(1);

    connection.closeSync();
  });

  it("honours the COMPOSITE (parent_session_id, agent_id) PK — same agent_id under different sessions are distinct; identical copies collapse", async () => {
    const { connection } = await createV5Db();
    await new SchemaManager().migrate(connection);

    // Same agent_id, DIFFERENT parent_session_id => two distinct agents.
    // (agentId is NOT globally unique — the integration-safe REFUTED finding.)
    const insertA = `INSERT INTO sub_agents (parent_session_id, agent_id, cost_usd)
      VALUES ('sess-A', 'agentDup', 0.10)
      ON CONFLICT (parent_session_id, agent_id) DO NOTHING`;
    const insertB = `INSERT INTO sub_agents (parent_session_id, agent_id, cost_usd)
      VALUES ('sess-B', 'agentDup', 0.20)
      ON CONFLICT (parent_session_id, agent_id) DO NOTHING`;
    await connection.run(insertA);
    await connection.run(insertB);
    expect(await scalar(connection, "SELECT COUNT(*) AS n FROM sub_agents")).toBe(2);

    // Byte-identical duplicate of A (same composite key) collapses to one row.
    // This also proves DuckDB accepts a composite ON CONFLICT target (Risk #1).
    await connection.run(insertA);
    expect(await scalar(connection, "SELECT COUNT(*) AS n FROM sub_agents")).toBe(2);

    connection.closeSync();
  });

  it("v_session_orchestration blends main + sub-agent cost WITHOUT changing the conversation_turns SSOT", async () => {
    const { connection } = await createV5Db();
    await new SchemaManager().migrate(connection);

    const ssotBefore = await scalar(
      connection,
      "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM conversation_turns",
    );

    // Add a sub-agent + a workflow run for sess-A.
    await connection.run(`
      INSERT INTO sub_agents (parent_session_id, agent_id, subagent_type,
        workflow_run_id, model, cost_usd, num_turns, num_tool_calls, success)
      VALUES ('sess-A', 'agent1', 'general-purpose', 'wf_1',
        'claude-sonnet-5', 0.25, 4, 6, TRUE)`);
    await connection.run(`
      INSERT INTO workflow_runs (run_id, parent_session_id, workflow_name, status, num_phases)
      VALUES ('wf_1', 'sess-A', 'demo-flow', 'completed', 3)`);

    // SSOT invariant: conversation_turns cost is byte-for-byte unchanged.
    const ssotAfter = await scalar(
      connection,
      "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM conversation_turns",
    );
    expect(ssotAfter).toBe(ssotBefore);
    expect(ssotAfter).toBeCloseTo(1.0, 6);

    // v_session_orchestration is the only place main + sub cost combine.
    const orch = (
      await connection.runAndReadAll(
        `SELECT main_cost_usd, orchestration_cost_usd, blended_cost_usd,
                orchestration_cost_share, sub_agents_spawned, workflow_runs
         FROM v_session_orchestration WHERE session_id = 'sess-A'`,
      )
    ).getRowObjectsJS()[0] as Record<string, unknown>;
    expect(Number(orch.main_cost_usd)).toBeCloseTo(1.0, 6);
    expect(Number(orch.orchestration_cost_usd)).toBeCloseTo(0.25, 6);
    expect(Number(orch.blended_cost_usd)).toBeCloseTo(1.25, 6);
    expect(Number(orch.orchestration_cost_share)).toBeCloseTo(0.2, 4);
    expect(Number(orch.sub_agents_spawned)).toBe(1);
    expect(Number(orch.workflow_runs)).toBe(1);

    connection.closeSync();
  });

  it("v_subagent_usage and v_workflow_summary aggregate correctly", async () => {
    const { connection } = await createV5Db();
    await new SchemaManager().migrate(connection);

    await connection.run(`
      INSERT INTO sub_agents (parent_session_id, agent_id, subagent_type,
        workflow_run_id, cost_usd, num_turns, num_tool_calls, success,
        input_tokens, output_tokens)
      VALUES
        ('sess-A', 'a1', 'general-purpose', 'wf_1', 0.25, 4, 6, TRUE, 100, 50),
        ('sess-A', 'a2', 'general-purpose', 'wf_1', 0.35, 6, 8, TRUE, 200, 80)`);
    await connection.run(`
      INSERT INTO workflow_runs (run_id, parent_session_id, workflow_name, status, num_phases)
      VALUES ('wf_1', 'sess-A', 'demo-flow', 'completed', 2)`);

    // v_subagent_usage: one row per subagent_type.
    const usage = (
      await connection.runAndReadAll(
        `SELECT subagent_type, agent_runs, total_cost_usd, total_tokens,
                total_tool_calls, success_rate
         FROM v_subagent_usage`,
      )
    ).getRowObjectsJS() as Array<Record<string, unknown>>;
    expect(usage).toHaveLength(1);
    expect(usage[0].subagent_type).toBe("general-purpose");
    expect(Number(usage[0].agent_runs)).toBe(2);
    expect(Number(usage[0].total_cost_usd)).toBeCloseTo(0.6, 6);
    expect(Number(usage[0].total_tokens)).toBe(430); // (100+50)+(200+80)
    expect(Number(usage[0].total_tool_calls)).toBe(14);
    expect(Number(usage[0].success_rate)).toBeCloseTo(1.0, 6);

    // v_workflow_summary: agents_observed is authoritative (COUNT), not manifest.
    const wf = (
      await connection.runAndReadAll(
        `SELECT run_id, agents_observed, fan_out_per_phase, total_cost_usd, num_phases
         FROM v_workflow_summary WHERE run_id = 'wf_1'`,
      )
    ).getRowObjectsJS()[0] as Record<string, unknown>;
    expect(Number(wf.agents_observed)).toBe(2);
    expect(Number(wf.num_phases)).toBe(2);
    expect(Number(wf.fan_out_per_phase)).toBeCloseTo(1.0, 6); // 2 agents / 2 phases
    expect(Number(wf.total_cost_usd)).toBeCloseTo(0.6, 6);

    connection.closeSync();
  });
});
