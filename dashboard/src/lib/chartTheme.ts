/**
 * Shared chart theme constants for Recharts.
 * Dark-mode palette aligned with the dashboard CSS variables.
 */

/** Primary palette colors for chart series. */
export const CHART_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f59e0b", // amber
  "#22c55e", // green
  "#06b6d4", // cyan
  "#f97316", // orange
  "#14b8a6", // teal
  "#e879f9", // fuchsia
  "#facc15", // yellow
] as const;

/** Grid line stroke color. Mirrors CSS var(--border): #2d3348 */
export const GRID_STROKE = "#2d3348";

/** Axis tick label fill color. Mirrors CSS var(--text-muted): #7c8aa3 */
export const AXIS_TICK_FILL = "#7c8aa3";

/** Default axis stroke color. Mirrors CSS var(--border): #2d3348 */
export const AXIS_STROKE = "#2d3348";

/** Trend line stroke color. Mirrors CSS var(--text-primary): #e2e8f0 */
export const TREND_LINE_COLOR = "#e2e8f0";

/** Default CartesianGrid props. */
export const GRID_PROPS = {
  strokeDasharray: "3 3",
  stroke: GRID_STROKE,
  vertical: false,
} as const;

/** Default XAxis props. */
export const X_AXIS_PROPS = {
  tick: { fill: AXIS_TICK_FILL, fontSize: 12 },
  axisLine: { stroke: AXIS_STROKE },
  tickLine: false as const,
} as const;

/** Default YAxis props. */
export const Y_AXIS_PROPS = {
  tick: { fill: AXIS_TICK_FILL, fontSize: 12 },
  axisLine: false as const,
  tickLine: false as const,
} as const;
