/**
 * @module lib/skillThresholds
 *
 * F2K — Skill Analysis heuristic constants. **Single source of truth.**
 *
 * D11 / D12 (locked decisions): the "too many skills active" and "invocation
 * not required" heuristics are deliberately judgement calls grounded in the
 * real dataset. Keeping every threshold here — in ONE place — means they can be
 * tuned without code archaeology. Both the dashboard routes
 * (`dashboard/src/server/routes/skills.ts`) and the CLI analyzer
 * (`src/queries/skill-analyzer.ts`, which re-declares the same values) read
 * these so the web table and `ccanalytics query skills` always agree.
 *
 * The UI must label any signal derived from these as "Heuristic", never as
 * authoritative.
 */

/**
 * D11(a): the page is in the "too many skills active" state when the share of
 * loaded skills that never fired in the period exceeds this ratio.
 *
 * `dead_weight_ratio = dead_weight_skill_count / distinct_loaded_skill_count`.
 * Grounded in real data — with a long never-invoked tail, the ratio sits well
 * above 0.50, so the default surfaces a real, actionable problem.
 */
export const DEAD_WEIGHT_RATIO_THRESHOLD = 0.5;

/**
 * D11(b): the page is also in the "too many skills active" state when skill
 * descriptions account for more than this fraction of average session context.
 *
 * `loaded_context_share = avg_loaded_skill_tokens / avg_session_context_tokens`.
 * Deliberately conservative — `CLAUDE.md` treats >60% TOTAL context utilization
 * as the quality-risk line, so 5% for skill descriptions alone is a soft early
 * warning.
 */
export const LOADED_CONTEXT_SHARE_THRESHOLD = 0.05;

/**
 * D12 (Gate-1 decision): same-session skill thrash threshold. A
 * `(session_id, skill_name)` pair is flagged THRASH when
 * `invocations_in_session >= SKILL_THRASH_MIN`.
 *
 * Lowered from the originally-researched `3` (which matched only ONE row in the
 * user's entire history) to `2` so the "Possibly-Unnecessary Invocations"
 * signal ships with meaningful rows. Raise back to 3 if `>= 2` proves noisy.
 */
export const SKILL_THRASH_MIN = 2;

/**
 * D10: flat per-skill context-token estimate.
 *
 * Kept as the documented FALLBACK when a skill_listing row has no
 * `skill_description` (rare but possible — historical rows + the NOT NULL
 * default removed in S-01). The default per-skill estimate is now computed
 * from the description length via the 4-chars-per-token heuristic — see
 * {@link estimateSkillTokens} and SEM2-287.
 *
 * `estContextTokens = SUM over loadings of estimateSkillTokens(description)`
 * (or, when the rep description is the same across loadings of the same
 * skill, simply `loadedInSessions * estimateSkillTokens(description)`).
 */
export const FLAT_SKILL_TOKEN_ESTIMATE = 45;

/**
 * SEM2-287: per-skill context-token estimate derived from the skill's
 * description length using the 4-chars-per-token heuristic, falling back to
 * {@link FLAT_SKILL_TOKEN_ESTIMATE} when the description is null / empty.
 *
 * Mirrors the SQL expression used in `v_skill_loaded` /
 * `SkillAnalyzer.getLoadedSkills` / `routes/skills.ts`:
 *
 *     COALESCE(CEIL(LENGTH(skill_description) / 4.0), 45)
 *
 * The flat constant systematically understated real skill descriptions by
 * ~45%; the length-based estimate is the new default and the flat value
 * remains only as the NULL fallback so all surfaces stay symmetric.
 *
 * @param description - the `session_skills.skill_description` value (may be
 *   null, undefined, or an empty string — all three fall back to 45).
 * @returns an integer estimated-tokens count, never less than 1.
 */
export function estimateSkillTokens(
  description: string | null | undefined,
): number {
  if (description == null) return FLAT_SKILL_TOKEN_ESTIMATE;
  const len = description.length;
  if (len === 0) return FLAT_SKILL_TOKEN_ESTIMATE;
  return Math.ceil(len / 4);
}

/**
 * D12 / R3: skills that are *designed* to be invoked many times per session
 * (orchestrators, loops, schedulers, multi-step workflow skills). Thrash rows
 * for these are still surfaced but flagged `isKnownReentrant: true` so the UI
 * can de-emphasise them — the thrash signal means "worth a look", not
 * "definitely wrong".
 *
 * Matched case-insensitively against the resolved skill name
 * (`COALESCE(skill_name, parameters->>'skill')`).
 */
export const KNOWN_REENTRANT_SKILLS: readonly string[] = [
  "babysitter:babysit",
  "babysitter:call",
  "babysitter:babysit-prs",
  "loop",
  "schedule",
  "handoff",
];

/**
 * Case-insensitive membership test against {@link KNOWN_REENTRANT_SKILLS}.
 *
 * @param skillName - The resolved skill name to test (may be null).
 * @returns `true` when the skill is a known re-entrant skill.
 */
export function isKnownReentrantSkill(skillName: string | null | undefined): boolean {
  if (!skillName) return false;
  const lower = skillName.toLowerCase();
  return KNOWN_REENTRANT_SKILLS.some((s) => s.toLowerCase() === lower);
}
