/**
 * @module cli
 *
 * Main entry point for the ccanalytics CLI.
 * Builds the Commander program with global options and registers
 * all subcommands. This is the composition root that wires together
 * all other modules.
 */

import { Command } from "commander";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./utils/logger.js";
import { CCAnalyticsError, formatError } from "./errors.js";
import { registerIngestCommand } from "./commands/ingest.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerDashboardCommand } from "./commands/dashboard.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerExportCommand } from "./commands/export.js";
import { registerWebCommand } from "./commands/web.js";

/**
 * Build and return the configured Commander program.
 * Registers global options and all subcommands.
 *
 * @returns Configured Commander program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("ccanalytics")
    .description(
      "Local-first analytics for Claude Code sessions — cost tracking, cache efficiency, tool usage patterns",
    )
    .version("0.1.0")
    .option("--db <path>", "Path to DuckDB database file")
    .option("--claude-dir <path>", "Path to Claude data directory")
    .option(
      "--format <fmt>",
      "Output format: table, json, csv",
      "table",
    )
    .option("--verbose", "Enable verbose logging", false);

  // Register all subcommands
  registerIngestCommand(program);
  registerQueryCommand(program);
  registerWatchCommand(program);
  registerDashboardCommand(program);
  registerStatusCommand(program);
  registerExportCommand(program);
  registerWebCommand(program);

  return program;
}

/**
 * Parse argv and execute the matched command.
 * Resolves when the command completes or rejects on fatal error.
 *
 * @param argv - Process arguments (default: process.argv)
 */
export async function run(argv?: string[]): Promise<void> {
  const program = createProgram();

  // Install global error handlers
  process.on("uncaughtException", (error) => {
    const verbose = program.opts().verbose ?? false;
    if (error instanceof CCAnalyticsError) {
      process.stderr.write(formatError(error, verbose) + "\n");
      process.exit(error.exitCode);
    } else {
      process.stderr.write(`Error: [INTERNAL] ${error.message}\n`);
      if (verbose && error.stack) {
        process.stderr.write(error.stack + "\n");
      }
      process.exit(1);
    }
  });

  process.on("unhandledRejection", (reason) => {
    const error =
      reason instanceof Error ? reason : new Error(String(reason));
    const verbose = program.opts().verbose ?? false;
    process.stderr.write(
      `Error: [INTERNAL] Unhandled rejection: ${error.message}\n`,
    );
    if (verbose && error.stack) {
      process.stderr.write(error.stack + "\n");
    }
    process.exit(1);
  });

  await program.parseAsync(argv ?? process.argv);
}

// Entry point: run when invoked directly
run().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
