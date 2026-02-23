/**
 * @module commands/status
 *
 * CLI command: `ccanalytics status`
 *
 * Displays the current state of the ccanalytics database and
 * ingestion pipeline. Shows DB stats, table row counts, last
 * ingestion time, and configuration details.
 */

import { Command } from "commander";

/**
 * Register the `status` subcommand on the parent program.
 * This command takes no subcommand-specific flags beyond global options.
 *
 * Output sections:
 *   - Database: path, size, DuckDB version, schema version
 *   - Tables: row counts for all 5 star schema tables
 *   - Ingestion: last run time, Claude dir, project count
 *   - Config: file path, log level, default format
 *
 * @param parent - The parent Commander program
 */
export function registerStatusCommand(parent: Command): void {
  parent
    .command("status")
    .description("Show database and ingestion pipeline status")
    .action(async () => {
      // TODO: Implement status command
      // 1. Load config
      // 2. Open DB connection
      // 3. Query table row counts:
      //    SELECT COUNT(*) FROM sessions
      //    SELECT COUNT(*) FROM conversation_turns
      //    SELECT COUNT(*) FROM tool_calls
      //    SELECT COUNT(*) FROM errors
      //    SELECT COUNT(*) FROM ingestion_state
      // 4. Query schema version from schema_migrations
      // 5. Query last ingestion time from ingestion_state
      // 6. Get DB file size from filesystem
      // 7. Format and print status summary
      // 8. Close DB connection

      const { loadConfig } = await import("../config/index.js");
      const { ConnectionManager } = await import("../db/connection.js");
      const { SchemaManager } = await import("../db/schema.js");
      const { QueryExecutor } = await import("../db/executor.js");
      const { createLogger } = await import("../utils/logger.js");
      const { expandHome, ensureDir } = await import("../utils/paths.js");
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

      const logger = createLogger({ verbose: config.verbose, prefix: "status" });

      let db: InstanceType<typeof ConnectionManager> | null = null;
      try {
        const dbPath = expandHome(config.dbPath);
        await ensureDir(path.dirname(dbPath));

        db = new ConnectionManager();
        await db.open(dbPath);

        const schema = new SchemaManager();
        await schema.initialize(db.getConnection());

        const executor = new QueryExecutor(db.getConnection());

        // Query row counts for all 5 tables
        const tableNames = ["sessions", "conversation_turns", "tool_calls", "errors", "ingestion_state"];
        const rowCounts: Record<string, number> = {};
        for (const table of tableNames) {
          const count = await executor.scalar<number>(`SELECT COUNT(*) AS cnt FROM ${table}`);
          rowCounts[table] = Number(count ?? 0);
        }

        // Query schema version
        const schemaVersion = await schema.getVersion(db.getConnection());

        // Query last ingestion time
        const lastIngestedAt = await executor.scalar<string>(
          `SELECT MAX(last_ingested_at) FROM ingestion_state`,
        );

        // Get DB file size
        let dbFileSize = "N/A";
        try {
          const stat = await fs.stat(dbPath);
          const sizeKB = stat.size / 1024;
          if (sizeKB > 1024) {
            dbFileSize = `${(sizeKB / 1024).toFixed(1)} MB`;
          } else {
            dbFileSize = `${sizeKB.toFixed(1)} KB`;
          }
        } catch {
          dbFileSize = "N/A";
        }

        // Print formatted status output
        console.log("\n  ccanalytics status");
        console.log("  " + "=".repeat(40));
        console.log("");
        console.log("  Database");
        console.log(`    Path:            ${dbPath}`);
        console.log(`    Size:            ${dbFileSize}`);
        console.log(`    Schema version:  ${schemaVersion}`);
        console.log("");
        console.log("  Tables");
        for (const table of tableNames) {
          const label = table.padEnd(22);
          console.log(`    ${label}${rowCounts[table].toLocaleString()} rows`);
        }
        console.log("");
        console.log("  Ingestion");
        console.log(`    Last run:        ${lastIngestedAt ?? "never"}`);
        console.log(`    Claude dir:      ${config.claudeDir}`);
        console.log("");
        console.log("  Config");
        console.log(`    Format:          ${config.format}`);
        console.log(`    Verbose:         ${config.verbose}`);
        console.log("");

        await db.close();
      } catch (err) {
        logger.error(`Status failed: ${err instanceof Error ? err.message : String(err)}`);
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
