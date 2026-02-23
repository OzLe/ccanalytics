/**
 * @module tests/helpers/db-setup
 *
 * Test database setup utilities.
 * Creates in-memory DuckDB instances with the full schema for integration tests.
 */

import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface TestDB {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}

/**
 * Create an in-memory DuckDB instance with the full schema loaded.
 */
export async function createTestDB(): Promise<TestDB> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  // Load schema.sql
  const sqlDir = path.resolve(process.cwd(), "sql");
  const schemaSql = await fs.readFile(path.join(sqlDir, "schema.sql"), "utf-8");
  const viewsSql = await fs.readFile(path.join(sqlDir, "views.sql"), "utf-8");

  // Execute statements (strip comments, split on ;)
  for (const sql of splitStatements(schemaSql)) {
    await connection.run(sql);
  }
  for (const sql of splitStatements(viewsSql)) {
    await connection.run(sql);
  }

  return { instance, connection };
}

/**
 * Close a test database connection.
 */
export async function closeTestDB(db: TestDB): Promise<void> {
  db.connection.closeSync();
}

/**
 * Seed a test database with known data for cost/session/tool/cache tests.
 */
export async function seedTestData(connection: DuckDBConnection): Promise<void> {
  // Sessions
  await connection.run(`
    INSERT INTO sessions (session_id, start_time, end_time, duration_seconds, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      total_cost_usd, num_turns, num_tool_calls, project_path)
    VALUES
      ('sess-001', '2026-02-20 10:00:00', '2026-02-20 10:30:00', 1800, 'claude-sonnet-4-5',
       1000, 500, 200, 300, 0.05, 4, 2, '/projects/alpha'),
      ('sess-002', '2026-02-20 14:00:00', '2026-02-20 14:15:00', 900, 'claude-opus-4',
       2000, 800, 100, 500, 0.25, 3, 1, '/projects/beta'),
      ('sess-003', '2026-02-21 09:00:00', '2026-02-21 09:45:00', 2700, 'claude-sonnet-4-5',
       1500, 600, 300, 1200, 0.08, 5, 3, '/projects/alpha')
  `);

  // Conversation turns
  await connection.run(`
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
    VALUES
      ('turn-001', 'sess-001', 'user', '2026-02-20 10:00:00', 0, 0, 0, 0, 0, NULL, NULL, NULL, FALSE, FALSE),
      ('turn-002', 'sess-001', 'assistant', '2026-02-20 10:00:01', 500, 200, 200, 0, 0.02, 'claude-sonnet-4-5', 'end_turn', 'req-001', TRUE, TRUE),
      ('turn-003', 'sess-001', 'user', '2026-02-20 10:05:00', 0, 0, 0, 0, 0, NULL, NULL, NULL, FALSE, FALSE),
      ('turn-004', 'sess-001', 'assistant', '2026-02-20 10:05:01', 500, 300, 0, 300, 0.03, 'claude-sonnet-4-5', 'end_turn', 'req-002', TRUE, FALSE),
      ('turn-005', 'sess-002', 'user', '2026-02-20 14:00:00', 0, 0, 0, 0, 0, NULL, NULL, NULL, FALSE, FALSE),
      ('turn-006', 'sess-002', 'assistant', '2026-02-20 14:00:01', 2000, 800, 100, 500, 0.25, 'claude-opus-4', 'end_turn', 'req-003', FALSE, TRUE),
      ('turn-007', 'sess-003', 'user', '2026-02-21 09:00:00', 0, 0, 0, 0, 0, NULL, NULL, NULL, FALSE, FALSE),
      ('turn-008', 'sess-003', 'assistant', '2026-02-21 09:00:01', 800, 300, 300, 0, 0.04, 'claude-sonnet-4-5', 'tool_use', 'req-004', TRUE, FALSE),
      ('turn-009', 'sess-003', 'user', '2026-02-21 09:05:00', 0, 0, 0, 0, 0, NULL, NULL, NULL, FALSE, FALSE),
      ('turn-010', 'sess-003', 'assistant', '2026-02-21 09:05:01', 700, 300, 0, 1200, 0.04, 'claude-sonnet-4-5', 'end_turn', 'req-005', TRUE, TRUE)
  `);

  // Tool calls
  await connection.run(`
    INSERT INTO tool_calls (tool_call_id, session_id, turn_id, tool_name, tool_type, mcp_server, duration_ms, success)
    VALUES
      ('tc-001', 'sess-001', 'turn-002', 'Read', 'native', NULL, 50, TRUE),
      ('tc-002', 'sess-001', 'turn-004', 'Edit', 'native', NULL, 120, TRUE),
      ('tc-003', 'sess-002', 'turn-006', 'Bash', 'native', NULL, 200, FALSE),
      ('tc-004', 'sess-003', 'turn-008', 'mcp__github__create_pr', 'mcp', 'github', 350, TRUE),
      ('tc-005', 'sess-003', 'turn-010', 'mcp__google-sheets__get_sheet_data', 'mcp', 'google-sheets', 180, TRUE),
      ('tc-006', 'sess-003', 'turn-010', 'Read', 'native', NULL, 30, TRUE)
  `);

  // Errors
  await connection.run(`
    INSERT INTO errors (error_id, session_id, timestamp, error_type, message, is_retryable, retry_count)
    VALUES
      ('err-001', 'sess-002', '2026-02-20 14:05:00', 'tool_error', 'Command exited with code 1', TRUE, 1)
  `);
}

function splitStatements(sql: string): string[] {
  const stripped = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
