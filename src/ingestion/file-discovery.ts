/**
 * @module ingestion/file-discovery
 *
 * Glob-based JSONL file discovery.
 * Finds all .jsonl session files under the Claude projects directory.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectsDir, decodeProjectPath, extractSessionId } from "../utils/paths.js";

/** A discovered JSONL file with metadata. */
export interface DiscoveredFile {
  /** Absolute path to the JSONL file. */
  absolutePath: string;
  /** Decoded project path (dashes -> slashes). */
  projectPath: string;
  /** Session ID extracted from filename. */
  sessionId: string;
  /** Whether this is a sub-agent file (agent-{shortId}.jsonl). */
  isSidechain: boolean;
  /** File size in bytes. */
  sizeBytes: number;
  /** Last modified timestamp. */
  modifiedAt: Date;
  /** Source type discriminator (set by adapters). */
  sourceType?: string;
  /** Arbitrary adapter-specific metadata (e.g. Desktop session info). */
  metadata?: Record<string, unknown>;
}

/**
 * Discovers JSONL session files under the Claude projects directory.
 */
export class FileDiscovery {
  private claudeDir: string;

  constructor(claudeDir: string) {
    this.claudeDir = claudeDir;
  }

  /**
   * Discover all JSONL files under the Claude projects directory.
   * Respects glob overrides and since-date filtering.
   *
   * @param options - Discovery options
   * @param options.glob - Glob pattern override for file matching
   * @param options.since - Only return files modified after this ISO date
   * @returns Array of discovered file descriptors
   */
  async discoverFiles(options?: {
    glob?: string;
    since?: string;
  }): Promise<DiscoveredFile[]> {
    const projectsDir = getProjectsDir(this.claudeDir);
    const results: DiscoveredFile[] = [];

    // Parse the since filter date if provided
    const sinceDate = options?.since ? new Date(options.since) : null;

    // Read all subdirectories in the projects dir
    let projectDirs: string[];
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      projectDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // If the projects directory doesn't exist or can't be read, return empty
      return [];
    }

    // For each project directory, find all .jsonl files
    for (const dirName of projectDirs) {
      const dirPath = path.join(projectsDir, dirName);
      let files: string[];
      try {
        const entries = await fs.readdir(dirPath);
        files = entries.filter((f) => f.endsWith(".jsonl"));
      } catch {
        // Skip directories that can't be read
        continue;
      }

      for (const filename of files) {
        const absolutePath = path.join(dirPath, filename);

        // Stat the file for size and mtime
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(absolutePath);
        } catch {
          // Skip files that can't be stat'd
          continue;
        }

        // Filter by since date if provided
        if (sinceDate && stat.mtime < sinceDate) {
          continue;
        }

        // Decode project path from directory name
        const projectPath = decodeProjectPath(dirName);

        // Extract session ID and sidechain flag from filename
        const { sessionId, isSidechain } = extractSessionId(filename);

        results.push({
          absolutePath,
          projectPath,
          sessionId,
          isSidechain,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
        });
      }
    }

    // Sort by modification time descending (newest first)
    results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    return results;
  }
}
