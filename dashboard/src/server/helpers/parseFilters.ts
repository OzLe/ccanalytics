/**
 * @module server/helpers/parseFilters
 *
 * Parse query string filters into structured time ranges and filter values.
 * Mirrors the parent project's parsePeriod() and filter-builder logic.
 */

import type { Request } from "express";

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
}

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
 *
 * @param req - Express request object
 * @returns Parsed filters with time range
 */
export function parseFilters(req: Request): ParsedFilters {
  const period = (req.query.period as string) || "7d";
  const range = parsePeriod(period);
  const model = req.query.model as string | undefined;
  const project = req.query.project as string | undefined;

  return {
    range,
    period,
    model: model || undefined,
    project: project || undefined,
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
