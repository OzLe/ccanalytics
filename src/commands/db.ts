/**
 * @module commands/db
 *
 * CLI command group: `ccanalytics db`
 *
 *   recover  Back up a database that will not open, set a damaged
 *            write-ahead log aside, and list the backups to restore from.
 *            Never deletes a file (see db/recover).
 */

import { Command } from "commander";

/**
 * Register the `db` command group on the parent program.
 *
 * @param parent - The parent Commander program
 */
export function registerDbCommand(parent: Command): void {
  const db = parent.command("db").description("Database maintenance");

  db.command("recover")
    .description(
      "Back up a database that will not open, set a damaged write-ahead log aside, and list backups to restore",
    )
    .action(async () => {
      const { loadConfig } = await import("../config/index.js");
      const { expandHome } = await import("../utils/paths.js");
      const { recoverDatabase, describeRecoverOutcome } = await import(
        "../db/recover.js"
      );

      const globalOpts = parent.opts();
      const config = await loadConfig({
        cliOverrides: {
          dbPath: globalOpts.db,
          claudeDir: globalOpts.claudeDir,
          verbose: globalOpts.verbose,
          format: globalOpts.format,
        },
      });

      const outcome = await recoverDatabase(expandHome(config.dbPath));
      const { lines, exitCode } = describeRecoverOutcome(outcome);
      console.log(lines.join("\n"));
      process.exitCode = exitCode;
    });
}
