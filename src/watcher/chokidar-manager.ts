/**
 * @module watcher/chokidar-manager
 *
 * Manages the Chokidar file watcher instance lifecycle.
 * Configures awaitWriteFinish to handle partial writes from Claude Code.
 */

import type { Stats } from "node:fs";

/** Options for Chokidar watcher initialization. */
export interface ChokidarManagerOptions {
  /** Glob patterns to watch. */
  patterns: string[];
  /** awaitWriteFinish stabilityThreshold in ms. Default: 2000 */
  stabilityThreshold: number;
  /** Polling interval when native events unavailable. Default: 2000 */
  pollInterval: number;
  /** Use polling instead of native events. Default: false */
  usePolling: boolean;
}

/**
 * Wraps the Chokidar file watcher with lifecycle management
 * and awaitWriteFinish configuration.
 */
export class ChokidarManager {
  private watcher: unknown = null;
  private changeCallbacks: Array<
    (filePath: string, stats: Stats) => void
  > = [];

  /**
   * Initialize the Chokidar watcher with configured options.
   * Sets up awaitWriteFinish to prevent reading partial JSONL writes.
   *
   * @param options - Watcher configuration
   */
  async start(options: ChokidarManagerOptions): Promise<void> {
    const chokidar = await import("chokidar");
    const watcher = chokidar.watch(options.patterns, {
      awaitWriteFinish: {
        stabilityThreshold: options.stabilityThreshold,
        pollInterval: 100,
      },
      ignoreInitial: false,
      persistent: true,
      usePolling: options.usePolling,
      interval: options.pollInterval,
    });

    watcher.on("add", (filePath: string, stats?: Stats) => {
      for (const cb of this.changeCallbacks) {
        cb(filePath, stats ?? ({} as Stats));
      }
    });

    watcher.on("change", (filePath: string, stats?: Stats) => {
      for (const cb of this.changeCallbacks) {
        cb(filePath, stats ?? ({} as Stats));
      }
    });

    await new Promise<void>((resolve, reject) => {
      watcher.on("ready", () => resolve());
      watcher.on("error", (err: unknown) => reject(err));
    });

    this.watcher = watcher;
  }

  /**
   * Register a callback for file add/change events.
   *
   * @param callback - Called when a JSONL file is added or changed
   */
  onFileChange(
    callback: (filePath: string, stats: Stats) => void,
  ): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Close the Chokidar watcher and release resources.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await (this.watcher as { close(): Promise<void> }).close();
      this.watcher = null;
    }
  }

  /**
   * Get the number of files currently being watched.
   *
   * @returns Count of watched files
   */
  getWatchedCount(): number {
    if (!this.watcher) {
      return 0;
    }
    const watched = (this.watcher as { getWatched(): Record<string, string[]> }).getWatched();
    let count = 0;
    for (const files of Object.values(watched)) {
      count += files.length;
    }
    return count;
  }
}
