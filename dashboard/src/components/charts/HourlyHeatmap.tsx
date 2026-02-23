import { useRef, useEffect, useCallback } from "react";
import * as d3 from "d3";
import type { ActivityHeatmap } from "@/lib/types";

interface Props {
  data: ActivityHeatmap[] | undefined;
}

const TOOLTIP_BG = "#1e2235";
const TOOLTIP_BORDER = "#2a2d3e";
const TOOLTIP_TEXT = "#e2e8f0";
const MIN_HEIGHT = 250;

const CELL_WIDTH = 24;
const CELL_HEIGHT = 28;
const CELL_GAP = 2;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOUR_LABELS: { hour: number; label: string }[] = [
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

export default function HourlyHeatmap({ data }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    // Build value lookup: dayOfWeek (0=Mon..6=Sun) x hourOfDay (0..23)
    const valueMap = new Map<string, number>();
    for (const d of data) {
      valueMap.set(`${d.dayOfWeek}-${d.hourOfDay}`, d.value);
    }

    const maxValue = d3.max(data, (d) => d.value) ?? 1;

    const colorScale = d3
      .scaleSequential(d3.interpolate("#1e2235", "#facc15"))
      .domain([0, maxValue]);

    const marginLeft = 48;
    const marginTop = 28;
    const width = marginLeft + 24 * (CELL_WIDTH + CELL_GAP) + 10;
    const height = Math.max(MIN_HEIGHT, marginTop + 7 * (CELL_HEIGHT + CELL_GAP) + 10);

    const svg = d3
      .select(svgRef.current)
      .attr("width", Math.max(width, containerRef.current.clientWidth))
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
      .attr("y", (_, i) => marginTop + i * (CELL_HEIGHT + CELL_GAP) + CELL_HEIGHT / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", "end")
      .attr("fill", "#94a3b8")
      .attr("font-size", 11)
      .text((d) => d);

    // Hour labels (columns) - every 3 hours
    svg
      .append("g")
      .selectAll("text")
      .data(HOUR_LABELS)
      .join("text")
      .attr(
        "x",
        (d) => marginLeft + d.hour * (CELL_WIDTH + CELL_GAP) + CELL_WIDTH / 2,
      )
      .attr("y", marginTop - 8)
      .attr("text-anchor", "middle")
      .attr("fill", "#64748b")
      .attr("font-size", 10)
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
      .attr("x", (d) => marginLeft + d.hour * (CELL_WIDTH + CELL_GAP))
      .attr("y", (d) => marginTop + d.day * (CELL_HEIGHT + CELL_GAP))
      .attr("width", CELL_WIDTH)
      .attr("height", CELL_HEIGHT)
      .attr("rx", 3)
      .attr("fill", (d) => colorScale(d.value))
      .style("cursor", "pointer")
      .on("mouseenter", function (event, d) {
        d3.select(this).attr("stroke", "#e2e8f0").attr("stroke-width", 1.5);
        const dayName = DAY_LABELS[d.day] ?? "";
        const hourLabel = formatHour(d.hour);
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${dayName} ${hourLabel}</strong><br/>${d.value} messages`,
          )
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
