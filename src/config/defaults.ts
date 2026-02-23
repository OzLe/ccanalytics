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
};
