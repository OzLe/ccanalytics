/**
 * @module tests/recommendation/windows
 *
 * Pure-unit tests for the window-reconstruction helpers (§2.3–2.6, §7.1).
 * No DB — all inputs are hand-built TurnRow arrays. Usage is measured by
 * API-equivalent cost (`costUsd`) per window.
 */

import { describe, it, expect } from "vitest";
import {
  reconstructWindows,
  summarizeWindows,
  windowFill,
  percentile,
  median,
  countActiveDays,
  computeRecencyDays,
  FIVE_HOUR_MS,
  WEEK_MS,
  NEAR_LIMIT_FILL,
  type TurnRow,
} from "../../src/recommendation/windows.js";

/** Helper: a turn at epoch-ms `t` with an API-equivalent cost. */
function turn(t: number, costUsd: number): TurnRow {
  return { timestamp: t, costUsd };
}

const T0 = Date.UTC(2026, 1, 20, 10, 0, 0); // 2026-02-20T10:00:00Z

describe("reconstructWindows", () => {
  it("opens one window for turns clustered within the span", () => {
    const rows = [
      turn(T0, 1),
      turn(T0 + 60 * 60 * 1000, 1), // +1h
      turn(T0 + 2 * 60 * 60 * 1000, 1), // +2h
    ];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w).toHaveLength(1);
    expect(w[0].turns).toBe(3);
    expect(w[0].costUsd).toBeCloseTo(3, 10);
    expect(w[0].anchor).toBe(T0);
  });

  it("opens a second window for a turn 6h after the anchor (two 5h windows)", () => {
    const rows = [
      turn(T0, 0.5),
      turn(T0 + 6 * 60 * 60 * 1000, 0.7), // +6h → new window
    ];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w).toHaveLength(2);
    expect(w[0].turns).toBe(1);
    expect(w[0].costUsd).toBeCloseTo(0.5, 10);
    expect(w[1].turns).toBe(1);
    expect(w[1].costUsd).toBeCloseTo(0.7, 10);
    expect(w[1].anchor).toBe(T0 + 6 * 60 * 60 * 1000);
  });

  it("treats a turn at exactly anchor+span as opening the NEXT window (boundary)", () => {
    const rows = [
      turn(T0, 0.1),
      turn(T0 + FIVE_HOUR_MS, 0.1), // exactly at boundary → new window
    ];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w).toHaveLength(2);
    expect(w[1].anchor).toBe(T0 + FIVE_HOUR_MS);
  });

  it("keeps a turn one ms before anchor+span in the SAME window", () => {
    const rows = [turn(T0, 0.1), turn(T0 + FIVE_HOUR_MS - 1, 0.1)];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w).toHaveLength(1);
    expect(w[0].turns).toBe(2);
  });

  it("sums cost across turns in the window", () => {
    const rows = [turn(T0, 0.25), turn(T0 + 1000, 0.5), turn(T0 + 2000, 1.25)];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w[0].turns).toBe(3);
    expect(w[0].costUsd).toBeCloseTo(2.0, 10);
  });

  it("returns no windows for an empty row set", () => {
    expect(reconstructWindows([], FIVE_HOUR_MS)).toEqual([]);
  });

  it("reconstructs weekly windows on the same row set", () => {
    const rows = [
      turn(T0, 0.1),
      turn(T0 + 2 * 24 * 60 * 60 * 1000, 0.1), // +2d → same week
      turn(T0 + 8 * 24 * 60 * 60 * 1000, 0.1), // +8d → next week
    ];
    const w = reconstructWindows(rows, WEEK_MS);
    expect(w).toHaveLength(2);
    expect(w[0].turns).toBe(2);
    expect(w[1].turns).toBe(1);
  });
});

describe("windowFill (cost fill%)", () => {
  it("is costUsd / ceilingCostUSD", () => {
    const fill = windowFill({ costUsd: 10 }, 100);
    expect(fill).toBeCloseTo(0.1, 10);
  });

  it("scales with the summed window cost", () => {
    expect(windowFill({ costUsd: 4.8 }, 5)).toBeCloseTo(0.96, 10);
    expect(windowFill({ costUsd: 50 }, 5)).toBeCloseTo(10, 10);
  });

  it("guards divide-by-zero (tier none → ceiling 0 → fill 0)", () => {
    const fill = windowFill({ costUsd: 999 }, 0);
    expect(fill).toBe(0);
  });
});

describe("percentile (nearest-rank) and median", () => {
  it("computes p95 by nearest rank on a sorted copy", () => {
    const vals = Array.from({ length: 20 }, (_, i) => (i + 1) / 20); // 0.05..1.0
    // nearest-rank: rank = ceil(0.95 * 20) = 19 → 19th value (1-based) = 0.95.
    expect(percentile(vals, 0.95)).toBeCloseTo(0.95, 10);
  });

  it("p100 returns the max, p-low returns the min", () => {
    const vals = [0.2, 0.9, 0.1, 0.5];
    expect(percentile(vals, 1)).toBeCloseTo(0.9, 10);
    expect(percentile(vals, 0)).toBeCloseTo(0.1, 10); // rank clamps to 1
  });

  it("returns 0 for an empty array", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(median([])).toBe(0);
  });

  it("median averages the two middle values for an even count", () => {
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5, 10);
  });

  it("median is the middle value for an odd count", () => {
    expect(median([5, 1, 3])).toBeCloseTo(3, 10);
  });
});

describe("summarizeWindows", () => {
  it("computes peak/p95/median fill and near-limit (≥0.90) window counts", () => {
    // Three windows vs a $100 ceiling: one well below, one exactly at
    // near-limit (0.90), one over (1.20).
    const windows = [
      { anchor: 0, turns: 10, costUsd: 10 },
      { anchor: 1, turns: 90, costUsd: 90 },
      { anchor: 2, turns: 120, costUsd: 120 },
    ];
    const stats = summarizeWindows(windows, 100);
    expect(stats.activeWindows).toBe(3);
    expect(stats.peakFill).toBeCloseTo(1.2, 10);
    expect(stats.medianFill).toBeCloseTo(0.9, 10);
    // near-limit: 0.9 (exactly NEAR_LIMIT_FILL) and 1.2 → 2 windows.
    expect(stats.nearLimitWindows).toBe(2);
    expect(NEAR_LIMIT_FILL).toBe(0.9);
    expect(stats.peakCostUSD).toBe(120);
  });

  it("tracks peak raw cost independently of fill", () => {
    const windows = [
      { anchor: 0, turns: 1, costUsd: 5 },
      { anchor: 1, turns: 1, costUsd: 9 },
    ];
    const stats = summarizeWindows(windows, 10);
    expect(stats.peakCostUSD).toBe(9);
    expect(stats.peakFill).toBeCloseTo(0.9, 10);
  });

  it("returns all-zero stats for no windows", () => {
    const stats = summarizeWindows([], 100);
    expect(stats).toEqual({
      activeWindows: 0,
      peakFill: 0,
      p95Fill: 0,
      medianFill: 0,
      nearLimitWindows: 0,
      peakCostUSD: 0,
    });
  });
});

describe("countActiveDays / computeRecencyDays (§2.6)", () => {
  it("counts distinct UTC dates", () => {
    const day = 24 * 60 * 60 * 1000;
    const rows = [turn(T0, 1), turn(T0 + 60_000, 1), turn(T0 + day, 1)];
    expect(countActiveDays(rows)).toBe(2);
  });

  it("computes whole days since the most recent row", () => {
    const day = 24 * 60 * 60 * 1000;
    const rows = [turn(T0, 1), turn(T0 + day, 1)];
    const now = T0 + day + 3 * day + 5 * 60 * 60 * 1000; // 3d 5h after newest
    expect(computeRecencyDays(rows, now)).toBe(3);
  });

  it("clamps recency to 0 for a future-most timestamp and for no rows", () => {
    expect(computeRecencyDays([turn(T0, 1)], T0 - 1000)).toBe(0);
    expect(computeRecencyDays([], Date.now())).toBe(0);
  });
});
