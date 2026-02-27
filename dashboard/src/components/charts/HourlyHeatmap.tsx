import React, { useRef, useEffect, useCallback, useState } from "react";
import * as d3 from "d3";
import type { ActivityHeatmap } from "@/lib/types";
import { TOOLTIP_BG, TOOLTIP_BORDER, TOOLTIP_TEXT } from "@/lib/chartTheme";

interface Props {
  data: ActivityHeatmap[] | undefined;
}

const MIN_HEIGHT = 250;
const CELL_GAP = 3;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Every-3-hours labels (used as fallback for narrow widths)
const HOUR_LABELS_SPARSE: { hour: number; label: string }[] = [
  { hour: 0, label: "12am" },
  { hour: 3, label: "3am" },
  { hour: 6, label: "6am" },
  { hour: 9, label: "9am" },
  { hour: 12, label: "12pm" },
  { hour: 15, label: "3pm" },
  { hour: 18, label: "6pm" },
  { hour: 21, label: "9pm" },
];

function formatHour(hour: number): string {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

// Generate all 24 hour labels
function getAllHourLabels(): { hour: number; label: string }[] {
  return Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    label: formatHour(i),
  }));
}

export default function HourlyHeatmap({ data }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [legendColors, setLegendColors] = useState<string[]>([]);
  const [maxVal, setMaxVal] = useState(0);

  const render = useCallback(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    const style = getComputedStyle(document.documentElement);
    const colorEmpty = style.getPropertyValue("--heatmap-empty").trim();
    const colorLow = style.getPropertyValue("--heatmap-hourly-low").trim();
    const colorHigh = style.getPropertyValue("--heatmap-hourly-high").trim();
    const colorHoverStroke = style.getPropertyValue("--heatmap-hover-stroke").trim();
    const colorLabel = style.getPropertyValue("--heatmap-label").trim();
    const colorLabelAlt = style.getPropertyValue("--heatmap-label-alt").trim();

    // Build value lookup: dayOfWeek (0=Mon..6=Sun) x hourOfDay (0..23)
    const valueMap = new Map<string, number>();
    for (const d of data) {
      valueMap.set(`${d.dayOfWeek}-${d.hourOfDay}`, d.value);
    }

    const maxValue = d3.max(data, (d) => d.value) ?? 1;
    setMaxVal(maxValue);

    // 5-step quantized color scale (matching CalendarHeatmap approach)
    const colorInterpolate = d3.interpolate(colorLow, colorHigh);
    const steppedColors = [
      colorEmpty,               // 0: empty
      colorInterpolate(0.25),   // 1: low (25%)
      colorInterpolate(0.50),   // 2: medium-low (50%)
      colorInterpolate(0.75),   // 3: medium-high (75%)
      colorInterpolate(1.0),    // 4: high (100%)
    ];

    const colorScale = (value: number): string => {
      if (value === 0) return steppedColors[0]!;
      const ratio = value / maxValue;
      if (ratio <= 0.25) return steppedColors[1]!;
      if (ratio <= 0.50) return steppedColors[2]!;
      if (ratio <= 0.75) return steppedColors[3]!;
      return steppedColors[4]!;
    };

    setLegendColors(steppedColors);

    const marginLeft = 44;
    const marginTop = 24;
    const containerWidth = containerRef.current.clientWidth;

    // Dynamic cell sizing: scale to fill available width
    const cellWidth = Math.max(
      24,
      Math.floor((containerWidth - marginLeft - 10) / 24) - CELL_GAP
    );
    const cellHeight = Math.max(24, Math.round(cellWidth * 0.75));

    // Decide whether to show all 24 hour labels or sparse (every 3 hours)
    const showAllHours = cellWidth > 30;
    const hourLabels = showAllHours ? getAllHourLabels() : HOUR_LABELS_SPARSE;

    const width = marginLeft + 24 * (cellWidth + CELL_GAP) + 10;
    const height = Math.max(MIN_HEIGHT, marginTop + 7 * (cellHeight + CELL_GAP) + 10);

    const svg = d3
      .select(svgRef.current)
      .attr("width", Math.max(width, containerWidth))
      .attr("height", height);

    svg.selectAll("*").remove();

    const tooltip = d3.select(tooltipRef.current);

    // Day of week labels (rows)
    svg
      .append("g")
      .selectAll("text")
      .data(DAY_LABELS)
      .join("text")
      .attr("x", marginLeft - 8)
      .attr("y", (_, i) => marginTop + i * (cellHeight + CELL_GAP) + cellHeight / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", "end")
      .attr("fill", colorLabelAlt)
      .attr("font-size", 12)
      .attr("font-family", "'Inter', sans-serif")
      .text((d) => d);

    // Hour labels (columns)
    svg
      .append("g")
      .selectAll("text")
      .data(hourLabels)
      .join("text")
      .attr(
        "x",
        (d) => marginLeft + d.hour * (cellWidth + CELL_GAP) + cellWidth / 2,
      )
      .attr("y", marginTop - 8)
      .attr("text-anchor", "middle")
      .attr("fill", colorLabel)
      .attr("font-size", showAllHours ? 11 : 12)
      .attr("font-family", "'Inter', sans-serif")
      .text((d) => d.label);

    // Build cell data
    const cells: { day: number; hour: number; value: number }[] = [];
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        cells.push({
          day,
          hour,
          value: valueMap.get(`${day}-${hour}`) ?? 0,
        });
      }
    }

    // Cells
    svg
      .append("g")
      .selectAll("rect")
      .data(cells)
      .join("rect")
      .attr("x", (d) => marginLeft + d.hour * (cellWidth + CELL_GAP))
      .attr("y", (d) => marginTop + d.day * (cellHeight + CELL_GAP))
      .attr("width", cellWidth)
      .attr("height", cellHeight)
      .attr("rx", 3)
      .attr("fill", (d) => colorScale(d.value))
      .attr("stroke", (d) => d.value === 0 ? "rgba(255,255,255,0.06)" : "none")
      .attr("stroke-width", (d) => d.value === 0 ? 1 : 0)
      .style("cursor", "pointer")
      .on("mouseenter", function (event, d) {
        d3.select(this).attr("stroke", colorHoverStroke).attr("stroke-width", 1.5);
        const dayName = DAY_LABELS[d.day] ?? "";
        const hourLabel = formatHour(d.hour);
        let left = event.offsetX + 12;
        let top = event.offsetY - 28;
        const cw = containerRef.current?.clientWidth || 0;
        if (left + 120 > cw) left = event.offsetX - 130;
        if (top < 0) top = event.offsetY + 12;
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${dayName} ${hourLabel}</strong><br/>${d.value} messages`,
          )
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
          .attr("stroke-width", d.value === 0 ? 1 : 0);
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
      {/* Color legend */}
      {legendColors.length > 0 && (
        <div
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
            {maxVal} msgs
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
