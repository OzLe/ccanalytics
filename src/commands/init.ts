/**
 * @module commands/init
 *
 * CLI command: `ccanalytics init`
 *
 * Resets the DuckDB database by deleting the existing file,
 * recreating it with a fresh schema, and running a full ingestion.
 * Useful when the database becomes corrupted or needs a clean slate.
 */

import { Command } from "commander";

/**
 * Register the `init` subcommand on the parent program.
 *
 * @param parent - The parent Commander program
 */
export function registerInitCommand(parent: Command): void {
  parent
    .command("init")
    .description(
      "Reset database and run full ingestion from scratch",
    )
    .action(async () => {
      const { loadConfig } = await import("../config/index.js");
      const { ConnectionManager } = await import("../db/connection.js");
      const { IngestionPipeline } = await import("../ingestion/index.js");
      const { createAdapters } = await import("../ingestion/adapters/index.js");
      const { createLogger } = await import("../utils/logger.js");
      const { findClaudeDir, expandHome, ensureDir } = await import("../utils/paths.js");
      const { SchemaManager } = await import("../db/schema.js");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");

      const globalOpts = parent.opts();
      const config = await loadConfig({
        cliOverrides: {
          dbPath: globalOpts.db,
          claudeDir: globalOpts.claudeDir,
          verbose: globalOpts.verbose,
          format: globalOpts.format,
        },
      });

      const logger = createLogger({ verbose: config.verbose, prefix: "init" });

      let db: InstanceType<typeof ConnectionManager> | null = null;
      try {
        // Resolve Claude directory
        const claudeDir = await findClaudeDir(config.claudeDir);
        config.claudeDir = claudeDir;
        logger.debug(`Claude directory: ${claudeDir}`);

        // Expand and ensure DB path directory exists
        const dbPath = expandHome(config.dbPath);
        await ensureDir(path.dirname(dbPath));

        // Delete existing database file if it exists
        try {
          await fs.unlink(dbPath);
          logger.info(`Removed existing database: ${dbPath}`);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
          logger.debug("No existing database file to remove");
        }

        // Open fresh database connection (creates new file)
        db = new ConnectionManager();
        await db.open(dbPath);
        logger.debug(`Database created: ${dbPath}`);

        // Initialize schema
        const schema = new SchemaManager();
        await schema.initialize(db.getConnection());
        await schema.migrate(db.getConnection());
        logger.debug("Schema initialized");

        // Create adapters and run full ingestion with backup
        const backupDir = path.join(path.dirname(dbPath), "backups");
        await ensureDir(backupDir);
        const adapters = createAdapters(config);
        logger.debug(`Active adapters: ${adapters.map(a => a.name).join(", ")}`);

        const pipeline = new IngestionPipeline(adapters, db, { backupDir });

        const startTime = Date.now();
        const result = await pipeline.run({ force: true });
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

        // Print summary
        console.log(`\nInit complete in ${durationSec}s`);
        console.log(`  Files discovered:  ${result.filesDiscovered}`);
        console.log(`  Files processed:   ${result.filesProcessed}`);
        console.log(`  Files skipped:     ${result.filesSkipped}`);
        console.log(`  Files failed:      ${result.filesFailed}`);
        console.log(`  Entries ingested:  ${result.entriesIngested}`);
        console.log(`  Duplicates:        ${result.duplicatesRemoved}`);
        console.log(`  Parse errors:      ${result.parseErrors}`);

        if (result.failedFiles.length > 0) {
          console.log(`\nFailed files:`);
          for (const f of result.failedFiles) {
            console.log(`  ${f.path}: ${f.error}`);
          }
        }

        await db.close();
        process.exit(0);
      } catch (err) {
        logger.error(`Init failed: ${err instanceof Error ? err.message : String(err)}`);
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
