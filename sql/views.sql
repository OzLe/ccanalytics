-- =============================================================================
-- ccanalytics Analytical Views
-- Version: 0.1.0
-- =============================================================================
--
-- KPI-009 — role of these views: the query analyzers (src/queries/*) and the
-- dashboard routes (dashboard/src/server/routes/*) re-implement each view's
-- logic inline so they can apply period/model/project filters. Only
-- v_session_summary is currently SELECTed by code; v_daily_cost,
-- v_cache_efficiency, v_hourly_activity, v_tool_usage, v_prompt_analysis and
-- the NEW-001/002/003 views (v_context_pressure, v_tool_failure_trend,
-- v_session_failure_chains) are REFERENCE / advisory definitions. They are
-- intentionally kept (not dropped) and are the canonical specification each
-- inline query is matched against. When a KPI definition changes, update BOTH
-- the inline SQL and the view here so they can never drift apart (this drift
-- was the root cause of KPI-001 / KPI-002). Every view is created with
-- CREATE OR REPLACE VIEW — additive only.

-- ---------------------------------------------------------------------------
-- v_daily_cost: Daily cost aggregation broken down by model
-- Powers cost trending dashboard and budget monitoring
--
-- COST-005: row inclusion is an explicit, intentional predicate — every
-- assistant turn, excluding only the '<synthetic>' placeholder model. The old
-- 'cost_usd > 0' silent filter is gone (cost must never be a proxy for "real
-- turn"). This matches costRowPredicate() in the CLI cost-analyzer and the
-- dashboard cost route, so token/turn counts reconcile across all cost views.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_cost AS
SELECT
    CAST(ct.timestamp AS DATE)          AS date,
    ct.model                            AS model,
    SUM(ct.cost_usd)                    AS total_cost,
    SUM(ct.input_tokens)                AS input_tokens,
    SUM(ct.output_tokens)               AS output_tokens,
    SUM(ct.cache_creation_tokens)       AS cache_creation_tokens,
    SUM(ct.cache_read_tokens)           AS cache_read_tokens,
    COUNT(*)                            AS turn_count,
    COUNT(DISTINCT ct.session_id)       AS session_count
FROM conversation_turns ct
WHERE ct.role = 'assistant'
  AND ct.model IS NOT NULL
  AND ct.model <> '<synthetic>'
GROUP BY
    CAST(ct.timestamp AS DATE),
    ct.model
ORDER BY date DESC, total_cost DESC;

-- ---------------------------------------------------------------------------
-- S-09 (F1) — v_token_totals: dataset-wide Total Tokens grand total.
--
-- ADVISORY / REFERENCE only — non-load-bearing. The Total Tokens KPI is served
-- by TokenAnalyzer (src/queries/token-analyzer.ts) and the /api/tokens/total
-- route, which re-implement this aggregate inline so they can apply
-- period/model/project filters. This view is the canonical specification of
-- the F1 row predicate: it is the SAME predicate v_daily_cost / the cost
-- analyzer / the cost route use (role='assistant', model IS NOT NULL, model
-- <> '<synthetic>'), NOT the looser assistant-only predicate of
-- v_session_summary / v_hourly_activity. That is what makes Total Tokens
-- reconcile 1:1 with Total Cost. F1 needs NO schema change — every token
-- column already exists on conversation_turns; this view is the only
-- sql/views.sql touch and it is purely documentary. When the F1 predicate
-- changes, update BOTH the inline SQL and this view so they cannot drift.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_token_totals AS
SELECT
    SUM(input_tokens)                                       AS input_tokens,
    SUM(output_tokens)                                      AS output_tokens,
    SUM(cache_creation_tokens)                              AS cache_write_tokens,
    SUM(cache_read_tokens)                                  AS cache_read_tokens,
    SUM(input_tokens + output_tokens
        + cache_creation_tokens + cache_read_tokens)        AS total_tokens
FROM conversation_turns
WHERE role = 'assistant'
  AND model IS NOT NULL
  AND model <> '<synthetic>';

-- ---------------------------------------------------------------------------
-- v_session_summary: Session-level summary with cache efficiency
-- Powers session list view and detail drill-down
--
-- COST-004: total_cost_usd, total token counts, cache_hit_rate, num_turns and
-- num_tool_calls are DERIVED here by aggregating the child tables
-- (conversation_turns / tool_calls) rather than trusting the sessions.*
-- columns. The adapters recompute the sessions.* aggregates from only the
-- latest incremental parse batch, so the stored columns drift from the
-- accumulated child rows (61/960 sessions diverged, ~$507 abs). Deriving from
-- the children makes this view always reconcile with v_daily_cost and the
-- /api/cost/* endpoints (which sum conversation_turns.cost_usd). The
-- backfill migration (scripts/backfill-costs.mjs) additionally corrects the
-- stored sessions.total_cost_usd column itself; the sessions.* columns are
-- treated as advisory.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_session_summary AS
WITH turn_agg AS (
    SELECT
        ct.session_id,
        SUM(ct.cost_usd)                                AS total_cost_usd,
        SUM(ct.input_tokens)                            AS input_tokens,
        SUM(ct.output_tokens)                           AS output_tokens,
        SUM(ct.cache_creation_tokens)                   AS cache_creation_tokens,
        SUM(ct.cache_read_tokens)                       AS cache_read_tokens,
        COUNT(*)                                        AS num_turns
    FROM conversation_turns ct
    GROUP BY ct.session_id
),
tool_agg AS (
    SELECT
        tc.session_id,
        COUNT(*)                                        AS num_tool_calls
    FROM tool_calls tc
    GROUP BY tc.session_id
)
SELECT
    s.session_id,
    s.start_time,
    s.end_time,
    s.duration_seconds,
    s.model,
    COALESCE(ta.total_cost_usd, 0.0)    AS total_cost_usd,
    COALESCE(
        ta.input_tokens + ta.output_tokens
        + ta.cache_creation_tokens + ta.cache_read_tokens,
        0
    )                                   AS total_tokens,
    CASE
        WHEN COALESCE(ta.cache_read_tokens + ta.cache_creation_tokens + ta.input_tokens, 0) > 0
        THEN ROUND(
            ta.cache_read_tokens::DOUBLE /
            (ta.cache_read_tokens + ta.cache_creation_tokens + ta.input_tokens)::DOUBLE,
            4
        )
        ELSE 0.0
    END                                 AS cache_hit_rate,
    COALESCE(ta.num_turns, 0)           AS num_turns,
    COALESCE(toa.num_tool_calls, 0)     AS num_tool_calls,
    s.project_path,
    s.project_name,
    s.git_branch,
    s.claude_version,
    s.cwd,
    s.source_file,
    s.source_type
FROM sessions s
LEFT JOIN turn_agg ta  ON ta.session_id  = s.session_id
LEFT JOIN tool_agg toa ON toa.session_id = s.session_id
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
--
-- KPI-004: this view emits one row per user turn WITH text, including user
-- turns immediately followed by another user turn — those get
-- multi_turn_depth = 0 / response_cost = 0 (no assistant response). The
-- PromptAnalyzer and the /api/prompts/* routes EXCLUDE multi_turn_depth = 0
-- rows from totalPrompts / avgCost / the distributions and surface their count
-- separately as promptsWithNoResponse, so a consumer of this view should apply
-- the same `multi_turn_depth > 0` predicate for "responded prompt" metrics.
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

-- ---------------------------------------------------------------------------
-- NEW-001 — v_context_pressure: per-session context-window utilization.
--
-- CLAUDE.md flags >60% context utilization as a quality-degradation risk, but
-- nothing computed it before. Per assistant turn the context proxy is
-- input_tokens + cache_read_tokens + cache_creation_tokens (in the Anthropic
-- API these three are SEPARATE fields, so summing them is the size of the
-- context the model actually processed for that turn).
--
-- The window denominator is MODEL-AWARE *and* SELF-CORRECTING. The 1M-context
-- capability is NOT reliably encoded in the model id — in this dataset
-- `claude-opus-4-7` (a plain id, no `-1m` suffix) legitimately reaches
-- ~861k tokens/turn. So the window is the LARGER of: (a) 1,000,000 if the
-- model id hints at a 1M variant ('-1m' / '1m-context'), and (b) whichever of
-- {200,000, 1,000,000} actually contains the turn's context_tokens. A turn
-- whose context already exceeds 200k was demonstrably running on the
-- 1M-context variant, so it gets the 1M denominator. This keeps utilization
-- in a sane 0..1 range with no schema change and no brittle id heuristic.
--
-- Per session: peak_context_pct = MAX(utilization), pressure_share =
-- share of assistant turns whose utilization > 0.60, plus a >0.80 "critical"
-- count and a stop_reason='max_tokens' truncation count. The CLI
-- SessionAnalyzer.getContextPressure / getContextPressureStats and
-- /api/sessions/context-pressure re-implement this inline to support
-- period/model/project filters — keep all three in sync.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_context_pressure AS
WITH assistant_turns AS (
    SELECT
        ct.session_id,
        ct.timestamp,
        ct.stop_reason,
        (ct.input_tokens + ct.cache_read_tokens + ct.cache_creation_tokens)
                                            AS context_tokens,
        CASE
            WHEN LOWER(COALESCE(ct.model, '')) LIKE '%-1m%'
              OR LOWER(COALESCE(ct.model, '')) LIKE '%1m-context%'
              OR (ct.input_tokens + ct.cache_read_tokens + ct.cache_creation_tokens) > 200000
            THEN 1000000
            ELSE 200000
        END                                 AS window_size
    FROM conversation_turns ct
    WHERE ct.role = 'assistant'
),
turn_util AS (
    SELECT
        session_id,
        timestamp,
        stop_reason,
        context_tokens,
        window_size,
        context_tokens::DOUBLE / window_size::DOUBLE AS context_utilization
    FROM assistant_turns
)
SELECT
    session_id,
    COUNT(*)                                                AS assistant_turns,
    ROUND(MAX(context_utilization), 4)                      AS peak_context_pct,
    MAX(context_tokens)                                     AS peak_context_tokens,
    ROUND(AVG(context_utilization), 4)                      AS avg_context_pct,
    COUNT(*) FILTER (WHERE context_utilization > 0.60)      AS turns_over_60,
    COUNT(*) FILTER (WHERE context_utilization > 0.80)      AS turns_over_80,
    ROUND(
        COUNT(*) FILTER (WHERE context_utilization > 0.60)::DOUBLE /
        NULLIF(COUNT(*), 0)::DOUBLE,
        4
    )                                                       AS pressure_share,
    COUNT(*) FILTER (WHERE stop_reason = 'max_tokens')      AS max_tokens_turns
FROM turn_util
GROUP BY session_id
ORDER BY peak_context_pct DESC;

-- ---------------------------------------------------------------------------
-- NEW-002 — v_tool_failure_trend: tool failure rate bucketed by day, split by
-- tool_type (builtin vs mcp).
--
-- failure_rate = COUNT(success = FALSE) / COUNT(success IS NOT NULL). NULL-
-- success calls are excluded from the denominator (a result that was never
-- captured is "no data", not a failure — same rule as v_tool_usage). The day
-- bucket comes from the JOINed conversation_turns.timestamp. tool_type values
-- in the data are 'mcp' and a native bucket ('native'/'builtin'); this view
-- normalizes anything that is not 'mcp' to 'builtin'. The ToolAnalyzer
-- getToolFailureTrend method and /api/tools/failure-trend re-implement this
-- inline (with a configurable bucket) to support period/model/project filters.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tool_failure_trend AS
SELECT
    CAST(ct.timestamp AS DATE)                              AS date,
    CASE WHEN tc.tool_type = 'mcp' THEN 'mcp' ELSE 'builtin' END
                                                            AS tool_class,
    COUNT(*)                                                AS total_calls,
    COUNT(*) FILTER (WHERE tc.success IS NOT NULL)          AS evaluated_calls,
    COUNT(*) FILTER (WHERE tc.success = FALSE)              AS failure_count,
    CASE
        WHEN COUNT(*) FILTER (WHERE tc.success IS NOT NULL) > 0
        THEN ROUND(
            COUNT(*) FILTER (WHERE tc.success = FALSE)::DOUBLE /
            COUNT(*) FILTER (WHERE tc.success IS NOT NULL)::DOUBLE,
            4
        )
        ELSE NULL
    END                                                     AS failure_rate
FROM tool_calls tc
JOIN conversation_turns ct
    ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
GROUP BY CAST(ct.timestamp AS DATE), tool_class
ORDER BY date DESC, tool_class;

-- ---------------------------------------------------------------------------
-- NEW-003 — v_session_failure_chains: consecutive tool-call failure streaks
-- per session ("the agent got stuck and thrashed" — a rework signal).
--
-- ORDERING (TOOL-002/003/004, SEM2-283/284/285) — Within a session,
-- tool_calls MUST be ordered by conversation_turns.timestamp (chronological).
-- The previous version of this view ORDER BY'd on tc.tool_call_id, which is
-- a random base62 identifier with no chronological relationship to call
-- order; the resulting "adjacency" was essentially random and undercounted
-- both max_failure_streak (showed 6 vs the real 8) and chained-tool counts
-- (Bash->Bash->Bash showed 7,307 vs the real 13,656 — ~half).
--
-- TIEBREAKER (TOOL-004, SEM2-285) — When the same assistant turn dispatches
-- multiple tool_use blocks in parallel, every resulting tool_calls row shares
-- the hosting turn's timestamp. We append tc.tool_call_id as a secondary
-- ORDER BY key to make the row-numbering deterministic across runs. The
-- tiebreaker order has no chronological meaning — it is just a stable proxy
-- for "same-turn parallel tool calls" — but a stable order is required for
-- the gaps-and-islands streak math to be reproducible. The contribution of
-- parallel same-turn calls to a streak is the same regardless of tiebreaker
-- direction, because the streak is over consecutive identical success
-- values; reversing the tiebreaker only swaps which row within a same-turn
-- block sits at which rn.
--
-- DENOMINATOR (TOOL-005, SEM2-286) — Sessions with ZERO failures must stay
-- in the view as failure_count = 0 rows so that dataset-level rates ("% of
-- sessions with a failure chain") compute against the full session
-- population, not just sessions that already had at least one failure. The
-- view is built bottom-up: `sessions_in_scope` is every session that had at
-- least one evaluated tool call (success IS NOT NULL); `failures` aggregates
-- only the failure streaks; a LEFT JOIN preserves the 0-failure sessions
-- with COALESCEd zero values.
--
-- The gaps-and-islands pattern itself: subtract a ROW_NUMBER partitioned by
-- success from the global ROW_NUMBER to group maximal consecutive runs of
-- the same success value; the runs WHERE success = FALSE are the failure
-- streaks. Per session this reports the longest failure streak and the
-- count of failure streaks of length >= 2 / >= 3.
--
-- The dataset-level KPI (% of sessions with a streak >= 3) is computed by
-- the ToolAnalyzer getFailureChains method / the /api/tools/failure-chains
-- route, which re-implement this inline to support period/model/project
-- filters; those callers carry the same fixes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_session_failure_chains AS
WITH ordered_tools AS (
    SELECT
        tc.session_id,
        tc.success,
        ROW_NUMBER() OVER (
            PARTITION BY tc.session_id
            ORDER BY ct.timestamp, tc.tool_call_id
        )                                                   AS rn
    FROM tool_calls tc
    JOIN conversation_turns ct
        ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
    WHERE tc.success IS NOT NULL
),
sessions_in_scope AS (
    SELECT DISTINCT session_id FROM ordered_tools
),
streak_groups AS (
    SELECT
        session_id,
        success,
        rn
            - ROW_NUMBER() OVER (
                PARTITION BY session_id, success ORDER BY rn
            )                                               AS streak_group
    FROM ordered_tools
),
failure_streaks AS (
    SELECT
        session_id,
        streak_group,
        COUNT(*)                                            AS streak_len
    FROM streak_groups
    WHERE success = FALSE
    GROUP BY session_id, streak_group
),
failures AS (
    SELECT
        session_id,
        COALESCE(MAX(streak_len), 0)                        AS max_failure_streak,
        COUNT(*) FILTER (WHERE streak_len >= 2)             AS failure_chains_2plus,
        COUNT(*) FILTER (WHERE streak_len >= 3)             AS failure_chains_3plus,
        COALESCE(SUM(streak_len), 0)                        AS total_failed_in_chains
    FROM failure_streaks
    GROUP BY session_id
)
SELECT
    s.session_id,
    COALESCE(f.max_failure_streak, 0)                       AS max_failure_streak,
    COALESCE(f.failure_chains_2plus, 0)                     AS failure_chains_2plus,
    COALESCE(f.failure_chains_3plus, 0)                     AS failure_chains_3plus,
    COALESCE(f.total_failed_in_chains, 0)                   AS total_failed_in_chains
FROM sessions_in_scope s
LEFT JOIN failures f USING (session_id)
ORDER BY max_failure_streak DESC;

-- ---------------------------------------------------------------------------
-- S-07 (Migration 5) — v_skill_usage: per (session, skill) loaded-vs-invoked.
--
-- LOADED side comes from session_skills (the parsed skill_listing attachments);
-- INVOKED side from tool_calls WHERE tool_name = 'Skill', with the
-- COALESCE(skill_name, parameters->>'skill') fallback so historical Skill rows
-- ingested before migration 5 (skill_name IS NULL) still resolve. A
-- FULL OUTER JOIN keeps skills that were loaded-but-never-invoked (dead weight)
-- AND skills invoked-but-not-in-the-loaded-set. `was_loaded` distinguishes the
-- two. This view is part of migration 5 and is also created by
-- applyMigration5() in src/db/schema.ts for already-migrated databases.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_skill_usage AS
WITH loaded AS (
    SELECT
        session_id,
        skill_name,
        MAX(skill_count)                                    AS skills_loaded_in_session
    FROM session_skills
    GROUP BY session_id, skill_name
),
invoked AS (
    SELECT
        session_id,
        COALESCE(skill_name, parameters->>'skill')          AS skill_name,
        COUNT(*)                                            AS invocations,
        SUM(CASE WHEN success THEN 1 ELSE 0 END)            AS successes,
        SUM(CASE
                WHEN skill_caller_type IS NOT NULL
                 AND skill_caller_type <> 'direct'
                THEN 1 ELSE 0
            END)                                            AS non_direct_invocations
    FROM tool_calls
    WHERE tool_name = 'Skill'
    GROUP BY session_id, COALESCE(skill_name, parameters->>'skill')
)
SELECT
    COALESCE(l.session_id, i.session_id)                    AS session_id,
    COALESCE(l.skill_name, i.skill_name)                    AS skill_name,
    (l.skill_name IS NOT NULL)                              AS was_loaded,
    COALESCE(i.invocations, 0)                              AS invocations,
    COALESCE(i.successes, 0)                                AS successes,
    COALESCE(i.non_direct_invocations, 0)                   AS non_direct_invocations
FROM loaded l
FULL OUTER JOIN invoked i
    ON l.session_id = i.session_id
   AND l.skill_name = i.skill_name;

-- ---------------------------------------------------------------------------
-- Chunk C (F2K) — v_skill_loaded: per-skill loaded-vs-invoked roll-up.
--
-- ADVISORY / REFERENCE only — non-load-bearing. The Skill Analysis "Loaded
-- Skills by Context Weight" table is served by SkillAnalyzer.getLoadedSkills
-- (src/queries/skill-analyzer.ts) and the /api/skills/loaded route, which
-- re-implement this inline so they can scope to the period-session set and
-- apply model/project filters. This view is the canonical, dataset-wide spec
-- of the aggregate:
--   - LOADED side  : COUNT(DISTINCT session_id) over session_skills, grouped
--                    by skill_name — i.e. "how many sessions loaded this skill".
--   - INVOKED side : COUNT(*) over the `Skill` tool_calls, with the
--                    COALESCE(skill_name, parameters->>'skill') fallback so
--                    pre-migration-5 rows still resolve, kept INSIDE the `inv`
--                    CTE (the Chunk-A DuckDB gotcha: a JSON predicate feeding a
--                    join/group can drop the tool_name filter — extract first,
--                    aggregate second).
--   - est_context_tokens : loaded_in_sessions * 45, the flat per-skill estimate
--                    (D10 — F2D ships no precise description_tokens column;
--                    every token figure derived from it is "estimated").
--   - is_dead_weight : loaded but with zero invocations (§4.3 row rule).
-- When the loaded-skill KPI definition changes, update BOTH the inline SQL and
-- this view so they cannot drift (KPI-009 / sql/views.sql header contract).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_skill_loaded AS
WITH loaded AS (
    SELECT
        sl.skill_name                                       AS skill,
        COUNT(DISTINCT sl.session_id)                       AS loaded_in_sessions
    FROM session_skills sl
    GROUP BY sl.skill_name
),
inv AS (
    SELECT
        COALESCE(tc.skill_name, tc.parameters->>'skill')    AS skill,
        COUNT(*)                                            AS invocations
    FROM tool_calls tc
    WHERE tc.tool_name = 'Skill'
    GROUP BY COALESCE(tc.skill_name, tc.parameters->>'skill')
)
SELECT
    l.skill,
    l.loaded_in_sessions,
    l.loaded_in_sessions * 45                               AS est_context_tokens,
    COALESCE(i.invocations, 0)                              AS invocations,
    (COALESCE(i.invocations, 0) = 0)                        AS is_dead_weight
FROM loaded l
LEFT JOIN inv i ON i.skill = l.skill
ORDER BY l.loaded_in_sessions DESC, l.skill;

-- ---------------------------------------------------------------------------
-- Chunk C (F2K) — v_skill_not_required: the same-session skill thrash signal.
--
-- ADVISORY / REFERENCE only — non-load-bearing. The "Possibly-Unnecessary
-- Invocations" table is served by SkillAnalyzer.getSkillThrash and the
-- /api/skills/not-required route, which re-implement this inline to apply
-- period/model/project filters and clamp a row limit. This view is the
-- canonical, dataset-wide spec of the v1 "invocation not required" heuristic
-- (D12): per (session_id, skill), COUNT(*) of `Skill` invocations, flagged when
-- the count reaches SKILL_THRASH_MIN.
--
--   SKILL_THRASH_MIN = 2. *** Gate-1 decision: lowered from the originally-
--   researched 3 (which matched only ONE row in the whole dataset) to 2. ***
--   The constant lives in skillThresholds.ts / skill-thresholds.ts; this view
--   hard-codes 2 to stay a faithful spec — if the constant changes, update
--   this `HAVING` too.
--
-- The skill extraction + `tool_name = 'Skill'` filter stay INSIDE the `inv` CTE
-- (the Chunk-A DuckDB gotcha). is_known_reentrant is NOT computed here — it is
-- a presentation-layer flag (KNOWN_REENTRANT_SKILLS) the analyzer/route add in
-- JS; this view intentionally surfaces every thrash row regardless.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_skill_not_required AS
WITH inv AS (
    SELECT
        tc.session_id,
        COALESCE(tc.skill_name, tc.parameters->>'skill')    AS skill
    FROM tool_calls tc
    WHERE tc.tool_name = 'Skill'
)
SELECT
    session_id,
    skill,
    COUNT(*)                                                AS invocations_in_session
FROM inv
WHERE skill IS NOT NULL
GROUP BY session_id, skill
HAVING COUNT(*) >= 2
ORDER BY invocations_in_session DESC, session_id, skill;
