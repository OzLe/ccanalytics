/**
 * @module watcher/chokidar-manager
 *
 * Manages the Chokidar file watcher instance lifecycle.
 * Configures awaitWriteFinish to handle partial writes from Claude Code.
 */

import type { Stats } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
    // F-SA: chokidar v5 dropped glob support, so the old
    // `~/.claude/projects/**/*.jsonl` pattern matched NOTHING (the `~` and `**`
    // were never expanded). Instead we resolve each pattern to its concrete
    // DIRECTORY root and let chokidar watch it recursively (v5 auto-adds new
    // nested dirs, e.g. a freshly-created <session>/subagents/), filtering to
    // the files we ingest via `ignored`.
    const roots = options.patterns.map(toWatchRoot);
    const watcher = chokidar.watch(roots, {
      awaitWriteFinish: {
        stabilityThreshold: options.stabilityThreshold,
        pollInterval: 100,
      },
      ignoreInitial: false,
      persistent: true,
      usePolling: options.usePolling,
      interval: options.pollInterval,
      ignored: (p: string, stats?: Stats) => ignorePath(p, stats),
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

/**
 * Resolve a configured watch pattern to a concrete directory chokidar v5 can
 * watch: expand a leading `~`, then drop the glob tail (everything from the
 * first glob metacharacter). e.g. `~/.claude/projects/**​/*.jsonl` ->
 * `/Users/me/.claude/projects`.
 */
export function toWatchRoot(pattern: string): string {
  const expanded = pattern.startsWith("~")
    ? path.join(os.homedir(), pattern.slice(1))
    : pattern;
  const globIdx = expanded.search(/[*?{[]/);
  const base = globIdx === -1 ? expanded : expanded.slice(0, globIdx);
  const trimmed = base.replace(/[/\\]+$/, "");
  return trimmed.length > 0 ? trimmed : path.sep;
}

/**
 * chokidar `ignored` predicate — returns TRUE to skip a path. Directories are
 * always traversed (so new nested dirs are picked up); among files we keep only
 * session/sub-agent transcripts (`*.jsonl`, including `agent-*.jsonl`) and
 * workflow manifests (`wf_*.json`), dropping `*.meta.json` sidecars and any
 * other file. Matches the F-SA ingestion discovery filter.
 */
export function ignorePath(p: string, stats?: Stats): boolean {
  const base = path.basename(p);
  if (base.endsWith(".meta.json")) return true; // sub-agent sidecars
  if (stats && !stats.isDirectory()) {
    if (base.endsWith(".jsonl")) return false;
    if (base.startsWith("wf_") && base.endsWith(".json")) return false;
    return true; // some other file — ignore
  }
  // Directory, or stats not yet resolved: allow (chokidar re-checks with stats).
  return false;
}
