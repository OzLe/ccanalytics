/**
 * @module server/routes/skills
 *
 * F2K — Skill Analysis API endpoints.
 *
 * Mirrors `SkillAnalyzer` (src/queries/skill-analyzer.ts) with raw SQL against
 * DuckDB. A new route file per the one-route-file-per-domain structure
 * (`cost.ts`, `cache.ts`, `tokens.ts`…) — D15.
 *
 * Two skill signals (see the migration-5 `v_skill_usage` view header):
 *   - **LOADED** from the `session_skills` table.
 *   - **INVOKED** from `tool_calls` rows where `tool_name = 'Skill'`, skill name
 *     resolved as `COALESCE(skill_name, parameters->>'skill')` so historical
 *     rows ingested before migration 5 still resolve.
 *
 * CRITICAL DuckDB SQL gotcha (Chunk A): DuckDB mis-plans flat predicates like
 * `WHERE tool_name='Skill' AND parameters->>'skill' = ...` when a JSON
 * expression feeds a join / count / group — it can silently drop the
 * `tool_name` filter. MITIGATION used throughout: the
 * `COALESCE(skill_name, parameters->>'skill')` extraction + the
 * `tool_name = 'Skill'` filter always live INSIDE a CTE; aggregation happens in
 * an outer query. The inline SQL here is kept in sync with `SkillAnalyzer` and
 * the advisory `v_skill_usage` / `v_skill_loaded` / `v_skill_not_required`
 * views — and produces the same numbers (CLI↔API parity).
 *
 * Heuristic constants come from `dashboard/src/lib/skillThresholds.ts` — the
 * single source of truth (mirrored CLI-side by `src/queries/skill-thresholds.ts`).
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import {
  parseFilters,
  buildTurnFilterClauses,
  envelope,
} from "../helpers/parseFilters.js";
import {
  DEAD_WEIGHT_RATIO_THRESHOLD,
  LOADED_CONTEXT_SHARE_THRESHOLD,
  SKILL_THRASH_MIN,
  estimateSkillTokens,
  isKnownReentrantSkill,
} from "../../lib/skillThresholds.js";

const router = Router();

/**
 * Remap the bare-column `buildTurnFilterClauses` fragments onto the `ct` alias
 * used inside the skill CTEs (same pattern as `routes/tools.ts`).
 */
function remapToCt(clauses: string[]): string[] {
  return clauses.map((c) =>
    c
      .replace(/\bAND model\b/, "AND ct.model")
      .replace(/\bAND session_id\b/, "AND ct.session_id"),
  );
}

/**
 * GET /api/skills/summary
 *
 * The page-level skill KPI bundle + the "too many skills active" flags (D11).
 * Powers the KPI row and the conditional advisory banner. Four SQL aggregates
 * (loaded set, invoked set, dead-weight, context proxy) combined in JS — keeps
 * each gotcha-sensitive skill extraction in its own CTE.
 *
 * Query params: ?period=7d&model=X&project=Y&source=Z
 */
router.get("/summary", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);
    const params = [filters.range.start, filters.range.end, ...f.params];

    // The period-session set — bare-column filter clauses (no alias).
    const periodSessions = `
        SELECT DISTINCT session_id
        FROM conversation_turns
        WHERE timestamp >= $1 AND timestamp < $2
          ${f.clauses.join("\n          ")}`;

    // 1. LOADED side: distinct skills loaded + per-session loaded counts.
    // SEM2-287: also sum the per-skill description-length estimate per session
    // (`COALESCE(CEIL(LENGTH(skill_description)/4.0), 45)` — same expression
    // as v_skill_loaded and estimateSkillTokens()) so the period-level
    // avgLoadedSkillTokens reflects real descriptions, not the flat 45.
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

    // 2. INVOKED side — skill extraction + tool_name filter inside `inv`.
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
          ${remapToCt(f.clauses).join("\n          ")}
      )
      SELECT
        COUNT(DISTINCT skill) FILTER (WHERE skill IS NOT NULL) AS distinct_invoked,
        COUNT(*) AS total_invocations,
        COUNT(*) FILTER (WHERE success = TRUE) AS success_count,
        COUNT(*) FILTER (WHERE success IS NOT NULL) AS evaluated_count
      FROM inv
    `;

    // 3. Dead-weight skills: loaded in the period, never invoked in the period.
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

    // 4. Context proxy: AVG over the period's assistant turns of
    //    (input + cache_read + cache_creation) — same proxy as v_context_pressure.
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

    const [loadedResult, invokedResult, deadWeightResult, contextResult] =
      await Promise.all([
        query(loadedSql, params),
        query(invokedSql, params),
        query(deadWeightSql, params),
        query(contextSql, params),
      ]);

    const lRow = loadedResult.rows[0] as Record<string, unknown> | undefined;
    const iRow = invokedResult.rows[0] as Record<string, unknown> | undefined;
    const dRow = deadWeightResult.rows[0] as Record<string, unknown> | undefined;
    const cRow = contextResult.rows[0] as Record<string, unknown> | undefined;

    const avgSkillsLoadedPerSession = Number(lRow?.avg_loaded ?? 0);
    const maxSkillsLoadedPerSession = Number(lRow?.max_loaded ?? 0);
    // SEM2-287: per-session AVG of SUM(per-skill estimate). Falls back to the
    // flat 45 per-skill when descriptions are null/empty.
    const avgLoadedSkillTokensRaw = Number(lRow?.avg_est_skill_tokens ?? 0);
    const distinctSkillsLoaded = Number(lRow?.distinct_loaded ?? 0);
    const distinctSkillsInvoked = Number(iRow?.distinct_invoked ?? 0);
    const totalInvocations = Number(iRow?.total_invocations ?? 0);
    const successCount = Number(iRow?.success_count ?? 0);
    const evaluatedCount = Number(iRow?.evaluated_count ?? 0);
    const deadWeightSkills = Number(dRow?.dead_weight ?? 0);
    const avgSessionContextTokens = Number(cRow?.avg_context_tokens ?? 0);

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

    res.json(
      envelope(
        {
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
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/skills/loaded
 *
 * Every loaded skill with `estContextTokens` (length-based, SEM2-287),
 * `loadedInSessions`, `invocations`, and `isDeadWeight`. Powers the
 * "Loaded Skills by Context Weight" table. `session_skills` is scoped to the
 * period sessions. Mirrors `v_skill_loaded` and `SkillAnalyzer.getLoadedSkills`.
 *
 * Query params: ?period=7d&model=X&project=Y&source=Z
 */
router.get("/loaded", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);
    const params = [filters.range.start, filters.range.end, ...f.params];

    const periodSessions = `
        SELECT DISTINCT session_id
        FROM conversation_turns
        WHERE timestamp >= $1 AND timestamp < $2
          ${f.clauses.join("\n          ")}`;

    // SEM2-287: surface a representative skill_description per skill so
    // estContextTokens uses the length-based estimate, falling back to
    // FLAT_SKILL_TOKEN_ESTIMATE (45) for null/empty descriptions. Mirrors
    // v_skill_loaded and SkillAnalyzer.getLoadedSkills.
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

    const result = await query(sql, params);

    const rows = result.rows.map((row: Record<string, unknown>) => {
      const loadedInSessions = Number(row.loaded_in_sessions);
      const invocations = Number(row.invocations);
      // SEM2-287: per-skill description-length estimate × loadings; falls
      // back to FLAT_SKILL_TOKEN_ESTIMATE when the description is null/empty.
      const perSkillEstimate = estimateSkillTokens(
        row.skill_description as string | null,
      );
      return {
        skill: row.skill as string,
        loadedInSessions,
        estContextTokens: loadedInSessions * perSkillEstimate,
        invocations,
        // §4.3: loaded in the period AND not invoked in the period.
        isDeadWeight: invocations === 0,
      };
    });

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/skills/invocations
 *
 * Per-skill invocation stats — `invocations`, `sessionsUsing`, `successCount`,
 * `failureCount`, `successRate` (KPI-006 NULL rule), `avgPerSession`. Powers the
 * Top Skills bar chart, the Skill Invocation Detail table, and the invocation
 * KPIs. Skill names use `COALESCE(skill_name, parameters->>'skill')` so
 * historical rows still appear. Mirrors `SkillAnalyzer.getSkillUsage`.
 *
 * Query params: ?period=7d&model=X&project=Y&source=Z
 */
router.get("/invocations", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);

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
          ${remapToCt(f.clauses).join("\n          ")}
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

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      skill: row.skill as string,
      invocations: Number(row.invocations),
      sessionsUsing: Number(row.sessions_using),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      successRate: row.success_rate != null ? Number(row.success_rate) : null,
      avgPerSession: row.avg_per_session != null ? Number(row.avg_per_session) : 0,
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/skills/trend
 *
 * Skills-Per-Session over time — per `?bucket` (default day), the AVG over that
 * bucket's sessions of (a) distinct skills loaded per session and (b) distinct
 * skills invoked per session. Each session is bucketed by its EARLIEST turn
 * timestamp so it contributes to exactly one bucket. Validates `?bucket` against
 * `{hour,day,week,month}` and 400s on invalid. Mirrors `SkillAnalyzer.getSkillTrend`.
 *
 * Query params: ?period=7d&bucket=day&model=X&project=Y&source=Z
 */
router.get("/trend", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const bucket = (req.query.bucket as string) || "day";
    const validBuckets: Record<string, string> = {
      hour: "hour",
      day: "day",
      week: "week",
      month: "month",
    };
    const duckBucket = validBuckets[bucket];
    if (!duckBucket) {
      return res.status(400).json({
        error: `Invalid time bucket: ${bucket}. Valid values: hour, day, week, month`,
      });
    }

    const f = buildTurnFilterClauses(filters, 3);

    const sql = `
      WITH session_bucket AS (
        SELECT
          session_id,
          DATE_TRUNC('${duckBucket}', MIN(timestamp)) AS ts
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

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.ts as string).toISOString(),
      avgLoadedPerSession: Number(row.avg_loaded_per_session),
      avgInvokedPerSession: Number(row.avg_invoked_per_session),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/skills/not-required
 *
 * The same-session skill thrash signal (D12) — the v1 "invocation not required"
 * heuristic. Flags every `(session_id, skill)` pair whose
 * `invocations_in_session` reached `SKILL_THRASH_MIN` (= 2). `isKnownReentrant`
 * is computed in JS against `KNOWN_REENTRANT_SKILLS`. Clamps `?limit` (1..500,
 * default 100). Mirrors `v_skill_not_required` and `SkillAnalyzer.getSkillThrash`.
 *
 * Query params: ?period=7d&model=X&project=Y&source=Z&limit=100
 */
router.get("/not-required", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit as string, 10) || 100, 1),
      500,
    );
    const f = buildTurnFilterClauses(filters, 4);

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
          ${remapToCt(f.clauses).join("\n          ")}
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
      LIMIT ${limit}
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      SKILL_THRASH_MIN,
      ...f.params,
    ]);

    const thrash = result.rows.map((row: Record<string, unknown>) => ({
      sessionId: row.session_id as string,
      skill: row.skill as string,
      invocationsInSession: Number(row.invocations_in_session),
      isKnownReentrant: isKnownReentrantSkill(row.skill as string),
    }));

    const sessionsAffected = new Set(thrash.map((t) => t.sessionId)).size;
    const nonReentrantRows = thrash.filter((t) => !t.isKnownReentrant).length;

    res.json(
      envelope(
        {
          thrash,
          summary: {
            flaggedRows: thrash.length,
            nonReentrantRows,
            sessionsAffected,
          },
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
