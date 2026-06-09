/**
 * @module tests/server/recommendation-route
 *
 * End-to-end integration tests for /api/recommendation (read-only) plus the
 * settings round-trip for the new `recommendation` config block. Mirrors the
 * isolation harness in tests/server/activity-route.test.ts exactly:
 *
 *   - `DB_PATH=<temp>.duckdb` is set BEFORE the first dynamic import of the
 *     route + db helper (the helper caches its singleton connection on first
 *     call), so the route reads a temp fixture DB — NEVER the LaunchAgent-
 *     locked live ~/.ccanalytics/analytics.duckdb.
 *   - `CCANALYTICS_CONFIG_PATH=<temp>/config.json` so the route reads an
 *     isolated config instead of the dev machine's ~/.ccanalytics/config.json
 *     (which the LaunchAgent also reads). Both env vars are saved/restored.
 *
 * Coverage:
 *   - GET /api/recommendation?period=all returns 200 with the recommendation
 *     verdict, the estimate caveat, the 5h/weekly window stats, and the
 *     per-model weekly keys (all / sonnet / opus).
 *   - autoCalibrate=false in the isolated config pins ceilingSource="default"
 *     even on a high-usage fixture; autoCalibrate=true flips it to "calibrated".
 *   - Param-index regression: ?period=7d&model&project + X-User-Timezone runs
 *     without a SQL `$N` error (the same guard the activity test asserts).
 *   - Settings round-trip: PUT a `recommendation` block, GET it back, and prove
 *     the other top-level keys (subscription/display/unknown) are NOT clobbered;
 *     malformed `recommendation` is rejected 400.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express, { type Express } from "express";
import { RECOMMENDATION_ESTIMATE_CAVEAT } from "../../src/config/limits.js";

/** Shape of the recommendation analysis payload (subset asserted here). */
interface RecommendationPayload {
  data: {
    tier: string;
    windowStats5h: { peakFill: number; activeWindows: number };
    weeklyStats: { peakFill: number };
    perModelWeekly: {
      all: { peakFill: number };
      sonnet: { peakFill: number };
      opus: { peakFill: number };
    };
    ceilings: { default: unknown; calibrated: unknown };
    ceilingSource: "default" | "calibrated";
    recommendation: {
      verdict: "upgrade" | "downgrade" | "stay" | "neutral";
      currentTier: string;
      confidence: "low" | "medium" | "high";
    };
    caveat: string;
  };
  meta: { period: string };
}

interface Handle {
  baseUrl: string;
  tmpDir: string;
  configPath: string;
  close: () => Promise<void>;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR PRIMARY KEY,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    duration_seconds INTEGER,
    model VARCHAR,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cache_creation_tokens BIGINT,
    cache_read_tokens BIGINT,
    total_cost_usd DOUBLE,
    num_turns INTEGER,
    num_tool_calls INTEGER,
    project_path VARCHAR,
    project_name VARCHAR,
    source_type VARCHAR
  );
  CREATE TABLE IF NOT EXISTS conversation_turns (
    turn_id VARCHAR PRIMARY KEY,
    session_id VARCHAR,
    role VARCHAR,
    timestamp TIMESTAMP,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cache_creation_tokens BIGINT,
    cache_read_tokens BIGINT,
    cost_usd DOUBLE,
    model VARCHAR,
    stop_reason VARCHAR,
    request_id VARCHAR,
    has_tool_use BOOLEAN,
    has_thinking BOOLEAN
  );
`;

/**
 * Boot the recommendation + settings routers against a fresh DuckDB file
 * seeded with a controlled, high-usage fixture, plus an isolated config file
 * whose contents the caller supplies.
 *
 * The fixture seeds a burst inside one 5-hour window whose summed tokens
 * exceed the Pro 5h token ceiling (45 × 35,000 = 1,575,000), so a tier=pro
 * recommendation must auto-calibrate when enabled. It also spans sonnet + opus
 * across two distinct weeks so the per-model weekly split is non-trivial.
 *
 * @param initialConfig - JSON written to the temp config.json before boot.
 */
async function bootRouter(
  initialConfig: Record<string, unknown>,
): Promise<Handle> {
  // db.ts caches the connection at module scope; close any prior one so the new
  // DB_PATH takes effect on the next getConnection() call (multiple describe
  // blocks reuse the same module instance — exactly like activity-route.test).
  try {
    const existing = await import("../../dashboard/src/server/helpers/db.js");
    await existing.closeDb();
  } catch {
    /* first call — no module yet */
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-reco-"));
  const dbPath = path.join(tmpDir, "test.duckdb");
  const configPath = path.join(tmpDir, "config.json");
  process.env.DB_PATH = dbPath;
  process.env.CCANALYTICS_CONFIG_PATH = configPath;
  fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2) + "\n");

  // Dynamic imports AFTER the env vars are set so initConnection() + the
  // settings/parseFilters config readers honour the temp paths.
  const { default: recommendationRouter } = await import(
    "../../dashboard/src/server/routes/recommendation.js"
  );
  const { default: settingsRouter } = await import(
    "../../dashboard/src/server/routes/settings.js"
  );
  const dbHelper = await import("../../dashboard/src/server/helpers/db.js");

  await dbHelper.query(SCHEMA_SQL);

  // High-usage fixture: a 3-turn burst in one ~1h window (each 700k tokens →
  // 2.1M > the Pro 1.575M 5h token ceiling → calibration must engage), then an
  // opus turn a clear week later so the weekly split shows both classes.
  await dbHelper.query(`
    INSERT INTO sessions VALUES
      ('rs-1', '2026-03-01 09:00:00', '2026-03-01 10:01:00', 3660, 'claude-sonnet-4-5', 1, 1, 0, 0, 1.5, 3, 0, '/p/burst', 'burst', 'claude-code'),
      ('rs-2', '2026-03-10 09:00:00', '2026-03-10 09:01:00', 60,   'claude-opus-4',     1, 1, 0, 0, 0.5, 1, 0, '/p/burst', 'burst', 'claude-code');
    INSERT INTO conversation_turns VALUES
      ('rt-1', 'rs-1', 'assistant', '2026-03-01 09:00:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'breq-1', FALSE, FALSE),
      ('rt-2', 'rs-1', 'assistant', '2026-03-01 09:30:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'breq-2', FALSE, FALSE),
      ('rt-3', 'rs-1', 'assistant', '2026-03-01 10:00:00', 700000, 0, 0, 0, 0.5, 'claude-sonnet-4-5', 'end_turn', 'breq-3', FALSE, FALSE),
      ('rt-4', 'rs-2', 'assistant', '2026-03-10 09:00:00', 700000, 0, 0, 0, 0.5, 'claude-opus-4',      'end_turn', 'breq-4', FALSE, FALSE);
  `);

  const app: Express = express();
  app.use(express.json());
  app.use("/api/recommendation", recommendationRouter);
  app.use("/api/settings", settingsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    tmpDir,
    configPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dbHelper.closeDb();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("recommendation route — GET /api/recommendation (read-only)", () => {
  let h: Handle;
  let prevDbPath: string | undefined;
  let prevConfigPath: string | undefined;

  beforeAll(async () => {
    prevDbPath = process.env.DB_PATH;
    prevConfigPath = process.env.CCANALYTICS_CONFIG_PATH;
    // tier=pro so the burst (2.1M tokens) clearly exceeds the Pro 5h ceiling.
    h = await bootRouter({ subscription: { tier: "pro", monthlyUSD: 20 } });
  });

  afterAll(async () => {
    await h.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    if (prevConfigPath === undefined) delete process.env.CCANALYTICS_CONFIG_PATH;
    else process.env.CCANALYTICS_CONFIG_PATH = prevConfigPath;
  });

  it("returns 200 with the recommendation payload shape + estimate caveat", async () => {
    const res = await fetch(`${h.baseUrl}/api/recommendation?period=all`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecommendationPayload;

    // Standard envelope.
    expect(body.meta.period).toBe("all");

    // The tier flows through from the isolated config.
    expect(body.data.tier).toBe("pro");

    // Recommendation verdict shape.
    expect(body.data.recommendation).toBeDefined();
    expect(["upgrade", "downgrade", "stay", "neutral"]).toContain(
      body.data.recommendation.verdict,
    );
    expect(body.data.recommendation.currentTier).toBe("pro");
    expect(["low", "medium", "high"]).toContain(
      body.data.recommendation.confidence,
    );

    // Window stats present.
    expect(body.data.windowStats5h.activeWindows).toBeGreaterThan(0);
    expect(typeof body.data.windowStats5h.peakFill).toBe("number");
    expect(typeof body.data.weeklyStats.peakFill).toBe("number");

    // Per-model weekly split keys.
    expect(body.data.perModelWeekly.all).toBeDefined();
    expect(body.data.perModelWeekly.sonnet).toBeDefined();
    expect(body.data.perModelWeekly.opus).toBeDefined();

    // Estimate caveat is surfaced on the payload (every surface must show it).
    expect(body.data.caveat).toBe(RECOMMENDATION_ESTIMATE_CAVEAT);

    // Default autoCalibrate (config has no `recommendation` block) is ON, and
    // the burst exceeds the Pro 5h token ceiling, so calibration must engage.
    expect(body.data.ceilingSource).toBe("calibrated");
  });

  it("param-index regression — ?period=7d&model&project + tz header executes without a SQL $N error", async () => {
    const res = await fetch(
      `${h.baseUrl}/api/recommendation?period=7d&model=sonnet&project=/p`,
      { headers: { "X-User-Timezone": "Asia/Jerusalem" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecommendationPayload;
    expect(body.meta.period).toBe("7d");
    expect(body.data.recommendation).toBeDefined();
  });

  it("rejects an unknown period with 400", async () => {
    const res = await fetch(`${h.baseUrl}/api/recommendation?period=bogus`);
    expect(res.status).toBe(400);
  });
});

describe("recommendation route — autoCalibrate=false pins ceilingSource=default", () => {
  let h: Handle;
  let prevDbPath: string | undefined;
  let prevConfigPath: string | undefined;

  beforeAll(async () => {
    prevDbPath = process.env.DB_PATH;
    prevConfigPath = process.env.CCANALYTICS_CONFIG_PATH;
    h = await bootRouter({
      subscription: { tier: "pro", monthlyUSD: 20 },
      recommendation: { autoCalibrate: false },
    });
  });

  afterAll(async () => {
    await h.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    if (prevConfigPath === undefined) delete process.env.CCANALYTICS_CONFIG_PATH;
    else process.env.CCANALYTICS_CONFIG_PATH = prevConfigPath;
  });

  it("ceilingSource is 'default' even though the burst exceeds the Pro ceiling", async () => {
    const res = await fetch(`${h.baseUrl}/api/recommendation?period=all`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecommendationPayload;
    expect(body.data.ceilingSource).toBe("default");
  });
});

describe("settings route — recommendation block round-trip (non-clobbering)", () => {
  let h: Handle;
  let prevDbPath: string | undefined;
  let prevConfigPath: string | undefined;

  beforeAll(async () => {
    prevDbPath = process.env.DB_PATH;
    prevConfigPath = process.env.CCANALYTICS_CONFIG_PATH;
    // Seed with subscription + display + an unknown key to prove preservation.
    h = await bootRouter({
      subscription: { tier: "max-5x", monthlyUSD: 100 },
      display: { userTimezone: "Asia/Jerusalem" },
      dbPath: "/some/custom/path/analytics.duckdb",
    });
  });

  afterAll(async () => {
    await h.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    if (prevConfigPath === undefined) delete process.env.CCANALYTICS_CONFIG_PATH;
    else process.env.CCANALYTICS_CONFIG_PATH = prevConfigPath;
  });

  it("GET resolves a recommendation block (defaults to autoCalibrate=true)", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { recommendation: { autoCalibrate: boolean } };
    };
    // Seed config has no `recommendation` key → default fallback.
    expect(body.data.recommendation.autoCalibrate).toBe(true);
  });

  it("PUT a recommendation block, GET it back; subscription/display/unknown preserved", async () => {
    const putRes = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recommendation: {
          autoCalibrate: false,
          ceilings: {
            pro: { fiveHourRequests: 60, weeklyRequests: 1500 },
            // An unknown tier + a bad numeric dimension must be sanitized away.
            team: { fiveHourRequests: 10 },
            "max-5x": { fiveHourTokens: -5, weeklyTokens: 9000000 },
          },
        },
      }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      data: {
        recommendation: {
          autoCalibrate: boolean;
          ceilings?: Record<string, Record<string, number>>;
        };
      };
    };
    expect(putBody.data.recommendation.autoCalibrate).toBe(false);
    expect(putBody.data.recommendation.ceilings?.pro?.fiveHourRequests).toBe(60);

    // GET round-trips.
    const getRes = await fetch(`${h.baseUrl}/api/settings`);
    const getBody = (await getRes.json()) as {
      data: {
        subscription: { tier: string };
        display: { userTimezone: string };
        recommendation: {
          autoCalibrate: boolean;
          ceilings?: Record<string, Record<string, number>>;
        };
      };
    };
    expect(getBody.data.recommendation.autoCalibrate).toBe(false);
    expect(getBody.data.recommendation.ceilings?.pro?.fiveHourRequests).toBe(60);
    expect(getBody.data.recommendation.ceilings?.pro?.weeklyRequests).toBe(1500);
    // Other keys preserved (the non-clobbering shallow-merge invariant).
    expect(getBody.data.subscription.tier).toBe("max-5x");
    expect(getBody.data.display.userTimezone).toBe("Asia/Jerusalem");

    // On-disk view: subscription/display/unknown key all survive; malformed
    // ceiling input was sanitized (unknown tier dropped; negative dim dropped).
    const onDisk = JSON.parse(fs.readFileSync(h.configPath, "utf-8")) as {
      subscription?: { tier: string };
      display?: { userTimezone: string };
      dbPath?: string;
      recommendation?: {
        autoCalibrate: boolean;
        ceilings?: Record<string, Record<string, number>>;
      };
    };
    expect(onDisk.subscription?.tier).toBe("max-5x");
    expect(onDisk.display?.userTimezone).toBe("Asia/Jerusalem");
    expect(onDisk.dbPath).toBe("/some/custom/path/analytics.duckdb");
    expect(onDisk.recommendation?.autoCalibrate).toBe(false);
    expect(onDisk.recommendation?.ceilings?.team).toBeUndefined();
    // The negative fiveHourTokens was dropped, but the valid weeklyTokens kept.
    expect(onDisk.recommendation?.ceilings?.["max-5x"]?.fiveHourTokens).toBeUndefined();
    expect(onDisk.recommendation?.ceilings?.["max-5x"]?.weeklyTokens).toBe(9000000);
  });

  it("PUT only `recommendation` preserves an already-persisted subscription", async () => {
    // First set a subscription explicitly.
    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: { tier: "max-20x" } }),
    });
    // Then PUT only recommendation.
    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendation: { autoCalibrate: true } }),
    });
    const getRes = await fetch(`${h.baseUrl}/api/settings`);
    const body = (await getRes.json()) as {
      data: {
        subscription: { tier: string };
        recommendation: { autoCalibrate: boolean };
      };
    };
    expect(body.data.subscription.tier).toBe("max-20x");
    expect(body.data.recommendation.autoCalibrate).toBe(true);
  });

  it("rejects a malformed recommendation body with 400", async () => {
    const arrayRes = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendation: [] }),
    });
    expect(arrayRes.status).toBe(400);

    const boolRes = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendation: { autoCalibrate: "yes" } }),
    });
    expect(boolRes.status).toBe(400);

    const ceilRes = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendation: { ceilings: "nope" } }),
    });
    expect(ceilRes.status).toBe(400);
  });
});
