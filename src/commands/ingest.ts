/**
 * @module commands/ingest
 *
 * CLI command: `ccanalytics ingest`
 *
 * Parses JSONL session transcripts from configured data sources
 * and loads them into the DuckDB analytical store. Supports incremental
 * ingestion via byte-offset tracking per file.
 */

import { Command } from "commander";

/**
 * Register the `ingest` subcommand on the parent program.
 *
 * Flags:
 *   --incremental   Only ingest new bytes (default: true)
 *   --full          Force full re-ingestion, ignoring byte-offset state
 *   --project <n>   Restrict ingestion to a specific project
 *   --batch-size <n> Max rows per INSERT batch (default: 1000)
 *   --source <type> Data source: "claude-code", "claude-desktop", or "all" (default: "all")
 *
 * @param parent - The parent Commander program
 */
export function registerIngestCommand(parent: Command): void {
  parent
    .command("ingest")
    .description(
      "Parse JSONL session files and load into DuckDB analytical store",
    )
    .option(
      "--incremental",
      "Only ingest new bytes since last run (default)",
      true,
    )
    .option(
      "--full",
      "Force full re-ingestion, ignoring byte-offset state",
      false,
    )
    .option(
      "--project <name>",
      "Restrict ingestion to a specific project",
    )
    .option(
      "--batch-size <n>",
      "Max rows per INSERT batch",
      "1000",
    )
    .option(
      "--source <type>",
      'Data source: "claude-code", "claude-desktop", or "all"',
      "all",
    )
    .action(async (options) => {
      const { loadConfig } = await import("../config/index.js");
      const { ConnectionManager } = await import("../db/connection.js");
      const { IngestionPipeline } = await import("../ingestion/index.js");
      const { createAdapters } = await import("../ingestion/adapters/index.js");
      const { createLogger } = await import("../utils/logger.js");

      const globalOpts = parent.opts();
      const config = await loadConfig({
        cliOverrides: {
          dbPath: globalOpts.db,
          claudeDir: globalOpts.claudeDir,
          verbose: globalOpts.verbose,
          format: globalOpts.format,
        },
      });

      const logger = createLogger({ verbose: config.verbose, prefix: "ingest" });
      logger.info("Starting ingestion...");

      const { findClaudeDir, expandHome, ensureDir } = await import("../utils/paths.js");
      const { SchemaManager } = await import("../db/schema.js");
      const path = await import("node:path");

      let db: InstanceType<typeof ConnectionManager> | null = null;
      try {
        // Resolve Claude directory
        const claudeDir = await findClaudeDir(config.claudeDir);
        config.claudeDir = claudeDir;
        logger.debug(`Claude directory: ${claudeDir}`);

        // Expand and ensure DB path directory exists
        const dbPath = expandHome(config.dbPath);
        await ensureDir(path.dirname(dbPath));

        // Open database connection
        db = new ConnectionManager();
        await db.open(dbPath);
        logger.debug(`Database opened: ${dbPath}`);

        // Initialize schema (runs migrations if needed)
        const schema = new SchemaManager();
        await schema.initialize(db.getConnection());
        await schema.migrate(db.getConnection());
        logger.debug("Schema initialized");

        // Create adapters based on --source flag
        const sourceFilter = options.source === "all"
          ? undefined
          : (options.source as "claude-code" | "claude-desktop");
        const adapters = createAdapters(config, sourceFilter);

        logger.debug(`Active adapters: ${adapters.map(a => a.name).join(", ")}`);

        // Resolve backup directory (sibling to DB file)
        const backupDir = path.join(path.dirname(dbPath), "backups");
        await ensureDir(backupDir);
        logger.debug(`Backup directory: ${backupDir}`);

        // Create ingestion pipeline with adapters and backup
        const pipeline = new IngestionPipeline(adapters, db, { backupDir });

        // Set batch size from options
        if (options.batchSize) {
          config.ingestion.batchSize = parseInt(options.batchSize, 10);
        }

        // Run ingestion
        const startTime = Date.now();
        const result = await pipeline.run({ force: options.full });
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

        // Print summary
        console.log(`\nIngestion complete in ${durationSec}s`);
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

        // Close database
        await db.close();

        // Exit with appropriate code
        if (result.filesFailed > 0 && result.filesProcessed > 0) {
          process.exit(3); // Partial failure
        }
        process.exit(0);
      } catch (err) {
        logger.error(`Ingestion failed: ${err instanceof Error ? err.message : String(err)}`);
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
