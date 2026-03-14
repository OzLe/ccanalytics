/**
 * @module ingestion/file-backup
 *
 * Copies source JSONL files to a local backup directory during ingestion.
 * Prevents data loss if the upstream source (Claude Desktop, Claude Code)
 * cleans up or rotates its session files before the next ingestion run.
 *
 * Backup layout mirrors the source path relative to the user's home directory:
 *   ~/.ccanalytics/backups/Library/Application Support/Claude/local-agent-mode-sessions/…/audit.jsonl
 *   ~/.ccanalytics/backups/.claude/projects/-Users-oz-project/abc123.jsonl
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export class FileBackup {
  private backupDir: string;
  private homeDir: string;

  constructor(backupDir: string) {
    this.backupDir = backupDir;
    this.homeDir = os.homedir();
  }

  /**
   * Back up a source file if it's new or has grown since the last backup.
   * Returns true if a copy was made, false if the backup was already up-to-date.
   */
  async backupIfNeeded(absolutePath: string, sourceSizeBytes: number): Promise<boolean> {
    const dest = this.backupPath(absolutePath);

    // Check existing backup
    try {
      const stat = await fs.stat(dest);
      if (stat.size >= sourceSizeBytes) {
        return false; // backup is already at least as large — skip
      }
    } catch {
      // No backup exists yet — proceed
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(absolutePath, dest);
    return true;
  }

  /**
   * Convert a source absolute path to a backup path.
   * Strips the home directory prefix so the backup mirrors the relative structure.
   */
  backupPath(absolutePath: string): string {
    const relative = absolutePath.startsWith(this.homeDir + "/")
      ? absolutePath.slice(this.homeDir.length + 1)
      : absolutePath.replace(/^\//, "");
    return path.join(this.backupDir, relative);
  }
}
