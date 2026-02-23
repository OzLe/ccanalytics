/**
 * @module server/routes/filters
 *
 * Filter options API endpoints.
 * Returns available filter values (models, projects) for the UI dropdowns.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import { parseFilters, envelope } from "../helpers/parseFilters.js";

const router = Router();

/**
 * GET /api/filters/models
 *
 * Get distinct model names available in the data.
 * Query params: ?period=7d
 */
router.get("/models", async (req, res, next) => {
  try {
    const filters = parseFilters(req);

    const sql = `
      SELECT DISTINCT model
      FROM sessions
      WHERE model IS NOT NULL
        AND start_time >= $1 AND start_time < $2
      ORDER BY model ASC
    `;

    const result = await query(sql, [filters.range.start, filters.range.end]);

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
 * Query params: ?period=7d
 */
router.get("/projects", async (req, res, next) => {
  try {
    const filters = parseFilters(req);

    const sql = `
      SELECT DISTINCT project_path,
             COUNT(*) AS session_count,
             MAX(start_time) AS last_active
      FROM sessions
      WHERE project_path IS NOT NULL
        AND start_time >= $1 AND start_time < $2
      GROUP BY project_path
      ORDER BY session_count DESC
    `;

    const result = await query(sql, [filters.range.start, filters.range.end]);

    const projects = result.rows.map((row: Record<string, unknown>) => ({
      projectPath: row.project_path as string,
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

export default router;
