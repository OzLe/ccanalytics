/**
 * @module tests/server/parseFilters
 *
 * Tests for `parseFilters()` (dashboard/src/server/helpers/parseFilters.ts).
 *
 * The two ACT-001 / SEM2-293 invariants this file enforces:
 *   1. `userTimezone` is resolved with strict precedence:
 *      `X-User-Timezone` header > config.json `display.userTimezone` > 'UTC'.
 *   2. Invalid input at any layer silently falls through to the next, so a
 *      bogus header (e.g. from curl) doesn't shadow a valid config value.
 *      The PUT /api/settings handler is the surface that rejects bad input
 *      loudly — analyzer / parseFilters always degrades to UTC.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Request } from "express";
import { parseFilters } from "../../dashboard/src/server/helpers/parseFilters.js";

/** Lightweight Request stand-in — parseFilters only uses query + header. */
function mockRequest(opts: {
  query?: Record<string, string>;
  headers?: Record<string, string>;
}): Request {
  const query = opts.query ?? {};
  const headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    query,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe("parseFilters userTimezone resolution", () => {
  let tmpDir: string;
  let configPath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-pf-"));
    configPath = path.join(tmpDir, "config.json");
    prevEnv = process.env.CCANALYTICS_CONFIG_PATH;
    process.env.CCANALYTICS_CONFIG_PATH = configPath;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CCANALYTICS_CONFIG_PATH;
    else process.env.CCANALYTICS_CONFIG_PATH = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to UTC when neither header nor config supplies a tz", () => {
    const f = parseFilters(mockRequest({ query: { period: "7d" } }));
    expect(f.userTimezone).toBe("UTC");
    expect(f.period).toBe("7d");
  });

  it("reads `display.userTimezone` from config.json when the header is absent", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ display: { userTimezone: "Asia/Jerusalem" } }),
    );
    const f = parseFilters(mockRequest({}));
    expect(f.userTimezone).toBe("Asia/Jerusalem");
  });

  it("X-User-Timezone header takes precedence over config.json", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ display: { userTimezone: "Asia/Jerusalem" } }),
    );
    const f = parseFilters(
      mockRequest({ headers: { "X-User-Timezone": "America/New_York" } }),
    );
    expect(f.userTimezone).toBe("America/New_York");
  });

  it("invalid header falls through to config.json value", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ display: { userTimezone: "Asia/Jerusalem" } }),
    );
    const f = parseFilters(
      mockRequest({ headers: { "X-User-Timezone": "Bogus/NotReal" } }),
    );
    expect(f.userTimezone).toBe("Asia/Jerusalem");
  });

  it("invalid header + missing config falls through to UTC", () => {
    const f = parseFilters(
      mockRequest({ headers: { "X-User-Timezone": "Bogus/NotReal" } }),
    );
    expect(f.userTimezone).toBe("UTC");
  });

  it("invalid config tz silently degrades to UTC (does not 500 the request)", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ display: { userTimezone: "Atlantis/Lost" } }),
    );
    const f = parseFilters(mockRequest({}));
    expect(f.userTimezone).toBe("UTC");
  });

  it("malformed config.json silently degrades to UTC", () => {
    fs.writeFileSync(configPath, "{ this is not JSON ");
    const f = parseFilters(mockRequest({}));
    expect(f.userTimezone).toBe("UTC");
  });

  it("preserves model/project/source query params alongside the timezone resolution", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ display: { userTimezone: "Asia/Jerusalem" } }),
    );
    const f = parseFilters(
      mockRequest({
        query: {
          period: "30d",
          model: "opus",
          project: "tooling/ccanalytics",
          source: "claude-code",
        },
      }),
    );
    expect(f.userTimezone).toBe("Asia/Jerusalem");
    expect(f.model).toBe("opus");
    expect(f.project).toBe("tooling/ccanalytics");
    expect(f.source).toBe("claude-code");
    expect(f.period).toBe("30d");
  });
});
