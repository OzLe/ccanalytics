/**
 * @module ingestion/adapters/skill-rows
 *
 * Shared helper for turning parsed `skill_listing` attachment records
 * (`ParsedLoadedSkillRecord[]`) into flat `SessionSkillRow[]` ready for the
 * batch inserter. Used by both the Claude Code and Claude Desktop adapters
 * (P-05 / P-06) so the deterministic primary-key rule (D4) lives in exactly
 * one place.
 */

import type { SessionSkillRow } from "../../types/index.js";
import type { ParsedLoadedSkillRecord } from "./types.js";

/**
 * Build the deterministic `session_skill_id` primary key (D4):
 *
 *   session_id || ':' || (record_uuid ?? timestamp) || ':' || skill_name
 *
 * Deterministic so a re-ingest of the same `skill_listing` record produces
 * identical keys and is absorbed by `ON CONFLICT(session_skill_id) DO NOTHING`.
 * Including `record_uuid` (falling back to `timestamp` when the record carries
 * no uuid) means a genuine mid-session re-listing — a different record — is
 * stored as additional rows rather than colliding with the initial listing.
 */
export function buildSessionSkillId(
  sessionId: string,
  recordUuid: string | null,
  timestamp: string,
  skillName: string,
): string {
  const discriminator = recordUuid ?? timestamp;
  return `${sessionId}:${discriminator}:${skillName}`;
}

/**
 * Flatten `ParsedLoadedSkillRecord[]` into `SessionSkillRow[]` — one row per
 * parsed skill of each record. A record may carry many skills; a file may
 * carry 0..N records. Pure and total.
 *
 * @param loadedSkills - Parsed `skill_listing` records for one file (may be undefined).
 * @returns Session-skill rows ready for `BatchInserter.insertSessionSkills`.
 */
export function buildSessionSkillRows(
  loadedSkills: ParsedLoadedSkillRecord[] | undefined,
): SessionSkillRow[] {
  if (!loadedSkills || loadedSkills.length === 0) {
    return [];
  }

  const rows: SessionSkillRow[] = [];
  for (const record of loadedSkills) {
    let capturedAt: Date | null = null;
    if (record.timestamp) {
      const d = new Date(record.timestamp);
      capturedAt = Number.isNaN(d.getTime()) ? null : d;
    }

    for (const skill of record.skills) {
      rows.push({
        session_skill_id: buildSessionSkillId(
          record.sessionId,
          record.recordUuid,
          record.timestamp,
          skill.name,
        ),
        session_id: record.sessionId,
        record_uuid: record.recordUuid,
        skill_name: skill.name,
        skill_description: skill.description.length > 0 ? skill.description : null,
        skill_count: record.skillCount,
        is_initial: record.isInitial,
        captured_at: capturedAt,
        source: "skill_listing",
      });
    }
  }
  return rows;
}
