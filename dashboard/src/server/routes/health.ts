/**
 * @module server/routes/health
 *
 * Health check endpoint.
 * Returns server status and database connectivity.
 */

import { Router } from "express";
import { query, getDbPathInfo } from "../helpers/db.js";
import {
  MODEL_USAGE_SQL,
  findUnpricedModels,
  type UnpricedModel,
} from "../../../../src/db/unpriced-models.js";

const router = Router();

/** Models costed at fallback rates; empty while the tables do not exist yet. */
async function listUnpricedModels(): Promise<UnpricedModel[]> {
  try {
    return findUnpricedModels((await query(MODEL_USAGE_SQL)).rows);
  } catch {
    return [];
  }
}

/**
 * GET /api/health
 *
 * Returns server health status including database connectivity and the
 * models that have no pricing entry (src/db/unpriced-models).
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
      pricing: { unpricedModels: await listUnpricedModels() },
    });
  } catch (err) {
    // A DatabaseOpenError (src/db/open-failure) also says why and what to do.
    const { reason, hint } = err as { reason?: string; hint?: string };
    res.status(503).json({
      status: "degraded",
      timestamp: new Date().toISOString(),
      database: {
        connected: false,
        path: getDbPathInfo(),
        error: err instanceof Error ? err.message : "Unknown error",
        ...(reason ? { reason } : {}),
        ...(hint ? { hint } : {}),
      },
    });
  }
});

export default router;
