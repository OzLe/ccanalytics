/**
 * @module ingestion/run-ingestion
 *
 * Shared ingestion orchestration.
 *
 * This is the SINGLE code path for running an ingestion pass. Both the CLI
 * `ccanalytics ingest` command and the dashboard's `POST /api/ingest` route
 * call `runIngestion()`, so the two entry points cannot drift apart.
 *
 * Connection ownership is the only thing that varies between callers:
 *   - The CLI passes no connection, so `runIngestion` opens its own
 *     {@link ConnectionManager} and closes it before returning.
 *   - The dashboard API server passes its long-lived connection (a
 *     {@link ConnectionLike}); `runIngestion` reuses it and leaves it open.
 *     This avoids opening a second, lock-conflicting connection to the same
 *     DuckDB file (DuckDB is single-writer).
 */

import * as path from "node:path";

import type {
  IngestionResult,
  IngestionProgress,
  CCAnalyticsConfig,
} from "../types/index.js";
import { ConnectionManager, type ConnectionLike } from "../db/connection.js";
import { SchemaManager } from "../db/schema.js";
import { loadConfig } from "../config/index.js";
import { findClaudeDir, expandHome, ensureDir } from "../utils/paths.js";
import { IngestionPipeline } from "./index.js";
import { createAdapters } from "./adapters/index.js";
import type { SourceType } from "./adapters/types.js";

/** Options accepted by {@link runIngestion}. */
export interface RunIngestionOptions {
  /** Config overrides applied on top of the resolved config file / defaults. */
  configOverrides?: Partial<CCAnalyticsConfig>;
  /** Force full re-ingestion, ignoring byte-offset state. */
  force?: boolean;
  /** Restrict ingestion to a single source type, or "all" (default). */
  source?: SourceType | "all";
  /** Max rows per INSERT batch. */
  batchSize?: number;
  /** Max files to process per adapter. */
  limit?: number;
  /** Only process files modified after this ISO date. */
  since?: string;
  /**
   * An already-open connection to reuse. When provided, the CALLER owns the
   * connection lifecycle and `runIngestion` will NOT close it. When omitted,
   * `runIngestion` opens a fresh {@link ConnectionManager} and closes it
   * before returning.
   */
  db?: ConnectionLike;
  /** Optional progress callback, forwarded to the pipeline. */
  onProgress?: (progress: IngestionProgress) => void;
  /** Optional logger for debug-level orchestration output. */
  logger?: { debug: (message: string) => void };
}

/** Outcome of an ingestion run: the result summary plus the resolved config. */
export interface RunIngestionOutcome {
  result: IngestionResult;
  config: CCAnalyticsConfig;
}

/**
 * Run a full or incremental ingestion pass.
 *
 * @param options - Ingestion options (see {@link RunIngestionOptions})
 * @returns The {@link IngestionResult} summary and the resolved config
 */
export async function runIngestion(
  options: RunIngestionOptions = {},
): Promise<RunIngestionOutcome> {
  const log = options.logger;

  // Resolve config (config file / env / defaults + caller overrides).
  const config = await loadConfig({ cliOverrides: options.configOverrides });

  // Resolve the Claude data directory.
  const claudeDir = await findClaudeDir(config.claudeDir);
  config.claudeDir = claudeDir;
  log?.debug(`Claude directory: ${claudeDir}`);

  // Expand the DB path and make sure its parent directory exists.
  const dbPath = expandHome(config.dbPath);
  await ensureDir(path.dirname(dbPath));

  // Apply the batch-size override before constructing the pipeline.
  if (options.batchSize && options.batchSize > 0) {
    config.ingestion.batchSize = options.batchSize;
  }

  // Connection: reuse the caller's if provided, otherwise open (and own) one.
  const ownsConnection = !options.db;
  let ownConnection: ConnectionManager | null = null;
  let db: ConnectionLike;

  if (options.db) {
    db = options.db;
    log?.debug("Reusing caller-provided database connection");
  } else {
    ownConnection = new ConnectionManager();
    await ownConnection.open(dbPath);
    db = ownConnection;
    log?.debug(`Database opened: ${dbPath}`);
  }

  try {
    // Initialize schema — idempotent (CREATE TABLE IF NOT EXISTS + tracked
    // migrations), so this is safe even on an already-migrated database.
    const schema = new SchemaManager();
    await schema.initialize(db.getConnection());
    await schema.migrate(db.getConnection());
    log?.debug("Schema initialized");

    // Create adapters based on the source filter.
    const sourceFilter =
      !options.source || options.source === "all" ? undefined : options.source;
    const adapters = createAdapters(config, sourceFilter);
    log?.debug(`Active adapters: ${adapters.map((a) => a.name).join(", ")}`);

    // Resolve the backup directory (sibling to the DB file).
    const backupDir = path.join(path.dirname(dbPath), "backups");
    await ensureDir(backupDir);
    log?.debug(`Backup directory: ${backupDir}`);

    // Build and run the pipeline.
    const pipeline = new IngestionPipeline(adapters, db, { backupDir });
    if (options.onProgress) {
      pipeline.onProgress(options.onProgress);
    }

    const result = await pipeline.run({
      force: options.force,
      limit: options.limit,
      since: options.since,
    });

    return { result, config };
  } finally {
    // Only close the connection if WE opened it. A caller-supplied connection
    // is the caller's to manage.
    if (ownsConnection && ownConnection) {
      await ownConnection.close();
    }
  }
}
