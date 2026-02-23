/**
 * @module tests/queries/tool-analyzer
 *
 * Integration tests for the ToolAnalyzer class.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDB, closeTestDB, seedTestData, type TestDB } from "../helpers/db-setup.js";
import { QueryExecutor } from "../../src/db/executor.js";
import { ToolAnalyzer } from "../../src/queries/tool-analyzer.js";
import type { TimeRange } from "../../src/types/index.js";

describe("ToolAnalyzer", () => {
  let db: TestDB;
  let executor: QueryExecutor;
  let analyzer: ToolAnalyzer;

  const testRange: TimeRange = {
    start: new Date("2026-02-19T00:00:00Z"),
    end: new Date("2026-02-22T00:00:00Z"),
  };

  beforeEach(async () => {
    db = await createTestDB();
    executor = new QueryExecutor(db.connection);
    analyzer = new ToolAnalyzer(executor);
    await seedTestData(db.connection);
  });

  afterEach(async () => {
    await closeTestDB(db);
  });

  describe("getToolUsage", () => {
    it("should return usage stats for all tools", async () => {
      const results = await analyzer.getToolUsage(testRange);
      expect(results.length).toBeGreaterThan(0);
      const toolNames = results.map((r) => r.toolName);
      expect(toolNames).toContain("Read");
      expect(toolNames).toContain("Edit");
    });

    it("should include MCP server info for MCP tools", async () => {
      const results = await analyzer.getToolUsage(testRange);
      const mcpTool = results.find((r) => r.toolType === "mcp");
      expect(mcpTool).toBeDefined();
      expect(mcpTool!.mcpServer).toBeTruthy();
    });

    it("should compute success rates", async () => {
      const results = await analyzer.getToolUsage(testRange);
      const bash = results.find((r) => r.toolName === "Bash");
      expect(bash).toBeDefined();
      expect(bash!.successRate).toBe(0); // Bash had success=FALSE
    });
  });

  describe("getToolSuccessRates", () => {
    it("should return per-tool success rates", async () => {
      const results = await analyzer.getToolSuccessRates(testRange);
      expect(results.length).toBeGreaterThan(0);
      for (const rate of results) {
        expect(rate.totalCalls).toBeGreaterThan(0);
        expect(rate.successRate).toBeGreaterThanOrEqual(0);
        expect(rate.successRate).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("getMCPServerUsage", () => {
    it("should aggregate by MCP server", async () => {
      const results = await analyzer.getMCPServerUsage(testRange);
      expect(results.length).toBeGreaterThan(0);
      const servers = results.map((r) => r.serverName);
      expect(servers).toContain("github");
      expect(servers).toContain("google-sheets");
    });

    it("should include unique tools per server", async () => {
      const results = await analyzer.getMCPServerUsage(testRange);
      const github = results.find((r) => r.serverName === "github");
      expect(github).toBeDefined();
      expect(github!.uniqueTools.length).toBeGreaterThan(0);
    });
  });
});
