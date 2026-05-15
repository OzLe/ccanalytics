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
    content_text          TEXT
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

-- sessions indexes
CREATE INDEX IF NOT EXISTS idx_sessions_start_time      ON sessions (start_time);
CREATE INDEX IF NOT EXISTS idx_sessions_project_path    ON sessions (project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_project_time    ON sessions (project_path, start_time);

-- conversation_turns indexes
CREATE INDEX IF NOT EXISTS idx_turns_session_id         ON conversation_turns (session_id);
CREATE INDEX IF NOT EXISTS idx_turns_timestamp          ON conversation_turns (timestamp);
CREATE INDEX IF NOT EXISTS idx_turns_request_id         ON conversation_turns (request_id);
CREATE INDEX IF NOT EXISTS idx_turns_session_time       ON conversation_turns (session_id, timestamp);

-- tool_calls indexes
CREATE INDEX IF NOT EXISTS idx_tools_session_id         ON tool_calls (session_id);
CREATE INDEX IF NOT EXISTS idx_tools_tool_name          ON tool_calls (tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_session_tool       ON tool_calls (session_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_turn_id            ON tool_calls (turn_id);

-- errors indexes
CREATE INDEX IF NOT EXISTS idx_errors_session_id        ON errors (session_id);
CREATE INDEX IF NOT EXISTS idx_errors_timestamp         ON errors (timestamp);
CREATE INDEX IF NOT EXISTS idx_errors_type              ON errors (error_type);
CREATE INDEX IF NOT EXISTS idx_errors_session_time      ON errors (session_id, timestamp);

-- Record schema version
INSERT INTO schema_migrations (version, description)
VALUES (1, 'Initial schema: 5 tables, 14 indexes')
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- Migration 5 — Skill Analysis (F2D)
-- Additive only: CREATE TABLE / CREATE INDEX / ALTER ADD COLUMN, all
-- IF NOT EXISTS. Mirrors applyMigration5() in src/db/schema.ts (S-01..S-08);
-- the v_skill_usage view (S-07) lives in sql/views.sql so it is re-created
-- with the other views. Re-running this whole file is a no-op.
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

-- S-02 / S-03: session_skills indexes
CREATE INDEX IF NOT EXISTS idx_session_skills_session    ON session_skills (session_id);
CREATE INDEX IF NOT EXISTS idx_session_skills_skill_name ON session_skills (skill_name);

-- S-04 / S-05: invoked-skill columns on tool_calls (NULL for non-Skill rows)
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS skill_name        VARCHAR;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS skill_caller_type VARCHAR;

-- S-06: index for skill-name lookups on tool_calls
CREATE INDEX IF NOT EXISTS idx_tools_skill_name          ON tool_calls (skill_name);

-- S-08: record schema version 5
INSERT INTO schema_migrations (version, description)
VALUES (5, 'Skill Analysis: session_skills table + tool_calls.skill_name/skill_caller_type columns + v_skill_usage view')
ON CONFLICT (version) DO NOTHING;
