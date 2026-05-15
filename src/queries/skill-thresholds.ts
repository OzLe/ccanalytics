/**
 * @module queries/skill-thresholds
 *
 * F2K — Skill Analysis heuristic constants, CLI side.
 *
 * Mirrors `dashboard/src/lib/skillThresholds.ts` exactly — kept in sync
 * manually because the CLI build (`tsup`, NodeNext) and the dashboard build
 * (Vite, bundler resolution) do not share a module graph. The values MUST
 * stay identical so `ccanalytics query skills` and the `/api/skills/*` routes
 * produce the same numbers (CLI↔API parity).
 *
 * See the dashboard module's doc comments for the rationale behind each
 * constant (D10 / D11 / D12 locked decisions).
 */

/** D11(a): `dead_weight_ratio` threshold for "too many skills active". */
export const DEAD_WEIGHT_RATIO_THRESHOLD = 0.5;

/** D11(b): `loaded_context_share` threshold for "too many skills active". */
export const LOADED_CONTEXT_SHARE_THRESHOLD = 0.05;

/**
 * D12 (Gate-1 decision): same-session thrash threshold — flag a
 * `(session_id, skill_name)` pair when `invocations_in_session >= 2`.
 * Lowered from the originally-researched `3` (matched only 1 row ever).
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
 * D12 / R3: skills designed to be invoked many times per session. Thrash rows
 * for these are still surfaced but flagged `isKnownReentrant` so the CLI/UI
 * can de-emphasise them.
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
