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
 * IMPORTANT: the fill percentages produced here are ESTIMATES (see
 * src/config/limits.ts). Nothing here reads or recomputes cost.
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
  /** Request id, or null/empty for older data (triggers the §2.2 fallback). */
  requestId: string | null;
  /** input + output + cache_creation + cache_read for this turn. */
  totalTokens: number;
}

/**
 * A reconstructed rolling window. `requests` applies the §2.2 fallback:
 * distinct request ids when present, else the assistant-turn count.
 */
export interface ReconstructedWindow {
  /** Epoch ms of the first request that opened the window. */
  anchor: number;
  /** §2.2 prompt-like unit: distinct request ids, or assistant turns if none. */
  requests: number;
  /** Distinct request ids observed (0 when all rows lacked a request id). */
  distinctRequestIds: number;
  /** Count of assistant turns in the window (the fallback unit). */
  assistantTurns: number;
  /** Summed total_tokens across the window. */
  tokens: number;
}

/** Per-window stats over a set of reconstructed windows (§2.4). */
export interface WindowStats {
  /** Number of reconstructed windows (drives confidence as activeWindows). */
  activeWindows: number;
  /** Max blended fill% across windows (the primary signal). */
  peakFill: number;
  /** 95th-percentile blended fill% (nearest-rank). */
  p95Fill: number;
  /** Median blended fill%. */
  medianFill: number;
  /** Count of windows with fill% ≥ {@link NEAR_LIMIT_FILL}. */
  nearLimitWindows: number;
  /** Max raw request count across windows (auto-calibration input). */
  peakRequests: number;
  /** Max raw token sum across windows (auto-calibration input). */
  peakTokens: number;
}

/**
 * Greedy session-start anchoring (§2.3), reused for the 5h and weekly passes.
 *
 * The FIRST request opens a window `[t, t+span)`; every request before
 * `t+span` accrues to it; the first request at/after `t+span` opens the next
 * window. This is a rolling window keyed off first-activity (resets N after the
 * session's first activity, not on a fixed wall clock), which is why it is done
 * in TS anchored on the row timestamp.
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
  // The window object currently being filled + its set of distinct request ids.
  // Holding the live `ReconstructedWindow` reference (rather than re-reading
  // `windows[windows.length - 1]` each row) keeps the aggregate update simple
  // and avoids an unchecked index access on every iteration.
  let current: ReconstructedWindow | null = null;
  let requestIds = new Set<string>();

  for (const r of rows) {
    if (current === null || r.timestamp >= current.anchor + windowMs) {
      requestIds = new Set<string>();
      current = {
        anchor: r.timestamp,
        requests: 0,
        distinctRequestIds: 0,
        assistantTurns: 0,
        tokens: 0,
      };
      windows.push(current);
    }
    if (r.requestId) {
      requestIds.add(r.requestId);
    }
    current.assistantTurns += 1;
    current.tokens += r.totalTokens;
    current.distinctRequestIds = requestIds.size;
    // §2.2 fallback: distinct request ids when present, else assistant turns.
    current.requests =
      current.distinctRequestIds > 0
        ? current.distinctRequestIds
        : current.assistantTurns;
  }

  return windows;
}

/**
 * Blended fill% for a window (§2.3): `max(requests/ceiling, tokens/ceiling)` —
 * either dimension can drive the signal. Returns the RAW (unclamped) value so
 * thresholds see the true intensity; callers clamp only for display.
 *
 * Divide-by-zero guard: a zero ceiling (tier "none") yields fill 0 for that
 * dimension, so "none" never produces a spurious signal.
 *
 * @param window - A reconstructed window.
 * @param ceiling - The tier ceilings (requests + tokens) for the window span.
 * @returns Blended fill fraction (0..∞ before any display clamp).
 */
export function windowFill(
  window: Pick<ReconstructedWindow, "requests" | "tokens">,
  ceiling: { requests: number; tokens: number },
): number {
  const reqFill = ceiling.requests > 0 ? window.requests / ceiling.requests : 0;
  const tokFill = ceiling.tokens > 0 ? window.tokens / ceiling.tokens : 0;
  return Math.max(reqFill, tokFill);
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
 * given ceiling (§2.4). Computes peak/p95/median fill, the near-limit window
 * count (fill ≥ {@link NEAR_LIMIT_FILL}), and the raw peak request/token counts
 * used as auto-calibration inputs.
 *
 * @param windows - Reconstructed windows for one span.
 * @param ceiling - Tier ceilings (requests + tokens) for that span.
 * @returns Aggregate window statistics (all zero for an empty window set).
 */
export function summarizeWindows(
  windows: ReconstructedWindow[],
  ceiling: { requests: number; tokens: number },
): WindowStats {
  if (windows.length === 0) {
    return {
      activeWindows: 0,
      peakFill: 0,
      p95Fill: 0,
      medianFill: 0,
      nearLimitWindows: 0,
      peakRequests: 0,
      peakTokens: 0,
    };
  }
  const fills = windows.map((w) => windowFill(w, ceiling));
  let peakRequests = 0;
  let peakTokens = 0;
  let nearLimitWindows = 0;
  for (const w of windows) {
    if (w.requests > peakRequests) peakRequests = w.requests;
    if (w.tokens > peakTokens) peakTokens = w.tokens;
    const fill = windowFill(w, ceiling);
    if (fill >= NEAR_LIMIT_FILL) nearLimitWindows += 1;
  }
  return {
    activeWindows: windows.length,
    peakFill: Math.max(...fills),
    p95Fill: percentile(fills, 0.95),
    medianFill: median(fills),
    nearLimitWindows,
    peakRequests,
    peakTokens,
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
