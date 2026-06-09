/**
 * @module server/index
 *
 * Express API server for the ccanalytics web dashboard.
 * Serves analytics data from the DuckDB database at ~/.ccanalytics/analytics.duckdb.
 *
 * Usage:
 *   npm run server        # Start API server on port 3001
 *   PORT=3002 npm run server  # Custom port
 *
 * All routes are prefixed with /api/ and return JSON.
 */

import express from "express";
import cors from "cors";

import healthRoutes from "./routes/health.js";
import costRoutes from "./routes/cost.js";
import tokensRoutes from "./routes/tokens.js";
import sessionsRoutes from "./routes/sessions.js";
import toolsRoutes from "./routes/tools.js";
import skillsRoutes from "./routes/skills.js";
import cacheRoutes from "./routes/cache.js";
import activityRoutes from "./routes/activity.js";
import filtersRoutes from "./routes/filters.js";
import promptsRoutes from "./routes/prompts.js";
import settingsRoutes from "./routes/settings.js";
import recommendationRoutes from "./routes/recommendation.js";
import ingestRoutes from "./routes/ingest.js";
import { closeDb } from "./helpers/db.js";

/**
 * Create and configure the Express application.
 * Mounts all route files and adds error handling middleware.
 */
function createApp(): express.Application {
  const app = express();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------
  app.use(
    cors({
      origin: true,
      credentials: true,
    }),
  );
  app.use(express.json());

  // Request logging (lightweight)
  app.use((req, _res, next) => {
    const start = Date.now();
    _res.on("finish", () => {
      const duration = Date.now() - start;
      if (req.path.startsWith("/api/")) {
        console.log(
          `${req.method} ${req.path} ${_res.statusCode} ${duration}ms`,
        );
      }
    });
    next();
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  app.use("/api/health", healthRoutes);
  app.use("/api/cost", costRoutes);
  app.use("/api/tokens", tokensRoutes);
  app.use("/api/sessions", sessionsRoutes);
  app.use("/api/tools", toolsRoutes);
  app.use("/api/skills", skillsRoutes);
  app.use("/api/cache", cacheRoutes);
  app.use("/api/activity", activityRoutes);
  app.use("/api/filters", filtersRoutes);
  app.use("/api/prompts", promptsRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/recommendation", recommendationRoutes);
  app.use("/api/ingest", ingestRoutes);

  // ---------------------------------------------------------------------------
  // 404 handler for unmatched /api routes
  // ---------------------------------------------------------------------------
  app.use("/api/*", (req, res) => {
    res.status(404).json({
      error: "Not found",
      path: req.originalUrl,
    });
  });

  // ---------------------------------------------------------------------------
  // Global error handler
  // ---------------------------------------------------------------------------
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("Unhandled error:", err.message);
      if (process.env.NODE_ENV !== "production") {
        console.error(err.stack);
      }

      // DuckDB connection errors
      if (err.message?.includes("Failed to connect") || err.message?.includes("Not connected")) {
        return res.status(503).json({
          error: "Database unavailable",
          message: err.message,
        });
      }

      // Query execution errors
      if (err.message?.includes("Failed to execute")) {
        return res.status(500).json({
          error: "Query execution failed",
          message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
        });
      }

      res.status(500).json({
        error: "Internal server error",
        message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
      });
    },
  );

  return app;
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`ccanalytics API server running on http://localhost:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET /api/health`);
  console.log(`  GET /api/cost/total`);
  console.log(`  GET /api/cost/daily`);
  console.log(`  GET /api/cost/by-model`);
  console.log(`  GET /api/cost/by-project`);
  console.log(`  GET /api/cost/trend`);
  console.log(`  GET /api/tokens/total`);
  console.log(`  GET /api/sessions`);
  console.log(`  GET /api/sessions/stats`);
  console.log(`  GET /api/sessions/context-pressure`);
  console.log(`  GET /api/sessions/:id`);
  console.log(`  GET /api/tools/usage`);
  console.log(`  GET /api/tools/success-rates`);
  console.log(`  GET /api/tools/failure-trend`);
  console.log(`  GET /api/tools/failure-chains`);
  console.log(`  GET /api/tools/mcp-servers`);
  console.log(`  GET /api/tools/chains`);
  console.log(`  GET /api/skills/summary`);
  console.log(`  GET /api/skills/loaded`);
  console.log(`  GET /api/skills/invocations`);
  console.log(`  GET /api/skills/trend`);
  console.log(`  GET /api/skills/not-required`);
  console.log(`  GET /api/cache/metrics`);
  console.log(`  GET /api/cache/trend`);
  console.log(`  GET /api/activity/hourly`);
  console.log(`  GET /api/activity/daily`);
  console.log(`  GET /api/activity/heatmap`);
  console.log(`  GET /api/filters/models`);
  console.log(`  GET /api/filters/projects`);
  console.log(`  GET /api/prompts/ranked`);
  console.log(`  GET /api/prompts/stats`);
  console.log(`  GET /api/prompts/throughput`);
  console.log(`  GET /api/prompts/:turnId`);
  console.log(`  GET /api/settings`);
  console.log(`  PUT /api/settings`);
  console.log(`  GET /api/recommendation`);
  console.log(`  POST /api/ingest`);
});

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  server.close(async () => {
    await closeDb();
    console.log("Server closed.");
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => {
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { createApp };
