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

/** Grid line stroke color. */
export const GRID_STROKE = "#2a2d3e";

/** Axis tick label fill color. */
export const AXIS_TICK_FILL = "#94a3b8";

/** Default axis stroke color. */
export const AXIS_STROKE = "#2a2d3e";

/** Tooltip styling props for the Recharts Tooltip component. */
export const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: "#1e2235",
    borderColor: "#2a2d3e",
    borderRadius: 8,
    color: "#e2e8f0",
    fontSize: 13,
    padding: "8px 12px",
  },
  itemStyle: {
    color: "#e2e8f0",
    fontSize: 12,
  },
  labelStyle: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 4,
  },
  cursor: { fill: "rgba(99, 102, 241, 0.08)" },
} as const;

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
