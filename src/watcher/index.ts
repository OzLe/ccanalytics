/**
 * @module watcher
 *
 * Barrel export and main Watcher class for real-time JSONL file monitoring.
 * Coordinates Chokidar file watching with debounced change processing
 * and incremental ingestion.
 */

export { ChokidarManager } from "./chokidar-manager.js";
export { ChangeProcessor } from "./change-processor.js";

import type {
  WatcherStatus,
  WatchEvent,
  WatcherConfig,
} from "../types/index.js";
import type { IngestionPipeline } from "../ingestion/index.js";
import { ChokidarManager } from "./chokidar-manager.js";
import { ChangeProcessor } from "./change-processor.js";

/**
 * Real-time file watcher for Claude Code JSONL session files.
 * Monitors the Claude data directory for new/modified files and
 * triggers incremental ingestion when changes are detected.
 */
export class Watcher {
  private chokidar: ChokidarManager;
  private processor: ChangeProcessor;
  private status: WatcherStatus;
  private eventCallbacks: Array<(event: WatchEvent) => void> = [];

  constructor(
    private config: WatcherConfig,
    private pipeline: IngestionPipeline,
  ) {
    this.chokidar = new ChokidarManager();
    this.processor = new ChangeProcessor({
      debounceMs: config.debounceMs,
      maxBatchSize: config.maxBatchSize,
    });
    this.status = {
      running: false,
      watchedFiles: 0,
      lastEventAt: null,
      lastEventFile: null,
      totalEventsProcessed: 0,
      errors: 0,
    };
  }

  /**
   * Start watching for JSONL file changes.
   * Initializes Chokidar and begins monitoring the configured patterns.
   */
  async start(): Promise<void> {
    // Register file change handler: emit event and enqueue for processing
    this.chokidar.onFileChange((filePath, stats) => {
      this.emitEvent({
        type: "change",
        filePath,
        timestamp: new Date(),
        sizeBytes: stats?.size,
      });
      this.processor.enqueue(filePath);
    });

    // Register batch handler: run ingestion for each changed file
    this.processor.onBatch(async (filePaths) => {
      for (const filePath of filePaths) {
        try {
          await this.pipeline.run({ limit: 1 });
        } catch {
          this.status.errors++;
        }
      }
    });

    // Start watching with config patterns and settings
    await this.chokidar.start({
      patterns: this.config.patterns,
      stabilityThreshold: this.config.stabilityThreshold,
      pollInterval: this.config.pollInterval,
      usePolling: this.config.usePolling,
    });

    this.status.running = true;
    this.status.watchedFiles = this.chokidar.getWatchedCount();
  }

  /**
   * Stop watching and clean up resources.
   * Flushes any pending changes before stopping.
   */
  async stop(): Promise<void> {
    // Flush any pending changes before stopping
    await this.processor.flush();
    // Close the chokidar watcher
    await this.chokidar.stop();
    this.status.running = false;
  }

  /**
   * Get current watcher status (running, file count, last event).
   */
  getStatus(): WatcherStatus {
    return { ...this.status };
  }

  /**
   * Subscribe to watch events for logging/display.
   *
   * @param callback - Called for each file system event
   */
  onEvent(callback: (event: WatchEvent) => void): void {
    this.eventCallbacks.push(callback);
  }

  /**
   * Emit a watch event to all registered callbacks.
   */
  private emitEvent(event: WatchEvent): void {
    this.status.lastEventAt = event.timestamp;
    this.status.lastEventFile = event.filePath;
    this.status.totalEventsProcessed++;

    for (const cb of this.eventCallbacks) {
      cb(event);
    }
  }
}
