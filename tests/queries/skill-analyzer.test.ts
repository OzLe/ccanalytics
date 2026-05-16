/**
 * @module tests/queries/skill-analyzer
 *
 * Integration tests for the SkillAnalyzer class (F2K — Skill Analysis).
 * Uses DuckDB :memory: mode with the migration-5 schema (`session_skills`
 * table + `tool_calls.skill_name` / `skill_caller_type` columns) and the
 * `seedSkillData` fixture from tests/helpers/db-setup.ts.
 *
 * The fixture (see `seedSkillData` for the full layout):
 *   LOADED  : skill-alpha (sess-001,003), skill-beta (sess-001),
 *             skill-ghost (sess-002,003), skill-orphan (sess-003)
 *   INVOKED : skill-alpha ×4 (sess-001 ×3 thrash + sess-003 ×1),
 *             skill-beta ×2 (sess-002, thrash), loop ×2 (sess-003, thrash)
 *   Some INVOKED rows leave `skill_name` NULL and rely on the
 *   `COALESCE(skill_name, parameters->>'skill')` fallback; some carry
 *   `skill_caller_type`. skill-ghost / skill-orphan are never invoked → dead
 *   weight.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestDB,
  closeTestDB,
  seedTestData,
  seedSkillData,
  SKILL_DESC,
  type TestDB,
} from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { SkillAnalyzer } from "../../src/queries/skill-analyzer.js";
import {
  DEAD_WEIGHT_RATIO_THRESHOLD,
  LOADED_CONTEXT_SHARE_THRESHOLD,
  SKILL_THRASH_MIN,
  FLAT_SKILL_TOKEN_ESTIMATE,
  estimateSkillTokens,
} from "../../src/queries/skill-thresholds.js";
import type { TimeRange } from "../../src/types/index.js";

describe("SkillAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: SkillAnalyzer;

  // Covers every base session (sess-001/002/003) and every seeded Skill call.
  const testRange: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new SkillAnalyzer(executor);
    await seedTestData(db.connection);
    await seedSkillData(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  // -------------------------------------------------------------------------
  // skill-thresholds.ts — assert the constants the analyzer is built on.
  // -------------------------------------------------------------------------
  describe("skill-thresholds constants", () => {
    it("exposes the locked D10/D11/D12 heuristic constants", () => {
      expect(DEAD_WEIGHT_RATIO_THRESHOLD).toBe(0.5);
      expect(LOADED_CONTEXT_SHARE_THRESHOLD).toBe(0.05);
      expect(SKILL_THRASH_MIN).toBe(2);
      expect(FLAT_SKILL_TOKEN_ESTIMATE).toBe(45);
    });
  });

  // -------------------------------------------------------------------------
  // getSkillUsage — per-skill INVOKED stats.
  // -------------------------------------------------------------------------
  describe("getSkillUsage", () => {
    it("aggregates invocations per resolved skill, ordered by invocations desc", async () => {
      const rows = await analyzer.getSkillUsage(testRange);
      expect(rows.map((r) => r.skill)).toEqual([
        "skill-alpha",
        "loop",
        "skill-beta",
      ]);
    });

    it("resolves skill names via the COALESCE(skill_name, parameters->>'skill') fallback", async () => {
      // skill-alpha's sess-003 row and one skill-beta row leave skill_name NULL
      // — they must still be counted, via parameters->>'skill'.
      const rows = await analyzer.getSkillUsage(testRange);
      const alpha = rows.find((r) => r.skill === "skill-alpha");
      const beta = rows.find((r) => r.skill === "skill-beta");
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      // skill-alpha: 3 in sess-001 + 1 (skill_name NULL) in sess-003.
      expect(alpha!.invocations).toBe(4);
      expect(alpha!.sessionsUsing).toBe(2);
      expect(alpha!.avgPerSession).toBe(2); // 4 / 2
      // skill-beta: 1 explicit + 1 (skill_name NULL) = 2, all in sess-002.
      expect(beta!.invocations).toBe(2);
      expect(beta!.sessionsUsing).toBe(1);
    });

    it("applies the KPI-006 NULL-success rule to per-skill success rates", async () => {
      const rows = await analyzer.getSkillUsage(testRange);
      const alpha = rows.find((r) => r.skill === "skill-alpha")!;
      const beta = rows.find((r) => r.skill === "skill-beta")!;
      const loop = rows.find((r) => r.skill === "loop")!;
      // skill-alpha: success TRUE, TRUE, NULL, FALSE → 2 of 3 non-NULL.
      expect(alpha.successCount).toBe(2);
      expect(alpha.failureCount).toBe(1);
      expect(alpha.successRate).toBeCloseTo(2 / 3, 10);
      // skill-beta: both invocations have NULL success → rate is null, not 0.
      expect(beta.successCount).toBe(0);
      expect(beta.failureCount).toBe(0);
      expect(beta.successRate).toBeNull();
      // loop: TRUE, TRUE → rate 1.
      expect(loop.successRate).toBe(1);
    });

    it("the model filter narrows the result set", async () => {
      // Only sess-002 is claude-opus-4, and sess-002 only invoked skill-beta.
      const rows = await analyzer.getSkillUsage(testRange, { model: "opus" });
      expect(rows.map((r) => r.skill)).toEqual(["skill-beta"]);
      expect(rows[0].invocations).toBe(2);
    });

    it("the project filter narrows the result set", async () => {
      // /projects/alpha = sess-001 + sess-003 → skill-alpha + loop, no skill-beta.
      const rows = await analyzer.getSkillUsage(testRange, { project: "alpha" });
      expect(rows.map((r) => r.skill).sort()).toEqual(["loop", "skill-alpha"]);
      const alpha = rows.find((r) => r.skill === "skill-alpha")!;
      expect(alpha.invocations).toBe(4);
    });

    it("returns no rows for a period with no Skill calls", async () => {
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const rows = await analyzer.getSkillUsage(futureRange);
      expect(rows).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getLoadedSkills — per-skill LOADED stats + dead-weight detection.
  // -------------------------------------------------------------------------
  describe("getLoadedSkills", () => {
    it("returns loaded-session counts ordered by loaded sessions desc", async () => {
      const rows = await analyzer.getLoadedSkills(testRange);
      expect(rows.map((r) => r.skill)).toEqual([
        "skill-alpha", // loaded in 2
        "skill-ghost", // loaded in 2
        "skill-beta", // loaded in 1
        "skill-orphan", // loaded in 1
      ]);
      const alpha = rows.find((r) => r.skill === "skill-alpha")!;
      expect(alpha.loadedInSessions).toBe(2);
    });

    it("flags loaded-but-never-invoked skills as dead weight", async () => {
      const rows = await analyzer.getLoadedSkills(testRange);
      const byName = Object.fromEntries(rows.map((r) => [r.skill, r]));
      // skill-ghost / skill-orphan are loaded but never invoked.
      expect(byName["skill-ghost"].isDeadWeight).toBe(true);
      expect(byName["skill-ghost"].invocations).toBe(0);
      expect(byName["skill-orphan"].isDeadWeight).toBe(true);
      // skill-alpha / skill-beta are loaded AND invoked → not dead weight.
      expect(byName["skill-alpha"].isDeadWeight).toBe(false);
      expect(byName["skill-alpha"].invocations).toBe(4);
      expect(byName["skill-beta"].isDeadWeight).toBe(false);
      expect(byName["skill-beta"].invocations).toBe(2);
    });

    it("estimates context tokens with the per-skill description-length model (SEM2-287)", async () => {
      // Fixture descriptions are padded to known lengths so each skill has a
      // round per-skill estimate: alpha=50, beta=60, ghost=40, orphan=30.
      const expectedTokens: Record<string, number> = {
        "skill-alpha": estimateSkillTokens(SKILL_DESC.alpha), // 50
        "skill-beta": estimateSkillTokens(SKILL_DESC.beta), // 60
        "skill-ghost": estimateSkillTokens(SKILL_DESC.ghost), // 40
        "skill-orphan": estimateSkillTokens(SKILL_DESC.orphan), // 30
      };
      const rows = await analyzer.getLoadedSkills(testRange);
      for (const row of rows) {
        expect(row.estContextTokens).toBe(
          row.loadedInSessions * expectedTokens[row.skill],
        );
      }
      const alpha = rows.find((r) => r.skill === "skill-alpha")!;
      // loaded in 2 sessions × 50 tokens = 100
      expect(alpha.estContextTokens).toBe(
        2 * estimateSkillTokens(SKILL_DESC.alpha),
      );
      expect(alpha.estContextTokens).toBe(100);
    });

    it("falls back to FLAT_SKILL_TOKEN_ESTIMATE when skill_description is NULL (SEM2-287)", async () => {
      // Wipe skill-alpha's description on both its loaded rows → ANY_VALUE
      // in the loaded CTE returns NULL → JS helper returns the flat 45.
      await db.connection.run(
        `UPDATE session_skills SET skill_description = NULL WHERE skill_name = 'skill-alpha'`,
      );
      const rows = await analyzer.getLoadedSkills(testRange);
      const alpha = rows.find((r) => r.skill === "skill-alpha")!;
      // loaded in 2 sessions × 45 fallback = 90
      expect(alpha.estContextTokens).toBe(2 * FLAT_SKILL_TOKEN_ESTIMATE);
      expect(alpha.estContextTokens).toBe(90);
    });

    it("scopes both loaded and invoked sides to the filtered period sessions", async () => {
      // Under the /projects/alpha filter, period sessions = sess-001 + sess-003.
      // skill-beta is LOADED in sess-001 but only INVOKED in sess-002 (excluded)
      // → it becomes dead weight under this filter.
      const rows = await analyzer.getLoadedSkills(testRange, {
        project: "alpha",
      });
      const beta = rows.find((r) => r.skill === "skill-beta")!;
      expect(beta.loadedInSessions).toBe(1);
      expect(beta.invocations).toBe(0);
      expect(beta.isDeadWeight).toBe(true);
      // skill-ghost was loaded in sess-002 + sess-003 → only sess-003 remains.
      const ghost = rows.find((r) => r.skill === "skill-ghost")!;
      expect(ghost.loadedInSessions).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getSkillSummary — page-level KPI bundle + tooManySkillsActive OR-logic.
  // -------------------------------------------------------------------------
  describe("getSkillSummary", () => {
    it("computes the loaded / invoked / dead-weight KPI bundle", async () => {
      const s = await analyzer.getSkillSummary(testRange);
      // LOADED: sess-001 → 2, sess-002 → 1, sess-003 → 3 distinct skills.
      expect(s.avgSkillsLoadedPerSession).toBeCloseTo(2, 10); // (2+1+3)/3
      expect(s.maxSkillsLoadedPerSession).toBe(3);
      expect(s.distinctSkillsLoaded).toBe(4); // alpha, beta, ghost, orphan
      // INVOKED: alpha, beta, loop.
      expect(s.distinctSkillsInvoked).toBe(3);
      expect(s.totalInvocations).toBe(8); // 4 + 2 + 2
      // dead weight = loaded ∖ invoked = {ghost, orphan}.
      expect(s.deadWeightSkills).toBe(2);
    });

    it("applies the KPI-006 NULL-success rule to the aggregate success rate", async () => {
      const s = await analyzer.getSkillSummary(testRange);
      // Non-NULL success rows: alpha (TRUE,TRUE,FALSE) + loop (TRUE,TRUE) = 5,
      // of which 4 are TRUE. skill-beta's two NULL rows are excluded.
      expect(s.skillSuccessRate).toBeCloseTo(4 / 5, 10);
    });

    it("returns a null aggregate success rate when no Skill row has a non-NULL success", async () => {
      // Wipe every non-NULL success → the KPI-006 'null when no data' branch.
      await db.connection.run(`UPDATE tool_calls SET success = NULL WHERE tool_name = 'Skill'`);
      const s = await analyzer.getSkillSummary(testRange);
      expect(s.skillSuccessRate).toBeNull();
    });

    it("computes invocationRate and deadWeightRatio against the loaded set", async () => {
      const s = await analyzer.getSkillSummary(testRange);
      expect(s.invocationRate).toBeCloseTo(3 / 4, 10); // distinctInvoked / distinctLoaded
      expect(s.deadWeightRatio).toBeCloseTo(2 / 4, 10); // deadWeight / distinctLoaded
    });

    it("computes loadedContextShare from the per-skill length-based estimate over the context proxy (SEM2-287)", async () => {
      const s = await analyzer.getSkillSummary(testRange);
      // SEM2-287: per-session SUM of CEIL(LEN(desc)/4) — each skill's
      // description has a fixed length so the per-skill token count is
      // deterministic (alpha=50, beta=60, ghost=40, orphan=30):
      //   sess-001: alpha(50) + beta(60)          = 110
      //   sess-002: ghost(40)                     =  40
      //   sess-003: alpha(50) + ghost(40) + orphan(30) = 120
      //   AVG = (110 + 40 + 120) / 3              =  90
      const sumA = estimateSkillTokens(SKILL_DESC.alpha) +
        estimateSkillTokens(SKILL_DESC.beta);
      const sumB = estimateSkillTokens(SKILL_DESC.ghost);
      const sumC = estimateSkillTokens(SKILL_DESC.alpha) +
        estimateSkillTokens(SKILL_DESC.ghost) +
        estimateSkillTokens(SKILL_DESC.orphan);
      const expectedAvg = (sumA + sumB + sumC) / 3; // 90
      expect(s.avgLoadedSkillTokens).toBeCloseTo(expectedAvg, 10);
      expect(s.avgLoadedSkillTokens).toBe(90);
      // Context proxy = AVG over the 5 base assistant turns of
      // (input + cache_read + cache_creation): (700+800+2600+1100+1900)/5 = 1420.
      expect(s.avgSessionContextTokens).toBeCloseTo(1420, 6);
      expect(s.loadedContextShare).toBeCloseTo(90 / 1420, 10);
    });

    it("trips tooManySkillsActive via the loaded_context_share sub-condition only (D11 OR-logic)", async () => {
      const s = await analyzer.getSkillSummary(testRange);
      // (a) deadWeightRatio = 0.50 — NOT > DEAD_WEIGHT_RATIO_THRESHOLD (0.50),
      //     strict-inequality boundary → does NOT trip.
      expect(s.deadWeightRatio).toBe(DEAD_WEIGHT_RATIO_THRESHOLD);
      // (b) loadedContextShare ≈ 0.0634 > LOADED_CONTEXT_SHARE_THRESHOLD (0.05)
      //     → trips. So the OR is true with exactly one reason.
      expect(s.loadedContextShare!).toBeGreaterThan(LOADED_CONTEXT_SHARE_THRESHOLD);
      expect(s.tooManySkillsActive).toBe(true);
      expect(s.tooManyReasons).toHaveLength(1);
      expect(s.tooManyReasons[0]).toContain("session context");
    });

    it("does not trip tooManySkillsActive when neither sub-condition is met", async () => {
      // Remove all dead-weight skills (→ deadWeightRatio 0) and shrink the
      // loaded set to one skill in one session (→ loaded_context_share tiny).
      await db.connection.run(
        `DELETE FROM session_skills WHERE skill_name IN ('skill-ghost','skill-orphan','skill-beta')`,
      );
      await db.connection.run(
        `DELETE FROM session_skills WHERE session_id IN ('sess-001','sess-002')`,
      );
      const s = await analyzer.getSkillSummary(testRange);
      expect(s.deadWeightSkills).toBe(0);
      expect(s.deadWeightRatio).toBe(0);
      // SEM2-287: skill-alpha (200-char description → 50 tokens) loaded in
      // 1 session → avgLoadedSkillTokens ≈ 50 over a ~1420 context proxy
      // ≈ 3.5%, under the 5% threshold.
      expect(s.loadedContextShare!).toBeLessThan(LOADED_CONTEXT_SHARE_THRESHOLD);
      expect(s.tooManySkillsActive).toBe(false);
      expect(s.tooManyReasons).toEqual([]);
    });

    it("trips the dead_weight_ratio sub-condition when it exceeds the threshold", async () => {
      // Drop skill-alpha's loaded rows: loaded set = {beta, ghost, orphan},
      // invoked-in-period (non-null) = {alpha, beta, loop} → dead = {ghost,
      // orphan} = 2 of 3 → ratio 0.667 > 0.50.
      await db.connection.run(
        `DELETE FROM session_skills WHERE skill_name = 'skill-alpha'`,
      );
      const s = await analyzer.getSkillSummary(testRange);
      expect(s.distinctSkillsLoaded).toBe(3);
      expect(s.deadWeightSkills).toBe(2);
      expect(s.deadWeightRatio!).toBeGreaterThan(DEAD_WEIGHT_RATIO_THRESHOLD);
      expect(s.tooManySkillsActive).toBe(true);
      // The dead-weight reason mentions skills "never invoked".
      expect(s.tooManyReasons.some((r) => r.includes("never invoked"))).toBe(
        true,
      );
    });

    it("returns null ratios and a clean summary for a period with no skills", async () => {
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const s = await analyzer.getSkillSummary(futureRange);
      expect(s.distinctSkillsLoaded).toBe(0);
      expect(s.distinctSkillsInvoked).toBe(0);
      expect(s.totalInvocations).toBe(0);
      expect(s.skillSuccessRate).toBeNull();
      expect(s.invocationRate).toBeNull();
      expect(s.deadWeightRatio).toBeNull();
      expect(s.loadedContextShare).toBeNull();
      expect(s.tooManySkillsActive).toBe(false);
      expect(s.tooManyReasons).toEqual([]);
    });

    it("the model filter narrows the summary", async () => {
      // model=opus → only sess-002: loads skill-ghost, invokes skill-beta.
      const s = await analyzer.getSkillSummary(testRange, { model: "opus" });
      expect(s.distinctSkillsLoaded).toBe(1); // skill-ghost
      expect(s.distinctSkillsInvoked).toBe(1); // skill-beta
      expect(s.totalInvocations).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // getSkillThrash — same-session thrash (D12), SKILL_THRASH_MIN = 2.
  // -------------------------------------------------------------------------
  describe("getSkillThrash", () => {
    it("flags only (session, skill) pairs at or above SKILL_THRASH_MIN", async () => {
      const { thrash } = await analyzer.getSkillThrash(testRange);
      // Flagged: (sess-001,skill-alpha)=3, (sess-002,skill-beta)=2,
      // (sess-003,loop)=2. NOT flagged: (sess-003,skill-alpha)=1.
      expect(thrash).toHaveLength(3);
      const pairs = thrash.map((t) => `${t.sessionId}:${t.skill}`);
      expect(pairs).toContain("sess-001:skill-alpha");
      expect(pairs).toContain("sess-002:skill-beta");
      expect(pairs).toContain("sess-003:loop");
      expect(pairs).not.toContain("sess-003:skill-alpha");
      for (const row of thrash) {
        expect(row.invocationsInSession).toBeGreaterThanOrEqual(SKILL_THRASH_MIN);
      }
    });

    it("orders thrash rows by invocations desc", async () => {
      const { thrash } = await analyzer.getSkillThrash(testRange);
      // sess-001:skill-alpha has 3, the rest 2 → it sorts first.
      expect(thrash[0].sessionId).toBe("sess-001");
      expect(thrash[0].skill).toBe("skill-alpha");
      expect(thrash[0].invocationsInSession).toBe(3);
    });

    it("flags known re-entrant skills via isKnownReentrant", async () => {
      const { thrash } = await analyzer.getSkillThrash(testRange);
      const loop = thrash.find((t) => t.skill === "loop")!;
      const alpha = thrash.find((t) => t.skill === "skill-alpha")!;
      const beta = thrash.find((t) => t.skill === "skill-beta")!;
      // `loop` is in KNOWN_REENTRANT_SKILLS; skill-alpha / skill-beta are not.
      expect(loop.isKnownReentrant).toBe(true);
      expect(alpha.isKnownReentrant).toBe(false);
      expect(beta.isKnownReentrant).toBe(false);
    });

    it("summarizes flagged / non-reentrant / sessions-affected counts", async () => {
      const { summary } = await analyzer.getSkillThrash(testRange);
      expect(summary.flaggedRows).toBe(3);
      // 3 flagged, 1 of them (loop) is known re-entrant.
      expect(summary.nonReentrantRows).toBe(2);
      // sess-001, sess-002, sess-003 all appear.
      expect(summary.sessionsAffected).toBe(3);
    });

    it("the project filter narrows the thrash list", async () => {
      // /projects/alpha = sess-001 + sess-003 → drops the sess-002 skill-beta row.
      const { thrash, summary } = await analyzer.getSkillThrash(testRange, {
        project: "alpha",
      });
      const pairs = thrash.map((t) => `${t.sessionId}:${t.skill}`);
      expect(pairs).toContain("sess-001:skill-alpha");
      expect(pairs).toContain("sess-003:loop");
      expect(pairs).not.toContain("sess-002:skill-beta");
      expect(summary.flaggedRows).toBe(2);
    });

    it("clamps the limit and respects it", async () => {
      // limit 1 → only the top (highest-invocation) thrash row is returned.
      const { thrash } = await analyzer.getSkillThrash(testRange, undefined, 1);
      expect(thrash).toHaveLength(1);
      expect(thrash[0].sessionId).toBe("sess-001");
      expect(thrash[0].skill).toBe("skill-alpha");
    });

    it("returns an empty thrash list when nothing reaches the threshold", async () => {
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const { thrash, summary } = await analyzer.getSkillThrash(futureRange);
      expect(thrash).toEqual([]);
      expect(summary).toEqual({
        flaggedRows: 0,
        nonReentrantRows: 0,
        sessionsAffected: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // getSkillTrend — Skills-Per-Session trend buckets.
  // -------------------------------------------------------------------------
  describe("getSkillTrend", () => {
    it("buckets sessions by their earliest turn and averages loaded vs invoked", async () => {
      const points = await analyzer.getSkillTrend(testRange, "day");
      // sess-001 + sess-002 fall on 2026-02-20; sess-003 on 2026-02-21.
      expect(points).toHaveLength(2);

      const day20 = points[0];
      // loaded: sess-001 → 2, sess-002 → 1 ⇒ avg 1.5.
      expect(day20.avgLoadedPerSession).toBeCloseTo(1.5, 10);
      // invoked distinct: sess-001 → {skill-alpha}=1, sess-002 → {skill-beta}=1.
      expect(day20.avgInvokedPerSession).toBeCloseTo(1, 10);

      const day21 = points[1];
      // loaded: sess-003 → 3; invoked distinct: {skill-alpha, loop} = 2.
      expect(day21.avgLoadedPerSession).toBeCloseTo(3, 10);
      expect(day21.avgInvokedPerSession).toBeCloseTo(2, 10);
    });

    it("returns points ordered ascending by bucket timestamp", async () => {
      const points = await analyzer.getSkillTrend(testRange, "day");
      for (let i = 1; i < points.length; i++) {
        expect(points[i].timestamp.getTime()).toBeGreaterThan(
          points[i - 1].timestamp.getTime(),
        );
      }
    });

    it("rejects an invalid time bucket", async () => {
      await expect(
        analyzer.getSkillTrend(testRange, "decade" as never),
      ).rejects.toThrow(/Invalid time bucket/);
    });

    it("the project filter narrows the trend", async () => {
      // /projects/alpha = sess-001 + sess-003 → sess-002 (the other 02-20
      // session) drops out, so the 02-20 bucket reflects sess-001 only.
      const points = await analyzer.getSkillTrend(testRange, "day", {
        project: "alpha",
      });
      expect(points).toHaveLength(2);
      // 02-20 bucket: sess-001 only → loaded 2, invoked distinct {skill-alpha}=1.
      expect(points[0].avgLoadedPerSession).toBeCloseTo(2, 10);
      expect(points[0].avgInvokedPerSession).toBeCloseTo(1, 10);
    });

    it("returns no points for an empty period", async () => {
      const futureRange: TimeRange = {
        start: new Date("2030-01-01"),
        end: new Date("2030-01-02"),
      };
      const points = await analyzer.getSkillTrend(futureRange, "day");
      expect(points).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // v_skill_loaded — the SQL view's per-skill est_context_tokens column.
  //
  // SEM2-287: the view's est_context_tokens column was a flat
  // `loaded_in_sessions * 45` and is now
  // `loaded_in_sessions * COALESCE(CEIL(LENGTH(skill_description)/4.0), 45)`.
  // These tests assert the SQL behaviour directly so the SQL spec and the
  // TS analyzer (`SkillAnalyzer.getLoadedSkills`) can never silently drift.
  // -------------------------------------------------------------------------
  describe("v_skill_loaded view (SEM2-287)", () => {
    async function readView(): Promise<
      Array<{
        skill: string;
        loaded_in_sessions: number;
        est_context_tokens: number;
        invocations: number;
        is_dead_weight: boolean;
      }>
    > {
      const reader = await db.connection.runAndReadAll(
        `SELECT skill, loaded_in_sessions, est_context_tokens, invocations, is_dead_weight
         FROM v_skill_loaded ORDER BY skill ASC`,
      );
      return (reader.getRowObjectsJS() as Array<Record<string, unknown>>).map(
        (r) => ({
          skill: String(r.skill),
          loaded_in_sessions: Number(r.loaded_in_sessions),
          est_context_tokens: Number(r.est_context_tokens),
          invocations: Number(r.invocations),
          is_dead_weight: Boolean(r.is_dead_weight),
        }),
      );
    }

    it("computes est_context_tokens as loaded_in_sessions × CEIL(LENGTH(description)/4)", async () => {
      const rows = await readView();
      const byName = Object.fromEntries(rows.map((r) => [r.skill, r]));
      // Fixture descriptions are exact-length: alpha=50, beta=60, ghost=40,
      // orphan=30 tokens per skill. Loaded-session counts come from the
      // fixture: alpha=2, beta=1, ghost=2, orphan=1.
      expect(byName["skill-alpha"].loaded_in_sessions).toBe(2);
      expect(byName["skill-alpha"].est_context_tokens).toBe(
        2 * estimateSkillTokens(SKILL_DESC.alpha),
      );
      expect(byName["skill-alpha"].est_context_tokens).toBe(100);

      expect(byName["skill-beta"].loaded_in_sessions).toBe(1);
      expect(byName["skill-beta"].est_context_tokens).toBe(
        1 * estimateSkillTokens(SKILL_DESC.beta),
      );
      expect(byName["skill-beta"].est_context_tokens).toBe(60);

      expect(byName["skill-ghost"].loaded_in_sessions).toBe(2);
      expect(byName["skill-ghost"].est_context_tokens).toBe(
        2 * estimateSkillTokens(SKILL_DESC.ghost),
      );
      expect(byName["skill-ghost"].est_context_tokens).toBe(80);

      expect(byName["skill-orphan"].loaded_in_sessions).toBe(1);
      expect(byName["skill-orphan"].est_context_tokens).toBe(
        1 * estimateSkillTokens(SKILL_DESC.orphan),
      );
      expect(byName["skill-orphan"].est_context_tokens).toBe(30);
    });

    it("falls back to 45 per loading when skill_description is NULL", async () => {
      // Wipe the description on every row of skill-orphan → ANY_VALUE in
      // the loaded CTE returns NULL → COALESCE(..., 45) kicks in. The
      // multiplier stays at the loaded_in_sessions count (1).
      await db.connection.run(
        `UPDATE session_skills SET skill_description = NULL WHERE skill_name = 'skill-orphan'`,
      );
      const rows = await readView();
      const orphan = rows.find((r) => r.skill === "skill-orphan")!;
      expect(orphan.loaded_in_sessions).toBe(1);
      expect(orphan.est_context_tokens).toBe(1 * FLAT_SKILL_TOKEN_ESTIMATE);
      expect(orphan.est_context_tokens).toBe(45);
    });

    it("returns an INTEGER (not a fractional) est_context_tokens column", async () => {
      // The view CASTs to INTEGER so downstream readers can treat it as a
      // count. Use a description whose LENGTH/4 is non-integer to exercise
      // both the CEIL and the cast.
      await db.connection.run(
        `UPDATE session_skills SET skill_description = 'abcde' WHERE skill_name = 'skill-orphan'`,
      );
      const rows = await readView();
      const orphan = rows.find((r) => r.skill === "skill-orphan")!;
      // CEIL(5/4) = 2; loaded_in_sessions = 1 → est_context_tokens = 2.
      expect(orphan.est_context_tokens).toBe(2);
      expect(Number.isInteger(orphan.est_context_tokens)).toBe(true);
    });
  });
});
