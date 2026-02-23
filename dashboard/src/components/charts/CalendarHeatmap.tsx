import { useRef, useEffect, useCallback } from "react";
import * as d3 from "d3";
import type { ActivityDaily } from "@/lib/types";

interface Props {
  data: ActivityDaily[] | undefined;
}

const TOOLTIP_BG = "#1e2235";
const TOOLTIP_BORDER = "#2a2d3e";
const TOOLTIP_TEXT = "#e2e8f0";
const CELL_SIZE = 14;
const CELL_GAP = 2;
const MIN_HEIGHT = 180;

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export default function CalendarHeatmap({ data }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    // Build a map of date string -> value
    const valueByDate = new Map<string, number>();
    for (const d of data) {
      const dateStr = d.timestamp.slice(0, 10);
      valueByDate.set(dateStr, (valueByDate.get(dateStr) ?? 0) + d.value);
    }

    // Generate last ~365 days
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 364);
    // Adjust to start on a Sunday
    const dayOfWeek = startDate.getDay();
    startDate.setDate(startDate.getDate() - dayOfWeek);

    const days: { date: Date; value: number; dateStr: string }[] = [];
    const current = new Date(startDate);
    while (current <= today) {
      const dateStr = current.toISOString().slice(0, 10);
      days.push({
        date: new Date(current),
        value: valueByDate.get(dateStr) ?? 0,
        dateStr,
      });
      current.setDate(current.getDate() + 1);
    }

    const maxValue = d3.max(days, (d) => d.value) ?? 1;

    const colorScale = d3
      .scaleSequential((t) => {
        if (t === 0) return "#1e2235";
        return d3.interpolate("#1a3a2a", "#22c55e")(t);
      })
      .domain([0, maxValue]);

    const marginLeft = 36;
    const marginTop = 20;
    const numWeeks = Math.ceil(days.length / 7);
    const totalWidth = marginLeft + numWeeks * (CELL_SIZE + CELL_GAP) + 10;
    const totalHeight = marginTop + 7 * (CELL_SIZE + CELL_GAP) + 10;
    const containerWidth = containerRef.current.clientWidth;

    const svg = d3
      .select(svgRef.current)
      .attr("width", Math.max(totalWidth, containerWidth))
      .attr("height", Math.max(totalHeight, MIN_HEIGHT));

    svg.selectAll("*").remove();

    const tooltip = d3.select(tooltipRef.current);

    // Day of week labels
    svg
      .append("g")
      .selectAll("text")
      .data(DAY_LABELS)
      .join("text")
      .attr("x", marginLeft - 6)
      .attr("y", (_, i) => marginTop + i * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", "end")
      .attr("fill", "#64748b")
      .attr("font-size", 10)
      .text((d) => d);

    // Month labels
    const monthPositions: { label: string; x: number }[] = [];
    let lastMonth = -1;
    for (const day of days) {
      const month = day.date.getMonth();
      if (month !== lastMonth) {
        const dayIndex = days.indexOf(day);
        const weekIndex = Math.floor(dayIndex / 7);
        monthPositions.push({
          label: MONTH_NAMES[month]!,
          x: marginLeft + weekIndex * (CELL_SIZE + CELL_GAP),
        });
        lastMonth = month;
      }
    }

    svg
      .append("g")
      .selectAll("text")
      .data(monthPositions)
      .join("text")
      .attr("x", (d) => d.x)
      .attr("y", marginTop - 6)
      .attr("fill", "#64748b")
      .attr("font-size", 10)
      .text((d) => d.label);

    // Day cells
    svg
      .append("g")
      .selectAll("rect")
      .data(days)
      .join("rect")
      .attr("x", (_, i) => marginLeft + Math.floor(i / 7) * (CELL_SIZE + CELL_GAP))
      .attr("y", (_, i) => marginTop + (i % 7) * (CELL_SIZE + CELL_GAP))
      .attr("width", CELL_SIZE)
      .attr("height", CELL_SIZE)
      .attr("rx", 2)
      .attr("fill", (d) => colorScale(d.value))
      .style("cursor", "pointer")
      .on("mouseenter", function (event, d) {
        d3.select(this).attr("stroke", "#e2e8f0").attr("stroke-width", 1.5);
        const dateFormatted = d.date.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        tooltip
          .style("opacity", "1")
          .html(`<strong>${dateFormatted}</strong><br/>${d.value} turns`)
          .style("left", `${event.offsetX + 12}px`)
          .style("top", `${event.offsetY - 28}px`);
      })
      .on("mousemove", function (event) {
        tooltip
          .style("left", `${event.offsetX + 12}px`)
          .style("top", `${event.offsetY - 28}px`);
      })
      .on("mouseleave", function () {
        d3.select(this).attr("stroke", "none");
        tooltip.style("opacity", "0");
      });
  }, [data]);

  useEffect(() => {
    render();

    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      render();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (svgRef.current) {
        d3.select(svgRef.current).selectAll("*").remove();
      }
    };
  }, [render]);

  if (!data) return null;

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        position: "relative",
        overflowX: "auto",
        minHeight: MIN_HEIGHT,
      }}
    >
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
