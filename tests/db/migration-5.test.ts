/**
 * @module tests/db/migration-5
 *
 * Tests for schema migration 5 (Skill Analysis / F2D — S-01..S-08).
 *
 * Builds an in-memory database that looks like a real schema-version-4
 * database (the v1 base tables + the v2/v3/v4 ALTERs, but WITHOUT
 * session_skills, the tool_calls skill columns, or v_skill_usage), then runs
 * SchemaManager.migrate() and asserts:
 *   - all 8 migration-5 objects now exist
 *   - SELECT MAX(version) FROM schema_migrations === 5
 *   - migrate() is a no-op on an already-migrated DB (idempotent, no error)
 *   - every migration-5 statement is additive — pre-existing rows survive
 *     and the new tool_calls columns read NULL on old rows
 */

import { describe, it, expect } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { SchemaManager } from "../../src/db/schema.js";

/**
 * Stand up an in-memory DB at "schema version 4": the original v1 tables +
 * indexes, plus the columns the v2/v3/v4 migrations add, with
 * schema_migrations seeded to version 4. Deliberately does NOT create
 * session_skills, tool_calls.skill_name/skill_caller_type, or v_skill_usage —
 * that is exactly what migration 5 must add.
 */
async function createV4Db(): Promise<{
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  // v1 base tables (subset sufficient for migration 5 + the additive checks).
  await connection.run(`
    CREATE TABLE sessions (
      session_id VARCHAR PRIMARY KEY,
      start_time TIMESTAMP NOT NULL,
      project_name VARCHAR,
      source_type VARCHAR DEFAULT 'claude-code'
    )`);
  await connection.run(`
    CREATE TABLE conversation_turns (
      turn_id VARCHAR PRIMARY KEY,
      session_id VARCHAR NOT NULL,
      role VARCHAR NOT NULL,
      timestamp TIMESTAMP NOT NULL,
      content_text TEXT
    )`);
  await connection.run(`
    CREATE TABLE tool_calls (
      tool_call_id VARCHAR PRIMARY KEY,
      session_id VARCHAR NOT NULL,
      turn_id VARCHAR NOT NULL,
      tool_name VARCHAR NOT NULL,
      tool_type VARCHAR NOT NULL DEFAULT 'native',
      success BOOLEAN,
      parameters JSON
    )`);
  await connection.run(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      description VARCHAR
    )`);

  // Seed schema_migrations up to version 4 (a real migrated v4 DB).
  await connection.run(`
    INSERT INTO schema_migrations (version, description) VALUES
      (1, 'Initial schema'),
      (2, 'Add source_type column to sessions'),
      (3, 'Add content_text column to conversation_turns'),
      (4, 'Add Desktop suffix to desktop project names')`);

  // A couple of pre-existing rows so we can prove migration 5 is additive.
  await connection.run(`
    INSERT INTO sessions (session_id, start_time, project_name)
    VALUES ('sess-old-1', '2026-01-01 00:00:00', 'legacy-project')`);
  await connection.run(`
    INSERT INTO tool_calls (tool_call_id, session_id, turn_id, tool_name, tool_type, success, parameters)
    VALUES ('tc-old-skill', 'sess-old-1', 'turn-old-1', 'Skill', 'builtin', TRUE, '{"skill":"linear"}')`);

  return { instance, connection };
}

/** Does a table or view with this name exist? */
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

/** Does an index with this name exist? */
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

/** Does a column exist on a table? */
async function columnExists(
  conn: DuckDBConnection,
  table: string,
  column: string,
): Promise<boolean> {
  const reader = await conn.runAndReadAll(
    `SELECT COUNT(*) AS n FROM duckdb_columns()
     WHERE table_name = '${table}' AND column_name = '${column}'`,
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

describe("schema migration 5 (Skill Analysis / F2D)", () => {
  it("migrate() on a v4 DB applies migration 5 and bumps version to 5", async () => {
    const { connection } = await createV4Db();
    const mgr = new SchemaManager();

    expect(await maxVersion(connection)).toBe(4);

    const applied = await mgr.migrate(connection);

    // Only migration 5 is pending on a v4 DB.
    expect(applied).toBe(1);
    expect(await maxVersion(connection)).toBe(5);

    connection.closeSync();
  });

  it("creates all 8 migration-5 schema objects", async () => {
    const { connection } = await createV4Db();
    await new SchemaManager().migrate(connection);

    // S-01: table session_skills
    expect(await objectExists(connection, "session_skills")).toBe(true);
    // S-02 / S-03: session_skills indexes
    expect(await indexExists(connection, "idx_session_skills_session")).toBe(true);
    expect(await indexExists(connection, "idx_session_skills_skill_name")).toBe(true);
    // S-04 / S-05: tool_calls skill columns
    expect(await columnExists(connection, "tool_calls", "skill_name")).toBe(true);
    expect(await columnExists(connection, "tool_calls", "skill_caller_type")).toBe(true);
    // S-06: idx_tools_skill_name
    expect(await indexExists(connection, "idx_tools_skill_name")).toBe(true);
    // S-07: view v_skill_usage
    expect(await objectExists(connection, "v_skill_usage")).toBe(true);
    // S-08: schema_migrations row for version 5
    const reader = await connection.runAndReadAll(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 5",
    );
    const rows = reader.getRowObjectsJS() as Array<{ n: unknown }>;
    expect(Number(rows[0]?.n ?? 0)).toBe(1);

    connection.closeSync();
  });

  it("is additive — pre-existing rows survive and new tool_calls columns read NULL", async () => {
    const { connection } = await createV4Db();
    await new SchemaManager().migrate(connection);

    // The legacy session + Skill tool_call are still there.
    const sReader = await connection.runAndReadAll(
      "SELECT COUNT(*) AS n FROM sessions",
    );
    expect(
      Number((sReader.getRowObjectsJS() as Array<{ n: unknown }>)[0].n),
    ).toBe(1);

    // The pre-existing Skill row's new columns are NULL (no backfill yet) but
    // the COALESCE(skill_name, parameters->>'skill') fallback still resolves.
    const tReader = await connection.runAndReadAll(
      `SELECT skill_name, skill_caller_type,
              COALESCE(skill_name, parameters->>'skill') AS resolved
       FROM tool_calls WHERE tool_call_id = 'tc-old-skill'`,
    );
    const row = (tReader.getRowObjectsJS() as Array<Record<string, unknown>>)[0];
    expect(row.skill_name).toBeNull();
    expect(row.skill_caller_type).toBeNull();
    expect(row.resolved).toBe("linear");

    // v_skill_usage is queryable and picks up the invoked-side fallback row.
    const vReader = await connection.runAndReadAll(
      "SELECT session_id, skill_name, was_loaded, invocations FROM v_skill_usage",
    );
    const vRows = vReader.getRowObjectsJS() as Array<Record<string, unknown>>;
    expect(vRows).toHaveLength(1);
    expect(vRows[0].skill_name).toBe("linear");
    expect(vRows[0].was_loaded).toBe(false);
    expect(Number(vRows[0].invocations)).toBe(1);

    connection.closeSync();
  });

  it("re-running migrate() on an already-migrated DB is a no-op", async () => {
    const { connection } = await createV4Db();
    const mgr = new SchemaManager();

    await mgr.migrate(connection); // v4 -> v5
    expect(await maxVersion(connection)).toBe(5);

    // Second call: nothing pending, returns 0, no error, version unchanged.
    const appliedAgain = await mgr.migrate(connection);
    expect(appliedAgain).toBe(0);
    expect(await maxVersion(connection)).toBe(5);

    // And applyMigration5's statements are themselves idempotent — running
    // migrate() a third time still does not throw or duplicate the v5 row.
    await mgr.migrate(connection);
    const reader = await connection.runAndReadAll(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 5",
    );
    expect(
      Number((reader.getRowObjectsJS() as Array<{ n: unknown }>)[0].n),
    ).toBe(1);

    connection.closeSync();
  });

  it("session_skills accepts inserts with the deterministic PK and dedupes on conflict", async () => {
    const { connection } = await createV4Db();
    await new SchemaManager().migrate(connection);

    const insert = `INSERT INTO session_skills
      (session_skill_id, session_id, record_uuid, skill_name, skill_description, skill_count, is_initial, captured_at, source)
      VALUES ('sess-1:rec-1:simplify', 'sess-1', 'rec-1', 'simplify', 'desc', 2, TRUE, '2026-05-01 00:00:00', 'skill_listing')
      ON CONFLICT(session_skill_id) DO NOTHING`;
    await connection.run(insert);
    // Re-insert the same PK — ON CONFLICT DO NOTHING keeps it at one row.
    await connection.run(insert);

    const reader = await connection.runAndReadAll(
      "SELECT COUNT(*) AS n FROM session_skills",
    );
    expect(
      Number((reader.getRowObjectsJS() as Array<{ n: unknown }>)[0].n),
    ).toBe(1);

    connection.closeSync();
  });
});
