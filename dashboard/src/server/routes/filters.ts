/**
 * @module server/routes/filters
 *
 * Filter options API endpoints.
 * Returns available filter values (models, projects) for the UI dropdowns.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import {
  parseFilters,
  buildSessionFilterClauses,
  envelope,
} from "../helpers/parseFilters.js";

const router = Router();

/**
 * GET /api/filters/models
 *
 * Get distinct model names available in the data.
 * Cross-filtered by source and project when provided.
 * Query params: ?period=7d&source=X&project=Y
 */
router.get("/models", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildSessionFilterClauses(
      { ...filters, model: undefined },
      3,
      "s",
    );

    const sql = `
      SELECT DISTINCT s.model
      FROM sessions s
      WHERE s.model IS NOT NULL
        AND s.start_time >= $1 AND s.start_time < $2
        ${f.clauses.join("\n        ")}
      ORDER BY s.model ASC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const models = result.rows.map((row: Record<string, unknown>) => row.model as string);

    res.json(envelope(models, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/filters/projects
 *
 * Get distinct project paths available in the data.
 * Cross-filtered by source and model when provided.
 * Query params: ?period=7d&source=X&model=Y
 */
router.get("/projects", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildSessionFilterClauses(
      { ...filters, project: undefined },
      3,
      "s",
    );

    const sql = `
      SELECT s.project_path,
             COALESCE(MAX(s.project_name), s.project_path) AS project_name,
             COUNT(*) AS session_count,
             MAX(s.start_time) AS last_active
      FROM sessions s
      WHERE s.project_path IS NOT NULL
        AND s.start_time >= $1 AND s.start_time < $2
        ${f.clauses.join("\n        ")}
      GROUP BY s.project_path
      ORDER BY session_count DESC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const projects = result.rows.map((row: Record<string, unknown>) => ({
      projectPath: row.project_path as string,
      projectName: row.project_name as string,
      sessionCount: Number(row.session_count),
      lastActive: row.last_active
        ? new Date(row.last_active as string).toISOString()
        : null,
    }));

    res.json(envelope(projects, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/filters/sources
 *
 * Get distinct source types available in the data.
 * Cross-filtered by project and model when provided.
 * Query params: ?period=7d&project=Y&model=X
 */
router.get("/sources", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildSessionFilterClauses(
      { ...filters, source: undefined },
      3,
      "s",
    );

    const sql = `
      SELECT DISTINCT s.source_type,
             COUNT(*) AS session_count
      FROM sessions s
      WHERE s.source_type IS NOT NULL
        AND s.start_time >= $1 AND s.start_time < $2
        ${f.clauses.join("\n        ")}
      GROUP BY s.source_type
      ORDER BY session_count DESC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const sources = result.rows.map((row: Record<string, unknown>) => ({
      sourceType: row.source_type as string,
      sessionCount: Number(row.session_count),
    }));

    res.json(envelope(sources, filters.period));
  } catch (err) {
    next(err);
  }
});

export default router;
