/**
 * @module tests/db/migration-8
 *
 * Migration 8 adds `cache_creation_1h_tokens` to `conversation_turns` and
 * `sub_agents`; existing rows keep NULL (not recorded) and nothing else changes.
 */

import { describe, it, expect } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { SchemaManager } from "../../src/db/schema.js";

async function scalar(conn: DuckDBConnection, sql: string): Promise<number> {
  const reader = await conn.runAndReadAll(sql);
  return Number(Object.values(reader.getRowObjectsJS()[0] as object)[0]);
}

const maxVersion = (conn: DuckDBConnection) =>
  scalar(conn, "SELECT MAX(version) FROM schema_migrations");

const hasColumn = (conn: DuckDBConnection, table: string) =>
  scalar(
    conn,
    `SELECT COUNT(*) FROM duckdb_columns()
     WHERE table_name = '${table}' AND column_name = 'cache_creation_1h_tokens'`,
  );

/** A database at schema version 7: the current schema without migration 8. */
async function createV7Db(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await new SchemaManager().initialize(connection);
  await connection.run("DELETE FROM schema_migrations WHERE version >= 8");
  await connection.run("ALTER TABLE conversation_turns DROP COLUMN cache_creation_1h_tokens");
  await connection.run("ALTER TABLE sub_agents DROP COLUMN cache_creation_1h_tokens");
  await connection.run(
    `INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, request_id, cache_creation_tokens)
     VALUES ('t1', 's1', 'assistant', '2026-09-20 10:00:01', 'r1', 500)`,
  );
  await connection.run(
    `INSERT INTO sub_agents (parent_session_id, agent_id, cache_creation_tokens) VALUES ('s1', 'a1', 700)`,
  );
  return connection;
}

describe("schema migration 8 (1-hour cache writes)", () => {
  it("adds the column to both tables, leaving existing rows unrecorded", async () => {
    const connection = await createV7Db();
    expect(await maxVersion(connection)).toBe(7);
    expect(await hasColumn(connection, "conversation_turns")).toBe(0);

    const applied = await new SchemaManager().migrate(connection);

    expect(applied).toBe(1);
    expect(await maxVersion(connection)).toBe(8);
    expect(await hasColumn(connection, "conversation_turns")).toBe(1);
    expect(await hasColumn(connection, "sub_agents")).toBe(1);
    expect(
      await scalar(connection, "SELECT COUNT(*) FROM conversation_turns WHERE cache_creation_1h_tokens IS NULL"),
    ).toBe(1);
    expect(await scalar(connection, "SELECT cache_creation_tokens FROM sub_agents")).toBe(700);
    connection.closeSync();
  });

  it("is a no-op the second time", async () => {
    const connection = await createV7Db();
    await new SchemaManager().migrate(connection);
    expect(await new SchemaManager().migrate(connection)).toBe(0);
    expect(await maxVersion(connection)).toBe(8);
    connection.closeSync();
  });

  it("initialize() on a v7 DB adds the column too (commands that only initialize)", async () => {
    const connection = await createV7Db();
    await new SchemaManager().initialize(connection);
    expect(await hasColumn(connection, "conversation_turns")).toBe(1);
    expect(await hasColumn(connection, "sub_agents")).toBe(1);
    expect(await maxVersion(connection)).toBe(8);
    connection.closeSync();
  });
});
