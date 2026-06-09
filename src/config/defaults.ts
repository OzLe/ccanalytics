/**
 * @module config/defaults
 *
 * Built-in default values for all ccanalytics configuration options.
 * These defaults are used when no config file, environment variable,
 * or CLI flag provides an override.
 */

import type { CCAnalyticsConfig } from "../types/index.js";

/** Built-in defaults for all configuration options. */
export const DEFAULT_CONFIG: Readonly<CCAnalyticsConfig> = {
  dbPath: "~/.ccanalytics/analytics.duckdb",
  claudeDir: "~/.claude",
  desktopDataDir: "~/Library/Application Support/Claude",
  sources: ["claude-code", "claude-desktop"],
  format: "table",
  verbose: false,
  ingestion: {
    globPattern: "projects/**/*.jsonl",
    batchSize: 1000,
    minFileSize: 0,
    maxAgeDays: 30,
  },
  watcher: {
    patterns: ["~/.claude/projects/**/*.jsonl"],
    stabilityThreshold: 2000,
    debounceMs: 500,
    pollInterval: 2000,
    usePolling: false,
    maxBatchSize: 50,
  },
  database: {
    logQueries: false,
    memoryLimit: "256MB",
    threads: 0, // 0 = DuckDB auto-detect
  },
  subscription: {
    tier: "max-20x",
    monthlyUSD: 200,
  },
  recommendation: {
    // ceilings omitted → DEFAULT_TIER_LIMITS (src/config/limits.ts) is the
    // effective default. Auto-calibration is opt-in but defaults ON so a user
    // who exceeds the published estimate is not pinned at a meaningless >100%.
    autoCalibrate: true,
  },
};
