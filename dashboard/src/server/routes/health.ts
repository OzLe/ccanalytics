/**
 * @module server/routes/health
 *
 * Health check endpoint.
 * Returns server status and database connectivity.
 */

import { Router } from "express";
import { query, getDbPathInfo } from "../helpers/db.js";

const router = Router();

/**
 * GET /api/health
 *
 * Returns server health status including database connectivity.
 */
router.get("/", async (_req, res) => {
  try {
    const start = performance.now();
    await query("SELECT 1 AS ok");
    const dbLatencyMs = Math.round(performance.now() - start);

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        path: getDbPathInfo(),
        latencyMs: dbLatencyMs,
      },
    });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      timestamp: new Date().toISOString(),
      database: {
        connected: false,
        path: getDbPathInfo(),
        error: err instanceof Error ? err.message : "Unknown error",
      },
    });
  }
});

export default router;
