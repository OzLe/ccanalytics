/**
 * @module commands/export
 *
 * CLI command: `ccanalytics export`
 *
 * Exports data from the DuckDB analytical store to portable file formats.
 * Supports Parquet (with ZSTD compression), CSV, and JSON.
 */

import { Command } from "commander";

/**
 * Register the `export` subcommand on the parent program.
 *
 * Flags:
 *   --format <fmt>    Export format: parquet, csv, json (default: parquet)
 *   --output <path>   Output directory or file path
 *   --compress        Enable ZSTD compression for Parquet (default: true)
 *   --no-compress     Disable ZSTD compression
 *   --period <range>  Export only data within time range
 *   --table <name>    Export specific table(s), can be repeated
 *
 * @param parent - The parent Commander program
 */
export function registerExportCommand(parent: Command): void {
  parent
    .command("export")
    .description("Export analytics data to Parquet, CSV, or JSON")
    .option(
      "--format <fmt>",
      "Export format: parquet, csv, json",
      "parquet",
    )
    .option(
      "--output <path>",
      "Output directory or file path",
      "./ccanalytics-export/",
    )
    .option("--compress", "Enable ZSTD compression for Parquet", true)
    .option("--no-compress", "Disable compression")
    .option("--period <range>", "Time range filter", "all")
    .option(
      "--table <name>",
      "Export specific table (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .action(async (options) => {
      // TODO: Implement export command
      // 1. Load config
      // 2. Open DB connection
      // 3. Validate output path and create directories
      // 4. Determine tables to export (all or --table subset)
      // 5. For each table:
      //    a. Build COPY query with format and compression
      //    b. Execute COPY ... TO '...' (FORMAT PARQUET, CODEC 'ZSTD')
      //    c. Track row count and file size
      // 6. Print summary of exported files
      // 7. Close DB connection

      const { loadConfig } = await import("../config/index.js");
      const { ConnectionManager } = await import("../db/connection.js");
      const { SchemaManager } = await import("../db/schema.js");
      const { QueryExecutor } = await import("../db/executor.js");
      const { createLogger } = await import("../utils/logger.js");
      const { expandHome, ensureDir } = await import("../utils/paths.js");
      const pathMod = await import("node:path");
      const fs = await import("node:fs/promises");

      const globalOpts = parent.opts();
      const config = await loadConfig({
        cliOverrides: {
          dbPath: globalOpts.db,
          claudeDir: globalOpts.claudeDir,
          verbose: globalOpts.verbose,
        },
      });

      const logger = createLogger({ verbose: config.verbose, prefix: "export" });

      // Valid data tables for export
      const ALL_TABLES = ["sessions", "conversation_turns", "tool_calls", "errors"];

      // Determine which tables to export
      let tablesToExport: string[];
      if (options.table && options.table.length > 0) {
        // Validate specified table names
        for (const t of options.table) {
          if (!ALL_TABLES.includes(t)) {
            process.stderr.write(`Error: Invalid table name "${t}". Valid tables: ${ALL_TABLES.join(", ")}\n`);
            process.exit(1);
          }
        }
        tablesToExport = options.table;
      } else {
        tablesToExport = ALL_TABLES;
      }

      // Determine export format and file extension
      const exportFormat = options.format.toLowerCase();
      const validFormats = ["parquet", "csv", "json"];
      if (!validFormats.includes(exportFormat)) {
        process.stderr.write(`Error: Invalid format "${exportFormat}". Valid formats: ${validFormats.join(", ")}\n`);
        process.exit(1);
      }

      const extMap: Record<string, string> = {
        parquet: ".parquet",
        csv: ".csv",
        json: ".json",
      };
      const ext = extMap[exportFormat];

      let db: InstanceType<typeof ConnectionManager> | null = null;
      try {
        const dbPath = expandHome(config.dbPath);
        await ensureDir(pathMod.dirname(dbPath));

        db = new ConnectionManager();
        await db.open(dbPath);

        const schema = new SchemaManager();
        await schema.initialize(db.getConnection());

        const executor = new QueryExecutor(db.getConnection());

        // Create output directory
        const outputDir = pathMod.resolve(options.output);
        await fs.mkdir(outputDir, { recursive: true });

        const exportedFiles: Array<{ table: string; path: string; size: string }> = [];

        for (const table of tablesToExport) {
          const filePath = pathMod.join(outputDir, `${table}${ext}`);

          // Build COPY command based on format
          let copyCmd: string;
          if (exportFormat === "parquet") {
            const codec = options.compress ? "'ZSTD'" : "'UNCOMPRESSED'";
            copyCmd = `COPY (SELECT * FROM ${table}) TO '${filePath}' (FORMAT PARQUET, CODEC ${codec})`;
          } else if (exportFormat === "csv") {
            copyCmd = `COPY (SELECT * FROM ${table}) TO '${filePath}' (FORMAT CSV, HEADER)`;
          } else {
            // JSON
            copyCmd = `COPY (SELECT * FROM ${table}) TO '${filePath}' (FORMAT JSON)`;
          }

          logger.debug(`Exporting ${table} to ${filePath}`);
          await executor.run(copyCmd);

          // Get file size
          let sizeStr = "N/A";
          try {
            const stat = await fs.stat(filePath);
            const sizeKB = stat.size / 1024;
            if (sizeKB > 1024) {
              sizeStr = `${(sizeKB / 1024).toFixed(1)} MB`;
            } else {
              sizeStr = `${sizeKB.toFixed(1)} KB`;
            }
          } catch {
            // ignore
          }

          exportedFiles.push({ table, path: filePath, size: sizeStr });
        }

        // Print summary
        console.log(`\nExport complete (format: ${exportFormat})`);
        console.log(`Output directory: ${outputDir}\n`);
        for (const f of exportedFiles) {
          console.log(`  ${f.table.padEnd(22)} ${f.size.padStart(10)}  ${f.path}`);
        }
        console.log("");

        await db.close();
      } catch (err) {
        logger.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
