/**
 * @module watcher/change-processor
 *
 * Debounced change event processing.
 * Batches file change events within a configurable debounce window
 * before triggering ingestion, avoiding excessive processing during
 * rapid file writes.
 */

/** Options for the ChangeProcessor. */
export interface ChangeProcessorOptions {
  /** Debounce delay in ms. Events within this window are batched. Default: 500 */
  debounceMs: number;
  /** Maximum number of files to process in a single batch. Default: 50 */
  maxBatchSize: number;
}

/**
 * Batches file change events with debouncing.
 * Accumulates changed file paths and fires them as a batch
 * after the debounce window expires.
 */
export class ChangeProcessor {
  private pendingFiles: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private batchCallbacks: Array<(filePaths: string[]) => Promise<void>> = [];
  private options: ChangeProcessorOptions;

  constructor(options?: Partial<ChangeProcessorOptions>) {
    this.options = {
      debounceMs: options?.debounceMs ?? 500,
      maxBatchSize: options?.maxBatchSize ?? 50,
    };
  }

  /**
   * Queue a file change for processing.
   * The file path is added to the pending set, and a debounce timer
   * is started/reset. When the timer expires, all pending files are
   * emitted as a batch.
   *
   * @param filePath - Absolute path to the changed file
   */
  enqueue(filePath: string): void {
    this.pendingFiles.add(filePath);

    // Reset debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // If we've hit the max batch size, flush immediately
    if (this.pendingFiles.size >= this.options.maxBatchSize) {
      void this.flush();
      return;
    }

    // Otherwise, start debounce timer
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.options.debounceMs);
  }

  /**
   * Register handler called when the debounced batch is ready.
   *
   * @param callback - Called with an array of changed file paths
   */
  onBatch(callback: (filePaths: string[]) => Promise<void>): void {
    this.batchCallbacks.push(callback);
  }

  /**
   * Flush any pending changes immediately.
   * Clears the debounce timer and processes all accumulated files.
   */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pendingFiles.size === 0) {
      return;
    }

    const filePaths = Array.from(this.pendingFiles);
    this.pendingFiles.clear();

    for (const cb of this.batchCallbacks) {
      await cb(filePaths);
    }
  }

  /**
   * Get count of pending (not yet flushed) changes.
   */
  getPendingCount(): number {
    return this.pendingFiles.size;
  }
}
