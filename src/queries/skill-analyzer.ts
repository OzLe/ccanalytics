/**
 * @module queries/skill-analyzer
 *
 * F2K — Skill Analysis queries.
 *
 * Answers the two core questions of the Skill Analysis domain:
 *   1. *"Do I have too many skills active?"* — `getSkillSummary` (the
 *      `tooManySkillsActive` heuristic, D11).
 *   2. *"Was this skill invocation unnecessary?"* — `getSkillThrash` (the
 *      same-session thrash heuristic, D12).
 *
 * Two skill signals (see the migration-5 `v_skill_usage` view header):
 *   - **LOADED** skills come from the `session_skills` table (parsed
 *     `skill_listing` attachments).
 *   - **INVOKED** skills come from `tool_calls` rows where `tool_name = 'Skill'`,
 *     with the skill name resolved as `COALESCE(skill_name, parameters->>'skill')`
 *     so historical rows ingested before migration 5 still resolve.
 *
 * CRITICAL DuckDB SQL gotcha (discovered in Chunk A): DuckDB mis-plans flat
 * predicates like `WHERE tool_name='Skill' AND parameters->>'skill' = ...` when
 * a JSON expression feeds a join / count / group — it can silently drop the
 * `tool_name` filter. MITIGATION used throughout this module: the
 * `COALESCE(skill_name, parameters->>'skill')` extraction (and the
 * `tool_name = 'Skill'` filter) always live INSIDE a CTE, and all
 * joining / aggregating happens in an outer query over that CTE. The
 * `v_skill_usage` view does the same — this analyzer is modelled on it.
 *
 * The CLI counterpart of the `/api/skills/*` routes: `query skills` consumes
 * these methods, so the analyzer and the routes must return the same numbers
 * for the same inputs (CLI↔API parity). Heuristic constants are shared via
 * `src/queries/skill-thresholds.ts` (mirrored by `dashboard/src/lib/skillThresholds.ts`).
 */

import type {
  TimeRange,
  TimeBucket,
  QueryFilters,
  SkillInvocationStats,
  SkillLoadedStats,
  SkillThrashResult,
  SkillThrashRow,
  SkillTrendPoint,
  SkillSummary,
} from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildTurnFilters } from "./filter-builder.js";
import { resolveTimezone, wrapTimestampForTz } from "../utils/timezone.js";
import {
  DEAD_WEIGHT_RATIO_THRESHOLD,
  LOADED_CONTEXT_SHARE_THRESHOLD,
  SKILL_THRASH_MIN,
  estimateSkillTokens,
  isKnownReentrantSkill,
} from "./skill-thresholds.js";

/**
 * Analyzes skill usage from the `session_skills` table, the `Skill` rows of
 * `tool_calls`, and the `v_skill_usage` view's logic re-implemented inline.
 */
export class SkillAnalyzer {
  constructor(private executor: QueryExecutor) {}

  /**
   * Per-skill INVOKED stats — invocations, distinct sessions, success counts,
   * the KPI-006 success rate, and avg invocations per session.
   *
   * Powers the Top Skills bar chart, the Skill Invocation Detail table, and the
   * invocation KPIs. Skill names use `COALESCE(skill_name, parameters->>'skill')`
   * (inside the `inv` CTE) so historical Skill rows still appear.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @returns Per-skill invocation stats, ordered by invocations desc
   */
  async getSkillUsage(
    range: TimeRange,
    filters?: QueryFilters,
  ): Promise<SkillInvocationStats[]> {
    const f = buildTurnFilters(filters, 3);
    // Remap the bare-column filter clauses onto the `ct` alias used in the CTE.
    const filterClauses = f.clauses.map((c) =>
      c
        .replace(/\bAND model\b/, "AND ct.model")
        .replace(/\bAND session_id\b/, "AND ct.session_id"),
    );
    // GOTCHA mitigation: extract the skill name + apply the tool_name filter
    // and the period/model/project join INSIDE the `inv` CTE; aggregate outside.
    const sql = `
      WITH inv AS (
        SELECT
          tc.session_id,
          COALESCE(tc.skill_name, tc.parameters->>'skill') AS skill,
          tc.success
        FROM tool_calls tc
        JOIN conversation_turns ct
          ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
        WHERE tc.tool_name = 'Skill'
          AND ct.timestamp >= $1 AND ct.timestamp < $2
          ${filterClauses.join("\n          ")}
      )
      SELECT
        skill,
        COUNT(*) AS invocations,
        COUNT(DISTINCT session_id) AS sessions_using,
        COUNT(*) FILTER (WHERE success = TRUE) AS success_count,
        COUNT(*) FILTER (WHERE success = FALSE) AS failure_count,
        CASE
          WHEN COUNT(*) FILTER (WHERE success IS NOT NULL) > 0
          THEN COUNT(*) FILTER (WHERE success = TRUE)::DOUBLE /
               COUNT(*) FILTER (WHERE success IS NOT NULL)::DOUBLE
          ELSE NULL
        END AS success_rate,
        COUNT(*)::DOUBLE / NULLIF(COUNT(DISTINCT session_id), 0)::DOUBLE
          AS avg_per_session
      FROM inv
      WHERE skill IS NOT NULL
      GROUP BY skill
      ORDER BY invocations DESC, skill ASC
    `;
    const result = await this.executor.query<{
      skill: string;
      invocations: number;
      sessions_using: number;
      success_count: number;
      failure_count: number;
      success_rate: number | null;
      avg_per_session: number | null;
    }>(sql, [range.start, range.end, ...f.params]);

    return result.rows.map((row) => ({
      skill: row.skill,
      invocations: Number(row.invocations),
      sessionsUsing: Number(row.sessions_using),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      successRate: row.success_rate != null ? Number(row.success_rate) : null,
      avgPerSession: row.avg_per_session != null ? Number(row.avg_per_session) : 0,
    }));
  }

  /**
   * Per-skill LOADED stats — distinct sessions a skill was loaded into,
   * estimated context tokens (length-based, SEM2-287), invocation count, and the
   * `isDeadWeight` flag (loaded in the period, never invoked in it — §4.3).
   *
   * Powers the "Loaded Skills by Context Weight" table. `session_skills` is
   * scoped to the period sessions (sessions with at least one assistant turn in
   * range that pass the filters). Sorted by est. context tokens desc.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @returns Per-loaded-skill stats, ordered by est. context tokens desc
   */
  async getLoadedSkills(
    range: TimeRange,
    filters?: QueryFilters,
  ): Promise<SkillLoadedStats[]> {
    const f = buildTurnFilters(filters, 3);
    // The period-session set: filter clauses here run against the bare
    // conversation_turns columns (no alias) — exactly the buildTurnFilters form.
    const periodSessions = `
        SELECT DISTINCT session_id
        FROM conversation_turns
        WHERE timestamp >= $1 AND timestamp < $2
          ${f.clauses.join("\n          ")}`;
    // LOADED side from session_skills (distinct (session, skill)); INVOKED side
    // from the `inv` CTE (GOTCHA mitigation: skill extraction inside the CTE).
    // SEM2-287: also surface a representative skill_description per skill so
    // estContextTokens uses CEIL(LEN/4) instead of the flat 45 estimate. The
    // helper estimateSkillTokens() applies the same COALESCE fallback as the
    // SQL view (`COALESCE(CEIL(LENGTH(skill_description)/4.0), 45)`).
    const sql = `
      WITH period_sessions AS (${periodSessions}),
      loaded AS (
        SELECT
          sl.skill_name AS skill,
          COUNT(DISTINCT sl.session_id) AS loaded_in_sessions,
          ANY_VALUE(sl.skill_description) AS skill_description
        FROM session_skills sl
        WHERE sl.session_id IN (SELECT session_id FROM period_sessions)
        GROUP BY sl.skill_name
      ),
      inv AS (
        SELECT
          COALESCE(tc.skill_name, tc.parameters->>'skill') AS skill,
          COUNT(*) AS invocations
        FROM tool_calls tc
        WHERE tc.tool_name = 'Skill'
          AND tc.session_id IN (SELECT session_id FROM period_sessions)
        GROUP BY COALESCE(tc.skill_name, tc.parameters->>'skill')
      )
      SELECT
        l.skill,
        l.loaded_in_sessions,
        l.skill_description,
        COALESCE(i.invocations, 0) AS invocations
      FROM loaded l
      LEFT JOIN inv i ON i.skill = l.skill
      ORDER BY l.loaded_in_sessions DESC, l.skill ASC
    `;
    const result = await this.executor.query<{
      skill: string;
      loaded_in_sessions: number;
      skill_description: string | null;
      invocations: number;
    }>(sql, [range.start, range.end, ...f.params]);

    return result.rows.map((row) => {
      const loadedInSessions = Number(row.loaded_in_sessions);
      const invocations = Number(row.invocations);
      // SEM2-287: per-skill estimate × loadings — falls back to
      // FLAT_SKILL_TOKEN_ESTIMATE (45) when skill_description is null/empty.
      const perSkillEstimate = estimateSkillTokens(row.skill_description);
      return {
        skill: row.skill,
        loadedInSessions,
        estContextTokens: loadedInSessions * perSkillEstimate,
        invocations,
        // §4.3: loaded in the period AND not invoked in the period.
        isDeadWeight: invocations === 0,
      };
    });
  }

  /**
   * The page-level skill KPI bundle plus the "too many skills active" flags
   * (D11). One method, four SQL aggregates (loaded set, invoked set, success
   * counts, context proxy) combined in JS — clearer than one mega-CTE and it
   * keeps each GOTCHA-sensitive skill extraction in its own CTE.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @returns The skill KPI summary + `tooManySkillsActive` / `tooManyReasons`
   */
  async getSkillSummary(
    range: TimeRange,
    filters?: QueryFilters,
  ): Promise<SkillSummary> {
    const f = buildTurnFilters(filters, 3);
    const periodSessions = `
        SELECT DISTINCT session_id
        FROM conversation_turns
        WHERE timestamp >= $1 AND timestamp < $2
          ${f.clauses.join("\n          ")}`;

    // 1. LOADED side: distinct skills loaded + per-session loaded counts.
    // SEM2-287: also sum the per-skill description-length estimate per session
    // (`COALESCE(CEIL(LENGTH(skill_description)/4.0), 45)` — same expression
    // as v_skill_loaded and estimateSkillTokens()) so the period-level
    // avgLoadedSkillTokens reflects real descriptions rather than the flat 45.
    const loadedSql = `
      WITH period_sessions AS (${periodSessions}),
      per_session AS (
        SELECT
          sl.session_id,
          COUNT(DISTINCT sl.skill_name) AS loaded_count,
          SUM(COALESCE(CEIL(LENGTH(sl.skill_description) / 4.0), 45))
            AS est_skill_tokens
        FROM session_skills sl
        WHERE sl.session_id IN (SELECT session_id FROM period_sessions)
        GROUP BY sl.session_id
      )
      SELECT
        COALESCE(AVG(loaded_count), 0) AS avg_loaded,
        COALESCE(MAX(loaded_count), 0) AS max_loaded,
        COALESCE(AVG(est_skill_tokens), 0) AS avg_est_skill_tokens,
        (
          SELECT COUNT(DISTINCT sl.skill_name)
          FROM session_skills sl
          WHERE sl.session_id IN (SELECT session_id FROM period_sessions)
        ) AS distinct_loaded
      FROM per_session
    `;
    const loadedResult = await this.executor.query<{
      avg_loaded: number;
      max_loaded: number;
      avg_est_skill_tokens: number;
      distinct_loaded: number;
    }>(loadedSql, [range.start, range.end, ...f.params]);

    // 2. INVOKED side: distinct invoked skills, total invocations, success rate.
    //    GOTCHA mitigation: skill extraction + tool_name filter inside `inv`.
    const filterClausesCt = f.clauses.map((c) =>
      c
        .replace(/\bAND model\b/, "AND ct.model")
        .replace(/\bAND session_id\b/, "AND ct.session_id"),
    );
    const invokedSql = `
      WITH inv AS (
        SELECT
          COALESCE(tc.skill_name, tc.parameters->>'skill') AS skill,
          tc.success
        FROM tool_calls tc
        JOIN conversation_turns ct
          ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
        WHERE tc.tool_name = 'Skill'
          AND ct.timestamp >= $1 AND ct.timestamp < $2
          ${filterClausesCt.join("\n          ")}
      )
      SELECT
        COUNT(DISTINCT skill) FILTER (WHERE skill IS NOT NULL) AS distinct_invoked,
        COUNT(*) AS total_invocations,
        COUNT(*) FILTER (WHERE success = TRUE) AS success_count,
        COUNT(*) FILTER (WHERE success IS NOT NULL) AS evaluated_count
      FROM inv
    `;
    const invokedResult = await this.executor.query<{
      distinct_invoked: number;
      total_invocations: number;
      success_count: number;
      evaluated_count: number;
    }>(invokedSql, [range.start, range.end, ...f.params]);

    // 3. Dead-weight skills: loaded in the period, never invoked in the period.
    //    Both sides scoped to the period-session set; skill extraction in a CTE.
    const deadWeightSql = `
      WITH period_sessions AS (${periodSessions}),
      loaded AS (
        SELECT DISTINCT sl.skill_name AS skill
        FROM session_skills sl
        WHERE sl.session_id IN (SELECT session_id FROM period_sessions)
      ),
      invoked AS (
        SELECT DISTINCT COALESCE(tc.skill_name, tc.parameters->>'skill') AS skill
        FROM tool_calls tc
        WHERE tc.tool_name = 'Skill'
          AND tc.session_id IN (SELECT session_id FROM period_sessions)
      )
      SELECT COUNT(*) AS dead_weight
      FROM loaded l
      WHERE l.skill NOT IN (SELECT skill FROM invoked WHERE skill IS NOT NULL)
    `;
    const deadWeightResult = await this.executor.query<{ dead_weight: number }>(
      deadWeightSql,
      [range.start, range.end, ...f.params],
    );

    // 4. Context proxy: AVG over the period's assistant turns of
    //    (input + cache_read + cache_creation) — the same proxy v_context_pressure
    //    uses for the denominator.
    const contextSql = `
      SELECT
        COALESCE(
          AVG(input_tokens + cache_read_tokens + cache_creation_tokens),
          0
        ) AS avg_context_tokens
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
    `;
    const contextResult = await this.executor.query<{
      avg_context_tokens: number;
    }>(contextSql, [range.start, range.end, ...f.params]);

    const avgSkillsLoadedPerSession = Number(
      loadedResult.rows[0]?.avg_loaded ?? 0,
    );
    const maxSkillsLoadedPerSession = Number(
      loadedResult.rows[0]?.max_loaded ?? 0,
    );
    // SEM2-287: per-session AVG of SUM(per-skill estimate). Falls back to the
    // flat 45 per-skill when descriptions are null/empty.
    const avgLoadedSkillTokensRaw = Number(
      loadedResult.rows[0]?.avg_est_skill_tokens ?? 0,
    );
    const distinctSkillsLoaded = Number(
      loadedResult.rows[0]?.distinct_loaded ?? 0,
    );
    const distinctSkillsInvoked = Number(
      invokedResult.rows[0]?.distinct_invoked ?? 0,
    );
    const totalInvocations = Number(
      invokedResult.rows[0]?.total_invocations ?? 0,
    );
    const successCount = Number(invokedResult.rows[0]?.success_count ?? 0);
    const evaluatedCount = Number(invokedResult.rows[0]?.evaluated_count ?? 0);
    const deadWeightSkills = Number(deadWeightResult.rows[0]?.dead_weight ?? 0);
    const avgSessionContextTokens = Number(
      contextResult.rows[0]?.avg_context_tokens ?? 0,
    );

    // KPI-006 NULL-success rule: null when no Skill row has a non-NULL success.
    const skillSuccessRate =
      evaluatedCount > 0 ? successCount / evaluatedCount : null;

    const invocationRate =
      distinctSkillsLoaded > 0
        ? distinctSkillsInvoked / distinctSkillsLoaded
        : null;
    const deadWeightRatio =
      distinctSkillsLoaded > 0 ? deadWeightSkills / distinctSkillsLoaded : null;

    // SEM2-287: avg per-session sum of per-skill description-length estimates
    // (falling back to FLAT_SKILL_TOKEN_ESTIMATE when a description is null/
    // empty). Replaces the old flat `avgSkillsLoadedPerSession * 45` model
    // that systematically understated real descriptions by ~45%.
    const avgLoadedSkillTokens = avgLoadedSkillTokensRaw;
    const loadedContextShare =
      avgSessionContextTokens > 0
        ? avgLoadedSkillTokens / avgSessionContextTokens
        : null;

    // D11: too-many-skills-active = (a) OR (b).
    const tooManyReasons: string[] = [];
    if (
      deadWeightRatio != null &&
      deadWeightRatio > DEAD_WEIGHT_RATIO_THRESHOLD
    ) {
      tooManyReasons.push(
        `${deadWeightSkills} of ${distinctSkillsLoaded} loaded skills were never invoked in this period ` +
          `(dead-weight ratio ${(deadWeightRatio * 100).toFixed(0)}% > ` +
          `${(DEAD_WEIGHT_RATIO_THRESHOLD * 100).toFixed(0)}% threshold).`,
      );
    }
    if (
      loadedContextShare != null &&
      loadedContextShare > LOADED_CONTEXT_SHARE_THRESHOLD
    ) {
      tooManyReasons.push(
        `Skill descriptions account for ~${(loadedContextShare * 100).toFixed(1)}% of average session context ` +
          `(> ${(LOADED_CONTEXT_SHARE_THRESHOLD * 100).toFixed(0)}% threshold, length-based estimate).`,
      );
    }

    return {
      avgSkillsLoadedPerSession,
      maxSkillsLoadedPerSession,
      distinctSkillsInvoked,
      distinctSkillsLoaded,
      totalInvocations,
      skillSuccessRate,
      deadWeightSkills,
      invocationRate,
      deadWeightRatio,
      avgLoadedSkillTokens,
      avgSessionContextTokens,
      loadedContextShare,
      tooManySkillsActive: tooManyReasons.length > 0,
      tooManyReasons,
    };
  }

  /**
   * The same-session skill thrash signal (D12) — the v1 "invocation not
   * required" heuristic. Flags every `(session_id, skill)` pair whose
   * `invocations_in_session` reached `SKILL_THRASH_MIN` (= 2). `isKnownReentrant`
   * is computed in JS against `KNOWN_REENTRANT_SKILLS`.
   *
   * GOTCHA mitigation: the skill extraction + `tool_name = 'Skill'` filter +
   * period/model/project join live in the `inv` CTE; the `HAVING COUNT(*) >= N`
   * is applied in the outer aggregate.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @param limit - Max thrash rows to return (clamped 1..500; default 100)
   * @returns Flagged thrash rows + a small summary
   */
  async getSkillThrash(
    range: TimeRange,
    filters?: QueryFilters,
    limit = 100,
  ): Promise<SkillThrashResult> {
    const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const f = buildTurnFilters(filters, 4);
    const filterClauses = f.clauses.map((c) =>
      c
        .replace(/\bAND model\b/, "AND ct.model")
        .replace(/\bAND session_id\b/, "AND ct.session_id"),
    );
    const sql = `
      WITH inv AS (
        SELECT
          tc.session_id,
          COALESCE(tc.skill_name, tc.parameters->>'skill') AS skill
        FROM tool_calls tc
        JOIN conversation_turns ct
          ON ct.turn_id = tc.turn_id AND ct.session_id = tc.session_id
        WHERE tc.tool_name = 'Skill'
          AND ct.timestamp >= $1 AND ct.timestamp < $2
          ${filterClauses.join("\n          ")}
      )
      SELECT
        session_id,
        skill,
        COUNT(*) AS invocations_in_session
      FROM inv
      WHERE skill IS NOT NULL
      GROUP BY session_id, skill
      HAVING COUNT(*) >= $3
      ORDER BY invocations_in_session DESC, session_id ASC, skill ASC
      LIMIT ${clampedLimit}
    `;
    const result = await this.executor.query<{
      session_id: string;
      skill: string;
      invocations_in_session: number;
    }>(sql, [range.start, range.end, SKILL_THRASH_MIN, ...f.params]);

    const thrash: SkillThrashRow[] = result.rows.map((row) => ({
      sessionId: row.session_id,
      skill: row.skill,
      invocationsInSession: Number(row.invocations_in_session),
      isKnownReentrant: isKnownReentrantSkill(row.skill),
    }));

    const sessionsAffected = new Set(thrash.map((t) => t.sessionId)).size;
    const nonReentrantRows = thrash.filter((t) => !t.isKnownReentrant).length;

    return {
      thrash,
      summary: {
        flaggedRows: thrash.length,
        nonReentrantRows,
        sessionsAffected,
      },
    };
  }

  /**
   * Skills-Per-Session trend — per time bucket, the AVG over that bucket's
   * sessions of (a) distinct skills loaded per session and (b) distinct skills
   * invoked per session. Reveals whether the loaded set is creeping up while
   * invocation stays flat.
   *
   * Each session is assigned to a bucket by its EARLIEST turn timestamp in the
   * period, so a session contributes to exactly one bucket. The loaded and
   * invoked per-session counts are computed in separate CTEs (GOTCHA: the
   * invoked side extracts the skill name inside its CTE) and combined per bucket.
   *
   * @param range - Time range to query
   * @param bucket - Aggregation granularity (default: day)
   * @param filters - Optional model/project filters
   * @returns One point per non-empty time bucket, ordered ascending
   */
  async getSkillTrend(
    range: TimeRange,
    bucket: TimeBucket = "day",
    filters?: QueryFilters,
  ): Promise<SkillTrendPoint[]> {
    const validBuckets: Record<TimeBucket, string> = {
      hour: "hour",
      day: "day",
      week: "week",
      month: "month",
    };
    const duckBucket = validBuckets[bucket];
    if (!duckBucket) {
      throw new Error(`Invalid time bucket: ${bucket}`);
    }

    // ACT-001: bucket boundaries are computed from each session's earliest
    // turn projected through the user's IANA zone, so a session whose first
    // turn was 22:30Z lands in the user's local "tomorrow" bucket.
    const userTimezone = resolveTimezone(filters?.userTimezone);
    const f = buildTurnFilters(filters, 4);
    const localTs = wrapTimestampForTz("MIN(timestamp)", "$3");
    // session_bucket: each period session -> the bucket of its earliest turn.
    const sql = `
      WITH session_bucket AS (
        SELECT
          session_id,
          DATE_TRUNC('${duckBucket}', ${localTs}) AS ts
        FROM conversation_turns
        WHERE timestamp >= $1 AND timestamp < $2
          ${f.clauses.join("\n          ")}
        GROUP BY session_id
      ),
      loaded_per_session AS (
        SELECT sl.session_id, COUNT(DISTINCT sl.skill_name) AS loaded_count
        FROM session_skills sl
        WHERE sl.session_id IN (SELECT session_id FROM session_bucket)
        GROUP BY sl.session_id
      ),
      invoked_raw AS (
        SELECT
          tc.session_id,
          COALESCE(tc.skill_name, tc.parameters->>'skill') AS skill
        FROM tool_calls tc
        WHERE tc.tool_name = 'Skill'
          AND tc.session_id IN (SELECT session_id FROM session_bucket)
      ),
      invoked_per_session AS (
        SELECT session_id, COUNT(DISTINCT skill) AS invoked_count
        FROM invoked_raw
        WHERE skill IS NOT NULL
        GROUP BY session_id
      )
      SELECT
        sb.ts,
        COALESCE(AVG(lps.loaded_count), 0) AS avg_loaded_per_session,
        COALESCE(AVG(ips.invoked_count), 0) AS avg_invoked_per_session
      FROM session_bucket sb
      LEFT JOIN loaded_per_session lps ON lps.session_id = sb.session_id
      LEFT JOIN invoked_per_session ips ON ips.session_id = sb.session_id
      GROUP BY sb.ts
      ORDER BY sb.ts ASC
    `;
    const result = await this.executor.query<{
      ts: string;
      avg_loaded_per_session: number;
      avg_invoked_per_session: number;
    }>(sql, [range.start, range.end, userTimezone, ...f.params]);

    return result.rows.map((row) => ({
      timestamp: new Date(row.ts),
      avgLoadedPerSession: Number(row.avg_loaded_per_session),
      avgInvokedPerSession: Number(row.avg_invoked_per_session),
    }));
  }
}
