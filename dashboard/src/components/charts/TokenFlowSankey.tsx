import { useRef, useEffect, useCallback } from "react";
import * as d3 from "d3";
import {
  sankey as d3Sankey,
  sankeyLinkHorizontal,
  type SankeyNode,
} from "d3-sankey";
import type { CostTotal } from "@/lib/types";

interface Props {
  data: CostTotal | undefined;
}

interface TNode {
  name: string;
  color: string;
}

interface TLink {
  source: number;
  target: number;
  value: number;
}

const TOOLTIP_BG = "#1e2235";
const TOOLTIP_BORDER = "#2a2d3e";
const TOOLTIP_TEXT = "#e2e8f0";
const MIN_HEIGHT = 350;

const INPUT_COLOR = "#06b6d4";
const CACHE_COLOR = "#22c55e";
const OUTPUT_COLOR = "#6366f1";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function TokenFlowSankey({ data }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    if (!data || !svgRef.current || !containerRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = Math.max(MIN_HEIGHT, width * 0.45);
    const margin = { top: 20, right: 24, bottom: 20, left: 24 };

    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height);

    svg.selectAll("*").remove();

    // Nodes:
    // 0: Input Tokens (left)
    // 1: Cache Write (middle)
    // 2: Uncached Input (middle)
    // 3: Cache Read (middle)
    // 4: Output Tokens (right)
    const nodes: TNode[] = [
      { name: "Input Tokens", color: INPUT_COLOR },
      { name: "Cache Write", color: CACHE_COLOR },
      { name: "Uncached Input", color: INPUT_COLOR },
      { name: "Cache Read", color: CACHE_COLOR },
      { name: "Output Tokens", color: OUTPUT_COLOR },
    ];

    // Compute uncached input = total input - cache write tokens
    const uncachedInput = Math.max(
      0,
      data.totalInputTokens - data.totalCacheWriteTokens,
    );

    // Links:
    // Input Tokens -> Cache Write
    // Input Tokens -> Uncached Input
    // Cache Read -> Output Tokens (cache read feeds into output generation)
    // Uncached Input -> Output Tokens
    const links: TLink[] = [];

    if (data.totalCacheWriteTokens > 0) {
      links.push({ source: 0, target: 1, value: data.totalCacheWriteTokens });
    }
    if (uncachedInput > 0) {
      links.push({ source: 0, target: 2, value: uncachedInput });
    }
    if (data.totalCacheReadTokens > 0) {
      links.push({ source: 3, target: 4, value: data.totalCacheReadTokens });
    }
    if (data.totalOutputTokens > 0) {
      // Show uncached input feeding into output
      const feedIntoOutput = Math.min(uncachedInput, data.totalOutputTokens);
      if (feedIntoOutput > 0) {
        links.push({ source: 2, target: 4, value: feedIntoOutput });
      }
    }

    if (links.length === 0) return;

    const sankeyGen = d3Sankey<TNode, TLink>()
      .nodeWidth(20)
      .nodePadding(24)
      .extent([
        [margin.left, margin.top],
        [width - margin.right, height - margin.bottom],
      ]);

    const graph = sankeyGen({
      nodes: nodes.map((d) => ({ ...d })),
      links: links.map((d) => ({ ...d })),
    });

    const tooltip = d3.select(tooltipRef.current);

    // Links
    svg
      .append("g")
      .attr("fill", "none")
      .selectAll("path")
      .data(graph.links)
      .join("path")
      .attr("d", sankeyLinkHorizontal())
      .attr("stroke", (d) => {
        const src = d.source as SankeyNode<TNode, TLink>;
        return src.color ?? INPUT_COLOR;
      })
      .attr("stroke-opacity", 0.35)
      .attr("stroke-width", (d) => Math.max(1, d.width ?? 1))
      .style("cursor", "pointer")
      .on("mouseenter", function (event, d) {
        d3.select(this).attr("stroke-opacity", 0.65);
        const src = d.source as SankeyNode<TNode, TLink>;
        const tgt = d.target as SankeyNode<TNode, TLink>;
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${src.name} → ${tgt.name}</strong><br/>${formatTokens(d.value)} tokens`,
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
        d3.select(this).attr("stroke-opacity", 0.35);
        tooltip.style("opacity", "0");
      });

    // Nodes
    svg
      .append("g")
      .selectAll("rect")
      .data(graph.nodes)
      .join("rect")
      .attr("x", (d) => d.x0 ?? 0)
      .attr("y", (d) => d.y0 ?? 0)
      .attr("height", (d) => Math.max(1, (d.y1 ?? 0) - (d.y0 ?? 0)))
      .attr("width", (d) => (d.x1 ?? 0) - (d.x0 ?? 0))
      .attr("fill", (d) => d.color ?? INPUT_COLOR)
      .attr("rx", 4)
      .attr("opacity", 0.9)
      .style("cursor", "pointer")
      .on("mouseenter", function (event, d) {
        d3.select(this).attr("opacity", 1);
        const nodeValue = d.value ?? 0;
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${d.name}</strong><br/>${formatTokens(nodeValue)} tokens`,
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
        d3.select(this).attr("opacity", 0.9);
        tooltip.style("opacity", "0");
      });

    // Labels
    svg
      .append("g")
      .selectAll("text")
      .data(graph.nodes)
      .join("text")
      .attr("x", (d) => {
        const x0 = d.x0 ?? 0;
        const x1 = d.x1 ?? 0;
        return x0 < width / 2 ? x1 + 8 : x0 - 8;
      })
      .attr("y", (d) => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", (d) => ((d.x0 ?? 0) < width / 2 ? "start" : "end"))
      .attr("fill", "#e2e8f0")
      .attr("font-size", 12)
      .attr("font-weight", 500)
      .attr("font-family", "'Inter', sans-serif")
      .text((d) => {
        const val = d.value ?? 0;
        return `${d.name ?? ""} (${formatTokens(val)})`;
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
