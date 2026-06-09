/**
 * @module types/config
 *
 * Configuration types for ccanalytics.
 * These types define the shape of the configuration object
 * used throughout the application.
 */

import type { OutputFormat } from "./analytics.js";
import type { TierLimitCeilings } from "../config/limits.js";

/** Discriminator for data source origin. */
export type SourceType = "claude-code" | "claude-desktop";

/**
 * The user's Claude subscription plan.
 *
 * Used purely to reframe API-equivalent costs as subscription ROI — it has no
 * effect on how cost is computed. Confirmed against claude.com/pricing
 * (2026-05): none $0, pro $20, max-5x $100, max-20x $200. Team/Enterprise are
 * intentionally omitted (this is a single-user local analytics tool).
 */
export type SubscriptionTier = "none" | "pro" | "max-5x" | "max-20x";

/** User's Claude subscription, used to reframe API-equivalent costs as ROI. */
export interface SubscriptionConfig {
  /** Subscription plan the user is on. Default: "max-20x" */
  tier: SubscriptionTier;
  /** Flat monthly fee in USD for the chosen tier. Default: 200 */
  monthlyUSD: number;
}

/**
 * Display preferences. Affects how time math (hour-of-day, day-of-week,
 * local-date, date-truncation) is projected onto the user's wall clock. Stored
 * timestamps are tz-naive UTC wall-clock (see ACT-001 / SEM2-293).
 */
export interface DisplayConfig {
  /**
   * IANA timezone the dashboard/CLI should project local-time math into. Empty
   * or absent falls back to `'UTC'`. Examples: 'UTC', 'Asia/Jerusalem',
   * 'America/New_York'.
   */
  userTimezone?: string;
}

/**
 * Editable rate-limit ceilings + recommendation behaviour. All ceiling values
 * are ESTIMATES (see src/config/limits.ts and RECOMMENDATION_ESTIMATE_CAVEAT).
 * This block only tunes the advisory subscription recommendation — it never
 * affects how cost is computed.
 */
export interface RecommendationConfig {
  /** Opt-in auto-calibration of ceilings to observed peaks. Default: true. */
  autoCalibrate: boolean;
  /**
   * Per-tier ceiling overrides. Sparse: any tier/dimension omitted falls back
   * to DEFAULT_TIER_LIMITS in src/config/limits.ts. Never stored fully unless
   * the user edits it.
   */
  ceilings?: Partial<Record<SubscriptionTier, Partial<TierLimitCeilings>>>;
}

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
  /** User's Claude subscription plan, for cost-vs-subscription ROI framing. */
  subscription: SubscriptionConfig;
  /** Display / projection preferences (user timezone, etc.). */
  display?: DisplayConfig;
  /** Subscription-recommendation ceilings + auto-calibrate toggle. */
  recommendation?: RecommendationConfig;
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
