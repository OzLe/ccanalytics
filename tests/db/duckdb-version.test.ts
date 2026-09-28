/**
 * @module tests/db/duckdb-version
 *
 * Guards the DuckDB pin. 1.4.4 lost rows from secondary ART indexes when it
 * replayed the WAL, and 1.4.5 also fixes a silent string corruption on reverted
 * appends (docs/filtered-query-misses-2026-09-28.md). The CLI and the dashboard
 * server load @duckdb/node-api from two node_modules trees — the dashboard's
 * POST /api/ingest runs parent-package code in the server process — so both
 * manifests must pin the same exact version.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

function pinned(manifest: string): string {
  const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), manifest), "utf-8"));
  return pkg.dependencies["@duckdb/node-api"];
}

describe("DuckDB version", () => {
  it("runs DuckDB 1.4.5 or newer", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    const reader = await connection.runAndReadAll("SELECT library_version FROM pragma_version()");
    const version = String(reader.getRowObjectsJS()[0].library_version);
    connection.closeSync();

    const [major, minor, patch] = version.replace(/^v/, "").split(".").map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch, version).toBeGreaterThanOrEqual(1_004_005);
  });

  it("pins the same exact @duckdb/node-api version for the CLI and the dashboard", () => {
    const cli = pinned("package.json");
    expect(cli).toMatch(/^\d+\.\d+\.\d+(-r\.\d+)?$/);
    expect(pinned("dashboard/package.json")).toBe(cli);
  });
});
