/**
 * @module db/schema
 *
 * Schema creation and migration for the DuckDB star schema.
 * Reads DDL from sql/schema.sql and sql/views.sql and applies them
 * to the database connection.
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MigrationError } from "../errors.js";

/** Current schema version matching sql/schema.sql */
const CURRENT_VERSION = 6;

/**
 * Split a SQL file into individual statements.
 * Strips comments first (so semicolons inside comments don't cause
 * incorrect splits), then splits on semicolons and filters empty fragments.
 */
function splitStatements(sql: string): string[] {
  // Remove comments before splitting so semicolons within
  // comments (e.g. "-- rates above 80%; effective") don't split
  const stripped = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the path to the sql/ directory.
 * In CJS bundle (dist/cli.cjs), __dirname points to dist/, so sql/ is one level up.
 * In ESM source (src/db/schema.ts), navigate up 3 levels to project root.
 */
/**
 * Resolve the directory this module lives in, working in BOTH module systems:
 *   - ESM source run via tsx (the package is "type": "module") — use
 *     import.meta.url. This path is exercised by the dashboard's POST
 *     /api/ingest route, which loads the ingestion pipeline from source.
 *   - The tsup CJS bundle (dist/cli.cjs), where import.meta.url may be absent —
 *     fall back to __dirname (typeof guard is safe even when undefined), then
 *     to process.cwd().
 */
function getModuleDir(): string {
  if (typeof import.meta.url === "string") {
    return path.dirname(fileURLToPath(import.meta.url));
  }
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return process.cwd();
}

function getSqlDir(): string {
  const moduleDir = getModuleDir();
  // dist/cli.cjs        -> moduleDir = dist/,   sql/ is ../sql
  // src/db/schema.ts    -> moduleDir = src/db/, sql/ is ../../sql
  const candidates = [
    path.resolve(moduleDir, "..", "sql"),
    path.resolve(moduleDir, "..", "..", "sql"),
    path.resolve(moduleDir, "..", "..", "..", "sql"),
    path.resolve(process.cwd(), "sql"),
  ];

  // Return the first candidate that actually contains schema.sql.
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "schema.sql"))) {
      return candidate;
    }
  }

  // Fallback: relative to cwd
  return path.resolve(process.cwd(), "sql");
}

/**
 * Manages schema initialization and migrations for the DuckDB database.
 */
export class SchemaManager {
  /**
   * Ensure all required tables, views, and indexes exist.
   * Runs the full DDL from sql/schema.sql and sql/views.sql.
   *
   * @param connection - Active DuckDB connection
   * @throws MigrationError if schema initialization fails
   */
  async initialize(connection: unknown): Promise<void> {
    const conn = connection as { run(sql: string): Promise<unknown> };
    const sqlDir = getSqlDir();

    try {
      // Read and execute schema.sql (tables, indexes, migrations record)
      const schemaPath = path.join(sqlDir, "schema.sql");
      const schemaSql = await fs.readFile(schemaPath, "utf-8");
      const schemaStatements = splitStatements(schemaSql);

      for (const stmt of schemaStatements) {
        await conn.run(stmt);
      }

      // Read and execute views.sql (analytical views)
      const viewsPath = path.join(sqlDir, "views.sql");
      const viewsSql = await fs.readFile(viewsPath, "utf-8");
      const viewStatements = splitStatements(viewsSql);

      for (const stmt of viewStatements) {
        await conn.run(stmt);
      }
    } catch (err) {
      if (err instanceof MigrationError) {
        throw err;
      }
      throw new MigrationError(CURRENT_VERSION, err as Error);
    }
  }

  /**
   * Run pending migrations from the current version to the latest.
   *
   * @param connection - Active DuckDB connection
   * @returns Number of migrations applied
   * @throws MigrationError if any migration fails (rolled back)
   */
  async migrate(connection: unknown): Promise<number> {
    const currentVersion = await this.getVersion(connection);

    if (currentVersion >= CURRENT_VERSION) {
      return 0;
    }

    // For v0.1.0, if version is 0 (no schema), run full initialization
    if (currentVersion === 0) {
      await this.initialize(connection);
      return 1;
    }

    let applied = 0;

    if (currentVersion < 2) {
      await this.applyMigration2(connection);
      applied++;
    }

    if (currentVersion < 3) {
      await this.applyMigration3(connection);
      applied++;
    }

    if (currentVersion < 4) {
      await this.applyMigration4(connection);
      applied++;
    }

    if (currentVersion < 5) {
      await this.applyMigration5(connection);
      applied++;
    }

    if (currentVersion < 6) {
      await this.applyMigration6(connection);
      applied++;
    }

    return applied;
  }

  /**
   * Migration v2: Add source_type column to sessions table.
   */
  private async applyMigration2(connection: unknown): Promise<void> {
    const conn = connection as { run(sql: string): Promise<unknown> };
    try {
      await conn.run(
        `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_type VARCHAR DEFAULT 'claude-code'`,
      );
      await conn.run(
        `INSERT INTO schema_migrations (version, description) VALUES (2, 'Add source_type column to sessions') ON CONFLICT (version) DO NOTHING`,
      );
    } catch (err) {
      throw new MigrationError(2, err as Error);
    }
  }

  /**
   * Migration v3: Add content_text column to conversation_turns table.
   */
  private async applyMigration3(connection: unknown): Promise<void> {
    const conn = connection as { run(sql: string): Promise<unknown> };
    try {
      await conn.run(
        `ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS content_text TEXT`,
      );
      await conn.run(
        `INSERT INTO schema_migrations (version, description) VALUES (3, 'Add content_text column to conversation_turns') ON CONFLICT (version) DO NOTHING`,
      );
    } catch (err) {
      throw new MigrationError(3, err as Error);
    }
  }

  /**
   * Migration v4: Append " (Desktop)" suffix to existing Desktop project names
   * so they're visually distinct from Code projects in the UI.
   */
  private async applyMigration4(connection: unknown): Promise<void> {
    const conn = connection as { run(sql: string): Promise<unknown> };
    try {
      await conn.run(
        `UPDATE sessions SET project_name = project_name || ' (Desktop)' WHERE source_type = 'claude-desktop' AND project_name IS NOT NULL AND project_name NOT LIKE '% (Desktop)'`,
      );
      await conn.run(
        `INSERT INTO schema_migrations (version, description) VALUES (4, 'Add Desktop suffix to desktop project names') ON CONFLICT (version) DO NOTHING`,
      );
    } catch (err) {
      throw new MigrationError(4, err as Error);
    }
  }

  /**
   * Migration v5: Skill Analysis (F2D) — purely ADDITIVE.
   *
   * Runs S-01..S-08 from the feature plan:
   *   - S-01  CREATE TABLE session_skills
   *   - S-02/S-03  CREATE INDEX on session_skills
   *   - S-04/S-05  ALTER TABLE tool_calls ADD COLUMN skill_name / skill_caller_type
   *   - S-06  CREATE INDEX idx_tools_skill_name
   *   - S-07  CREATE OR REPLACE VIEW v_skill_usage
   *   - S-08  record schema_migrations version 5
   *
   * Every statement is CREATE/ALTER ... IF NOT EXISTS or CREATE OR REPLACE —
   * there is NO DROP, DELETE, TRUNCATE, column-drop, or existing-row UPDATE,
   * so re-running on an already-migrated database is a no-op. The new
   * tool_calls columns are nullable with no default, so existing rows are
   * untouched (their skill_name/skill_caller_type read as NULL until a
   * re-ingest or the backfill script fills them).
   */
  private async applyMigration5(connection: unknown): Promise<void> {
    const conn = connection as { run(sql: string): Promise<unknown> };
    try {
      // S-01: loaded-skills table.
      await conn.run(
        `CREATE TABLE IF NOT EXISTS session_skills (
           session_skill_id  VARCHAR   PRIMARY KEY,
           session_id        VARCHAR   NOT NULL,
           record_uuid       VARCHAR,
           skill_name        VARCHAR   NOT NULL,
           skill_description TEXT,
           skill_count       INTEGER,
           is_initial        BOOLEAN   DEFAULT TRUE,
           captured_at       TIMESTAMP,
           source            VARCHAR   DEFAULT 'skill_listing'
         )`,
      );
      // S-02 / S-03: session_skills indexes.
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_session_skills_session ON session_skills (session_id)`,
      );
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_session_skills_skill_name ON session_skills (skill_name)`,
      );
      // S-04 / S-05: invoked-skill columns on tool_calls (nullable, no default).
      await conn.run(
        `ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS skill_name VARCHAR`,
      );
      await conn.run(
        `ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS skill_caller_type VARCHAR`,
      );
      // S-06: skill-name lookup index on tool_calls.
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_tools_skill_name ON tool_calls (skill_name)`,
      );
      // S-07: per (session, skill) loaded-vs-invoked view.
      await conn.run(
        `CREATE OR REPLACE VIEW v_skill_usage AS
         WITH loaded AS (
           SELECT session_id, skill_name, MAX(skill_count) AS skills_loaded_in_session
           FROM session_skills
           GROUP BY session_id, skill_name
         ),
         invoked AS (
           SELECT
             session_id,
             COALESCE(skill_name, parameters->>'skill') AS skill_name,
             COUNT(*) AS invocations,
             SUM(CASE WHEN success THEN 1 ELSE 0 END) AS successes,
             SUM(CASE
                   WHEN skill_caller_type IS NOT NULL AND skill_caller_type <> 'direct'
                   THEN 1 ELSE 0
                 END) AS non_direct_invocations
           FROM tool_calls
           WHERE tool_name = 'Skill'
           GROUP BY session_id, COALESCE(skill_name, parameters->>'skill')
         )
         SELECT
           COALESCE(l.session_id, i.session_id) AS session_id,
           COALESCE(l.skill_name, i.skill_name) AS skill_name,
           (l.skill_name IS NOT NULL) AS was_loaded,
           COALESCE(i.invocations, 0) AS invocations,
           COALESCE(i.successes, 0) AS successes,
           COALESCE(i.non_direct_invocations, 0) AS non_direct_invocations
         FROM loaded l
         FULL OUTER JOIN invoked i
           ON l.session_id = i.session_id AND l.skill_name = i.skill_name`,
      );
      // S-08: record the migration.
      await conn.run(
        `INSERT INTO schema_migrations (version, description) VALUES (5, 'Skill Analysis: session_skills table + tool_calls.skill_name/skill_caller_type columns + v_skill_usage view') ON CONFLICT (version) DO NOTHING`,
      );
    } catch (err) {
      throw new MigrationError(5, err as Error);
    }
  }

  /**
   * Migration v6: Sub-Agent & Workflow Attribution (F-SA) — purely ADDITIVE.
   *
   * Runs SA-01..SA-04 from the implementation spec:
   *   - SA-01  CREATE TABLE sub_agents (composite PK) + 3 indexes
   *   - SA-02  CREATE TABLE sub_agent_tool_calls + 2 indexes
   *   - SA-03  CREATE TABLE workflow_runs + 1 index
   *   - views  CREATE OR REPLACE v_subagent_usage / v_workflow_summary /
   *            v_session_orchestration (mirrored from sql/views.sql — the
   *            same BOTH-places contract as v_skill_usage in migration 5)
   *   - SA-04  record schema_migrations version 6
   *
   * Every statement is CREATE ... IF NOT EXISTS or CREATE OR REPLACE — no DROP,
   * DELETE, TRUNCATE, or existing-row UPDATE, so re-running on an already-
   * migrated database is a no-op. Sub-agent data lives ONLY in these new tables,
   * so the conversation_turns.cost_usd SSOT and every existing view/route are
   * byte-for-byte unaffected.
   */
  private async applyMigration6(connection: unknown): Promise<void> {
    const conn = connection as { run(sql: string): Promise<unknown> };
    try {
      // SA-01: sub_agents — one row per agent-<id>.jsonl transcript.
      await conn.run(
        `CREATE TABLE IF NOT EXISTS sub_agents (
           parent_session_id     VARCHAR   NOT NULL,
           agent_id              VARCHAR   NOT NULL,
           session_dir           VARCHAR,
           agent_class           VARCHAR,
           subagent_type         VARCHAR,
           workflow_run_id       VARCHAR,
           spawn_tool_use_id     VARCHAR,
           spawn_depth           INTEGER,
           is_fork               BOOLEAN,
           workflow_label        VARCHAR,
           workflow_phase        VARCHAR,
           entrypoint            VARCHAR,
           model                 VARCHAR,
           git_branch            VARCHAR,
           start_time            TIMESTAMP,
           end_time              TIMESTAMP,
           duration_seconds      INTEGER,
           input_tokens          BIGINT    DEFAULT 0,
           output_tokens         BIGINT    DEFAULT 0,
           cache_creation_tokens BIGINT    DEFAULT 0,
           cache_read_tokens     BIGINT    DEFAULT 0,
           cost_usd              DOUBLE    DEFAULT 0.0,
           num_turns             INTEGER   DEFAULT 0,
           num_tool_calls        INTEGER   DEFAULT 0,
           success               BOOLEAN,
           project_path          VARCHAR,
           source_file           VARCHAR,
           PRIMARY KEY (parent_session_id, agent_id)
         )`,
      );
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_sub_agents_session ON sub_agents (parent_session_id)`,
      );
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_sub_agents_workflow ON sub_agents (workflow_run_id)`,
      );
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_sub_agents_type ON sub_agents (subagent_type)`,
      );
      // SA-02: sub_agent_tool_calls — separate from tool_calls.
      await conn.run(
        `CREATE TABLE IF NOT EXISTS sub_agent_tool_calls (
           tool_call_id      VARCHAR   PRIMARY KEY,
           parent_session_id VARCHAR   NOT NULL,
           agent_id          VARCHAR   NOT NULL,
           tool_name         VARCHAR   NOT NULL,
           tool_type         VARCHAR   NOT NULL DEFAULT 'builtin',
           mcp_server        VARCHAR,
           success           BOOLEAN,
           error_message     VARCHAR,
           parameters        JSON,
           skill_name        VARCHAR,
           skill_caller_type VARCHAR
         )`,
      );
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_sub_tools_agent ON sub_agent_tool_calls (parent_session_id, agent_id)`,
      );
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_sub_tools_name ON sub_agent_tool_calls (tool_name)`,
      );
      // SA-03: workflow_runs — one row per wf_<runId>.
      await conn.run(
        `CREATE TABLE IF NOT EXISTS workflow_runs (
           run_id                    VARCHAR PRIMARY KEY,
           parent_session_id         VARCHAR,
           task_id                   VARCHAR,
           workflow_name             VARCHAR,
           summary                   TEXT,
           status                    VARCHAR,
           default_model             VARCHAR,
           num_phases                INTEGER,
           manifest_agent_count      INTEGER,
           manifest_total_tokens     BIGINT,
           manifest_total_tool_calls INTEGER,
           start_time                TIMESTAMP,
           end_time                  TIMESTAMP,
           duration_seconds          INTEGER,
           source_file               VARCHAR
         )`,
      );
      await conn.run(
        `CREATE INDEX IF NOT EXISTS idx_workflow_runs_session ON workflow_runs (parent_session_id)`,
      );
      // Views (mirrored from sql/views.sql — keep in sync).
      await conn.run(
        `CREATE OR REPLACE VIEW v_subagent_usage AS
         SELECT
           COALESCE(subagent_type, '(unknown)') AS subagent_type,
           COUNT(*) AS agent_runs,
           SUM(cost_usd) AS total_cost_usd,
           SUM(input_tokens + output_tokens) AS total_tokens,
           SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS context_volume_tokens,
           SUM(num_tool_calls) AS total_tool_calls,
           ROUND(AVG(num_tool_calls), 2) AS avg_tools_per_agent,
           ROUND(AVG(num_turns), 2) AS avg_turns_per_agent,
           CASE
             WHEN COUNT(*) FILTER (WHERE success IS NOT NULL) > 0
             THEN ROUND(
               COUNT(*) FILTER (WHERE success = TRUE)::DOUBLE /
               COUNT(*) FILTER (WHERE success IS NOT NULL)::DOUBLE, 4)
             ELSE NULL
           END AS success_rate
         FROM sub_agents
         GROUP BY COALESCE(subagent_type, '(unknown)')
         ORDER BY total_cost_usd DESC`,
      );
      await conn.run(
        `CREATE OR REPLACE VIEW v_workflow_summary AS
         WITH agent_agg AS (
           SELECT
             workflow_run_id,
             COUNT(*) AS agents_observed,
             SUM(cost_usd) AS total_cost_usd,
             SUM(input_tokens + output_tokens) AS total_tokens,
             SUM(num_tool_calls) AS total_tool_calls
           FROM sub_agents
           WHERE workflow_run_id IS NOT NULL
           GROUP BY workflow_run_id
         )
         SELECT
           w.run_id, w.parent_session_id, w.workflow_name, w.status, w.num_phases,
           COALESCE(a.agents_observed, 0) AS agents_observed,
           CASE WHEN COALESCE(w.num_phases, 0) > 0
                THEN ROUND(COALESCE(a.agents_observed, 0)::DOUBLE / w.num_phases::DOUBLE, 2)
                ELSE NULL END AS fan_out_per_phase,
           COALESCE(a.total_cost_usd, 0.0) AS total_cost_usd,
           COALESCE(a.total_tokens, 0) AS total_tokens,
           COALESCE(a.total_tool_calls, 0) AS total_tool_calls,
           w.duration_seconds, w.start_time, w.end_time
         FROM workflow_runs w
         LEFT JOIN agent_agg a ON a.workflow_run_id = w.run_id
         ORDER BY total_cost_usd DESC`,
      );
      await conn.run(
        `CREATE OR REPLACE VIEW v_session_orchestration AS
         WITH main AS (
           SELECT session_id, SUM(cost_usd) AS main_cost_usd
           FROM conversation_turns GROUP BY session_id
         ),
         sub AS (
           SELECT parent_session_id AS session_id,
                  COUNT(*) AS sub_agents_spawned,
                  SUM(cost_usd) AS orchestration_cost_usd,
                  SUM(num_tool_calls) AS subagent_tool_calls,
                  SUM(input_tokens + output_tokens) AS subagent_tokens
           FROM sub_agents GROUP BY parent_session_id
         ),
         wf AS (
           SELECT parent_session_id AS session_id, COUNT(*) AS workflow_runs
           FROM workflow_runs GROUP BY parent_session_id
         )
         SELECT
           s.session_id, s.project_name,
           COALESCE(sub.sub_agents_spawned, 0) AS sub_agents_spawned,
           COALESCE(wf.workflow_runs, 0) AS workflow_runs,
           COALESCE(m.main_cost_usd, 0.0) AS main_cost_usd,
           COALESCE(sub.orchestration_cost_usd, 0.0) AS orchestration_cost_usd,
           COALESCE(m.main_cost_usd, 0.0) + COALESCE(sub.orchestration_cost_usd, 0.0) AS blended_cost_usd,
           CASE WHEN COALESCE(m.main_cost_usd, 0) + COALESCE(sub.orchestration_cost_usd, 0) > 0
                THEN ROUND(COALESCE(sub.orchestration_cost_usd, 0)::DOUBLE /
                     (COALESCE(m.main_cost_usd, 0) + COALESCE(sub.orchestration_cost_usd, 0))::DOUBLE, 4)
                ELSE 0.0 END AS orchestration_cost_share
         FROM sessions s
         LEFT JOIN main m ON m.session_id = s.session_id
         LEFT JOIN sub ON sub.session_id = s.session_id
         LEFT JOIN wf ON wf.session_id = s.session_id
         WHERE COALESCE(sub.sub_agents_spawned, 0) > 0 OR COALESCE(wf.workflow_runs, 0) > 0
         ORDER BY orchestration_cost_usd DESC`,
      );
      // SA-04: record the migration.
      await conn.run(
        `INSERT INTO schema_migrations (version, description) VALUES (6, 'Sub-Agent & Workflow Attribution: sub_agents + sub_agent_tool_calls + workflow_runs tables + v_subagent_usage/v_workflow_summary/v_session_orchestration views') ON CONFLICT (version) DO NOTHING`,
      );
    } catch (err) {
      throw new MigrationError(6, err as Error);
    }
  }

  /**
   * Get the current schema version number.
   * Returns 0 if no schema has been initialized.
   *
   * @param connection - Active DuckDB connection
   * @returns Current schema version
   */
  async getVersion(connection: unknown): Promise<number> {
    const conn = connection as {
      runAndReadAll(sql: string): Promise<{
        getRowObjectsJS(): Record<string, unknown>[];
        currentRowCount: number;
      }>;
    };

    try {
      const reader = await conn.runAndReadAll(
        "SELECT MAX(version) AS version FROM schema_migrations",
      );

      if (reader.currentRowCount === 0) {
        return 0;
      }

      const rows = reader.getRowObjectsJS();
      const version = rows[0]?.version;

      // MAX() returns null if the table is empty
      if (version === null || version === undefined) {
        return 0;
      }

      return Number(version);
    } catch {
      // Table doesn't exist yet — schema not initialized
      return 0;
    }
  }
}
