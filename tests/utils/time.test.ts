/**
 * @module tests/utils/time
 *
 * Unit tests for the parsePeriod utility.
 */

import { describe, it, expect } from "vitest";
import { parsePeriod } from "../../src/utils/time.js";

describe("parsePeriod", () => {
  it("should parse 'today' to start of current day", () => {
    const { start, end } = parsePeriod("today");
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it("should parse '7d' to 7 days ago", () => {
    const { start, end } = parsePeriod("7d");
    const diffMs = end.getTime() - start.getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(7, 0);
  });

  it("should parse '30d' to 30 days ago", () => {
    const { start, end } = parsePeriod("30d");
    const diffMs = end.getTime() - start.getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(30, 0);
  });

  it("should parse '90d' to 90 days ago", () => {
    const { start, end } = parsePeriod("90d");
    const diffMs = end.getTime() - start.getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(90, 0);
  });

  it("should parse 'all' to 2020-01-01", () => {
    const { start } = parsePeriod("all");
    expect(start.getFullYear()).toBe(2020);
    expect(start.getMonth()).toBe(0); // January
    expect(start.getDate()).toBe(1);
  });

  it("should default to 7d for unknown period", () => {
    const { start, end } = parsePeriod("unknown");
    const diffMs = end.getTime() - start.getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(7, 0);
  });

  it("should return end as now", () => {
    const before = Date.now();
    const { end } = parsePeriod("7d");
    const after = Date.now();
    expect(end.getTime()).toBeGreaterThanOrEqual(before);
    expect(end.getTime()).toBeLessThanOrEqual(after);
  });
});
