import { useRef, useEffect, useCallback } from "react";
import * as d3 from "d3";
import type { HierarchyRectangularNode } from "d3";
import type { CostByProject } from "@/lib/types";
import { formatCost } from "@/lib/formatters";

interface Props {
  data: CostByProject[] | undefined;
}

interface TreemapDatum {
  name: string;
  fullPath: string;
  cost: number;
  sessions: number;
}

interface TreemapRoot {
  name: string;
  children: TreemapDatum[];
}

type TreeNode = TreemapRoot | TreemapDatum;
type RectNode = HierarchyRectangularNode<TreeNode>;

const TOOLTIP_BG = "#1e2235";
const TOOLTIP_BORDER = "#2a2d3e";
const TOOLTIP_TEXT = "#e2e8f0";
const MIN_HEIGHT = 400;

export default function CostTreemap({ data }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    if (!data || data.length === 0 || !svgRef.current || !containerRef.current)
      return;

    const width = containerRef.current.clientWidth;
    const height = Math.max(MIN_HEIGHT, width * 0.5);

    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height);

    svg.selectAll("*").remove();

    const treemapData: TreemapRoot = {
      name: "root",
      children: data.map((p) => ({
        name: p.projectPath.split("/").pop() ?? p.projectPath,
        fullPath: p.projectPath,
        cost: p.totalCostUSD,
        sessions: p.sessionCount,
      })),
    };

    const root = d3
      .hierarchy<TreeNode>(treemapData)
      .sum((d) => ("cost" in d ? d.cost : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    d3.treemap<TreeNode>()
      .size([width, height])
      .padding(3)
      .round(true)(root);

    const maxCost = d3.max(data, (d) => d.totalCostUSD) ?? 1;
    const colorScale = d3
      .scaleSequential(d3.interpolate("#2a2d5e", "#6366f1"))
      .domain([0, maxCost]);

    const tooltip = d3.select(tooltipRef.current);

    // After treemap layout, nodes gain x0/y0/x1/y1
    const leaves = root.leaves() as RectNode[];

    // Cells
    const cell = svg
      .selectAll("g")
      .data(leaves)
      .join("g")
      .attr("transform", (d) => `translate(${d.x0},${d.y0})`);

    cell
      .append("rect")
      .attr("width", (d) => Math.max(0, d.x1 - d.x0))
      .attr("height", (d) => Math.max(0, d.y1 - d.y0))
      .attr("fill", (d) => colorScale(d.value ?? 0))
      .attr("rx", 4)
      .attr("stroke", "#1a1d2e")
      .attr("stroke-width", 1)
      .style("cursor", "pointer")
      .attr("opacity", 0)
      .transition()
      .duration(300)
      .attr("opacity", 1);

    // Hover
    cell
      .on("mouseenter", function (event, d) {
        d3.select(this).select("rect").attr("stroke", "#6366f1").attr("stroke-width", 2);
        const datum = d.data as TreemapDatum;
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${datum.fullPath}</strong><br/>` +
              `Cost: ${formatCost(datum.cost)}<br/>` +
              `Sessions: ${datum.sessions}`,
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
        d3.select(this).select("rect").attr("stroke", "#1a1d2e").attr("stroke-width", 1);
        tooltip.style("opacity", "0");
      });

    // Labels - only show if the cell is large enough
    cell
      .append("text")
      .attr("x", 6)
      .attr("y", 18)
      .attr("fill", "#e2e8f0")
      .attr("font-size", 12)
      .attr("font-weight", 600)
      .attr("font-family", "'Inter', sans-serif")
      .text((d) => {
        const w = d.x1 - d.x0;
        const h = d.y1 - d.y0;
        if (w < 50 || h < 30) return "";
        const datum = d.data as TreemapDatum;
        return datum.name;
      })
      .attr("pointer-events", "none");

    cell
      .append("text")
      .attr("x", 6)
      .attr("y", 34)
      .attr("fill", "#94a3b8")
      .attr("font-size", 11)
      .attr("font-family", "'Inter', sans-serif")
      .text((d) => {
        const w = d.x1 - d.x0;
        const h = d.y1 - d.y0;
        if (w < 50 || h < 46) return "";
        const datum = d.data as TreemapDatum;
        return formatCost(datum.cost);
      })
      .attr("pointer-events", "none");
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

  if (!data || data.length === 0) return null;

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative" }}>
      <svg ref={svgRef} style={{ minHeight: MIN_HEIGHT }} />
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
