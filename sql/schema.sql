-- =============================================================================
-- ccanalytics DuckDB Schema Initialization
-- Version: 0.1.0
-- =============================================================================

-- Tables (in dependency order)

CREATE TABLE IF NOT EXISTS sessions (
    session_id            VARCHAR     PRIMARY KEY,
    start_time            TIMESTAMP   NOT NULL,
    end_time              TIMESTAMP,
    duration_seconds      INTEGER,
    model                 VARCHAR,
    input_tokens          BIGINT      DEFAULT 0,
    output_tokens         BIGINT      DEFAULT 0,
    cache_creation_tokens BIGINT      DEFAULT 0,
    cache_read_tokens     BIGINT      DEFAULT 0,
    total_cost_usd        DOUBLE      DEFAULT 0.0,
    num_turns             INTEGER     DEFAULT 0,
    num_tool_calls        INTEGER     DEFAULT 0,
    cwd                   VARCHAR,
    source_file           VARCHAR,
    git_branch            VARCHAR,
    claude_version        VARCHAR,
    project_path          VARCHAR,
    project_name          VARCHAR,
    source_type           VARCHAR     DEFAULT 'claude-code'
);

CREATE TABLE IF NOT EXISTS conversation_turns (
    turn_id               VARCHAR     PRIMARY KEY,
    session_id            VARCHAR     NOT NULL,
    role                  VARCHAR     NOT NULL,
    timestamp             TIMESTAMP   NOT NULL,
    input_tokens          BIGINT      DEFAULT 0,
    output_tokens         BIGINT      DEFAULT 0,
    cache_creation_tokens BIGINT      DEFAULT 0,
    cache_read_tokens     BIGINT      DEFAULT 0,
    cost_usd              DOUBLE      DEFAULT 0.0,
    model                 VARCHAR,
    stop_reason           VARCHAR,
    request_id            VARCHAR     UNIQUE,
    parent_uuid           VARCHAR,
    has_tool_use          BOOLEAN     DEFAULT FALSE,
    has_thinking          BOOLEAN     DEFAULT FALSE,
    content_text          TEXT,
    cache_creation_1h_tokens BIGINT             -- migration 8: of cache_creation_tokens, the 1-hour writes; NULL = not recorded
);

CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id          VARCHAR     PRIMARY KEY,
    session_id            VARCHAR     NOT NULL,
    turn_id               VARCHAR     NOT NULL,
    tool_name             VARCHAR     NOT NULL,
    tool_type             VARCHAR     NOT NULL DEFAULT 'native',
    mcp_server            VARCHAR,
    duration_ms           INTEGER,
    success               BOOLEAN,
    error_message         VARCHAR,
    parameters            JSON
);

CREATE TABLE IF NOT EXISTS errors (
    error_id              VARCHAR     PRIMARY KEY,
    session_id            VARCHAR     NOT NULL,
    timestamp             TIMESTAMP   NOT NULL,
    error_type            VARCHAR     NOT NULL,
    message               VARCHAR,
    is_retryable          BOOLEAN     DEFAULT FALSE,
    retry_count           INTEGER     DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingestion_state (
    file_path             VARCHAR     PRIMARY KEY,
    last_byte_offset      BIGINT      NOT NULL DEFAULT 0,
    last_line_number      INTEGER     NOT NULL DEFAULT 0,
    last_ingested_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    file_checksum         VARCHAR,
    file_size_bytes       BIGINT
);

-- Schema migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version               INTEGER     PRIMARY KEY,
    applied_at            TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    description           VARCHAR
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- No secondary indexes, by design: migration 7 dropped every CREATE INDEX this
-- file used to declare. DuckDB 1.4.4 lost rows from those ART indexes when it
-- replayed the WAL, so filtered queries silently returned too few rows, and a
-- columnar scan answers every dashboard query in about a millisecond without
-- them. Only the PRIMARY KEY / UNIQUE indexes remain; ON CONFLICT needs them.
-- See docs/filtered-query-misses-2026-09-28.md.

-- Record schema version
INSERT INTO schema_migrations (version, description)
VALUES (1, 'Initial schema: 5 tables, 14 indexes')
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- Migration 5 — Skill Analysis (F2D)
-- Additive only: CREATE TABLE / ALTER ADD COLUMN, all IF NOT EXISTS (its
-- S-02/S-03/S-06 indexes were dropped by migration 7). Mirrors
-- applyMigration5() in src/db/schema.ts (S-01..S-08); the v_skill_usage view
-- (S-07) lives in sql/views.sql so it is re-created with the other views.
-- Re-running this whole file is a no-op.
-- =============================================================================

-- S-01: loaded-skills table — one row per (session_id, record_uuid, skill_name).
CREATE TABLE IF NOT EXISTS session_skills (
    session_skill_id      VARCHAR     PRIMARY KEY,
    session_id            VARCHAR     NOT NULL,
    record_uuid           VARCHAR,
    skill_name            VARCHAR     NOT NULL,
    skill_description     TEXT,
    skill_count           INTEGER,
    is_initial            BOOLEAN     DEFAULT TRUE,
    captured_at           TIMESTAMP,
    source                VARCHAR     DEFAULT 'skill_listing'
);

-- S-04 / S-05: invoked-skill columns on tool_calls (NULL for non-Skill rows)
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS skill_name        VARCHAR;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS skill_caller_type VARCHAR;

-- S-08: record schema version 5
INSERT INTO schema_migrations (version, description)
VALUES (5, 'Skill Analysis: session_skills table + tool_calls.skill_name/skill_caller_type columns + v_skill_usage view')
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- Migration 6 — Sub-Agent & Workflow Attribution (F-SA)
-- Additive only: CREATE TABLE, all IF NOT EXISTS (its indexes were dropped by
-- migration 7). Mirrors applyMigration6() in src/db/schema.ts (SA-01..SA-04);
-- the v_subagent_usage / v_workflow_summary / v_session_orchestration views
-- live in sql/views.sql so they are re-created with the other views.
-- Re-running this whole file is a no-op.
--
-- WHY SEPARATE TABLES (not is_sidechain columns on conversation_turns /
-- tool_calls): every existing cost/token/cache view and its ~49 inline route
-- mirrors read straight from those two tables with no sessions join. A
-- sub-agent row there would silently inflate ALL of them (the parallel-inline-
-- SQL drift the views.sql header warns about). Keeping sub-agent data in its
-- own tables means the cost SSOT (SUM(conversation_turns.cost_usd)) stays
-- byte-for-byte unchanged. sub_agents.cost_usd is computed at ingest with the
-- SAME calculateCost()/pricing.ts SSOT but is NEVER summed by an existing
-- surface — only v_session_orchestration blends it, explicitly and opt-in.
-- =============================================================================

-- SA-01: one row per agent-<agentId>.jsonl transcript (AGGREGATE grain).
-- PK is COMPOSITE — agentId is NOT globally unique across sessions.
CREATE TABLE IF NOT EXISTS sub_agents (
    parent_session_id     VARCHAR     NOT NULL,   -- record.sessionId (reliable), NOT the dir name
    agent_id              VARCHAR     NOT NULL,    -- filename agent-<id> == record.agentId
    session_dir           VARCHAR,                 -- containing <session>/ dir name (provenance)
    agent_class           VARCHAR,                 -- 'regular' | 'workflow'
    subagent_type         VARCHAR,
    workflow_run_id       VARCHAR,                 -- 'wf_<runId>' for workflow agents, else NULL
    spawn_tool_use_id     VARCHAR,                 -- regular: meta.toolUseId -> parent Agent tool_use.id
    spawn_depth           INTEGER,
    is_fork               BOOLEAN,
    workflow_label        VARCHAR,
    workflow_phase        VARCHAR,
    entrypoint            VARCHAR,
    model                 VARCHAR,                 -- dominant model by turn count
    git_branch            VARCHAR,
    start_time            TIMESTAMP,
    end_time              TIMESTAMP,
    duration_seconds      INTEGER,
    input_tokens          BIGINT      DEFAULT 0,
    output_tokens         BIGINT      DEFAULT 0,
    cache_creation_tokens BIGINT      DEFAULT 0,
    cache_read_tokens     BIGINT      DEFAULT 0,
    cost_usd              DOUBLE      DEFAULT 0.0,
    num_turns             INTEGER     DEFAULT 0,
    num_tool_calls        INTEGER     DEFAULT 0,
    success               BOOLEAN,                 -- best-effort from last assistant stop_reason
    project_path          VARCHAR,
    source_file           VARCHAR,
    cache_creation_1h_tokens BIGINT,            -- migration 8: of cache_creation_tokens, the 1-hour writes; NULL = not recorded
    PRIMARY KEY (parent_session_id, agent_id)
);

-- SA-02: sub-agent tool calls — SEPARATE from tool_calls (no turn_id FK; never
-- JOINed to conversation_turns; never touched by main-session tool views). PK
-- is the globally-unique tool_use block id.
CREATE TABLE IF NOT EXISTS sub_agent_tool_calls (
    tool_call_id          VARCHAR     PRIMARY KEY,
    parent_session_id     VARCHAR     NOT NULL,
    agent_id              VARCHAR     NOT NULL,
    tool_name             VARCHAR     NOT NULL,
    tool_type             VARCHAR     NOT NULL DEFAULT 'builtin',
    mcp_server            VARCHAR,
    success               BOOLEAN,
    error_message         VARCHAR,
    parameters            JSON,
    skill_name            VARCHAR,
    skill_caller_type     VARCHAR
);

-- SA-03: one row per workflow RUN (wf_<runId>). Sourced from the
-- <session>/workflows/wf_<runId>.json manifest (a NEW file -> incremental-safe),
-- with a stub upserted from a workflow agent's run-dir path when no manifest.
CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id                    VARCHAR  PRIMARY KEY,   -- 'wf_<runId>'
    parent_session_id         VARCHAR,
    task_id                   VARCHAR,
    workflow_name             VARCHAR,
    summary                   TEXT,
    status                    VARCHAR,
    default_model             VARCHAR,
    num_phases                INTEGER,
    manifest_agent_count      INTEGER,               -- ADVISORY; authoritative count = COUNT(sub_agents)
    manifest_total_tokens     BIGINT,
    manifest_total_tool_calls INTEGER,
    start_time                TIMESTAMP,
    end_time                  TIMESTAMP,
    duration_seconds          INTEGER,
    source_file               VARCHAR                -- manifest path; NULL for stub rows
);

-- SA-04: record schema version 6
INSERT INTO schema_migrations (version, description)
VALUES (6, 'Sub-Agent & Workflow Attribution: sub_agents + sub_agent_tool_calls + workflow_runs tables + v_subagent_usage/v_workflow_summary/v_session_orchestration views')
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- Migration 7 — drop every secondary (non-unique) index
-- Mirrors applyMigration7() in src/db/schema.ts. DROP INDEX IF EXISTS, so
-- re-running this whole file is still a no-op. Why: see the Indexes section
-- above and docs/filtered-query-misses-2026-09-28.md.
-- =============================================================================

DROP INDEX IF EXISTS idx_sessions_start_time;
DROP INDEX IF EXISTS idx_sessions_project_path;
DROP INDEX IF EXISTS idx_sessions_project_time;
DROP INDEX IF EXISTS idx_turns_session_id;
DROP INDEX IF EXISTS idx_turns_timestamp;
DROP INDEX IF EXISTS idx_turns_request_id;
DROP INDEX IF EXISTS idx_turns_session_time;
DROP INDEX IF EXISTS idx_tools_session_id;
DROP INDEX IF EXISTS idx_tools_tool_name;
DROP INDEX IF EXISTS idx_tools_session_tool;
DROP INDEX IF EXISTS idx_tools_turn_id;
DROP INDEX IF EXISTS idx_tools_skill_name;
DROP INDEX IF EXISTS idx_errors_session_id;
DROP INDEX IF EXISTS idx_errors_timestamp;
DROP INDEX IF EXISTS idx_errors_type;
DROP INDEX IF EXISTS idx_errors_session_time;
DROP INDEX IF EXISTS idx_session_skills_session;
DROP INDEX IF EXISTS idx_session_skills_skill_name;
DROP INDEX IF EXISTS idx_sub_agents_session;
DROP INDEX IF EXISTS idx_sub_agents_workflow;
DROP INDEX IF EXISTS idx_sub_agents_type;
DROP INDEX IF EXISTS idx_sub_tools_agent;
DROP INDEX IF EXISTS idx_sub_tools_name;
DROP INDEX IF EXISTS idx_workflow_runs_session;

-- record schema version 7
INSERT INTO schema_migrations (version, description)
VALUES (7, 'Drop all secondary indexes (DuckDB 1.4.4 lost rows from them on WAL replay)')
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- Migration 8 — record 1-hour prompt-cache writes
-- Mirrors applyMigration8() in src/db/schema.ts. ALTER ... ADD COLUMN IF NOT
-- EXISTS, so re-running this whole file is still a no-op. Why: a 1-hour cache
-- write costs 2x input and a 5-minute write 1.25x, and Claude Code caches the
-- main conversation for 1 hour (docs/pricing-recovery-duckdb-plan-2026-09-28.md).
-- =============================================================================

ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS cache_creation_1h_tokens BIGINT;
ALTER TABLE sub_agents ADD COLUMN IF NOT EXISTS cache_creation_1h_tokens BIGINT;

-- record schema version 8
INSERT INTO schema_migrations (version, description)
VALUES (8, 'Record 1-hour prompt-cache writes (cache_creation_1h_tokens)')
ON CONFLICT (version) DO NOTHING;
