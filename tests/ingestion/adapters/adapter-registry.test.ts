/**
 * Tests for the adapter registry (createAdapters factory).
 */

import { describe, it, expect } from "vitest";
import { createAdapters } from "../../../src/ingestion/adapters/index.js";
import { ClaudeCodeAdapter } from "../../../src/ingestion/adapters/claude-code.js";
import { ClaudeDesktopAdapter } from "../../../src/ingestion/adapters/claude-desktop.js";
import type { CCAnalyticsConfig } from "../../../src/types/config.js";

function makeConfig(overrides?: Partial<CCAnalyticsConfig>): CCAnalyticsConfig {
  return {
    dbPath: "/tmp/test.duckdb",
    claudeDir: "/tmp/.claude",
    desktopDataDir: "/tmp/claude-desktop",
    sources: ["claude-code", "claude-desktop"],
    format: "table",
    verbose: false,
    ingestion: { globPattern: "**/*.jsonl", batchSize: 1000, minFileSize: 0, maxAgeDays: 30 },
    watcher: { patterns: [], stabilityThreshold: 2000, debounceMs: 500, pollInterval: 2000, usePolling: false, maxBatchSize: 50 },
    database: { logQueries: false, memoryLimit: "256MB", threads: 0 },
    ...overrides,
  };
}

describe("createAdapters", () => {
  it("creates both adapters by default", () => {
    const adapters = createAdapters(makeConfig());
    expect(adapters).toHaveLength(2);
    expect(adapters[0]).toBeInstanceOf(ClaudeCodeAdapter);
    expect(adapters[1]).toBeInstanceOf(ClaudeDesktopAdapter);
  });

  it("filters to claude-code only", () => {
    const adapters = createAdapters(makeConfig(), "claude-code");
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("filters to claude-desktop only", () => {
    const adapters = createAdapters(makeConfig(), "claude-desktop");
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toBeInstanceOf(ClaudeDesktopAdapter);
  });

  it("accepts array of source types", () => {
    const adapters = createAdapters(makeConfig(), ["claude-code"]);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("uses config.sources when no filter provided", () => {
    const adapters = createAdapters(makeConfig({ sources: ["claude-desktop"] }));
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toBeInstanceOf(ClaudeDesktopAdapter);
  });
});
