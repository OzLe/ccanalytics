/**
 * @module commands/recommend
 *
 * CLI command: `ccanalytics recommend`
 *
 * Answers one question from local Claude Code usage: should the user DOWNGRADE
 * (under-utilizing the tier), UPGRADE (frequently at/near the estimated limits),
 * or STAY — with an explicit confidence level and an honest "estimate" caveat.
 *
 * This is a thin presentation layer over the core engine. ALL decision logic
 * lives in the pure modules (src/recommendation/windows.ts +
 * src/recommendation/engine.ts) and the {@link RecommendationAnalyzer}; this
 * command only loads config, opens the DB the same way `status` does, runs the
 * analyzer for the period, and renders the structured result as table/json/csv.
 *
 * IMPORTANT: read-only and cost-neutral. Per-model rates stay in
 * src/utils/pricing.ts; tier prices stay in src/config/subscription.ts. Every
 * figure shown is an ESTIMATE (see RECOMMENDATION_ESTIMATE_CAVEAT).
 */

import { Command } from "commander";

/** Valid `--period` values (mirrors the `query` command + parsePeriod). */
const VALID_PERIODS = ["today", "7d", "30d", "90d", "all"] as const;

/**
 * Register the `recommend` subcommand on the parent program.
 *
 * Usage: ccanalytics recommend [options]
 *
 * Flags:
 *   --period <range>   Time range: today, 7d, 30d, 90d, all (default: 30d)
 *   --format <fmt>     Output format: table, json, csv (global; honored here)
 *
 * Output sections (table format):
 *   - Current tier
 *   - 5-hour window: peak / typical (median) fill
 *   - Weekly window: peak fill incl. per-model (all / Sonnet / Opus)
 *   - Recommendation: headline + verdict + confidence + monthly $ delta + rationale
 *   - The RECOMMENDATION_ESTIMATE_CAVEAT line
 *
 * For `--format json` the full structured object (analysis + recommendation) is
 * printed verbatim; for `table`/`csv` a small labelled rows table is printed via
 * the shared {@link OutputFormatter}.
 *
 * @param parent - The parent Commander program
 */
export function registerRecommendCommand(parent: Command): void {
  parent
    .command("recommend")
    .description(
      "Recommend whether to upgrade, downgrade, or stay on your Claude subscription (estimate)",
    )
    .option(
      "--period <range>",
      `Time range filter: ${VALID_PERIODS.join(", ")}`,
      "30d",
    )
    .option("--format <fmt>", "Output format: table, json, csv")
    .action(async (options) => {
      // Mirror `status` / `query`: lazy dynamic imports keep the CLI cold-start
      // cheap, then load config (for the current tier + recommendation block),
      // open the DB, run the analyzer, and render.
      const { loadConfig } = await import("../config/index.js");
      const { ConnectionManager } = await import("../db/connection.js");
      const { SchemaManager } = await import("../db/schema.js");
      const { QueryExecutor } = await import("../db/executor.js");
      const { RecommendationAnalyzer } = await import("../queries/index.js");
      const { createLogger } = await import("../utils/logger.js");
      const { OutputFormatter } = await import("../utils/format.js");
      const { parsePeriod } = await import("../utils/time.js");
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

      const logger = createLogger({ verbose: config.verbose, prefix: "recommend" });

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
        const format = (options.format ?? config.format ?? "table") as
          | "table"
          | "json"
          | "csv";
        const range = parsePeriod(options.period);

        // The analyzer is pure-data + cost-neutral; the only inputs it needs
        // beyond the range are the current tier and the recommendation config
        // (autoCalibrate + any sparse per-tier ceiling overrides). loadConfig
        // always populates `subscription`; `recommendation` is optional and
        // defaults to { autoCalibrate: true } via DEFAULT_CONFIG.
        const tier = config.subscription.tier;
        const analyzer = new RecommendationAnalyzer(executor);
        const analysis = await analyzer.analyze(tier, range, undefined, {
          autoCalibrate: config.recommendation?.autoCalibrate ?? true,
          ceilingOverrides: config.recommendation?.ceilings,
        });

        if (format === "json") {
          // Full structured object (analysis + the nested recommendation).
          console.log(formatter.formatJson(analysis));
        } else {
          // table / csv — a small labelled "metric / value" rows table, the
          // same shape the `query tokens` view uses. Numbers are humanized for
          // table output; the JSON form above keeps the raw values.
          const { recommendation: rec } = analysis;
          const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
          const deltaLabel =
            rec.monthlyDeltaUSD > 0
              ? `+$${rec.monthlyDeltaUSD}/mo`
              : rec.monthlyDeltaUSD < 0
                ? `-$${Math.abs(rec.monthlyDeltaUSD)}/mo`
                : "$0/mo";

          type Row = { metric: string; value: string };
          const rows: Row[] = [
            { metric: "Current tier", value: tier },
            {
              metric: "5h window peak fill",
              value: pct(analysis.windowStats5h.peakFill),
            },
            {
              metric: "5h peak (API-equiv $)",
              value: `$${analysis.windowStats5h.peakCostUSD.toFixed(2)}`,
            },
            {
              metric: "5h window typical (median) fill",
              value: pct(analysis.windowStats5h.medianFill),
            },
            {
              metric: "5h windows near limit",
              value: `${analysis.windowStats5h.nearLimitWindows} of ${analysis.windowStats5h.activeWindows}`,
            },
            {
              metric: "Weekly peak fill (all models)",
              value: pct(analysis.perModelWeekly.all.peakFill),
            },
            {
              metric: "Weekly peak fill (Sonnet)",
              value: pct(analysis.perModelWeekly.sonnet.peakFill),
            },
            {
              metric: "Weekly peak fill (Opus)",
              value: pct(analysis.perModelWeekly.opus.peakFill),
            },
            { metric: "Ceiling source", value: analysis.ceilingSource },
            { metric: "Recommendation", value: rec.headline },
            { metric: "Verdict", value: rec.verdict },
            {
              metric: "Suggested tier",
              value: rec.suggestedTier ?? "(no change)",
            },
            { metric: "Monthly delta", value: deltaLabel },
            { metric: "Confidence", value: rec.confidence },
            { metric: "Rationale", value: rec.detail },
            { metric: "Why this confidence", value: rec.confidenceReason },
            { metric: "Note", value: analysis.caveat },
          ];

          type ColumnDef = import("../utils/format.js").TableColumn;
          const columns: ColumnDef[] = [
            { header: "Metric", key: "metric" },
            { header: "Value", key: "value" },
          ];

          const output = formatter.auto(
            rows as unknown as Record<string, unknown>[],
            columns,
            format,
          );
          console.log(output);
        }

        await db.close();
      } catch (err) {
        logger.error(
          `Recommend failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (db) {
          await db.close();
        }
        process.exit(1);
      }
    });
}
