/**
 * @module ingestion
 *
 * Barrel export and pipeline orchestrator for the ingestion module.
 * Coordinates adapter-based discovery, parsing, deduplication, and batch insertion.
 */

export { FileDiscovery } from "./file-discovery.js";
export { JSONLParser } from "./jsonl-parser.js";
export { Deduplicator } from "./deduplicator.js";
export { BatchInserter } from "./batch-inserter.js";
export { IngestionTracker } from "./ingestion-tracker.js";
export { FileBackup } from "./file-backup.js";

import type {
  IngestionResult,
  IngestionProgress,
} from "../types/index.js";
import type { ConnectionLike } from "../db/connection.js";
import type { ISourceAdapter } from "./adapters/types.js";
import { BatchInserter } from "./batch-inserter.js";
import { IngestionTracker } from "./ingestion-tracker.js";
import { FileBackup } from "./file-backup.js";
import { reportUnknownModels } from "../utils/pricing.js";

/**
 * Orchestrates the full ingestion pipeline using source adapters:
 * 1. For each adapter: discover files
 * 2. Parse each file from last byte offset
 * 3. Deduplicate messages (adapter-specific strategy)
 * 4. Build insertion batch (adapter-specific mapping)
 * 5. Batch-insert into DuckDB
 * 6. Update ingestion state
 */
export class IngestionPipeline {
  private inserter: BatchInserter;
  private tracker: IngestionTracker;
  private backup: FileBackup | null;
  private progressCallbacks: Array<(progress: IngestionProgress) => void> = [];

  constructor(
    private adapters: ISourceAdapter[],
    private db: ConnectionLike,
    options?: { backupDir?: string },
  ) {
    this.inserter = new BatchInserter(db);
    this.tracker = new IngestionTracker(db);
    this.backup = options?.backupDir ? new FileBackup(options.backupDir) : null;
  }

  /**
   * Run a full or incremental ingestion pass across all adapters.
   *
   * @param options - Ingestion options
   * @param options.force - Force full re-ingestion, ignoring byte-offset state
   * @param options.limit - Maximum number of files to process (per adapter)
   * @param options.since - Only process files modified after this ISO date
   * @returns Summary of the ingestion run
   */
  async run(options?: {
    force?: boolean;
    limit?: number;
    since?: string;
  }): Promise<IngestionResult> {
    const startTime = Date.now();

    // If force, clear all tracked byte offsets up front
    if (options?.force) {
      await this.tracker.resetAll();
    }

    const result: IngestionResult = {
      filesDiscovered: 0,
      filesProcessed: 0,
      filesSkipped: 0,
      filesFailed: 0,
      failedFiles: [],
      entriesIngested: 0,
      duplicatesRemoved: 0,
      parseErrors: 0,
      durationMs: 0,
    };

    // COST-007: collect every distinct assistant model id seen this run so we
    // can warn ONCE at the end about any that have no exact pricing entry and
    // were therefore priced at the Sonnet DEFAULT rate. Surfacing this is the
    // diagnostic that would have caught the claude-opus-4-7 mispricing.
    const modelsSeen = new Set<string>();

    for (const adapter of this.adapters) {
      // 1. Discover files from this source
      let files = await adapter.discoverFiles({ since: options?.since });

      // 2. Apply limit if provided
      if (options?.limit != null && options.limit > 0) {
        files = files.slice(0, options.limit);
      }

      result.filesDiscovered += files.length;

      // 3. Process each discovered file
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Emit discovery progress
        this.emitProgress({
          phase: "discovery",
          filesTotal: files.length,
          filesProcessed: i,
          entriesTotal: 0,
          entriesProcessed: 0,
          bytesTotal: files.reduce((sum, f) => sum + f.sizeBytes, 0),
          bytesProcessed: 0,
          currentFile: file.absolutePath,
        });

        try {
          // Get last ingestion state for this file
          const state = await this.tracker.getState(file.absolutePath);

          // Determine byte offset to resume from
          const byteOffset = options?.force ? 0 : (state?.last_byte_offset ?? 0);

          // Skip if no new data to process
          if (byteOffset >= file.sizeBytes) {
            result.filesSkipped++;
            continue;
          }

          // Back up the source file before processing to prevent data loss
          if (this.backup) {
            try {
              await this.backup.backupIfNeeded(file.absolutePath, file.sizeBytes);
            } catch {
              // Backup failure is non-fatal — continue ingestion
            }
          }

          // Parse the file via the adapter
          const parseResult = await adapter.parseFile(file, byteOffset);

          // Emit parsing progress
          this.emitProgress({
            phase: "parsing",
            filesTotal: files.length,
            filesProcessed: i,
            entriesTotal: parseResult.assistantMessages.length + parseResult.userMessages.length,
            entriesProcessed: 0,
            bytesTotal: file.sizeBytes,
            bytesProcessed: parseResult.bytesRead,
            currentFile: file.absolutePath,
          });

          result.parseErrors += parseResult.parseErrors;

          // Deduplicate assistant messages (adapter-specific strategy)
          const dedupResult = adapter.deduplicate(parseResult.assistantMessages);
          result.duplicatesRemoved += dedupResult.duplicatesRemoved;

          // Build InsertionBatch (adapter-specific mapping + source_type)
          const batch = adapter.buildInsertionBatch(
            file,
            dedupResult.unique,
            parseResult.userMessages,
          );

          // Track assistant turn models for the COST-007 unknown-model warning
          for (const turn of batch.conversationTurns) {
            if (turn.role === "assistant" && turn.model) {
              modelsSeen.add(turn.model);
            }
          }

          // Insert batch into database
          await this.inserter.insert(batch);

          // Update tracker state with new byte offset
          await this.tracker.updateState(
            file.absolutePath,
            byteOffset + parseResult.bytesRead,
            (state?.last_line_number ?? 0) + parseResult.linesProcessed,
          );

          result.filesProcessed++;
          result.entriesIngested +=
            batch.conversationTurns.length + batch.toolCalls.length;
        } catch (err) {
          result.filesFailed++;
          result.failedFiles.push({
            path: file.absolutePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // COST-007: surface (once) any model id that fell through to DEFAULT
    // pricing. reportUnknownModels() ignores the expected '<synthetic>'
    // placeholder and logs nothing when every model has an exact entry.
    reportUnknownModels(modelsSeen);

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Subscribe to progress events during ingestion.
   * Useful for CLI progress display (spinners, progress bars).
   *
   * @param callback - Called with progress updates during ingestion
   */
  onProgress(callback: (progress: IngestionProgress) => void): void {
    this.progressCallbacks.push(callback);
  }

  /**
   * Emit a progress event to all registered callbacks.
   */
  private emitProgress(progress: IngestionProgress): void {
    for (const cb of this.progressCallbacks) {
      cb(progress);
    }
  }
}
