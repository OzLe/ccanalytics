import React, { useRef, useEffect, useCallback, useState } from "react";
import * as d3 from "d3";
import type { ActivityDaily } from "@/lib/types";
import { TOOLTIP_BG, TOOLTIP_BORDER, TOOLTIP_TEXT } from "@/lib/chartTheme";

interface Props {
  data: ActivityDaily[] | undefined;
}

const CELL_GAP = 3;
const MIN_HEIGHT = 160;

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export default function CalendarHeatmap({ data }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const [legendColors, setLegendColors] = useState<string[]>([]);
  const [maxVal, setMaxVal] = useState(0);

  const render = useCallback(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    const style = getComputedStyle(document.documentElement);
    const colorEmpty = style.getPropertyValue("--heatmap-empty").trim();
    const colorHoverStroke = style.getPropertyValue("--heatmap-hover-stroke").trim();
    const colorLabel = style.getPropertyValue("--heatmap-label").trim();

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
    setMaxVal(maxValue);

    // Stepped color scale: 5 levels with explicit hex values (no hue shift)
    const steppedColors = [
      colorEmpty,    // 0: empty (#252a3e)
      "#1e4d32",     // 1: low
      "#1f7a3f",     // 2: medium-low
      "#20a34c",     // 3: medium-high
      "#22c55e",     // 4: high
    ];

    // Update legend colors state
    setLegendColors(steppedColors);

    const colorScale = (value: number): string => {
      if (value === 0) return steppedColors[0]!;
      const ratio = value / maxValue;
      if (ratio <= 0.25) return steppedColors[1]!;
      if (ratio <= 0.50) return steppedColors[2]!;
      if (ratio <= 0.75) return steppedColors[3]!;
      return steppedColors[4]!;
    };

    const marginLeft = 44;
    const marginTop = 24;
    const numWeeks = Math.ceil(days.length / 7);
    const containerWidth = containerRef.current.clientWidth;

    // Dynamic cell sizing: scale to fill available width
    const cellSize = Math.max(
      14,
      Math.min(24, Math.floor((containerWidth - marginLeft - 10) / numWeeks) - CELL_GAP)
    );

    const totalWidth = marginLeft + numWeeks * (cellSize + CELL_GAP) + 10;
    const legendHeight = 30; // space for the legend below the grid
    const computedHeight = marginTop + 7 * (cellSize + CELL_GAP) + legendHeight;
    const totalHeight = Math.max(computedHeight, MIN_HEIGHT);

    const svg = d3
      .select(svgRef.current)
      .attr("width", Math.max(totalWidth, containerWidth))
      .attr("height", totalHeight);

    svg.selectAll("*").remove();

    const tooltip = d3.select(tooltipRef.current);

    // Day of week labels
    svg
      .append("g")
      .selectAll("text")
      .data(DAY_LABELS)
      .join("text")
      .attr("x", marginLeft - 6)
      .attr("y", (_, i) => marginTop + i * (cellSize + CELL_GAP) + cellSize / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", "end")
      .attr("fill", colorLabel)
      .attr("font-size", 11)
      .attr("font-family", "'Inter', sans-serif")
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
          x: marginLeft + weekIndex * (cellSize + CELL_GAP),
        });
        lastMonth = month;
      }
    }

    // Filter out first month label if it would crowd the day-of-week labels
    const filteredMonthPositions = monthPositions.filter(
      (mp, i) => i !== 0 || mp.x >= marginLeft + 20
    );

    svg
      .append("g")
      .selectAll("text")
      .data(filteredMonthPositions)
      .join("text")
      .attr("x", (d) => d.x)
      .attr("y", marginTop - 6)
      .attr("fill", colorLabel)
      .attr("font-size", 12)
      .attr("font-family", "'Inter', sans-serif")
      .text((d) => d.label);

    // Day cells
    svg
      .append("g")
      .selectAll("rect")
      .data(days)
      .join("rect")
      .attr("x", (_, i) => marginLeft + Math.floor(i / 7) * (cellSize + CELL_GAP))
      .attr("y", (_, i) => marginTop + (i % 7) * (cellSize + CELL_GAP))
      .attr("width", cellSize)
      .attr("height", cellSize)
      .attr("rx", 3)
      .attr("fill", (d) => colorScale(d.value))
      .attr("stroke", (d) => d.value === 0 ? "rgba(255,255,255,0.06)" : "none")
      .attr("stroke-width", (d) => d.value === 0 ? 1 : 0)
      .style("cursor", "pointer")
      .on("mouseenter", function (event, d) {
        d3.select(this).attr("stroke", colorHoverStroke).attr("stroke-width", 1.5);
        if (d.value > 0) {
          d3.select(this).attr("opacity", 0.85);
        }
        const dateFormatted = d.date.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        let left = event.offsetX + 12;
        let top = event.offsetY - 28;
        const cw = containerRef.current?.clientWidth || 0;
        if (left + 120 > cw) left = event.offsetX - 130;
        if (top < 0) top = event.offsetY + 12;
        tooltip
          .style("opacity", "1")
          .html(`<strong>${dateFormatted}</strong><br/>${d.value} turns`)
          .style("left", `${left}px`)
          .style("top", `${top}px`);
      })
      .on("mousemove", function (event) {
        let left = event.offsetX + 12;
        let top = event.offsetY - 28;
        const cw = containerRef.current?.clientWidth || 0;
        if (left + 120 > cw) left = event.offsetX - 130;
        if (top < 0) top = event.offsetY + 12;
        tooltip
          .style("left", `${left}px`)
          .style("top", `${top}px`);
      })
      .on("mouseleave", function (_, d) {
        d3.select(this)
          .attr("stroke", d.value === 0 ? "rgba(255,255,255,0.06)" : "none")
          .attr("stroke-width", d.value === 0 ? 1 : 0)
          .attr("opacity", 1);
        tooltip.style("opacity", "0");
      });

    // Auto-scroll to show most recent data
    if (containerRef.current) {
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;
    }
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
      {/* Color legend */}
      {legendColors.length > 0 && (
        <div
          ref={legendRef}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 4,
            paddingRight: 10,
            paddingTop: 4,
            paddingBottom: 4,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--text-tertiary)",
              fontFamily: "'Inter', sans-serif",
              marginRight: 4,
            }}
          >
            0
          </span>
          {legendColors.map((color, i) => (
            <React.Fragment key={i}>
              {i === 1 && (
                <div
                  style={{
                    width: 1,
                    height: 12,
                    backgroundColor: "rgba(255,255,255,0.1)",
                    marginLeft: 2,
                    marginRight: 2,
                  }}
                />
              )}
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  backgroundColor: color,
                }}
              />
            </React.Fragment>
          ))}
          <span
            style={{
              fontSize: 11,
              color: "var(--text-tertiary)",
              fontFamily: "'Inter', sans-serif",
              marginLeft: 4,
            }}
          >
            {maxVal} turns
          </span>
        </div>
      )}
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
