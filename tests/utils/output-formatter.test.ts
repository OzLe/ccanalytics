/**
 * @module tests/utils/output-formatter
 *
 * Unit tests for the OutputFormatter class.
 */

import { describe, it, expect } from "vitest";
import { OutputFormatter } from "../../src/utils/format.js";
import type { TableColumn } from "../../src/utils/format.js";

describe("OutputFormatter", () => {
  const formatter = new OutputFormatter();

  const sampleRows: Record<string, unknown>[] = [
    { name: "Alice", age: 30, cost: 1.5 },
    { name: "Bob", age: 25, cost: 2.75 },
  ];

  const columns: TableColumn[] = [
    { header: "Name", key: "name" },
    { header: "Age", key: "age", align: "right" },
    { header: "Cost", key: "cost", align: "right", format: (v) => `$${Number(v).toFixed(2)}` },
  ];

  describe("formatTable", () => {
    it("should render a table string", () => {
      const result = formatter.formatTable(sampleRows, columns);
      expect(result).toContain("Name");
      expect(result).toContain("Age");
      expect(result).toContain("Alice");
      expect(result).toContain("$1.50");
    });

    it("should handle empty rows", () => {
      const result = formatter.formatTable([], columns);
      expect(result).toContain("Name");
    });

    it("should truncate to maxWidth", () => {
      const longRows = [{ name: "A very long name that exceeds the max width" }];
      const cols: TableColumn[] = [{ header: "Name", key: "name", maxWidth: 10 }];
      const result = formatter.formatTable(longRows, cols);
      expect(result).not.toContain("A very long name that exceeds the max width");
    });
  });

  describe("formatJson", () => {
    it("should return pretty-printed JSON", () => {
      const result = formatter.formatJson(sampleRows);
      const parsed = JSON.parse(result);
      expect(parsed).toEqual(sampleRows);
      expect(result).toContain("\n"); // Pretty-printed
    });
  });

  describe("formatCsv", () => {
    it("should produce CSV with headers", () => {
      const result = formatter.formatCsv(sampleRows, columns);
      const lines = result.split("\n");
      expect(lines[0]).toBe("Name,Age,Cost");
      expect(lines.length).toBe(3); // header + 2 data rows
    });

    it("should escape values with commas", () => {
      const rows = [{ name: "Last, First", age: 30, cost: 1 }];
      const result = formatter.formatCsv(rows, columns);
      expect(result).toContain('"Last, First"');
    });

    it("should escape values with double quotes", () => {
      const rows = [{ name: 'Say "hello"', age: 30, cost: 1 }];
      const result = formatter.formatCsv(rows, columns);
      expect(result).toContain('"Say ""hello"""');
    });

    it("should handle null/undefined values", () => {
      const rows = [{ name: null, age: undefined, cost: 0 }];
      const result = formatter.formatCsv(rows as any, columns);
      const dataLine = result.split("\n")[1];
      expect(dataLine).toBe(",,0");
    });
  });

  describe("auto", () => {
    it("should dispatch to formatTable for 'table'", () => {
      const result = formatter.auto(sampleRows, columns, "table");
      expect(result).toContain("Name");
      expect(result).toContain("Alice");
    });

    it("should dispatch to formatJson for 'json'", () => {
      const result = formatter.auto(sampleRows, columns, "json");
      expect(JSON.parse(result)).toEqual(sampleRows);
    });

    it("should dispatch to formatCsv for 'csv'", () => {
      const result = formatter.auto(sampleRows, columns, "csv");
      expect(result).toContain("Name,Age,Cost");
    });

    it("should throw on unknown format", () => {
      expect(() => formatter.auto(sampleRows, columns, "xml" as any)).toThrow("Unknown output format");
    });
  });

  describe("formatting helpers", () => {
    it("formatCost should format currency", () => {
      expect(formatter.formatCost(6.3)).toBe("$6.30");
      expect(formatter.formatCost(0)).toBe("$0.00");
    });

    it("formatTokens should add thousands separators", () => {
      const result = formatter.formatTokens(1234567);
      expect(result).toContain("1");
      expect(result).toContain("234");
    });

    it("formatPercent should format as percentage", () => {
      expect(formatter.formatPercent(0.824)).toBe("82.4%");
      expect(formatter.formatPercent(0)).toBe("0.0%");
    });

    it("formatDuration should format milliseconds", () => {
      expect(formatter.formatDuration(90000)).toBe("1m 30s");
      expect(formatter.formatDuration(3600000)).toBe("1h");
      expect(formatter.formatDuration(3660000)).toBe("1h 1m");
      expect(formatter.formatDuration(5000)).toBe("5s");
    });

    it("formatSummary should align labels", () => {
      const result = formatter.formatSummary([
        { label: "Short", value: "1" },
        { label: "Longer Label", value: "2" },
      ]);
      expect(result).toContain("Short");
      expect(result).toContain("Longer Label");
    });
  });
});
