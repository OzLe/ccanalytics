/**
 * @module commands/watch
 *
 * CLI command: `ccanalytics watch`
 *
 * Starts a long-running file watcher that monitors the Claude data directory
 * for new or modified JSONL files. Triggers incremental ingestion on changes.
 */

import { Command } from "commander";

/**
 * Register the `watch` subcommand on the parent program.
 *
 * Flags:
 *   --interval <ms>  Polling interval / awaitWriteFinish threshold (default: 2000)
 *
 * @param parent - The parent Commander program
 */
export function registerWatchCommand(parent: Command): void {
  parent
    .command("watch")
    .description(
      "Watch for JSONL file changes and auto-ingest incrementally",
    )
    .option(
      "--interval <ms>",
      "Polling interval and stability threshold in ms",
      "2000",
    )
    .action(async (options) => {
      const { loadConfig } = await import("../config/index.js");
      const { ConnectionManager } = await import("../db/connection.js");
      const { SchemaManager } = await import("../db/schema.js");
      const { IngestionPipeline } = await import("../ingestion/index.js");
      const { createAdapters } = await import("../ingestion/adapters/index.js");
      const { Watcher } = await import("../watcher/index.js");
      const { createLogger } = await import("../utils/logger.js");
      const { findClaudeDir, expandHome, ensureDir } = await import("../utils/paths.js");
      const path = await import("node:path");

      const globalOpts = parent.opts();
      const config = await loadConfig({
        cliOverrides: {
          dbPath: globalOpts.db,
          claudeDir: globalOpts.claudeDir,
          verbose: globalOpts.verbose,
          format: globalOpts.format,
        },
      });

      const logger = createLogger({ verbose: config.verbose, prefix: "watch" });
      logger.info("Starting file watcher...");

      let db: InstanceType<typeof ConnectionManager> | null = null;
      let watcher: InstanceType<typeof Watcher> | null = null;

      try {
        // Resolve Claude directory
        const claudeDir = await findClaudeDir(config.claudeDir);
        config.claudeDir = claudeDir;

        // Update watcher patterns to use resolved Claude dir
        if (options.interval) {
          const interval = parseInt(options.interval, 10);
          config.watcher.stabilityThreshold = interval;
          config.watcher.pollInterval = interval;
        }

        // Expand and ensure DB path directory exists
        const dbPath = expandHome(config.dbPath);
        await ensureDir(path.dirname(dbPath));

        // Open database connection
        db = new ConnectionManager();
        await db.open(dbPath);

        // Initialize schema (runs migrations if needed)
        const schema = new SchemaManager();
        await schema.initialize(db.getConnection());
        await schema.migrate(db.getConnection());

        // Create adapters and pipeline
        const adapters = createAdapters(config);
        const pipeline = new IngestionPipeline(adapters, db);

        // Create watcher
        watcher = new Watcher(config.watcher, pipeline);

        // Register event handler for logging
        watcher.onEvent((event) => {
          logger.info(`[${event.type}] ${event.filePath}`);
        });

        // Start watcher
        await watcher.start();

        const status = watcher.getStatus();
        logger.info(`Watching ${status.watchedFiles} files for changes...`);
        logger.info("Press Ctrl+C to stop.");

        // Register graceful shutdown
        const shutdown = async () => {
          logger.info("Shutting down...");
          if (watcher) {
            await watcher.stop();
          }
          if (db) {
            await db.close();
          }
          process.exit(0);
        };

        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());

        // Keep the process alive
        await new Promise(() => {
          // This promise never resolves; process stays alive until signal
        });
      } catch (err) {
        logger.error(`Watch failed: ${err instanceof Error ? err.message : String(err)}`);
        if (watcher) {
          await watcher.stop();
        }
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
