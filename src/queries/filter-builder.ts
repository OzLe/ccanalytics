/**
 * @module queries/filter-builder
 *
 * Builds dynamic SQL WHERE clause fragments from QueryFilters.
 * All filter values are passed as bind parameters to prevent injection.
 */

import type { QueryFilters } from "../types/index.js";

export interface FilterResult {
  /** SQL fragments to append with AND, e.g. ["AND ct.model LIKE ..."] */
  clauses: string[];
  /** Bind parameter values corresponding to the $N placeholders */
  params: unknown[];
}

/**
 * Build filter clauses for queries against conversation_turns (aliased as ct).
 * Model filters on ct.model; project filters via subquery on sessions.
 *
 * @param filters - Optional query filters
 * @param startIndex - The next $N parameter index (1-based)
 */
export function buildTurnFilters(
  filters: QueryFilters | undefined,
  startIndex: number,
): FilterResult {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!filters) return { clauses, params };

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
  }

  return { clauses, params };
}

/**
 * Build filter clauses for queries against sessions (aliased as s or standalone).
 *
 * @param filters - Optional query filters
 * @param startIndex - The next $N parameter index (1-based)
 * @param alias - Table alias prefix (default: "s")
 */
export function buildSessionFilters(
  filters: QueryFilters | undefined,
  startIndex: number,
  alias: string = "s",
): FilterResult {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!filters) return { clauses, params };

  if (filters.model) {
    clauses.push(`AND ${alias}.model LIKE '%' || $${startIndex} || '%'`);
    params.push(filters.model);
    startIndex++;
  }
  if (filters.project) {
    clauses.push(`AND ${alias}.project_path LIKE '%' || $${startIndex} || '%'`);
    params.push(filters.project);
  }

  return { clauses, params };
}
