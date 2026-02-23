/**
 * @module utils/paths
 *
 * Path utilities for resolving Claude Code data directories,
 * encoding/decoding project paths, and extracting session IDs.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

/**
 * Find the Claude data directory by checking known locations.
 * Checks ~/.claude first, then ~/.config/claude (v1.0.30+ path).
 *
 * @param explicit - Explicit path override (highest priority)
 * @returns Resolved absolute path to the Claude data directory
 * @throws Error if no directory is found
 */
export async function findClaudeDir(explicit?: string): Promise<string> {
  if (explicit) {
    const expanded = expandHome(explicit);
    try {
      await fs.access(expanded);
      return expanded;
    } catch {
      throw new Error(`Specified Claude directory not found: ${expanded}`);
    }
  }

  const candidates = [
    path.join(os.homedir(), ".claude"),
    path.join(os.homedir(), ".config", "claude"),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to next candidate
    }
  }

  throw new Error(
    `Claude data directory not found. Checked: ${candidates.join(", ")}. Is Claude Code installed?`,
  );
}

/**
 * Encode an absolute file path to the Claude project directory format.
 * Replaces path separators with dashes.
 *
 * @example
 * encodeProjectPath("/Users/sam/Projects/my-app")
 * // => "-Users-sam-Projects-my-app"
 *
 * @param absolutePath - Absolute filesystem path
 * @returns Encoded directory name string
 */
export function encodeProjectPath(absolutePath: string): string {
  // Replace all path separators with dashes
  return absolutePath.replace(/\//g, "-");
}

/**
 * Decode an encoded project directory name back to an absolute path.
 * Leading dash becomes "/" (Unix root).
 *
 * @example
 * decodeProjectPath("-Users-sam-Projects-my-app")
 * // => "/Users/sam/Projects/my-app"
 *
 * @param encoded - Encoded directory name from Claude projects folder
 * @returns Decoded absolute filesystem path
 */
export function decodeProjectPath(encoded: string): string {
  if (!encoded || encoded === "-") {
    return "/";
  }
  // Leading dash represents root slash
  return encoded.replace(/-/g, "/");
}

/**
 * Get the projects directory within the Claude data directory.
 *
 * @param claudeDir - Path to Claude data directory
 * @returns Path to the projects subdirectory
 */
export function getProjectsDir(claudeDir: string): string {
  return path.join(claudeDir, "projects");
}

/**
 * Expand ~ to the user's home directory in a path string.
 *
 * @param filepath - Path potentially starting with ~
 * @returns Path with ~ expanded to home directory
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith("~")) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

/**
 * Extract session ID and sidechain flag from a JSONL filename.
 *
 * @example
 * extractSessionId("abc123-def456.jsonl")
 * // => { sessionId: "abc123-def456", isSidechain: false }
 *
 * extractSessionId("agent-abc123.jsonl")
 * // => { sessionId: "abc123", isSidechain: true }
 *
 * @param filename - JSONL filename (with or without path)
 * @returns Session ID and whether this is a sub-agent sidechain file
 */
export function extractSessionId(filename: string): {
  sessionId: string;
  isSidechain: boolean;
} {
  const basename = path.basename(filename, ".jsonl");

  if (basename.startsWith("agent-")) {
    return {
      sessionId: basename.slice("agent-".length),
      isSidechain: true,
    };
  }

  return {
    sessionId: basename,
    isSidechain: false,
  };
}

/**
 * Ensure a directory exists, creating it and parents if needed.
 *
 * @param dirPath - Directory path to ensure exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
