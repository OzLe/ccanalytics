/**
 * Shared chart theme constants for Recharts.
 * Dark-mode palette aligned with the v2 design system CSS variables.
 *
 * Note: Recharts requires literal color strings (not CSS var() references)
 * so we duplicate the values here. The comments note which CSS variable
 * each constant mirrors for future maintenance.
 */

/** Primary palette colors for chart series. */
export const CHART_COLORS = [
  "#6366f1", // indigo  — var(--accent)
  "#3b82f6", // blue
  "#ec4899", // pink
  "#f59e0b", // amber
  "#22c55e", // green   — var(--success)
  "#06b6d4", // cyan
  "#f97316", // orange  — var(--orange)
  "#14b8a6", // teal
  "#e879f9", // fuchsia
  "#facc15", // yellow
] as const;

/** Grid line stroke color. Mirrors var(--border): #2d3348 */
export const GRID_STROKE = "#2d3348";

/** Axis tick label fill color. Mirrors var(--text-tertiary): #64748b */
export const AXIS_TICK_FILL = "#64748b";

/** Default axis stroke color. Mirrors var(--border): #2d3348 */
export const AXIS_STROKE = "#2d3348";

/** Trend line stroke color. Mirrors var(--text-primary): #f1f5f9 */
export const TREND_LINE_COLOR = "#f1f5f9";

/** Tooltip background. Mirrors var(--bg-elevated): #1e2235 */
export const TOOLTIP_BG = "#1e2235";

/** Tooltip border. Mirrors var(--border): #2d3348 */
export const TOOLTIP_BORDER = "#2d3348";

/** Tooltip text. Mirrors var(--text-primary): #f1f5f9 */
export const TOOLTIP_TEXT = "#f1f5f9";

/** Chart area background. Mirrors var(--bg-surface): #161926 */
export const CHART_BG = "#161926";

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

/** Default Tooltip style props. */
export const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: TOOLTIP_BG,
    border: `1px solid ${TOOLTIP_BORDER}`,
    borderRadius: "8px",
    color: TOOLTIP_TEXT,
    fontSize: "13px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  },
  itemStyle: {
    color: TOOLTIP_TEXT,
  },
  cursor: { stroke: GRID_STROKE },
} as const;
