-- =============================================================================
-- ccanalytics Analytical Views
-- Version: 0.1.0
-- =============================================================================

-- ---------------------------------------------------------------------------
-- v_daily_cost: Daily cost aggregation broken down by model
-- Powers cost trending dashboard and budget monitoring
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_cost AS
SELECT
    CAST(ct.timestamp AS DATE)          AS date,
    ct.model                            AS model,
    SUM(ct.cost_usd)                    AS total_cost,
    SUM(ct.input_tokens)                AS input_tokens,
    SUM(ct.output_tokens)               AS output_tokens,
    SUM(ct.cache_read_tokens)           AS cache_read_tokens,
    COUNT(*)                            AS turn_count,
    COUNT(DISTINCT ct.session_id)       AS session_count
FROM conversation_turns ct
WHERE ct.role = 'assistant'
  AND ct.cost_usd > 0
GROUP BY
    CAST(ct.timestamp AS DATE),
    ct.model
ORDER BY date DESC, total_cost DESC;

-- ---------------------------------------------------------------------------
-- v_session_summary: Session-level summary with cache efficiency
-- Powers session list view and detail drill-down
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_session_summary AS
SELECT
    s.session_id,
    s.start_time,
    s.end_time,
    s.duration_seconds,
    s.model,
    s.total_cost_usd,
    (s.input_tokens + s.output_tokens + s.cache_creation_tokens + s.cache_read_tokens)
                                        AS total_tokens,
    CASE
        WHEN (s.cache_read_tokens + s.cache_creation_tokens + s.input_tokens) > 0
        THEN ROUND(
            s.cache_read_tokens::DOUBLE /
            (s.cache_read_tokens + s.cache_creation_tokens + s.input_tokens)::DOUBLE,
            4
        )
        ELSE 0.0
    END                                 AS cache_hit_rate,
    s.num_turns,
    s.num_tool_calls,
    s.project_path,
    s.git_branch,
    s.claude_version,
    s.cwd,
    s.source_file,
    s.source_type
FROM sessions s
ORDER BY s.start_time DESC;

-- ---------------------------------------------------------------------------
-- v_tool_usage: Tool call frequency, success rates, per-session averages
-- Powers tool analysis dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tool_usage AS
SELECT
    tc.tool_name,
    tc.tool_type,
    tc.mcp_server,
    COUNT(*)                                                        AS call_count,
    COUNT(*) FILTER (WHERE tc.success = TRUE)                       AS success_count,
    COUNT(*) FILTER (WHERE tc.success = FALSE)                      AS failure_count,
    CASE
        WHEN COUNT(*) FILTER (WHERE tc.success IS NOT NULL) > 0
        THEN ROUND(
            COUNT(*) FILTER (WHERE tc.success = TRUE)::DOUBLE /
            COUNT(*) FILTER (WHERE tc.success IS NOT NULL)::DOUBLE,
            4
        )
        ELSE NULL
    END                                                             AS success_rate,
    ROUND(
        COUNT(*)::DOUBLE /
        NULLIF(COUNT(DISTINCT tc.session_id), 0)::DOUBLE,
        2
    )                                                               AS avg_per_session,
    COUNT(DISTINCT tc.session_id)                                   AS sessions_using_tool
FROM tool_calls tc
GROUP BY tc.tool_name, tc.tool_type, tc.mcp_server
ORDER BY call_count DESC;

-- ---------------------------------------------------------------------------
-- v_cache_efficiency: Daily cache efficiency metrics
-- Tracks cache read ratio over time; rates above 80% = effective caching
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_cache_efficiency AS
SELECT
    CAST(ct.timestamp AS DATE)          AS date,
    SUM(ct.cache_read_tokens)           AS cache_read_tokens,
    SUM(ct.cache_creation_tokens)       AS cache_write_tokens,
    SUM(ct.input_tokens)                AS uncached_tokens,
    CASE
        WHEN (SUM(ct.cache_read_tokens) + SUM(ct.cache_creation_tokens) + SUM(ct.input_tokens)) > 0
        THEN ROUND(
            SUM(ct.cache_read_tokens)::DOUBLE /
            (SUM(ct.cache_read_tokens) + SUM(ct.cache_creation_tokens) + SUM(ct.input_tokens))::DOUBLE,
            4
        )
        ELSE 0.0
    END                                 AS cache_hit_rate,
    (SUM(ct.cache_read_tokens) + SUM(ct.cache_creation_tokens) + SUM(ct.input_tokens))
                                        AS total_input_processed,
    SUM(ct.cache_read_tokens) * 0.9     AS estimated_tokens_saved
FROM conversation_turns ct
WHERE ct.role = 'assistant'
GROUP BY CAST(ct.timestamp AS DATE)
ORDER BY date DESC;

-- ---------------------------------------------------------------------------
-- v_hourly_activity: Activity distribution by hour of day
-- Reveals peak usage hours and cost distribution
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_hourly_activity AS
SELECT
    EXTRACT(HOUR FROM ct.timestamp)     AS hour_of_day,
    COUNT(*)                            AS message_count,
    COUNT(DISTINCT ct.session_id)       AS session_count,
    ROUND(AVG(ct.cost_usd), 6)         AS avg_cost,
    SUM(ct.input_tokens + ct.output_tokens + ct.cache_read_tokens + ct.cache_creation_tokens)
                                        AS total_tokens,
    SUM(ct.cost_usd)                    AS total_cost,
    ROUND(AVG(ct.input_tokens + ct.output_tokens), 0)
                                        AS avg_tokens_per_turn
FROM conversation_turns ct
WHERE ct.role = 'assistant'
GROUP BY EXTRACT(HOUR FROM ct.timestamp)
ORDER BY hour_of_day;
