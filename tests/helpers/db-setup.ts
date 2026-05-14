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

/**
 * Seed skill-analysis fixtures (migration 5) on top of {@link seedTestData}.
 *
 * Additive: this only INSERTs into `session_skills`, `conversation_turns`
 * (extra `user` turns, all 0-token so they are invisible to the token / cost /
 * cache analyzers), and `tool_calls` (`Skill` rows). It never mutates the rows
 * `seedTestData` creates, so the existing analyzer tests are unaffected.
 *
 * Call AFTER `seedTestData` — the `Skill` `tool_calls` join onto
 * `conversation_turns`, and the period-session scoping in `session_skills`,
 * both rely on the base sessions (`sess-001/002/003`) already existing.
 *
 * Fixture layout (all timestamps inside 2026-02-19 .. 2026-02-22):
 *
 *   LOADED (`session_skills`)
 *     skill-alpha : sess-001, sess-003           (2 sessions, also invoked)
 *     skill-beta  : sess-001                     (1 session,  also invoked)
 *     skill-ghost : sess-002, sess-003           (2 sessions, NEVER invoked → dead weight)
 *     skill-orphan: sess-003                     (1 session,  NEVER invoked → dead weight)
 *
 *   INVOKED (`tool_calls` where tool_name = 'Skill')
 *     skill-alpha : sess-001 ×3 (success TRUE, TRUE, NULL), sess-003 ×1 (FALSE)
 *                   → the sess-001 ×3 is a thrash row; the sess-003 row uses
 *                     skill_name = NULL + parameters->>'skill' (COALESCE fallback)
 *     skill-beta  : sess-002 ×2 (both success NULL) — thrash row; one row uses
 *                   the COALESCE fallback. skill-beta is invoked in the period
 *                   so it is NOT dead weight even though loaded only once.
 *     loop        : sess-003 ×2 (success TRUE, TRUE) — thrash row, but `loop`
 *                   is a KNOWN_REENTRANT skill so isKnownReentrant = true.
 *
 *   skill_caller_type is populated on a subset of rows ('user' / 'agent').
 */
export async function seedSkillData(
  connection: DuckDBConnection,
): Promise<void> {
  // Extra host turns for the Skill tool_calls — role 'user', 0 tokens, so they
  // are invisible to the token / cost / cache fixtures (those predicates all
  // require role = 'assistant'). The `model` is set to each session's model so
  // the analyzer's model filter — which joins `tool_calls` onto the hosting
  // `conversation_turns` row — narrows the Skill rows correctly. The
  // skill-analyzer join needs (turn_id, session_id) to match and the timestamp
  // to fall in range.
  await connection.run(`
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
    VALUES
      ('turn-sk-101', 'sess-001', 'user', '2026-02-20 10:10:00', 0, 0, 0, 0, 0, 'claude-sonnet-4-5', NULL, NULL, FALSE, FALSE),
      ('turn-sk-102', 'sess-001', 'user', '2026-02-20 10:11:00', 0, 0, 0, 0, 0, 'claude-sonnet-4-5', NULL, NULL, FALSE, FALSE),
      ('turn-sk-103', 'sess-001', 'user', '2026-02-20 10:12:00', 0, 0, 0, 0, 0, 'claude-sonnet-4-5', NULL, NULL, FALSE, FALSE),
      ('turn-sk-201', 'sess-002', 'user', '2026-02-20 14:20:00', 0, 0, 0, 0, 0, 'claude-opus-4', NULL, NULL, FALSE, FALSE),
      ('turn-sk-202', 'sess-002', 'user', '2026-02-20 14:21:00', 0, 0, 0, 0, 0, 'claude-opus-4', NULL, NULL, FALSE, FALSE),
      ('turn-sk-301', 'sess-003', 'user', '2026-02-21 09:10:00', 0, 0, 0, 0, 0, 'claude-sonnet-4-5', NULL, NULL, FALSE, FALSE),
      ('turn-sk-302', 'sess-003', 'user', '2026-02-21 09:11:00', 0, 0, 0, 0, 0, 'claude-sonnet-4-5', NULL, NULL, FALSE, FALSE),
      ('turn-sk-303', 'sess-003', 'user', '2026-02-21 09:12:00', 0, 0, 0, 0, 0, 'claude-sonnet-4-5', NULL, NULL, FALSE, FALSE)
  `);

  // LOADED side — session_skills (one row per (session, skill); skill_count
  // and the rest are not read by the analyzer but are populated for realism).
  await connection.run(`
    INSERT INTO session_skills (session_skill_id, session_id, record_uuid,
      skill_name, skill_description, skill_count, is_initial, captured_at, source)
    VALUES
      ('ss-001', 'sess-001', 'rec-001', 'skill-alpha',  'Alpha skill',  4, TRUE,  '2026-02-20 10:00:00', 'skill_listing'),
      ('ss-002', 'sess-001', 'rec-001', 'skill-beta',   'Beta skill',   4, TRUE,  '2026-02-20 10:00:00', 'skill_listing'),
      ('ss-003', 'sess-002', 'rec-002', 'skill-ghost',  'Ghost skill',  2, TRUE,  '2026-02-20 14:00:00', 'skill_listing'),
      ('ss-004', 'sess-003', 'rec-003', 'skill-alpha',  'Alpha skill',  3, TRUE,  '2026-02-21 09:00:00', 'skill_listing'),
      ('ss-005', 'sess-003', 'rec-003', 'skill-ghost',  'Ghost skill',  3, TRUE,  '2026-02-21 09:00:00', 'skill_listing'),
      ('ss-006', 'sess-003', 'rec-003', 'skill-orphan', 'Orphan skill', 3, TRUE,  '2026-02-21 09:00:00', 'skill_listing')
  `);

  // INVOKED side — tool_calls where tool_name = 'Skill'. Some rows carry an
  // explicit skill_name; the COALESCE-fallback rows leave skill_name NULL and
  // only set parameters->>'skill'. skill_caller_type is set on a subset.
  await connection.run(`
    INSERT INTO tool_calls (tool_call_id, session_id, turn_id, tool_name,
      tool_type, mcp_server, duration_ms, success, error_message, parameters,
      skill_name, skill_caller_type)
    VALUES
      -- skill-alpha in sess-001 ×3 (thrash). success TRUE / TRUE / NULL.
      ('sk-tc-001', 'sess-001', 'turn-sk-101', 'Skill', 'native', NULL, 100, TRUE,  NULL, '{"skill":"skill-alpha"}', 'skill-alpha', 'user'),
      ('sk-tc-002', 'sess-001', 'turn-sk-102', 'Skill', 'native', NULL, 110, TRUE,  NULL, '{"skill":"skill-alpha"}', 'skill-alpha', 'user'),
      ('sk-tc-003', 'sess-001', 'turn-sk-103', 'Skill', 'native', NULL, 120, NULL,  NULL, '{"skill":"skill-alpha"}', 'skill-alpha', 'agent'),
      -- skill-alpha in sess-003 ×1 (FALSE) — COALESCE fallback: skill_name NULL.
      ('sk-tc-004', 'sess-003', 'turn-sk-301', 'Skill', 'native', NULL, 130, FALSE, 'boom', '{"skill":"skill-alpha"}', NULL, 'agent'),
      -- skill-beta in sess-002 ×2 (thrash). Both success NULL → per-skill rate NULL.
      ('sk-tc-005', 'sess-002', 'turn-sk-201', 'Skill', 'native', NULL, 140, NULL,  NULL, '{"skill":"skill-beta"}', 'skill-beta', NULL),
      ('sk-tc-006', 'sess-002', 'turn-sk-202', 'Skill', 'native', NULL, 150, NULL,  NULL, '{"skill":"skill-beta"}', NULL, NULL),
      -- loop in sess-003 ×2 (thrash) — KNOWN_REENTRANT, success TRUE / TRUE.
      ('sk-tc-007', 'sess-003', 'turn-sk-302', 'Skill', 'native', NULL, 160, TRUE,  NULL, '{"skill":"loop"}', 'loop', 'user'),
      ('sk-tc-008', 'sess-003', 'turn-sk-303', 'Skill', 'native', NULL, 170, TRUE,  NULL, '{"skill":"loop"}', 'loop', 'user')
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
