/**
 * @module commands/query
 *
 * CLI command: `ccanalytics query <type>`
 *
 * Runs pre-built analytical queries against the DuckDB store.
 * Available types: cost, sessions, tools, cache, activity
 */

import { Command } from "commander";

/** Valid query type arguments. */
const VALID_QUERY_TYPES = [
  "cost",
  "sessions",
  "tools",
  "cache",
  "activity",
] as const;

type QueryType = (typeof VALID_QUERY_TYPES)[number];

/**
 * Register the `query` subcommand on the parent program.
 *
 * Usage: ccanalytics query <cost|sessions|tools|cache|activity> [options]
 *
 * Flags:
 *   --period <range>   Time range: today, 7d, 30d, 90d, all (default: 7d)
 *   --model <name>     Filter by model name (supports partial match)
 *   --project <name>   Filter by project
 *   --format <fmt>     Output format: table, json, csv
 *   --sort <field>     Sort field (type-dependent)
 *   --limit <n>        Maximum rows (default: 25)
 *   --desc / --no-desc Sort order (default: --desc)
 *
 * @param parent - The parent Commander program
 */
export function registerQueryCommand(parent: Command): void {
  parent
    .command("query")
    .argument(
      "<type>",
      `Query type: ${VALID_QUERY_TYPES.join(", ")}`,
    )
    .description("Run analytical queries against the DuckDB store")
    .option("--period <range>", "Time range filter", "7d")
    .option("--model <name>", "Filter by model name")
    .option("--project <name>", "Filter by project")
    .option("--format <fmt>", "Output format: table, json, csv")
    .option("--sort <field>", "Sort field")
    .option("--limit <n>", "Maximum rows to return", "25")
    .option("--desc", "Sort descending (default)", true)
    .option("--no-desc", "Sort ascending")
    .action(async (type: string, options) => {
      // TODO: Implement query command
      // 1. Validate query type
      // 2. Load config with CLI overrides
      // 3. Open DB connection
      // 4. Create appropriate analyzer based on type
      // 5. Execute query with options
      // 6. Format and print results
      // 7. Close DB connection

      if (!VALID_QUERY_TYPES.includes(type as QueryType)) {
        process.stderr.write(
          `Error: Invalid query type "${type}". Valid types: ${VALID_QUERY_TYPES.join(", ")}\n`,
        );
        process.exit(1);
      }

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

      const logger = createLogger({ verbose: config.verbose, prefix: "query" });

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
        const format = (options.format ?? config.format ?? "table") as "table" | "json" | "csv";
        const range = parsePeriod(options.period);
        const limit = parseInt(options.limit, 10) || 25;
        const queryType = type as QueryType;

        type ColumnDef = import("../utils/format.js").TableColumn;

        if (queryType === "cost") {
          const { CostAnalyzer } = await import("../queries/index.js");
          const analyzer = new CostAnalyzer(executor);
          const results = await analyzer.getDailyCosts(range);
          const limited = results.slice(0, limit);

          const columns: ColumnDef[] = [
            { header: "Date", key: "date" },
            { header: "Model", key: "model", maxWidth: 30 },
            { header: "Cost", key: "totalCost", align: "right", format: (v) => `$${Number(v).toFixed(2)}` },
            { header: "Input Tokens", key: "inputTokens", align: "right", format: (v) => Number(v).toLocaleString() },
            { header: "Output Tokens", key: "outputTokens", align: "right", format: (v) => Number(v).toLocaleString() },
            { header: "Cache Read", key: "cacheReadTokens", align: "right", format: (v) => Number(v).toLocaleString() },
            { header: "Turns", key: "turnCount", align: "right" },
            { header: "Sessions", key: "sessionCount", align: "right" },
          ];

          const output = formatter.auto(limited as unknown as Record<string, unknown>[], columns, format);
          console.log(output);
        } else if (queryType === "sessions") {
          const { SessionAnalyzer } = await import("../queries/index.js");
          const analyzer = new SessionAnalyzer(executor);
          const results = await analyzer.getSessions({
            range,
            sortBy: (options.sort as "start_time" | "cost" | "turns" | "duration") ?? "start_time",
            order: options.desc ? "desc" : "asc",
            limit,
          });

          const columns: ColumnDef[] = [
            { header: "Session ID", key: "sessionId", maxWidth: 20 },
            { header: "Start Time", key: "startTime", format: (v) => v instanceof Date ? v.toLocaleString() : String(v) },
            { header: "Duration (min)", key: "durationMinutes", align: "right", format: (v) => Number(v).toFixed(1) },
            { header: "Model", key: "model", maxWidth: 25 },
            { header: "Cost", key: "totalCostUSD", align: "right", format: (v) => `$${Number(v).toFixed(2)}` },
            { header: "Turns", key: "numTurns", align: "right" },
            { header: "Tool Calls", key: "numToolCalls", align: "right" },
            { header: "Cache Hit %", key: "cacheHitRate", align: "right", format: (v) => `${(Number(v) * 100).toFixed(1)}%` },
          ];

          const output = formatter.auto(results as unknown as Record<string, unknown>[], columns, format);
          console.log(output);
        } else if (queryType === "tools") {
          const { ToolAnalyzer } = await import("../queries/index.js");
          const analyzer = new ToolAnalyzer(executor);
          const results = await analyzer.getToolUsage(range);
          const limited = results.slice(0, limit);

          const columns: ColumnDef[] = [
            { header: "Tool Name", key: "toolName", maxWidth: 35 },
            { header: "Type", key: "toolType" },
            { header: "MCP Server", key: "mcpServer", format: (v) => v ? String(v) : "-" },
            { header: "Calls", key: "callCount", align: "right" },
            { header: "Success Rate", key: "successRate", align: "right", format: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : "N/A" },
            { header: "Avg Duration", key: "avgDurationMs", align: "right", format: (v) => v != null ? `${Number(v).toFixed(0)}ms` : "N/A" },
            { header: "Sessions", key: "sessionsUsingTool", align: "right" },
          ];

          const output = formatter.auto(limited as unknown as Record<string, unknown>[], columns, format);
          console.log(output);
        } else if (queryType === "cache") {
          const { CacheAnalyzer } = await import("../queries/index.js");
          const analyzer = new CacheAnalyzer(executor);
          const results = await analyzer.getCacheTrend(range);
          const limited = results.slice(0, limit);

          const columns: ColumnDef[] = [
            { header: "Date", key: "timestamp", format: (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v) },
            { header: "Hit Rate", key: "cacheHitRate", align: "right", format: (v) => `${(Number(v) * 100).toFixed(1)}%` },
            { header: "Cache Read", key: "cacheReadTokens", align: "right", format: (v) => Number(v).toLocaleString() },
            { header: "Cache Write", key: "cacheWriteTokens", align: "right", format: (v) => Number(v).toLocaleString() },
          ];

          const output = formatter.auto(limited as unknown as Record<string, unknown>[], columns, format);
          console.log(output);
        } else if (queryType === "activity") {
          const { TimeSeriesAnalyzer } = await import("../queries/index.js");
          const analyzer = new TimeSeriesAnalyzer(executor);
          const results = await analyzer.getHourlyActivity(range);

          const columns: ColumnDef[] = [
            { header: "Hour", key: "hourOfDay", format: (v) => `${String(v).padStart(2, "0")}:00` },
            { header: "Messages", key: "messageCount", align: "right" },
            { header: "Sessions", key: "sessionCount", align: "right" },
            { header: "Avg Cost", key: "avgCost", align: "right", format: (v) => `$${Number(v).toFixed(4)}` },
            { header: "Total Tokens", key: "totalTokens", align: "right", format: (v) => Number(v).toLocaleString() },
            { header: "Total Cost", key: "totalCost", align: "right", format: (v) => `$${Number(v).toFixed(2)}` },
            { header: "Avg Tokens/Turn", key: "avgTokensPerTurn", align: "right", format: (v) => Number(v).toFixed(0) },
          ];

          const output = formatter.auto(results as unknown as Record<string, unknown>[], columns, format);
          console.log(output);
        }

        await db.close();
      } catch (err) {
        logger.error(`Query failed: ${err instanceof Error ? err.message : String(err)}`);
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
