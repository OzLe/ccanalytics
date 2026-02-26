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

-- ---------------------------------------------------------------------------
-- v_prompt_analysis: Per-prompt metrics joining user turns to assistant responses
-- For each user turn, aggregates cost, tokens, tool calls, and response depth
-- across all consecutive assistant turns that follow before the next user turn
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_prompt_analysis AS
WITH numbered_turns AS (
    -- Assign a sequential row number within each session ordered by time and turn_id
    SELECT
        turn_id,
        session_id,
        role,
        timestamp,
        content_text,
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        cost_usd,
        model,
        has_thinking,
        ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY timestamp, turn_id
        )                                   AS row_num
    FROM conversation_turns
),
user_turns AS (
    -- Isolate user turns that have actual text content
    SELECT
        turn_id,
        session_id,
        content_text,
        timestamp,
        row_num,
        -- Row number of the next user turn in the same session (NULL if last)
        LEAD(row_num) OVER (
            PARTITION BY session_id
            ORDER BY row_num
        )                                   AS next_user_row_num
    FROM numbered_turns
    WHERE role = 'user'
      AND content_text IS NOT NULL
),
assistant_agg AS (
    -- Aggregate all assistant turns that fall between a user turn and the next user turn
    SELECT
        ut.turn_id                          AS prompt_turn_id,
        ut.session_id,
        SUM(ast.cost_usd)                   AS response_cost,
        SUM(ast.input_tokens)               AS response_input_tokens,
        SUM(ast.output_tokens)              AS response_output_tokens,
        SUM(
            ast.input_tokens
            + ast.output_tokens
            + ast.cache_creation_tokens
            + ast.cache_read_tokens
        )                                   AS total_tokens,
        COUNT(ast.turn_id)                  AS multi_turn_depth,
        BOOL_OR(ast.has_thinking)           AS has_thinking,
        -- Collect assistant turn IDs for tool call counting
        LIST(ast.turn_id)                   AS assistant_turn_ids,
        -- First assistant turn's model (lowest row_num)
        MIN(ast.model) FILTER (
            WHERE ast.row_num = (
                SELECT MIN(x.row_num)
                FROM numbered_turns x
                WHERE x.session_id = ut.session_id
                  AND x.role = 'assistant'
                  AND x.row_num > ut.row_num
                  AND (ut.next_user_row_num IS NULL OR x.row_num < ut.next_user_row_num)
            )
        )                                   AS model
    FROM user_turns ut
    JOIN numbered_turns ast
        ON  ast.session_id = ut.session_id
        AND ast.role = 'assistant'
        AND ast.row_num > ut.row_num
        AND (ut.next_user_row_num IS NULL OR ast.row_num < ut.next_user_row_num)
    GROUP BY ut.turn_id, ut.session_id
),
tool_counts AS (
    -- Count tool calls across the assistant turns belonging to each prompt
    SELECT
        aa.prompt_turn_id,
        COUNT(tc.tool_call_id) AS tool_call_count
    FROM assistant_agg aa
    JOIN LATERAL UNNEST(aa.assistant_turn_ids) AS t(aid) ON TRUE
    LEFT JOIN tool_calls tc
        ON tc.turn_id = t.aid
        AND tc.session_id = aa.session_id
    GROUP BY aa.prompt_turn_id
)
SELECT
    ut.turn_id                              AS prompt_turn_id,
    ut.session_id,
    LEFT(ut.content_text, 200)             AS prompt_preview,
    COALESCE(aa.response_cost, 0.0)        AS response_cost,
    COALESCE(aa.response_input_tokens, 0)  AS response_input_tokens,
    COALESCE(aa.response_output_tokens, 0) AS response_output_tokens,
    COALESCE(aa.total_tokens, 0)           AS total_tokens,
    COALESCE(tcc.tool_call_count, 0)       AS tool_call_count,
    COALESCE(aa.multi_turn_depth, 0)       AS multi_turn_depth,
    COALESCE(aa.has_thinking, FALSE)       AS has_thinking,
    aa.model,
    ut.timestamp
FROM user_turns ut
LEFT JOIN assistant_agg aa
    ON aa.prompt_turn_id = ut.turn_id
LEFT JOIN tool_counts tcc
    ON tcc.prompt_turn_id = ut.turn_id
ORDER BY ut.timestamp DESC;
