/**
 * @module tests/recommendation/windows
 *
 * Pure-unit tests for the window-reconstruction helpers (§2.3–2.6, §7.1).
 * No DB — all inputs are hand-built TurnRow arrays.
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

/** Helper: a turn at epoch-ms `t` with a request id and token count. */
function turn(t: number, requestId: string | null, totalTokens: number): TurnRow {
  return { timestamp: t, requestId, totalTokens };
}

const T0 = Date.UTC(2026, 1, 20, 10, 0, 0); // 2026-02-20T10:00:00Z

describe("reconstructWindows", () => {
  it("opens one window for requests clustered within the span", () => {
    const rows = [
      turn(T0, "r1", 1000),
      turn(T0 + 60 * 60 * 1000, "r2", 1000), // +1h
      turn(T0 + 2 * 60 * 60 * 1000, "r3", 1000), // +2h
    ];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w).toHaveLength(1);
    expect(w[0].requests).toBe(3);
    expect(w[0].tokens).toBe(3000);
    expect(w[0].anchor).toBe(T0);
  });

  it("opens a second window for a request 6h after the anchor (two 5h windows)", () => {
    const rows = [
      turn(T0, "r1", 500),
      turn(T0 + 6 * 60 * 60 * 1000, "r2", 700), // +6h → new window
    ];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w).toHaveLength(2);
    expect(w[0].requests).toBe(1);
    expect(w[1].requests).toBe(1);
    expect(w[1].anchor).toBe(T0 + 6 * 60 * 60 * 1000);
  });

  it("treats a request at exactly anchor+span as opening the NEXT window (boundary)", () => {
    const rows = [
      turn(T0, "r1", 100),
      turn(T0 + FIVE_HOUR_MS, "r2", 100), // exactly at boundary → new window
    ];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w).toHaveLength(2);
    expect(w[1].anchor).toBe(T0 + FIVE_HOUR_MS);
  });

  it("keeps a request one ms before anchor+span in the SAME window", () => {
    const rows = [turn(T0, "r1", 100), turn(T0 + FIVE_HOUR_MS - 1, "r2", 100)];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w).toHaveLength(1);
    expect(w[0].requests).toBe(2);
  });

  it("counts COUNT(DISTINCT request_id) — duplicate ids collapse", () => {
    const rows = [turn(T0, "r1", 100), turn(T0 + 1000, "r1", 100), turn(T0 + 2000, "r2", 100)];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w[0].distinctRequestIds).toBe(2);
    expect(w[0].requests).toBe(2);
    expect(w[0].assistantTurns).toBe(3);
  });

  it("falls back to assistant-turn count when request_id is NULL/empty (§2.2)", () => {
    const rows = [turn(T0, null, 100), turn(T0 + 1000, null, 100), turn(T0 + 2000, null, 100)];
    const w = reconstructWindows(rows, FIVE_HOUR_MS);
    expect(w[0].distinctRequestIds).toBe(0);
    expect(w[0].requests).toBe(3); // fallback = assistant turn count
  });

  it("returns no windows for an empty row set", () => {
    expect(reconstructWindows([], FIVE_HOUR_MS)).toEqual([]);
  });

  it("reconstructs weekly windows on the same row set", () => {
    const rows = [
      turn(T0, "r1", 100),
      turn(T0 + 2 * 24 * 60 * 60 * 1000, "r2", 100), // +2d → same week
      turn(T0 + 8 * 24 * 60 * 60 * 1000, "r3", 100), // +8d → next week
    ];
    const w = reconstructWindows(rows, WEEK_MS);
    expect(w).toHaveLength(2);
    expect(w[0].requests).toBe(2);
    expect(w[1].requests).toBe(1);
  });
});

describe("windowFill (blended fill%)", () => {
  it("is max(requests/ceil, tokens/ceil)", () => {
    const fill = windowFill({ requests: 10, tokens: 100 }, { requests: 100, tokens: 1000 });
    expect(fill).toBeCloseTo(0.1, 10); // both 0.1
  });

  it("lets the TOKENS dimension drive the signal even when requests are low", () => {
    // requests/ceil = 1/100 = 0.01 but tokens/ceil = 950/1000 = 0.95.
    const fill = windowFill({ requests: 1, tokens: 950 }, { requests: 100, tokens: 1000 });
    expect(fill).toBeCloseTo(0.95, 10);
  });

  it("lets the REQUESTS dimension drive the signal even when tokens are low", () => {
    const fill = windowFill({ requests: 96, tokens: 10 }, { requests: 100, tokens: 1000 });
    expect(fill).toBeCloseTo(0.96, 10);
  });

  it("guards divide-by-zero (tier none → ceiling 0 → fill 0)", () => {
    const fill = windowFill({ requests: 999, tokens: 999 }, { requests: 0, tokens: 0 });
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
    // Three windows: one well below, one exactly at near-limit, one over.
    const windows = [
      { anchor: 0, requests: 10, distinctRequestIds: 10, assistantTurns: 10, tokens: 0 },
      { anchor: 1, requests: 90, distinctRequestIds: 90, assistantTurns: 90, tokens: 0 },
      { anchor: 2, requests: 120, distinctRequestIds: 120, assistantTurns: 120, tokens: 0 },
    ];
    const stats = summarizeWindows(windows, { requests: 100, tokens: 1 });
    expect(stats.activeWindows).toBe(3);
    expect(stats.peakFill).toBeCloseTo(1.2, 10);
    expect(stats.medianFill).toBeCloseTo(0.9, 10);
    // near-limit: 0.9 (exactly NEAR_LIMIT_FILL) and 1.2 → 2 windows.
    expect(stats.nearLimitWindows).toBe(2);
    expect(NEAR_LIMIT_FILL).toBe(0.9);
    expect(stats.peakRequests).toBe(120);
  });

  it("tracks peak raw tokens independently of fill", () => {
    const windows = [
      { anchor: 0, requests: 1, distinctRequestIds: 1, assistantTurns: 1, tokens: 5000 },
      { anchor: 1, requests: 1, distinctRequestIds: 1, assistantTurns: 1, tokens: 9000 },
    ];
    const stats = summarizeWindows(windows, { requests: 100, tokens: 10000 });
    expect(stats.peakTokens).toBe(9000);
    expect(stats.peakFill).toBeCloseTo(0.9, 10);
  });

  it("returns all-zero stats for no windows", () => {
    const stats = summarizeWindows([], { requests: 100, tokens: 100 });
    expect(stats).toEqual({
      activeWindows: 0,
      peakFill: 0,
      p95Fill: 0,
      medianFill: 0,
      nearLimitWindows: 0,
      peakRequests: 0,
      peakTokens: 0,
    });
  });
});

describe("countActiveDays / computeRecencyDays (§2.6)", () => {
  it("counts distinct UTC dates", () => {
    const day = 24 * 60 * 60 * 1000;
    const rows = [turn(T0, "a", 1), turn(T0 + 60_000, "b", 1), turn(T0 + day, "c", 1)];
    expect(countActiveDays(rows)).toBe(2);
  });

  it("computes whole days since the most recent row", () => {
    const day = 24 * 60 * 60 * 1000;
    const rows = [turn(T0, "a", 1), turn(T0 + day, "b", 1)];
    const now = T0 + day + 3 * day + 5 * 60 * 60 * 1000; // 3d 5h after newest
    expect(computeRecencyDays(rows, now)).toBe(3);
  });

  it("clamps recency to 0 for a future-most timestamp and for no rows", () => {
    expect(computeRecencyDays([turn(T0, "a", 1)], T0 - 1000)).toBe(0);
    expect(computeRecencyDays([], Date.now())).toBe(0);
  });
});
