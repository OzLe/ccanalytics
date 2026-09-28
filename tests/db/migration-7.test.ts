/**
 * @module tests/db/migration-7
 *
 * Tests for schema migration 7: drop every secondary (non-unique) index.
 *
 * DuckDB 1.4.4 lost rows from those ART indexes on WAL replay, so filtered
 * queries silently returned too few rows (docs/filtered-query-misses-2026-09-28.md).
 * Builds a "schema version 6" database — today's tables plus the 24 indexes
 * versions 1-6 created — then asserts that migrate() and initialize() both
 * leave no secondary index, keep every PRIMARY KEY / UNIQUE constraint and
 * every row, and are idempotent; and that a fresh database never gets one.
 */

import { describe, it, expect } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { SchemaManager } from "../../src/db/schema.js";

/** The secondary indexes schema versions 1-6 created (old sql/schema.sql). */
const V6_INDEXES = [
  "idx_sessions_start_time ON sessions (start_time)",
  "idx_sessions_project_path ON sessions (project_path)",
  "idx_sessions_project_time ON sessions (project_path, start_time)",
  "idx_turns_session_id ON conversation_turns (session_id)",
  "idx_turns_timestamp ON conversation_turns (timestamp)",
  "idx_turns_request_id ON conversation_turns (request_id)",
  "idx_turns_session_time ON conversation_turns (session_id, timestamp)",
  "idx_tools_session_id ON tool_calls (session_id)",
  "idx_tools_tool_name ON tool_calls (tool_name)",
  "idx_tools_session_tool ON tool_calls (session_id, tool_name)",
  "idx_tools_turn_id ON tool_calls (turn_id)",
  "idx_tools_skill_name ON tool_calls (skill_name)",
  "idx_errors_session_id ON errors (session_id)",
  "idx_errors_timestamp ON errors (timestamp)",
  "idx_errors_type ON errors (error_type)",
  "idx_errors_session_time ON errors (session_id, timestamp)",
  "idx_session_skills_session ON session_skills (session_id)",
  "idx_session_skills_skill_name ON session_skills (skill_name)",
  "idx_sub_agents_session ON sub_agents (parent_session_id)",
  "idx_sub_agents_workflow ON sub_agents (workflow_run_id)",
  "idx_sub_agents_type ON sub_agents (subagent_type)",
  "idx_sub_tools_agent ON sub_agent_tool_calls (parent_session_id, agent_id)",
  "idx_sub_tools_name ON sub_agent_tool_calls (tool_name)",
  "idx_workflow_runs_session ON workflow_runs (parent_session_id)",
];

async function scalar(conn: DuckDBConnection, sql: string): Promise<number> {
  const reader = await conn.runAndReadAll(sql);
  const rows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
  return Number(Object.values(rows[0] ?? { x: 0 })[0]);
}

const secondaryIndexCount = (conn: DuckDBConnection) =>
  scalar(conn, "SELECT COUNT(*) FROM duckdb_indexes()");

const maxVersion = (conn: DuckDBConnection) =>
  scalar(conn, "SELECT MAX(version) FROM schema_migrations");

/** PRIMARY KEY / UNIQUE constraints as sorted "table:TYPE(cols)" strings. */
async function keyConstraints(conn: DuckDBConnection): Promise<string[]> {
  const reader = await conn.runAndReadAll(
    `SELECT table_name, constraint_type, constraint_column_names
     FROM duckdb_constraints()
     WHERE constraint_type IN ('PRIMARY KEY', 'UNIQUE')`,
  );
  return (reader.getRowObjectsJS() as Array<Record<string, unknown>>)
    .map((r) => `${r.table_name}:${r.constraint_type}(${(r.constraint_column_names as unknown[]).join(",")})`)
    .sort();
}

/**
 * Stand up an in-memory DB at "schema version 6": the full current schema,
 * minus the version-7 row, plus the 24 secondary indexes, plus a few rows.
 */
async function createV6Db(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await new SchemaManager().initialize(connection);
  await connection.run("DELETE FROM schema_migrations WHERE version >= 7");
  for (const index of V6_INDEXES) {
    await connection.run(`CREATE INDEX ${index}`);
  }
  await connection.run(
    `INSERT INTO sessions (session_id, start_time, project_path) VALUES
       ('s1', '2026-09-20 10:00:00', '/p'), ('s2', '2026-09-22 10:00:00', '/p')`,
  );
  await connection.run(
    `INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, request_id) VALUES
       ('t1', 's1', 'assistant', '2026-09-20 10:00:01', 'r1'),
       ('t2', 's1', 'user', '2026-09-20 10:00:02', NULL),
       ('t3', 's2', 'assistant', '2026-09-22 10:00:01', 'r3')`,
  );
  await connection.run(
    `INSERT INTO sub_agents (parent_session_id, agent_id) VALUES ('s1', 'a1'), ('s1', 'a2')`,
  );
  return connection;
}

describe("schema migration 7 (drop secondary indexes)", () => {
  it("migrate() on a v6 DB drops every secondary index, then applies migration 8", async () => {
    const connection = await createV6Db();
    expect(await maxVersion(connection)).toBe(6);
    expect(await secondaryIndexCount(connection)).toBe(V6_INDEXES.length);

    const applied = await new SchemaManager().migrate(connection);

    expect(applied).toBe(2); // migrations 7 and 8
    expect(await maxVersion(connection)).toBe(8);
    expect(await secondaryIndexCount(connection)).toBe(0);
    connection.closeSync();
  });

  it("keeps every PRIMARY KEY / UNIQUE constraint and every row", async () => {
    const connection = await createV6Db();
    const keysBefore = await keyConstraints(connection);
    expect(keysBefore.length).toBeGreaterThan(0);

    await new SchemaManager().migrate(connection);

    expect(await keyConstraints(connection)).toEqual(keysBefore);
    expect(await scalar(connection, "SELECT COUNT(*) FROM sessions")).toBe(2);
    expect(await scalar(connection, "SELECT COUNT(*) FROM conversation_turns")).toBe(3);
    // The filters the dropped indexes served still find every row.
    expect(
      await scalar(connection, "SELECT COUNT(*) FROM conversation_turns WHERE session_id = 's1'"),
    ).toBe(2);
    expect(
      await scalar(connection, "SELECT COUNT(*) FROM sessions WHERE start_time >= '2026-09-21'"),
    ).toBe(1);
    // ON CONFLICT still deduplicates on the surviving PRIMARY KEY / UNIQUE indexes.
    await connection.run(
      `INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, request_id)
       VALUES ('t1', 's1', 'assistant', '2026-09-20 10:00:01', 'r1'),
              ('t9', 's1', 'assistant', '2026-09-20 10:00:09', 'r3')
       ON CONFLICT DO NOTHING`,
    );
    await connection.run(
      `INSERT INTO sub_agents (parent_session_id, agent_id) VALUES ('s1', 'a1')
       ON CONFLICT (parent_session_id, agent_id) DO NOTHING`,
    );
    expect(await scalar(connection, "SELECT COUNT(*) FROM conversation_turns")).toBe(3);
    expect(await scalar(connection, "SELECT COUNT(*) FROM sub_agents")).toBe(2);
    connection.closeSync();
  });

  it("initialize() on a v6 DB drops them too (commands that only initialize)", async () => {
    const connection = await createV6Db();

    await new SchemaManager().initialize(connection);

    expect(await secondaryIndexCount(connection)).toBe(0);
    expect(await maxVersion(connection)).toBe(8);
    connection.closeSync();
  });

  it("is idempotent", async () => {
    const connection = await createV6Db();
    const mgr = new SchemaManager();

    await mgr.migrate(connection);
    expect(await mgr.migrate(connection)).toBe(0);
    await mgr.initialize(connection);

    expect(await secondaryIndexCount(connection)).toBe(0);
    expect(
      await scalar(connection, "SELECT COUNT(*) FROM schema_migrations WHERE version = 7"),
    ).toBe(1);
    connection.closeSync();
  });

  it("a fresh database never gets a secondary index", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();

    await new SchemaManager().migrate(connection);

    expect(await secondaryIndexCount(connection)).toBe(0);
    expect(await maxVersion(connection)).toBe(8);
    connection.closeSync();
  });
});
