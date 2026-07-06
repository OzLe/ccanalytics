/**
 * @module tests/watcher/chokidar-manager
 *
 * F-SA: the file watcher must (a) resolve the `~`/glob pattern to a real
 * directory (chokidar v5 dropped glob support, so the old pattern matched
 * nothing) and (b) recurse into newly-created `<session>/subagents/` dirs while
 * ignoring `*.meta.json` sidecars.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir, homedir } from "node:os";
import * as path from "node:path";
import {
  ChokidarManager,
  toWatchRoot,
  ignorePath,
} from "../../src/watcher/chokidar-manager.js";

const fileStats = { isDirectory: () => false } as unknown as Stats;
const dirStats = { isDirectory: () => true } as unknown as Stats;

describe("toWatchRoot", () => {
  it("expands ~ and drops the glob tail", () => {
    expect(toWatchRoot("~/.claude/projects/**/*.jsonl")).toBe(
      path.join(homedir(), ".claude", "projects"),
    );
  });
  it("strips the glob tail from an absolute pattern", () => {
    expect(toWatchRoot("/abs/dir/**/*.jsonl")).toBe("/abs/dir");
  });
  it("returns a glob-free path unchanged (minus trailing slash)", () => {
    expect(toWatchRoot("/abs/plain/")).toBe("/abs/plain");
  });
});

describe("ignorePath", () => {
  it("ignores *.meta.json sidecars (even without stats)", () => {
    expect(ignorePath("/x/subagents/agent-a.meta.json")).toBe(true);
    expect(ignorePath("/x/subagents/agent-a.meta.json", fileStats)).toBe(true);
  });
  it("keeps session + sub-agent .jsonl transcripts", () => {
    expect(ignorePath("/x/sess.jsonl", fileStats)).toBe(false);
    expect(ignorePath("/x/subagents/agent-a.jsonl", fileStats)).toBe(false);
  });
  it("keeps wf_*.json manifests, ignores other files", () => {
    expect(ignorePath("/x/workflows/wf_123.json", fileStats)).toBe(false);
    expect(ignorePath("/x/notes.json", fileStats)).toBe(true);
    expect(ignorePath("/x/shot.png", fileStats)).toBe(true);
  });
  it("never ignores directories (traversal) or unresolved-stat paths", () => {
    expect(ignorePath("/x/subagents", dirStats)).toBe(false);
    expect(ignorePath("/x/subagents")).toBe(false);
  });
});

describe("ChokidarManager recursive sub-agent watch (integration)", () => {
  let mgr: ChokidarManager | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    if (mgr) {
      await mgr.stop();
      mgr = null;
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("fires for a new nested subagents/agent-*.jsonl and ignores its .meta.json", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "cca-watch-"));
    const subagents = path.join(dir, "projects", "-proj", "sessX", "subagents");
    mkdirSync(subagents, { recursive: true }); // dir exists, but empty at start

    mgr = new ChokidarManager();
    const seen: string[] = [];
    mgr.onFileChange((p) => seen.push(p));

    await mgr.start({
      patterns: [path.join(dir, "projects", "**", "*.jsonl")],
      stabilityThreshold: 50,
      pollInterval: 30,
      usePolling: true, // deterministic in CI where native FS events are flaky
    });

    const agentFile = path.join(subagents, "agent-abc.jsonl");
    writeFileSync(agentFile, '{"type":"assistant","sessionId":"sessX"}\n');
    writeFileSync(path.join(subagents, "agent-abc.meta.json"), '{"agentType":"x"}');

    const start = Date.now();
    while (Date.now() - start < 6000 && !seen.includes(agentFile)) {
      await new Promise((r) => setTimeout(r, 40));
    }

    expect(seen).toContain(agentFile);
    // The sidecar must never enqueue an ingest.
    expect(seen.some((p) => p.endsWith(".meta.json"))).toBe(false);
  }, 12000);
});
