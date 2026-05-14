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

/** D10: flat per-skill context-token estimate ("estimated (flat model)"). */
export const FLAT_SKILL_TOKEN_ESTIMATE = 45;

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
