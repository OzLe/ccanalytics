/**
 * @module commands/dashboard
 *
 * CLI command: `ccanalytics dashboard`
 *
 * Launches an interactive terminal dashboard showing key analytics metrics.
 * Displays cost trends, cache efficiency, tool usage, and session activity.
 *
 * Keyboard shortcuts:
 *   r = refresh, q/Ctrl+C = quit, 1-4 = time period, c = toggle compact
 */

import { Command } from "commander";

const PERIOD_KEYS: Record<string, string> = {
  "1": "today",
  "2": "7d",
  "3": "30d",
  "4": "all",
};

/**
 * Register the `dashboard` subcommand on the parent program.
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
      const { loadConfig } = await import("../config/index.js");
      const { ConnectionManager } = await import("../db/connection.js");
      const { SchemaManager } = await import("../db/schema.js");
      const { QueryExecutor } = await import("../db/executor.js");
      const { createLogger } = await import("../utils/logger.js");
      const { OutputFormatter } = await import("../utils/format.js");
      const { expandHome, ensureDir } = await import("../utils/paths.js");
      const { parsePeriod } = await import("../utils/time.js");
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

      let db: InstanceType<typeof ConnectionManager> | null = null;
      let refreshTimer: ReturnType<typeof setInterval> | null = null;
      let rendering = false;

      // Mutable state
      let currentPeriod = options.period as string;
      let compact = options.compact as boolean;

      function cleanup() {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        // Restore terminal
        if (process.stdin.isTTY && process.stdin.isRaw) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
      }

      async function shutdown() {
        cleanup();
        if (db) {
          await db.close();
          db = null;
        }
        process.exit(0);
      }

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

        // Render the dashboard
        async function render() {
          if (rendering) return;
          rendering = true;

          try {
            const range = parsePeriod(currentPeriod);

            // Clear screen and move cursor to top-left
            process.stdout.write("\x1b[2J\x1b[H");

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
              // Tool usage query may fail
            }

            let costTrend: Awaited<ReturnType<typeof costAnalyzer.getCostTrend>> = [];
            try {
              costTrend = await costAnalyzer.getCostTrend(range, "day");
            } catch {
              // May fail on empty DB
            }

            // Header
            const periodLabel = currentPeriod === "today" ? "Today" : currentPeriod;
            process.stdout.write(`\n  ccanalytics dashboard\n`);
            process.stdout.write(`  ${"=".repeat(50)}\n`);
            process.stdout.write(`  Period: ${periodLabel}${compact ? " (compact)" : ""}\n\n`);

            // Cost Summary
            const costSummary = formatter.formatSummary([
              { label: "Total Cost", value: formatter.formatCost(totalCost.totalCostUSD) },
              { label: "Input Tokens", value: formatter.formatTokens(totalCost.totalInputTokens) },
              { label: "Output Tokens", value: formatter.formatTokens(totalCost.totalOutputTokens) },
              ...(compact ? [] : [
                { label: "Cache Write Tokens", value: formatter.formatTokens(totalCost.totalCacheWriteTokens) },
                { label: "Cache Read Tokens", value: formatter.formatTokens(totalCost.totalCacheReadTokens) },
              ]),
            ]);
            process.stdout.write("  Cost Summary\n");
            process.stdout.write(costSummary + "\n\n");

            // Cache Efficiency
            const cacheSummary = formatter.formatSummary([
              { label: "Cache Hit Rate", value: formatter.formatPercent(cacheMetrics.cacheHitRate) },
              { label: "Interpretation", value: cacheMetrics.interpretation },
              { label: "Est. Savings", value: formatter.formatCost(cacheMetrics.estimatedSavingsUSD) },
            ]);
            process.stdout.write("  Cache Efficiency\n");
            process.stdout.write(cacheSummary + "\n\n");

            // Session Stats
            const sessionEntries: Array<{ label: string; value: string | number }> = [
              { label: "Total Sessions", value: sessionStats.totalSessions },
              { label: "Total Turns", value: sessionStats.totalTurns },
              { label: "Avg Turns/Session", value: sessionStats.avgTurnsPerSession.toFixed(1) },
            ];
            if (!compact) {
              sessionEntries.push(
                { label: "Avg Duration", value: `${sessionStats.avgDurationMinutes.toFixed(1)} min` },
                { label: "Avg Cost/Session", value: formatter.formatCost(sessionStats.avgCostPerSession) },
                { label: "Models Used", value: sessionStats.uniqueModels.join(", ") || "none" },
              );
            }
            const sessionSummary = formatter.formatSummary(sessionEntries);
            process.stdout.write("  Session Stats\n");
            process.stdout.write(sessionSummary + "\n\n");

            // Top Tools
            if (topTools.length > 0) {
              const toolEntries = topTools.map((t) => ({
                label: t.toolName,
                value: `${t.callCount} calls` as string | number,
              }));
              const toolSummary = formatter.formatSummary(toolEntries);
              process.stdout.write("  Top Tools (by call count)\n");
              process.stdout.write(toolSummary + "\n\n");
            }

            // Daily Cost Trend
            if (costTrend.length > 0) {
              const trendEntries = costTrend.slice(-7).map((pt) => ({
                label: pt.timestamp.toISOString().slice(0, 10),
                value: formatter.formatCost(pt.costUSD) as string | number,
              }));
              const trendSummary = formatter.formatSummary(trendEntries);
              process.stdout.write("  Daily Cost Trend\n");
              process.stdout.write(trendSummary + "\n\n");
            }

            // Footer with keyboard shortcuts
            process.stdout.write("  " + "-".repeat(50) + "\n");
            process.stdout.write("  [r] Refresh  [1] Today  [2] 7d  [3] 30d  [4] All  [c] Compact  [q] Quit\n");
          } catch (err) {
            process.stdout.write(`\n  Error rendering dashboard: ${err instanceof Error ? err.message : String(err)}\n`);
          } finally {
            rendering = false;
          }
        }

        // Initial render
        await render();

        // Only set up interactive mode if we're attached to a TTY
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.setEncoding("utf8");

          process.stdin.on("data", async (key: string) => {
            // Ctrl+C
            if (key === "\x03") {
              await shutdown();
              return;
            }

            switch (key) {
              case "q":
                await shutdown();
                break;
              case "r":
                await render();
                break;
              case "c":
                compact = !compact;
                await render();
                break;
              case "1":
              case "2":
              case "3":
              case "4": {
                currentPeriod = PERIOD_KEYS[key]!;
                await render();
                break;
              }
            }
          });

          // Auto-refresh timer
          const refreshSeconds = parseInt(options.refresh, 10) || 0;
          if (refreshSeconds > 0) {
            refreshTimer = setInterval(() => {
              render().catch(() => {});
            }, refreshSeconds * 1000);
          }

          // Handle SIGINT/SIGTERM gracefully
          process.on("SIGINT", () => { shutdown(); });
          process.on("SIGTERM", () => { shutdown(); });
        } else {
          // Non-TTY mode: render once and exit
          if (db) {
            await db.close();
            db = null;
          }
        }
      } catch (err) {
        cleanup();
        logger.error(`Dashboard failed: ${err instanceof Error ? err.message : String(err)}`);
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
