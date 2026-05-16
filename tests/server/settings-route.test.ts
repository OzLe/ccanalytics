/**
 * @module tests/server/settings-route
 *
 * End-to-end tests for the /api/settings route (dashboard side). Mounts the
 * router on a real express app over a real http listener so the JSON body
 * parsing, error handling, and response envelope are all exercised.
 *
 * Covers (ACT-001 / SEM2-293):
 *   - GET returns the DEFAULT_DISPLAY fallback (`userTimezone: 'UTC'`) when
 *     no config exists.
 *   - GET round-trips a `display.userTimezone` that's been PUT.
 *   - PUT 400s on an invalid IANA id, and GET still returns the previous
 *     value (atomic — bad PUT does NOT silently corrupt the on-disk config).
 *   - PUT preserves the `subscription` block when only `display` is sent
 *     (and vice versa) — shallow-merge invariant the route depends on so it
 *     never clobbers the other half of the config file.
 *   - Empty-string `userTimezone` normalises to UTC.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express, { type Express } from "express";
import settingsRouter from "../../dashboard/src/server/routes/settings.js";

interface ServerHandle {
  app: Express;
  server: http.Server;
  baseUrl: string;
}

async function startServer(): Promise<ServerHandle> {
  const app = express();
  app.use(express.json());
  app.use("/api/settings", settingsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr");
  return { app, server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function stopServer(h: ServerHandle): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

describe("settings route — display.userTimezone (ACT-001)", () => {
  let tmpDir: string;
  let configPath: string;
  let prevEnv: string | undefined;
  let h: ServerHandle;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-settings-"));
    configPath = path.join(tmpDir, "config.json");
    prevEnv = process.env.CCANALYTICS_CONFIG_PATH;
    process.env.CCANALYTICS_CONFIG_PATH = configPath;
    h = await startServer();
  });

  afterEach(async () => {
    await stopServer(h);
    if (prevEnv === undefined) delete process.env.CCANALYTICS_CONFIG_PATH;
    else process.env.CCANALYTICS_CONFIG_PATH = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET returns the default display block (UTC) when no config file exists", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        subscription: { tier: string; monthlyUSD: number };
        display: { userTimezone: string };
      };
    };
    expect(body.data.display.userTimezone).toBe("UTC");
    // Subscription defaults too (sanity for the shared envelope shape).
    expect(body.data.subscription.tier).toBe("max-20x");
  });

  it("PUT display.userTimezone then GET round-trips the value", async () => {
    const putRes = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { userTimezone: "Asia/Jerusalem" } }),
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      data: { display: { userTimezone: string } };
    };
    expect(putBody.data.display.userTimezone).toBe("Asia/Jerusalem");

    const getRes = await fetch(`${h.baseUrl}/api/settings`);
    const getBody = (await getRes.json()) as {
      data: { display: { userTimezone: string } };
    };
    expect(getBody.data.display.userTimezone).toBe("Asia/Jerusalem");

    // On-disk view matches.
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      display: { userTimezone: string };
    };
    expect(onDisk.display.userTimezone).toBe("Asia/Jerusalem");
  });

  it("PUT 400s on an invalid IANA id; GET still returns the previous value", async () => {
    // Seed a valid value.
    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { userTimezone: "America/New_York" } }),
    });

    // Bad PUT.
    const badRes = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { userTimezone: "Bogus/NotReal" } }),
    });
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { error: string };
    expect(badBody.error).toBe("Bad request");

    // Previous value preserved.
    const getRes = await fetch(`${h.baseUrl}/api/settings`);
    const getBody = (await getRes.json()) as {
      data: { display: { userTimezone: string } };
    };
    expect(getBody.data.display.userTimezone).toBe("America/New_York");
  });

  it("empty-string userTimezone normalises to UTC (an explicit reset)", async () => {
    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { userTimezone: "Asia/Jerusalem" } }),
    });
    const resetRes = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { userTimezone: "" } }),
    });
    expect(resetRes.status).toBe(200);
    const body = (await resetRes.json()) as {
      data: { display: { userTimezone: string } };
    };
    expect(body.data.display.userTimezone).toBe("UTC");
  });

  it("PUT with only `display` preserves the existing `subscription` block", async () => {
    // Set both.
    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: { tier: "pro" },
        display: { userTimezone: "UTC" },
      }),
    });

    // PUT only display.
    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { userTimezone: "Asia/Tokyo" } }),
    });

    const getRes = await fetch(`${h.baseUrl}/api/settings`);
    const body = (await getRes.json()) as {
      data: {
        subscription: { tier: string; monthlyUSD: number };
        display: { userTimezone: string };
      };
    };
    expect(body.data.subscription.tier).toBe("pro");
    expect(body.data.display.userTimezone).toBe("Asia/Tokyo");
  });

  it("PUT with only `subscription` preserves the existing `display` block", async () => {
    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { userTimezone: "Asia/Jerusalem" } }),
    });

    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: { tier: "max-5x" } }),
    });

    const getRes = await fetch(`${h.baseUrl}/api/settings`);
    const body = (await getRes.json()) as {
      data: {
        subscription: { tier: string; monthlyUSD: number };
        display: { userTimezone: string };
      };
    };
    expect(body.data.subscription.tier).toBe("max-5x");
    expect(body.data.display.userTimezone).toBe("Asia/Jerusalem");
  });

  it("PUT with neither key returns 400", async () => {
    const res = await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PUT preserves an UNKNOWN top-level key in the config file (does not clobber)", async () => {
    // Seed config with an extra key the route doesn't recognise.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        subscription: { tier: "pro", monthlyUSD: 20 },
        dbPath: "/some/custom/path/analytics.duckdb",
      }),
    );
    await fetch(`${h.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display: { userTimezone: "Europe/Berlin" } }),
    });
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      subscription?: { tier: string };
      display?: { userTimezone: string };
      dbPath?: string;
    };
    expect(onDisk.dbPath).toBe("/some/custom/path/analytics.duckdb");
    expect(onDisk.display?.userTimezone).toBe("Europe/Berlin");
    expect(onDisk.subscription?.tier).toBe("pro");
  });
});
