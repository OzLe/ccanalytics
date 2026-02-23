/**
 * @module commands/dashboard
 *
 * CLI command: `ccanalytics dashboard`
 *
 * Launches an interactive terminal dashboard showing key analytics metrics.
 * Displays cost trends, cache efficiency, tool usage, and session activity.
 */

import { Command } from "commander";

/**
 * Register the `dashboard` subcommand on the parent program.
 *
 * Flags:
 *   --refresh <s>  Auto-refresh interval in seconds (default: 30, 0 = off)
 *   --compact      Compact single-column layout
 *   --period <r>   Default time range for panels (default: 7d)
 *
 * Keyboard shortcuts:
 *   r = refresh, q/Ctrl+C = quit, 1-4 = time period, c = toggle compact
 *
 * @param parent - The parent Commander program
 */
export function registerDashboardCommand(parent: Command): void {
  parent
    .command("dashboard")
    .description("Launch interactive terminal analytics dashboard")
    .option(
      "--refresh <seconds>",
      "Auto-refresh interval (0 = off)",
      "30",
    )
    .option("--compact", "Use compact single-column layout", false)
    .option("--period <range>", "Default time range", "7d")
    .action(async (options) => {
      // TODO: Implement dashboard command
      // 1. Load config
      // 2. Open DB connection
      // 3. Create all analyzers (Cost, Cache, Tool, Session, TimeSeries)
      // 4. Render initial dashboard panels
      // 5. Set up auto-refresh timer if --refresh > 0
      // 6. Set up keyboard event listener (raw mode)
      // 7. Handle r=refresh, q=quit, 1-4=period, c=compact
      // 8. Clean up on exit

      const { loadConfig } = await import("../config/index.js");
      const { ConnectionManager } = await import("../db/connection.js");
      const { SchemaManager } = await import("../db/schema.js");
      const { QueryExecutor } = await import("../db/executor.js");
      const { createLogger } = await import("../utils/logger.js");
      const { OutputFormatter } = await import("../utils/format.js");
      const { expandHome, ensureDir } = await import("../utils/paths.js");
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

      const logger = createLogger({ verbose: config.verbose, prefix: "dashboard" });

      // Parse period to TimeRange
      const parsePeriod = (period: string): { start: Date; end: Date } => {
        const now = new Date();
        const end = now;
        let start: Date;

        switch (period) {
          case "today": {
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            break;
          }
          case "7d": {
            start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
          }
          case "30d": {
            start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
          }
          case "90d": {
            start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            break;
          }
          case "all": {
            start = new Date("2020-01-01");
            break;
          }
          default: {
            start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
          }
        }

        return { start, end };
      };

      let db: InstanceType<typeof ConnectionManager> | null = null;
      try {
        const dbPath = expandHome(config.dbPath);
        await ensureDir(path.dirname(dbPath));

        db = new ConnectionManager();
        await db.open(dbPath);

        const schema = new SchemaManager();
        await schema.initialize(db.getConnection());

        const executor = new QueryExecutor(db.getConnection());
        const formatter = new OutputFormatter();

        const { CostAnalyzer, CacheAnalyzer, ToolAnalyzer, SessionAnalyzer } = await import("../queries/index.js");
        const costAnalyzer = new CostAnalyzer(executor);
        const cacheAnalyzer = new CacheAnalyzer(executor);
        const toolAnalyzer = new ToolAnalyzer(executor);
        const sessionAnalyzer = new SessionAnalyzer(executor);

        const range = parsePeriod(options.period);

        // Query data
        const [totalCost, cacheMetrics, sessionStats] = await Promise.all([
          costAnalyzer.getTotalCost(range),
          cacheAnalyzer.getCacheHitRate(range),
          sessionAnalyzer.getSessionStats(range),
        ]);

        let topTools: Awaited<ReturnType<typeof toolAnalyzer.getToolUsage>> = [];
        try {
          topTools = await toolAnalyzer.getToolUsage(range);
          topTools = topTools.slice(0, 5);
        } catch {
          // Tool usage query may not be implemented yet
        }

        // Build summary panel
        console.log("\n  ccanalytics dashboard");
        console.log("  " + "=".repeat(50));
        console.log(`  Period: ${options.period}\n`);

        // Cost Summary
        const costSummary = formatter.formatSummary([
          { label: "Total Cost", value: formatter.formatCost(totalCost.totalCostUSD) },
          { label: "Input Tokens", value: formatter.formatTokens(totalCost.totalInputTokens) },
          { label: "Output Tokens", value: formatter.formatTokens(totalCost.totalOutputTokens) },
          { label: "Cache Write Tokens", value: formatter.formatTokens(totalCost.totalCacheWriteTokens) },
          { label: "Cache Read Tokens", value: formatter.formatTokens(totalCost.totalCacheReadTokens) },
        ]);
        console.log("  Cost Summary");
        console.log(costSummary);
        console.log("");

        // Cache Efficiency
        const cacheSummary = formatter.formatSummary([
          { label: "Cache Hit Rate", value: formatter.formatPercent(cacheMetrics.cacheHitRate) },
          { label: "Interpretation", value: cacheMetrics.interpretation },
          { label: "Est. Savings", value: formatter.formatCost(cacheMetrics.estimatedSavingsUSD) },
        ]);
        console.log("  Cache Efficiency");
        console.log(cacheSummary);
        console.log("");

        // Session Stats
        const sessionSummary = formatter.formatSummary([
          { label: "Total Sessions", value: sessionStats.totalSessions },
          { label: "Total Turns", value: sessionStats.totalTurns },
          { label: "Avg Turns/Session", value: sessionStats.avgTurnsPerSession.toFixed(1) },
          { label: "Avg Duration", value: `${sessionStats.avgDurationMinutes.toFixed(1)} min` },
          { label: "Avg Cost/Session", value: formatter.formatCost(sessionStats.avgCostPerSession) },
          { label: "Models Used", value: sessionStats.uniqueModels.join(", ") || "none" },
        ]);
        console.log("  Session Stats");
        console.log(sessionSummary);
        console.log("");

        // Top Tools
        if (topTools.length > 0) {
          const toolEntries = topTools.map((t) => ({
            label: t.toolName,
            value: `${t.callCount} calls` as string | number,
          }));
          const toolSummary = formatter.formatSummary(toolEntries);
          console.log("  Top Tools (by call count)");
          console.log(toolSummary);
          console.log("");
        }

        await db.close();
      } catch (err) {
        logger.error(`Dashboard failed: ${err instanceof Error ? err.message : String(err)}`);
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
