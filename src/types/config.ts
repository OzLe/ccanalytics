/**
 * @module types/config
 *
 * Configuration types for ccanalytics.
 * These types define the shape of the configuration object
 * used throughout the application.
 */

import type { OutputFormat } from "./analytics.js";

/** Discriminator for data source origin. */
export type SourceType = "claude-code" | "claude-desktop";

/** Top-level configuration for ccanalytics. */
export interface CCAnalyticsConfig {
  /** Path to DuckDB database file. Default: ~/.ccanalytics/analytics.duckdb */
  dbPath: string;
  /** Path to Claude data directory. Default: ~/.claude */
  claudeDir: string;
  /** Path to Claude Desktop data directory. Default: ~/Library/Application Support/Claude */
  desktopDataDir?: string;
  /** Which sources to ingest. Default: ["claude-code", "claude-desktop"] */
  sources?: SourceType[];
  /** Default output format. Default: "table" */
  format: OutputFormat;
  /** Enable verbose logging. Default: false */
  verbose: boolean;
  /** Ingestion-specific settings. */
  ingestion: IngestionConfig;
  /** Watcher-specific settings. */
  watcher: WatcherConfig;
  /** Database-specific settings. */
  database: DatabaseConfig;
}

/** Configuration for the ingestion pipeline. */
export interface IngestionConfig {
  /** Glob pattern for JSONL discovery. Default: "projects/**\/*.jsonl" */
  globPattern: string;
  /** Max rows per INSERT batch. Default: 1000 */
  batchSize: number;
  /** Skip files smaller than N bytes. Default: 0 */
  minFileSize: number;
  /** Skip files not modified in the last N days. Default: 30 */
  maxAgeDays: number;
}

/** Configuration for the file watcher. */
export interface WatcherConfig {
  /** Glob patterns to watch. Default: ["~/.claude/projects/**\/*.jsonl"] */
  patterns: string[];
  /** awaitWriteFinish stability threshold in ms. Default: 2000 */
  stabilityThreshold: number;
  /** Debounce delay for change events in ms. Default: 500 */
  debounceMs: number;
  /** Polling interval in ms (fallback mode). Default: 2000 */
  pollInterval: number;
  /** Use polling instead of native FS events. Default: false */
  usePolling: boolean;
  /** Max files per ingestion batch. Default: 50 */
  maxBatchSize: number;
}

/** Configuration for the DuckDB database connection. */
export interface DatabaseConfig {
  /** Whether to log all SQL queries. Default: false */
  logQueries: boolean;
  /** Memory limit for DuckDB. Default: "256MB" */
  memoryLimit: string;
  /** Number of threads for DuckDB. 0 = auto. Default: 0 */
  threads: number;
}

/** Global options parsed from CLI flags. */
export interface GlobalOptions {
  /** Path to DuckDB database file. */
  db?: string;
  /** Path to Claude data directory. */
  claudeDir?: string;
  /** Output format. */
  format?: OutputFormat;
  /** Enable verbose logging. */
  verbose?: boolean;
}

/** Options for the query command. */
export interface QueryOptions {
  /** Time range filter: "today", "7d", "30d", "90d", "all". */
  period: string;
  /** Filter by model name. */
  model?: string;
  /** Filter by project name. */
  project?: string;
  /** Sort field. */
  sort?: string;
  /** Maximum rows to return. */
  limit: number;
  /** Sort in descending order. */
  desc: boolean;
}
