/**
 * @module ingestion/file-discovery
 *
 * Glob-based JSONL file discovery.
 * Finds all .jsonl session files under the Claude projects directory.
 */

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import {
  getProjectsDir,
  decodeProjectPath,
  extractSessionId,
  parseAgentFilename,
} from "../utils/paths.js";

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
  /**
   * F-SA: what kind of file this is. "session" = a top-level `<session>.jsonl`
   * (default / absent), "subagent" = a sub-agent transcript under
   * `<session>/subagents/**`, "workflow-manifest" = a
   * `<session>/workflows/wf_*.json` run manifest.
   */
  kind?: "session" | "subagent" | "workflow-manifest";
  /** F-SA: sub-agent files only — the agentId parsed from `agent-<id>.jsonl`. */
  agentId?: string;
  /**
   * F-SA: sub-agent / manifest files only — the containing `<session-id>` dir
   * name. PROVENANCE ONLY: for parent attribution the adapter prefers the
   * record's own inner `sessionId` (this dir name mis-attributes resumed
   * transcripts).
   */
  parentSessionId?: string;
  /** F-SA: workflow sub-agents / manifests only — the `wf_<runId>` id. */
  workflowRunId?: string;
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
    const sinceDate = options?.since ? new Date(options.since) : null;

    // Read all project subdirectories.
    let projectDirs: string[];
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // If the projects directory doesn't exist or can't be read, return empty.
      return [];
    }

    for (const dirName of projectDirs) {
      const dirPath = path.join(projectsDir, dirName);
      const projectPath = decodeProjectPath(dirName);

      let entries: Dirent[];
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue; // Skip project dirs that can't be read.
      }

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          // Top-level <session>.jsonl — unchanged behavior.
          const { sessionId, isSidechain } = extractSessionId(entry.name);
          await this.pushFile(results, sinceDate, {
            absolutePath: path.join(dirPath, entry.name),
            projectPath,
            sessionId,
            isSidechain,
            kind: "session",
          });
        } else if (entry.isDirectory()) {
          // F-SA: a <session-id>/ dir — descend into its subagents/ and
          // workflows/ sidecars (previously dropped entirely, so sub-agent
          // tokens/cost were never ingested).
          await this.discoverSessionSidecars(
            results,
            sinceDate,
            path.join(dirPath, entry.name),
            entry.name,
            projectPath,
          );
        }
      }
    }

    // Sort by modification time descending (newest first).
    results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    return results;
  }

  /**
   * F-SA: descend into one `<session-id>/` directory and surface its sub-agent
   * transcripts + workflow-run manifests:
   *   - subagents/agent-<id>.jsonl               (regular sub-agents)
   *   - subagents/workflows/wf_<id>/agent-<id>.jsonl (workflow sub-agents)
   *   - workflows/wf_<id>.json                    (run manifests)
   * `*.meta.json` sidecars are read into `metadata`, never discovered as files.
   */
  private async discoverSessionSidecars(
    results: DiscoveredFile[],
    sinceDate: Date | null,
    sessionDirPath: string,
    sessionDirName: string,
    projectPath: string,
  ): Promise<void> {
    const subagentsDir = path.join(sessionDirPath, "subagents");

    // Regular sub-agents (depth 4).
    await this.discoverAgentDir(results, sinceDate, subagentsDir, {
      sessionDirName,
      projectPath,
    });

    // Workflow sub-agents (depth 6): subagents/workflows/wf_*/agent-*.jsonl.
    const wfAgentsRoot = path.join(subagentsDir, "workflows");
    for (const runDir of await readDirSafe(wfAgentsRoot)) {
      if (!runDir.isDirectory() || !runDir.name.startsWith("wf_")) continue;
      await this.discoverAgentDir(
        results,
        sinceDate,
        path.join(wfAgentsRoot, runDir.name),
        { sessionDirName, projectPath, workflowRunId: runDir.name },
      );
    }

    // Workflow run manifests: workflows/wf_*.json (a NEW file per run -> the
    // incremental-safe source for workflow_runs).
    const manifestsDir = path.join(sessionDirPath, "workflows");
    for (const m of await readDirSafe(manifestsDir)) {
      if (!m.isFile() || !m.name.startsWith("wf_") || !m.name.endsWith(".json")) {
        continue;
      }
      const absolutePath = path.join(manifestsDir, m.name);
      const metadata = await readJsonFile(absolutePath);
      await this.pushFile(results, sinceDate, {
        absolutePath,
        projectPath,
        sessionId: sessionDirName,
        isSidechain: false,
        kind: "workflow-manifest",
        parentSessionId: sessionDirName,
        workflowRunId: path.basename(m.name, ".json"),
        metadata: metadata ?? undefined,
      });
    }
  }

  /**
   * F-SA: surface every `agent-*.jsonl` transcript in a single agents dir,
   * reading each one's sibling `agent-*.meta.json` into `metadata`. Skips
   * `*.meta.json` and any non-agent file.
   */
  private async discoverAgentDir(
    results: DiscoveredFile[],
    sinceDate: Date | null,
    dir: string,
    ctx: { sessionDirName: string; projectPath: string; workflowRunId?: string },
  ): Promise<void> {
    for (const entry of await readDirSafe(dir)) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith("agent-") ||
        !entry.name.endsWith(".jsonl")
      ) {
        continue;
      }
      const base = path.basename(entry.name, ".jsonl");
      const metadata = await readJsonFile(path.join(dir, `${base}.meta.json`));
      const { agentId } = parseAgentFilename(entry.name);
      await this.pushFile(results, sinceDate, {
        absolutePath: path.join(dir, entry.name),
        projectPath: ctx.projectPath,
        // Provisional: the adapter re-keys parent attribution on the record's
        // own inner sessionId. Populated here so the field is never empty.
        sessionId: ctx.sessionDirName,
        isSidechain: true,
        kind: "subagent",
        agentId,
        parentSessionId: ctx.sessionDirName,
        workflowRunId: ctx.workflowRunId,
        metadata: metadata ?? undefined,
      });
    }
  }

  /**
   * Stat a candidate path, apply the `since` filter, and push a fully-formed
   * {@link DiscoveredFile}. Shared by every discovery branch so the stat +
   * since logic lives in exactly one place.
   */
  private async pushFile(
    results: DiscoveredFile[],
    sinceDate: Date | null,
    fields: Omit<DiscoveredFile, "sizeBytes" | "modifiedAt">,
  ): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(fields.absolutePath);
    } catch {
      return; // Skip files that can't be stat'd.
    }
    if (sinceDate && stat.mtime < sinceDate) {
      return;
    }
    results.push({ ...fields, sizeBytes: stat.size, modifiedAt: stat.mtime });
  }
}

/** readdir({withFileTypes}) that returns [] instead of throwing on ENOENT. */
async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Best-effort JSON.parse of a sidecar file; returns null on any failure. */
async function readJsonFile(
  absolutePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(absolutePath, "utf-8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
