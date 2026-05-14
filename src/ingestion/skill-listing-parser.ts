/**
 * @module ingestion/skill-listing-parser
 *
 * P-04: pure helper for parsing the `skill_listing` attachment payload.
 *
 * The available-skills list is delivered as a top-level `type:"attachment"`
 * JSONL record whose `attachment.type === "skill_listing"`. Its `content`
 * field is newline-delimited text of the form:
 *
 *   - <skill-name>: <description, possibly continuing onto following lines>
 *   - <skill-name>: <description>
 *   <continuation line of the previous skill's description>
 *
 * Parse algorithm (see feature-plan §3.3):
 *   - A line matching /^- ([^:]+): ?(.*)$/ STARTS a new skill — group 1 is the
 *     skill name (trimmed), group 2 the description start.
 *   - Any line NOT starting with "- " is a CONTINUATION of the previous
 *     skill's multi-line description and is appended to it.
 *   - `[^:]+` before the first ": " correctly handles both plain skills
 *     (`simplify`) and plugin-namespaced skills (`babysitter:babysit`,
 *     `chrome-devtools-mcp:chrome-devtools`) because the namespace colon
 *     carries no trailing space.
 *
 * This module is intentionally pure and dependency-free so it can be unit
 * tested in isolation and imported by both source adapters.
 */

/** A single skill parsed out of a `skill_listing` attachment's content. */
export interface ParsedSkill {
  /** Skill name, e.g. "simplify" or "babysitter:babysit". */
  name: string;
  /** Skill description — may have been assembled from multiple lines. */
  description: string;
}

/**
 * Matches a line that starts a new skill entry.
 * Group 1: skill name (everything up to the first ": "), Group 2: description.
 * The `[^:]+` stops at the first colon, but a trailing-`:` only counts as the
 * name/description separator when followed by an optional single space, so
 * `babysitter:babysit: <desc>` correctly yields name `babysitter:babysit`.
 */
const SKILL_LINE_RE = /^- ([^:]+(?::[^:]+)*): ?(.*)$/;

/**
 * Parse a `skill_listing` attachment's `content` string into a flat list of
 * `{ name, description }` skills.
 *
 * Continuation lines (lines that do not begin with "- ") are appended to the
 * preceding skill's description, joined with a single space. A continuation
 * line that appears before any skill line is ignored (malformed input).
 *
 * Pure and total — never throws. Callers that have an upstream `skillCount`
 * should compare `parsed.length` against it and log a warning on mismatch
 * (the integrity check is the caller's responsibility, not this helper's,
 * because only the caller has the count).
 *
 * @param content - The raw `attachment.content` newline-delimited text.
 * @returns Parsed skills in document order.
 */
export function parseSkillListing(content: string): ParsedSkill[] {
  if (!content || content.length === 0) {
    return [];
  }

  const skills: ParsedSkill[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const match = SKILL_LINE_RE.exec(line);
    if (match) {
      // A new skill entry.
      skills.push({
        name: match[1].trim(),
        description: match[2].trim(),
      });
      continue;
    }

    // Not a "- " skill line. If it has content, treat it as a continuation
    // of the previous skill's description. Skip blank lines and any
    // continuation that appears before the first skill line.
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const last = skills[skills.length - 1];
    if (last) {
      last.description = last.description.length > 0
        ? `${last.description} ${trimmed}`
        : trimmed;
    }
  }

  return skills;
}
