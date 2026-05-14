/**
 * @module commands/ingest
 *
 * CLI command: `ccanalytics ingest`
 *
 * Thin wrapper around the shared `runIngestion()` orchestration. This command
 * only parses CLI flags, prints the human-readable summary, and sets process
 * exit codes — all of the actual ingestion logic lives in
 * `src/ingestion/run-ingestion.ts`, which the dashboard's `POST /api/ingest`
 * route also uses, so the CLI and the API can never drift apart.
 */

import { Command } from "commander";

/**
 * Register the `ingest` subcommand on the parent program.
 *
 * Flags:
 *   --incremental    Only ingest new bytes (default: true)
 *   --full           Force full re-ingestion, ignoring byte-offset state
 *   --project <n>    Restrict ingestion to a specific project
 *   --batch-size <n> Max rows per INSERT batch (default: 1000)
 *   --source <type>  Data source: "claude-code", "claude-desktop", or "all" (default: "all")
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
      const { runIngestion } = await import("../ingestion/run-ingestion.js");
      const { createLogger } = await import("../utils/logger.js");

      const globalOpts = parent.opts();
      const logger = createLogger({
        verbose: Boolean(globalOpts.verbose),
        prefix: "ingest",
      });
      logger.info("Starting ingestion...");

      try {
        const { result } = await runIngestion({
          configOverrides: {
            dbPath: globalOpts.db,
            claudeDir: globalOpts.claudeDir,
            verbose: globalOpts.verbose,
            format: globalOpts.format,
          },
          force: Boolean(options.full),
          source: options.source as "claude-code" | "claude-desktop" | "all",
          batchSize: options.batchSize
            ? parseInt(options.batchSize, 10)
            : undefined,
          logger,
        });

        // Print summary
        const durationSec = (result.durationMs / 1000).toFixed(1);
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

        // Exit with appropriate code
        if (result.filesFailed > 0 && result.filesProcessed > 0) {
          process.exit(3); // Partial failure
        }
        process.exit(0);
      } catch (err) {
        logger.error(
          `Ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });
}
