/**
 * @module tests/commands/recommend
 *
 * Integration tests for the `ccanalytics recommend` CLI command (§6 / §7.4).
 *
 * Drives the REAL registered Commander command (via `registerRecommendCommand`)
 * against a TEMP file-based DuckDB seeded with a few assistant turns, asserting
 * that each `--format table|json|csv` runs and that the JSON form carries the
 * recommendation fields (verdict / confidence / caveat).
 *
 * Isolation (mirrors the activity / settings route tests):
 *   - `--db <temp>` points at a throwaway DuckDB file — the live
 *     ~/.ccanalytics/analytics.duckdb (LaunchAgent-locked) is NEVER touched.
 *   - A temp `.ccanalyticsrc.json` is discovered via `process.cwd()` (first in
 *     loadConfig's candidate list) so the command reads OUR tier, not the dev
 *     machine's ~/.ccanalytics/config.json. cwd + the file are restored/removed
 *     on teardown.
 */

import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { ConnectionManager } from "../../src/db/connection.js";
import { SchemaManager } from "../../src/db/schema.js";
import { registerRecommendCommand } from "../../src/commands/recommend.js";

/**
 * Seed a single 5-hour window whose summed tokens EXCEED the Pro 5h token
 * ceiling (45 × 35,000 = 1,575,000), so a "pro" tier yields a clear,
 * non-trivial signal. Three turns within ~1h, each 700k tokens → 2.1M.
 */
/** Temp DuckDB path, set in beforeAll; referenced by the runner closure. */
let dbPath = "";

async function seedBurst(dbPath: string): Promise<void> {
  const db = new ConnectionManager();
  await db.open(dbPath);
  const schema = new SchemaManager();
  await schema.initialize(db.getConnection());
  await schema.migrate(db.getConnection());
  const conn = db.getConnection();
  await conn.run(`
    INSERT INTO sessions (session_id, start_time, project_path, model)
    VALUES ('cs-1', '2026-03-01 09:00:00', '/p/burst', 'claude-sonnet-4-5')
  `);
  await conn.run(`
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cost_usd, model, stop_reason, request_id, has_tool_use, has_thinking)
    VALUES
      ('ct-1', 'cs-1', 'assistant', '2026-03-01 09:00:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'creq-1', FALSE, FALSE),
      ('ct-2', 'cs-1', 'assistant', '2026-03-01 09:30:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'creq-2', FALSE, FALSE),
      ('ct-3', 'cs-1', 'assistant', '2026-03-01 10:00:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'creq-3', FALSE, FALSE)
  `);
  await db.close();
}

/**
 * Build a fresh Commander program with the same global options `createProgram`
 * registers, plus the `recommend` subcommand under test, and run it. The global
 * `--db <temp>` is prepended so the command opens our throwaway DuckDB (never
 * the live, LaunchAgent-locked one). `subArgs` is the `recommend ...` tail.
 * Returns the captured stdout.
 *
 * The command never calls `process.exit` on the happy path, so it is safe to
 * drive inside the test process.
 */
async function runRecommend(subArgs: string[]): Promise<string> {
  const program = new Command();
  program
    .name("ccanalytics")
    .option("--db <path>", "Path to DuckDB database file")
    .option("--claude-dir <path>", "Path to Claude data directory")
    .option("--format <fmt>", "Output format: table, json, csv", "table")
    .option("--verbose", "Enable verbose logging", false);
  registerRecommendCommand(program);

  let out = "";
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out += a.join(" ") + "\n";
  });
  try {
    await program.parseAsync(["node", "ccanalytics", "--db", dbPath, ...subArgs]);
  } finally {
    logSpy.mockRestore();
  }
  return out;
}

describe("recommend command", () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-rec-cmd-"));
    dbPath = path.join(tmpDir, "test.duckdb");
    // A discovered config file pins the tier to "pro" so the verdict logic
    // exercises a real up/downgrade neighbour (not the default max-20x).
    fs.writeFileSync(
      path.join(tmpDir, ".ccanalyticsrc.json"),
      JSON.stringify({
        subscription: { tier: "pro", monthlyUSD: 20 },
        recommendation: { autoCalibrate: true },
      }) + "\n",
      "utf-8",
    );
    prevCwd = process.cwd();
    process.chdir(tmpDir);
    await seedBurst(dbPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits the recommendation fields in JSON output", async () => {
    const out = await runRecommend(["recommend", "--period", "all", "--format", "json"]);
    const parsed = JSON.parse(out);
    // Top-level analysis shape.
    expect(parsed.tier).toBe("pro");
    expect(parsed.caveat).toBe(
      "Estimate from local session data; Anthropic's exact limits are not published.",
    );
    expect(parsed.windowStats5h).toBeDefined();
    expect(parsed.perModelWeekly.all).toBeDefined();
    expect(parsed.perModelWeekly.sonnet).toBeDefined();
    expect(parsed.perModelWeekly.opus).toBeDefined();
    // Nested recommendation fields.
    expect(["upgrade", "downgrade", "stay", "neutral"]).toContain(
      parsed.recommendation.verdict,
    );
    expect(["low", "medium", "high"]).toContain(parsed.recommendation.confidence);
    expect(parsed.recommendation.caveat).toBe(parsed.caveat);
  });

  it("renders a labelled table with the tier + fill rows and the caveat", async () => {
    const out = await runRecommend(["recommend", "--period", "all", "--format", "table"]);
    expect(out).toContain("Current tier");
    expect(out).toContain("pro");
    expect(out).toContain("5h window peak fill");
    expect(out).toContain("Verdict");
    expect(out).toContain("Anthropic's exact limits are not published");
  });

  it("renders CSV with a header row", async () => {
    const out = await runRecommend(["recommend", "--period", "all", "--format", "csv"]);
    expect(out).toContain("Metric,Value");
    expect(out).toContain("Current tier,pro");
  });

  it("defaults to the 30d period and table format when no flags are given", async () => {
    // No --period / --format. Global format default is "table". Must run without
    // throwing and still print the labelled table.
    const out = await runRecommend(["recommend"]);
    expect(out).toContain("Current tier");
    expect(out).toContain("Recommendation");
  });
});
