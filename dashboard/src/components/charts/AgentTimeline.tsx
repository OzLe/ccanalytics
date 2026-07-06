import { useRef, useEffect, useCallback } from "react";
import * as d3 from "d3";
import type { AgentTimeline as AgentTimelineData } from "@/lib/types";
import { formatCost } from "@/lib/formatters";
import {
  CHART_COLORS,
  TOOLTIP_BG,
  TOOLTIP_BORDER,
  TOOLTIP_TEXT,
} from "@/lib/chartTheme";

/**
 * Parallel-agent Gantt: one lane (rect) per sub-agent from start_time→end_time
 * over a d3.scaleTime x-axis. Overlapping bars = concurrent fan-out (the point).
 * Lanes are colored by subagent_type. Custom inline SVG because Recharts has no
 * native Gantt and the codebase already hand-draws SVG timelines (HourlyHeatmap).
 */
export default function AgentTimeline({
  data,
}: {
  data: AgentTimelineData | undefined;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    if (!data || data.lanes.length === 0 || !svgRef.current || !containerRef.current)
      return;

    const style = getComputedStyle(document.documentElement);
    const colAxis = style.getPropertyValue("--text-tertiary").trim() || "#64748b";
    const colGrid = style.getPropertyValue("--border").trim() || "#2d3348";

    const marginTop = 26;
    const marginBottom = 6;
    const marginLeft = 8;
    const marginRight = 14;
    const width = containerRef.current.clientWidth || 640;
    // Adaptive lane height: a session can fan out to ~150 sub-agents, and one
    // 20px lane each would be a ~3,000px strip that dwarfs the tree beside it.
    // Thin the lanes to fit a ~460px body when there are many; keep them chunky
    // (up to 20px) when there are only a few. Overlaps still read as concurrency.
    const n = data.lanes.length;
    const gap = n > 30 ? 1 : 3;
    const laneH = Math.max(
      3,
      Math.min(20, Math.floor((460 - marginTop - marginBottom) / n) - gap),
    );
    const height = marginTop + marginBottom + n * (laneH + gap);

    const svg = d3.select(svgRef.current).attr("width", width).attr("height", height);
    svg.selectAll("*").remove();

    const t0 = new Date(data.windowStart).getTime();
    const t1 = Math.max(new Date(data.windowEnd).getTime(), t0 + 1000);
    const x = d3
      .scaleTime()
      .domain([new Date(t0), new Date(t1)])
      .range([marginLeft, width - marginRight]);

    const palette = CHART_COLORS;
    const types = Array.from(
      new Set(data.lanes.map((l) => l.subagentType ?? "(unknown)")),
    );
    const colorFor = (t: string | null): string =>
      palette[types.indexOf(t ?? "(unknown)") % palette.length] ?? palette[0];

    // Top time axis.
    const ticks = Math.min(8, Math.max(2, Math.floor(width / 120)));
    const axis = d3.axisTop(x).ticks(ticks).tickSizeOuter(0);
    const axisG = svg
      .append("g")
      .attr("transform", `translate(0,${marginTop})`)
      .call(axis);
    axisG.selectAll("text").attr("fill", colAxis).attr("font-size", 10);
    axisG.selectAll("line").attr("stroke", colGrid);
    axisG.select(".domain").attr("stroke", colGrid);

    const tooltip = d3.select(tooltipRef.current);

    svg
      .append("g")
      .selectAll("rect")
      .data(data.lanes)
      .join("rect")
      .attr("x", (l) => x(new Date(l.start)))
      .attr("y", (_l, i) => marginTop + gap + i * (laneH + gap))
      .attr("width", (l) => Math.max(2, x(new Date(l.end)) - x(new Date(l.start))))
      .attr("height", laneH)
      .attr("rx", 3)
      .attr("fill", (l) => colorFor(l.subagentType))
      .attr("opacity", 0.85)
      .style("cursor", "default")
      .on("mouseenter", function (event: MouseEvent, l) {
        d3.select(this).attr("opacity", 1);
        const durMs = new Date(l.end).getTime() - new Date(l.start).getTime();
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${l.subagentType ?? "(unknown)"}</strong><br/>` +
              `${l.turns} turns · ${l.toolCalls} tools · ${formatCost(l.costUSD)}<br/>` +
              `${Math.round(durMs / 1000)}s`,
          )
          .style("left", `${event.offsetX + 12}px`)
          .style("top", `${event.offsetY + 14}px`);
      })
      .on("mousemove", function (event: MouseEvent) {
        tooltip
          .style("left", `${event.offsetX + 12}px`)
          .style("top", `${event.offsetY + 14}px`);
      })
      .on("mouseleave", function () {
        d3.select(this).attr("opacity", 0.85);
        tooltip.style("opacity", "0");
      });
  }, [data]);

  useEffect(() => {
    render();
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => render());
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (svgRef.current) d3.select(svgRef.current).selectAll("*").remove();
    };
  }, [render]);

  if (!data || data.lanes.length === 0) return null;

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative" }}>
      <svg ref={svgRef} />
      <div
        ref={tooltipRef}
        style={{
          position: "absolute",
          opacity: 0,
          pointerEvents: "none",
          backgroundColor: TOOLTIP_BG,
          border: `1px solid ${TOOLTIP_BORDER}`,
          color: TOOLTIP_TEXT,
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 13,
          zIndex: 10,
          transition: "opacity 150ms",
          whiteSpace: "nowrap",
        }}
      />
    </div>
  );
}
