/**
 * @module commands/query
 *
 * CLI command: `ccanalytics query <type>`
 *
 * Runs pre-built analytical queries against the DuckDB store.
 * Available types: cost, tokens, sessions, tools, cache, activity, skills
 */

import { Command } from "commander";

/** Valid query type arguments. */
const VALID_QUERY_TYPES = [
  "cost",
  "tokens",
  "sessions",
  "tools",
  "cache",
  "activity",
  "skills",
] as const;

type QueryType = (typeof VALID_QUERY_TYPES)[number];

/**
 * Register the `query` subcommand on the parent program.
 *
 * Usage: ccanalytics query <cost|tokens|sessions|tools|cache|activity|skills> [options]
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
      // KPI-007: full implementation — the CLI query path exercises the same
      // analyzer classes (CostAnalyzer / TokenAnalyzer / SessionAnalyzer /
      // ToolAnalyzer / CacheAnalyzer / TimeSeriesAnalyzer / SkillAnalyzer) that
      // the /api/* routes mirror, so `ccanalytics query <type>` can be used to
      // cross-check the web numbers.
      //   1. Validate query type
      //   2. Load config with CLI overrides
      //   3. Open DB connection
      //   4. Create the analyzer for the requested type
      //   5. Execute the query with the CLI options
      //   6. Format and print results
      //   7. Close the DB connection

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
      const { parsePeriod } = await import("../utils/time.js");

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
        type QF = import("../types/index.js").QueryFilters;

        // Build filters from CLI options
        const filters: QF = {};
        if (options.model) filters.model = options.model;
        if (options.project) filters.project = options.project;
        const hasFilters = filters.model || filters.project ? filters : undefined;

        if (queryType === "cost") {
          const { CostAnalyzer } = await import("../queries/index.js");
          const analyzer = new CostAnalyzer(executor);

          // If --sort trending, use getCostTrend for time-series view
          if (options.sort === "trending") {
            const results = await analyzer.getCostTrend(range, "day", hasFilters);
            const limited = results.slice(0, limit);

            const columns: ColumnDef[] = [
              { header: "Date", key: "timestamp", format: (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v) },
              { header: "Cost", key: "costUSD", align: "right", format: (v) => `$${Number(v).toFixed(2)}` },
              { header: "Input Tokens", key: "inputTokens", align: "right", format: (v) => Number(v).toLocaleString() },
              { header: "Output Tokens", key: "outputTokens", align: "right", format: (v) => Number(v).toLocaleString() },
            ];

            const output = formatter.auto(limited as unknown as Record<string, unknown>[], columns, format);
            console.log(output);
          } else {
            const results = await analyzer.getDailyCosts(range, hasFilters);
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
          }
        } else if (queryType === "tokens") {
          // F1: Total Tokens. Backed by TokenAnalyzer (the same analyzer the
          // /api/tokens/total route mirrors). Prints a Total row + the 4-way
          // breakdown for the period, plus an All-time total row. The All-time
          // number is a fully unfiltered, dataset-wide constant (D7) — --model
          // / --project / --period change only the period rows.
          const { TokenAnalyzer } = await import("../queries/index.js");
          const analyzer = new TokenAnalyzer(executor);
          const { period, allTime } = await analyzer.getTotalTokens(range, hasFilters);

          const rows = [
            { metric: "Total", tokens: period.totalTokens },
            { metric: "Input", tokens: period.inputTokens },
            { metric: "Output", tokens: period.outputTokens },
            { metric: "Cache Read", tokens: period.cacheReadTokens },
            { metric: "Cache Write", tokens: period.cacheWriteTokens },
            { metric: "All-time total", tokens: allTime.totalTokens },
          ];

          const columns: ColumnDef[] = [
            { header: "Metric", key: "metric" },
            {
              header: "Tokens",
              key: "tokens",
              align: "right",
              format: (v) => formatter.formatTokens(Number(v)),
            },
          ];

          const output = formatter.auto(rows as unknown as Record<string, unknown>[], columns, format);
          console.log(output);
        } else if (queryType === "sessions") {
          const { SessionAnalyzer } = await import("../queries/index.js");
          const analyzer = new SessionAnalyzer(executor);
          const results = await analyzer.getSessions({
            range,
            sortBy: (options.sort as "start_time" | "cost" | "turns" | "duration") ?? "start_time",
            order: options.desc ? "desc" : "asc",
            limit,
            filters: hasFilters,
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
          const results = await analyzer.getToolUsage(range, hasFilters);
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
          const results = await analyzer.getCacheTrend(range, undefined, hasFilters);
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
          const results = await analyzer.getHourlyActivity(range, hasFilters);

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
        } else if (queryType === "skills") {
          // F2K: Skill Analysis. Backed by SkillAnalyzer (the same analyzer the
          // /api/skills/* routes mirror). Default view: a per-skill summary
          // table (loaded-vs-invoked, est. context tokens, status), sorted by
          // Invocations desc. --sort weight sorts by est. context tokens;
          // --sort loaded by loaded-in count; --sort not-required switches to
          // the same-session thrash view so the CLI cross-checks the web table.
          const { SkillAnalyzer } = await import("../queries/index.js");
          const analyzer = new SkillAnalyzer(executor);

          if (options.sort === "not-required") {
            // Possibly-unnecessary invocations: same-session thrash rows.
            const { thrash } = await analyzer.getSkillThrash(range, hasFilters, limit);

            const columns: ColumnDef[] = [
              { header: "Session", key: "sessionId", maxWidth: 24 },
              { header: "Skill", key: "skill", maxWidth: 35 },
              { header: "Times In Session", key: "invocationsInSession", align: "right" },
              {
                header: "Re-entrant?",
                key: "isKnownReentrant",
                format: (v) => (v ? "yes (expected)" : "no"),
              },
            ];

            const output = formatter.auto(
              thrash as unknown as Record<string, unknown>[],
              columns,
              format,
            );
            console.log(output);
          } else {
            // Per-skill summary: merge the loaded side and the invoked side
            // into one row per skill (full outer join in JS, mirroring
            // v_skill_usage's FULL OUTER JOIN).
            const [invocations, loaded] = await Promise.all([
              analyzer.getSkillUsage(range, hasFilters),
              analyzer.getLoadedSkills(range, hasFilters),
            ]);

            interface SkillRow {
              skill: string;
              loadedInSessions: number;
              invocations: number;
              sessionsUsing: number;
              avgPerSession: number;
              successRate: number | null;
              estContextTokens: number;
              status: string;
            }
            const bySkill = new Map<string, SkillRow>();
            for (const l of loaded) {
              bySkill.set(l.skill, {
                skill: l.skill,
                loadedInSessions: l.loadedInSessions,
                invocations: l.invocations,
                sessionsUsing: 0,
                avgPerSession: 0,
                successRate: null,
                estContextTokens: l.estContextTokens,
                status: l.isDeadWeight ? "dead weight" : "used",
              });
            }
            for (const i of invocations) {
              const existing = bySkill.get(i.skill);
              if (existing) {
                existing.invocations = i.invocations;
                existing.sessionsUsing = i.sessionsUsing;
                existing.avgPerSession = i.avgPerSession;
                existing.successRate = i.successRate;
                existing.status = "used";
              } else {
                // Invoked but not in the loaded set (e.g. loaded data absent
                // for pre-migration sessions) — still surface it.
                bySkill.set(i.skill, {
                  skill: i.skill,
                  loadedInSessions: 0,
                  invocations: i.invocations,
                  sessionsUsing: i.sessionsUsing,
                  avgPerSession: i.avgPerSession,
                  successRate: i.successRate,
                  estContextTokens: 0,
                  status: "invoked (not loaded)",
                });
              }
            }

            let rows = [...bySkill.values()];
            // Default sort: Invocations desc. --sort weight | loaded switch it.
            // Skill name is a deterministic tiebreaker (many skills share a
            // loaded-in count, so the primary key alone is not stable).
            if (options.sort === "weight") {
              rows.sort(
                (a, b) =>
                  b.estContextTokens - a.estContextTokens ||
                  a.skill.localeCompare(b.skill),
              );
            } else if (options.sort === "loaded") {
              rows.sort(
                (a, b) =>
                  b.loadedInSessions - a.loadedInSessions ||
                  a.skill.localeCompare(b.skill),
              );
            } else {
              rows.sort(
                (a, b) =>
                  b.invocations - a.invocations ||
                  a.skill.localeCompare(b.skill),
              );
            }
            if (!options.desc) rows.reverse();
            rows = rows.slice(0, limit);

            const columns: ColumnDef[] = [
              { header: "Skill", key: "skill", maxWidth: 35 },
              { header: "Loaded In", key: "loadedInSessions", align: "right" },
              { header: "Invocations", key: "invocations", align: "right" },
              { header: "Sessions Using", key: "sessionsUsing", align: "right" },
              {
                header: "Invocation/Session",
                key: "avgPerSession",
                align: "right",
                format: (v) => Number(v).toFixed(2),
              },
              {
                header: "Success Rate",
                key: "successRate",
                align: "right",
                format: (v) => (v != null ? `${(Number(v) * 100).toFixed(1)}%` : "N/A"),
              },
              {
                header: "Est. Context Tokens",
                key: "estContextTokens",
                align: "right",
                format: (v) => Number(v).toLocaleString(),
              },
              { header: "Status", key: "status" },
            ];

            const output = formatter.auto(
              rows as unknown as Record<string, unknown>[],
              columns,
              format,
            );
            console.log(output);
          }
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
