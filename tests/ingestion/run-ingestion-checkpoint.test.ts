/**
 * @module tests/ingestion/run-ingestion-checkpoint
 *
 * runIngestion() checkpoints after writing, so the ingested rows live in the
 * database file rather than only in the WAL. Neither the CLI nor the dashboard
 * closes the DuckDB instance on exit, and replaying the WAL on the next open is
 * where DuckDB 1.4.4 lost index entries (docs/filtered-query-misses-2026-09-28.md).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runIngestion } from "../../src/ingestion/run-ingestion.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-checkpoint-"));
  const projectDir = path.join(tmpDir, "claude", "projects", "-tmp-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(
    path.resolve(process.cwd(), "tests/fixtures/multi-turn-session.jsonl"),
    path.join(projectDir, "sess-multi-001.jsonl"),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runIngestion checkpoint", () => {
  it("leaves no WAL to replay after an ingest that wrote rows", async () => {
    const dbPath = path.join(tmpDir, "analytics.duckdb");

    const { result } = await runIngestion({
      configOverrides: { dbPath, claudeDir: path.join(tmpDir, "claude") },
      source: "claude-code",
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.entriesIngested).toBeGreaterThan(0);
    const wal = `${dbPath}.wal`;
    expect(fs.existsSync(wal) ? fs.statSync(wal).size : 0).toBe(0);
  });
});
