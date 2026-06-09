/**
 * @module recommendation/windows
 *
 * Pure, DB-free window-reconstruction helpers for the subscription
 * recommendation (§2). All math runs in TypeScript on rows returned by ONE SQL
 * query (see src/queries/recommendation-analyzer.ts) rather than in SQL window
 * functions: the greedy "session-start anchoring" is a stateful single-pass
 * scan that is far clearer in TS than a recursive CTE, and it keeps DuckDB
 * read-only and bind-param-simple. This mirrors how CostAnalyzer pulls grouped
 * rows and aggregates them in JS.
 *
 * Usage is measured by API-equivalent cost (`cost_usd`) per window — the unit
 * Anthropic's 5h / weekly limits actually scale with (see src/config/limits.ts).
 * Each window sums the stored conversation_turns.cost_usd; nothing here reads or
 * recomputes cost. The fill percentages produced here are ESTIMATES.
 */

/** Rolling-window span constants (§2.3). */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "Near-limit" fill threshold — a window at ≥90% fill is near its ceiling. */
export const NEAR_LIMIT_FILL = 0.9;

/**
 * One cost-bearing assistant turn row, as projected by the §2.1 source query.
 * `timestamp` is epoch milliseconds (the analyzer converts the DuckDB
 * TIMESTAMP to ms before calling the pure helpers).
 */
export interface TurnRow {
  /** Epoch milliseconds of the turn timestamp. */
  timestamp: number;
  /** Stored API-equivalent cost (USD) for this turn (conversation_turns.cost_usd). */
  costUsd: number;
}

/**
 * A reconstructed rolling window. `turns` is the assistant-turn count (used for
 * activeWindows / info); `costUsd` is the summed API-equivalent cost — the
 * metering-aligned consumption signal.
 */
export interface ReconstructedWindow {
  /** Epoch ms of the first turn that opened the window. */
  anchor: number;
  /** Count of assistant turns in the window. */
  turns: number;
  /** Summed API-equivalent cost (USD) across the window. */
  costUsd: number;
}

/** Per-window stats over a set of reconstructed windows (§2.4). */
export interface WindowStats {
  /** Number of reconstructed windows (drives confidence as activeWindows). */
  activeWindows: number;
  /** Max cost-fill% across windows (the primary signal). */
  peakFill: number;
  /** 95th-percentile cost-fill% (nearest-rank). */
  p95Fill: number;
  /** Median cost-fill%. */
  medianFill: number;
  /** Count of windows with fill% ≥ {@link NEAR_LIMIT_FILL}. */
  nearLimitWindows: number;
  /** Max raw API-equivalent cost (USD) across windows (auto-calibration input). */
  peakCostUSD: number;
}

/**
 * Greedy session-start anchoring (§2.3), reused for the 5h and weekly passes.
 *
 * The FIRST turn opens a window `[t, t+span)`; every turn before `t+span`
 * accrues to it; the first turn at/after `t+span` opens the next window. This
 * is a rolling window keyed off first-activity (resets N after the session's
 * first activity, not on a fixed wall clock), which is why it is done in TS
 * anchored on the row timestamp.
 *
 * Rows MUST be sorted ascending by timestamp (the SQL `ORDER BY ct.timestamp`
 * guarantees this); the function does not re-sort.
 *
 * @param rows - Cost-bearing assistant turns, ascending by timestamp.
 * @param windowMs - Window span in ms ({@link FIVE_HOUR_MS} or {@link WEEK_MS}).
 * @returns The reconstructed windows in chronological order.
 */
export function reconstructWindows(
  rows: TurnRow[],
  windowMs: number,
): ReconstructedWindow[] {
  const windows: ReconstructedWindow[] = [];
  // The window object currently being filled. Holding the live
  // `ReconstructedWindow` reference (rather than re-reading
  // `windows[windows.length - 1]` each row) keeps the aggregate update simple
  // and avoids an unchecked index access on every iteration.
  let current: ReconstructedWindow | null = null;

  for (const r of rows) {
    if (current === null || r.timestamp >= current.anchor + windowMs) {
      current = {
        anchor: r.timestamp,
        turns: 0,
        costUsd: 0,
      };
      windows.push(current);
    }
    current.turns += 1;
    current.costUsd += r.costUsd;
  }

  return windows;
}

/**
 * Cost-fill% for a window (§2.3): `window.costUsd / ceilingCostUSD`. Returns the
 * RAW (unclamped) value so thresholds see the true intensity; callers clamp only
 * for display.
 *
 * Divide-by-zero guard: a zero ceiling (tier "none") yields fill 0, so "none"
 * never produces a spurious signal.
 *
 * @param window - A reconstructed window.
 * @param ceilingCostUSD - The tier's cost ceiling (USD) for the window span.
 * @returns Cost-fill fraction (0..∞ before any display clamp).
 */
export function windowFill(
  window: Pick<ReconstructedWindow, "costUsd">,
  ceilingCostUSD: number,
): number {
  return ceilingCostUSD > 0 ? window.costUsd / ceilingCostUSD : 0;
}

/**
 * Nearest-rank percentile over an UNSORTED numeric array (§2.4). The array is
 * sorted internally. `p` is a fraction in [0,1] (e.g. 0.95). Empty input → 0.
 *
 * Nearest-rank: rank = ceil(p × n), clamped to [1, n], 1-based.
 *
 * @param values - Numeric samples (e.g. per-window fill fractions).
 * @param p - Percentile as a fraction in [0,1].
 * @returns The value at the nearest rank, or 0 when `values` is empty.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedP = Math.min(1, Math.max(0, p));
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(clampedP * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/**
 * Median over an UNSORTED numeric array (mean of the two middle values for an
 * even count). Empty input → 0.
 *
 * @param values - Numeric samples.
 * @returns The median, or 0 when `values` is empty.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * Reduce a set of reconstructed windows to {@link WindowStats} against the
 * given cost ceiling (§2.4). Computes peak/p95/median cost-fill, the near-limit
 * window count (fill ≥ {@link NEAR_LIMIT_FILL}), and the raw peak window cost
 * used as the auto-calibration input.
 *
 * @param windows - Reconstructed windows for one span.
 * @param ceilingCostUSD - The tier's cost ceiling (USD) for that span.
 * @returns Aggregate window statistics (all zero for an empty window set).
 */
export function summarizeWindows(
  windows: ReconstructedWindow[],
  ceilingCostUSD: number,
): WindowStats {
  if (windows.length === 0) {
    return {
      activeWindows: 0,
      peakFill: 0,
      p95Fill: 0,
      medianFill: 0,
      nearLimitWindows: 0,
      peakCostUSD: 0,
    };
  }
  const fills = windows.map((w) => windowFill(w, ceilingCostUSD));
  let peakCostUSD = 0;
  let nearLimitWindows = 0;
  for (const w of windows) {
    if (w.costUsd > peakCostUSD) peakCostUSD = w.costUsd;
    const fill = windowFill(w, ceilingCostUSD);
    if (fill >= NEAR_LIMIT_FILL) nearLimitWindows += 1;
  }
  return {
    activeWindows: windows.length,
    peakFill: Math.max(...fills),
    p95Fill: percentile(fills, 0.95),
    medianFill: median(fills),
    nearLimitWindows,
    peakCostUSD,
  };
}

/**
 * Count distinct UTC calendar dates over the rows (§2.6). A data-volume proxy
 * for confidence, not a localized display, so UTC dates are sufficient (no
 * userTimezone projection required).
 *
 * @param rows - Cost-bearing assistant turns.
 * @returns The number of distinct UTC dates with at least one row.
 */
export function countActiveDays(rows: TurnRow[]): number {
  const days = new Set<string>();
  for (const r of rows) {
    days.add(new Date(r.timestamp).toISOString().slice(0, 10));
  }
  return days.size;
}

/**
 * Whole days between the most recent row's date and `now` (§2.6). Returns 0
 * when there are no rows. Never negative (future timestamps clamp to 0).
 *
 * @param rows - Cost-bearing assistant turns.
 * @param nowMs - Reference "now" in epoch ms (injectable for tests).
 * @returns Recency in whole days (floored), ≥ 0.
 */
export function computeRecencyDays(rows: TurnRow[], nowMs: number): number {
  if (rows.length === 0) return 0;
  let maxTs = -Infinity;
  for (const r of rows) {
    if (r.timestamp > maxTs) maxTs = r.timestamp;
  }
  const diffMs = nowMs - maxTs;
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}
