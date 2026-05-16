/**
 * @module server/helpers/parseFilters
 *
 * Parse query string filters into structured time ranges and filter values.
 * Mirrors the parent project's parsePeriod() and filter-builder logic.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Request } from "express";
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  resolveTimezone,
} from "../../../../src/utils/timezone.js";

/** Parsed time range. */
export interface TimeRange {
  start: Date;
  end: Date;
}

/** Parsed query filters from the request query string. */
export interface ParsedFilters {
  range: TimeRange;
  period: string;
  model?: string;
  project?: string;
  source?: string;
  /**
   * IANA timezone (validated) the user wants local-time math projected into.
   * Always populated — falls back to 'UTC' if config + header are both
   * missing/invalid. See ACT-001 / SEM2-293. Routes that do hour-of-day /
   * day-of-week / local-date / date-truncated math MUST pass this as an
   * additional bind parameter (typically `$3`) and use
   * `wrapTimestampForTz(col, '$3')` to project the column.
   */
  userTimezone: string;
}

/**
 * Path the dashboard's settings route writes to and the CLI's loader reads
 * from. Resolved on every read so a PUT /api/settings change takes effect on
 * the very next API call without a server restart, AND so tests can override
 * the path via `CCANALYTICS_CONFIG_PATH` at any time.
 */
function resolveConfigPath(): string {
  const override = process.env.CCANALYTICS_CONFIG_PATH;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".ccanalytics", "config.json");
}

/**
 * Best-effort sync read of `display.userTimezone` from the config file.
 * Returns `undefined` for any failure — ENOENT, parse error, missing key —
 * so the caller falls through to the header / DEFAULT_TIMEZONE path. Sync I/O
 * is acceptable here: the file is small (KB), the JSON parse is cheap, and
 * keeping parseFilters() sync matches the existing route ergonomics.
 */
function readUserTimezoneFromConfig(): string | undefined {
  try {
    const raw = fs.readFileSync(resolveConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as { display?: { userTimezone?: unknown } };
    const tz = parsed?.display?.userTimezone;
    if (isValidTimezone(tz)) return tz;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the userTimezone for a request. Precedence (highest first):
 *   1. `X-User-Timezone` request header (per-call override; lets a CLI/curl
 *      power-user pin a zone without touching config.json).
 *   2. `display.userTimezone` from ~/.ccanalytics/config.json.
 *   3. `DEFAULT_TIMEZONE` ('UTC').
 * Invalid input at any layer silently falls through to the next layer (so a
 * bogus header doesn't shadow a valid config). The result is always a known
 * IANA id — safe to inject as a bind parameter.
 */
function resolveRequestTimezone(req: Request): string {
  const headerRaw = req.header("x-user-timezone");
  if (isValidTimezone(headerRaw)) return headerRaw;
  const fromConfig = readUserTimezoneFromConfig();
  if (fromConfig) return fromConfig;
  return DEFAULT_TIMEZONE;
}

// Re-export the canonical IANA helpers so route files can validate user input
// without reaching across many path segments.
export { isValidTimezone, resolveTimezone, DEFAULT_TIMEZONE };

/**
 * Parse a period string into a TimeRange (inclusive start, exclusive end).
 *
 * Supported values: "today", "7d", "30d", "90d", "all".
 * Unknown values fall back to "7d".
 *
 * @param period - Period identifier
 * @returns TimeRange with start and end dates
 */
export function parsePeriod(period: string): TimeRange {
  const now = new Date();
  const end = now;
  let start: Date;

  switch (period) {
    case "today": {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    }
    case "7d": {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
    case "30d": {
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
    case "90d": {
      start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    }
    case "all": {
      start = new Date("2020-01-01");
      break;
    }
    default: {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
  }

  return { start, end };
}

/**
 * Parse filters from an Express request's query string.
 *
 * Reads: ?period=7d&model=X&project=Y
 * Reads header: X-User-Timezone (overrides config.json display.userTimezone).
 *
 * @param req - Express request object
 * @returns Parsed filters with time range and resolved userTimezone
 */
export function parseFilters(req: Request): ParsedFilters {
  const period = (req.query.period as string) || "7d";
  const range = parsePeriod(period);
  const model = req.query.model as string | undefined;
  const project = req.query.project as string | undefined;
  const source = req.query.source as string | undefined;
  const userTimezone = resolveRequestTimezone(req);

  return {
    range,
    period,
    model: model || undefined,
    project: project || undefined,
    source: source || undefined,
    userTimezone,
  };
}

/**
 * Build parameterized SQL filter clauses for conversation_turns queries.
 * Returns SQL fragments and bind parameters.
 *
 * @param filters - Parsed filters
 * @param startIndex - The next $N parameter index (1-based)
 * @returns Object with SQL clauses array and params array
 */
export function buildTurnFilterClauses(
  filters: ParsedFilters,
  startIndex: number,
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.model) {
    clauses.push(`AND model LIKE '%' || $${startIndex} || '%'`);
    params.push(filters.model);
    startIndex++;
  }
  if (filters.project) {
    clauses.push(
      `AND session_id IN (SELECT session_id FROM sessions WHERE project_path LIKE '%' || $${startIndex} || '%')`,
    );
    params.push(filters.project);
    startIndex++;
  }
  if (filters.source) {
    clauses.push(
      `AND session_id IN (SELECT session_id FROM sessions WHERE source_type = $${startIndex})`,
    );
    params.push(filters.source);
    startIndex++;
  }

  return { clauses, params };
}

/**
 * Build parameterized SQL filter clauses for sessions queries.
 *
 * @param filters - Parsed filters
 * @param startIndex - The next $N parameter index (1-based)
 * @param alias - Table alias (default: "s")
 * @returns Object with SQL clauses array and params array
 */
export function buildSessionFilterClauses(
  filters: ParsedFilters,
  startIndex: number,
  alias: string = "s",
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.model) {
    clauses.push(`AND ${alias}.model LIKE '%' || $${startIndex} || '%'`);
    params.push(filters.model);
    startIndex++;
  }
  if (filters.project) {
    clauses.push(`AND ${alias}.project_path LIKE '%' || $${startIndex} || '%'`);
    params.push(filters.project);
    startIndex++;
  }
  if (filters.source) {
    clauses.push(`AND ${alias}.source_type = $${startIndex}`);
    params.push(filters.source);
    startIndex++;
  }

  return { clauses, params };
}

/**
 * Build a standard JSON response envelope.
 *
 * @param data - Response payload
 * @param period - Period identifier that was queried
 * @returns Envelope with data and meta
 */
export function envelope(data: unknown, period: string) {
  return {
    data,
    meta: {
      period,
      timestamp: new Date().toISOString(),
    },
  };
}
