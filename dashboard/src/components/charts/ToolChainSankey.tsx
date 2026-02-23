import { useRef, useEffect, useCallback } from "react";
import * as d3 from "d3";
import {
  sankey as d3Sankey,
  sankeyLinkHorizontal,
  type SankeyNode,
  type SankeyLink,
} from "d3-sankey";
import type { ToolChain } from "@/lib/types";
import { CHART_COLORS } from "@/lib/chartTheme";

interface Props {
  data: ToolChain[] | undefined;
}

interface SNode {
  name: string;
}

interface SLink {
  source: number;
  target: number;
  value: number;
  label: string;
}

const TOOLTIP_BG = "#1e2235";
const TOOLTIP_BORDER = "#2a2d3e";
const TOOLTIP_TEXT = "#e2e8f0";
const MIN_HEIGHT = 400;

export default function ToolChainSankey({ data }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    if (!data || data.length === 0 || !svgRef.current || !containerRef.current)
      return;

    const width = containerRef.current.clientWidth;
    const height = Math.max(MIN_HEIGHT, width * 0.5);
    const margin = { top: 16, right: 24, bottom: 16, left: 24 };

    // Build nodes and links from chain data
    const nodeNames = new Set<string>();
    const linkMap = new Map<string, { source: string; target: string; value: number }>();

    for (const chain of data) {
      for (let i = 0; i < chain.chain.length; i++) {
        const toolName = chain.chain[i]!;
        nodeNames.add(toolName);
        if (i < chain.chain.length - 1) {
          const nextTool = chain.chain[i + 1]!;
          const key = `${toolName}||${nextTool}`;
          const existing = linkMap.get(key);
          if (existing) {
            existing.value += chain.occurrences;
          } else {
            linkMap.set(key, {
              source: toolName,
              target: nextTool,
              value: chain.occurrences,
            });
          }
        }
      }
    }

    const nodeArray = Array.from(nodeNames);
    const nodeIndex = new Map(nodeArray.map((n, i) => [n, i]));

    const nodes: SNode[] = nodeArray.map((name) => ({ name }));
    const links: SLink[] = Array.from(linkMap.values())
      .filter((l) => l.source !== l.target) // sankey doesn't support self-loops
      .map((l) => ({
        source: nodeIndex.get(l.source)!,
        target: nodeIndex.get(l.target)!,
        value: l.value,
        label: `${l.source} → ${l.target}: ${l.value} transitions`,
      }));

    if (nodes.length === 0 || links.length === 0) return;

    // Detect and remove cycles - d3-sankey throws "circular link" otherwise
    const adj = new Map<number, Set<number>>();
    for (const l of links) {
      if (!adj.has(l.source)) adj.set(l.source, new Set());
      adj.get(l.source)!.add(l.target);
    }
    const visited = new Set<number>();
    const stack = new Set<number>();
    const cycleEdges = new Set<string>();
    function dfs(node: number): void {
      visited.add(node);
      stack.add(node);
      for (const neighbor of adj.get(node) ?? []) {
        if (stack.has(neighbor)) {
          cycleEdges.add(`${node}->${neighbor}`);
        } else if (!visited.has(neighbor)) {
          dfs(neighbor);
        }
      }
      stack.delete(node);
    }
    for (const n of nodes.keys()) {
      if (!visited.has(n)) dfs(n);
    }
    const safeLinks = links.filter(
      (l) => !cycleEdges.has(`${l.source}->${l.target}`),
    );
    if (safeLinks.length === 0) return;

    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height);

    svg.selectAll("*").remove();

    const sankeyGen = d3Sankey<SNode, SLink>()
      .nodeWidth(18)
      .nodePadding(14)
      .extent([
        [margin.left, margin.top],
        [width - margin.right, height - margin.bottom],
      ]);

    let graph;
    try {
      graph = sankeyGen({
        nodes: nodes.map((d) => ({ ...d })),
        links: safeLinks.map((d) => ({ ...d })),
      });
    } catch {
      return; // gracefully bail if sankey still fails
    }

    const tooltip = d3.select(tooltipRef.current);

    // Links
    const linkGroup = svg
      .append("g")
      .attr("fill", "none")
      .selectAll("path")
      .data(graph.links)
      .join("path")
      .attr("d", sankeyLinkHorizontal())
      .attr("stroke", (_d, i) => CHART_COLORS[i % CHART_COLORS.length]!)
      .attr("stroke-opacity", 0.35)
      .attr("stroke-width", (d) => Math.max(1, d.width ?? 1))
      .style("cursor", "pointer")
      .on("mouseenter", function (event, d) {
        d3.select(this).attr("stroke-opacity", 0.7);
        const link = d as SankeyLink<SNode, SLink> & { label?: string };
        const sourceName = (link.source as SankeyNode<SNode, SLink>).name ?? "";
        const targetName = (link.target as SankeyNode<SNode, SLink>).name ?? "";
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${sourceName} → ${targetName}</strong><br/>${d.value} transitions`,
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

    // Animate links in
    linkGroup
      .attr("stroke-dasharray", function () {
        const len = (this as SVGPathElement).getTotalLength();
        return `${len} ${len}`;
      })
      .attr("stroke-dashoffset", function () {
        return (this as SVGPathElement).getTotalLength();
      })
      .transition()
      .duration(600)
      .attr("stroke-dashoffset", 0);

    // Nodes
    const nodeGroup = svg
      .append("g")
      .selectAll("rect")
      .data(graph.nodes)
      .join("rect")
      .attr("x", (d) => d.x0 ?? 0)
      .attr("y", (d) => d.y0 ?? 0)
      .attr("height", (d) => Math.max(1, (d.y1 ?? 0) - (d.y0 ?? 0)))
      .attr("width", (d) => (d.x1 ?? 0) - (d.x0 ?? 0))
      .attr("fill", (_d, i) => CHART_COLORS[i % CHART_COLORS.length]!)
      .attr("rx", 3)
      .attr("opacity", 0)
      .style("cursor", "pointer");

    nodeGroup.transition().duration(300).attr("opacity", 1);

    // Highlight connected paths on hover
    nodeGroup
      .on("mouseenter", function (_event, d) {
        const connectedLinks = new Set<number>();
        const connectedNodes = new Set<number>();
        for (const [i, link] of graph.links.entries()) {
          const src = link.source as SankeyNode<SNode, SLink>;
          const tgt = link.target as SankeyNode<SNode, SLink>;
          if (src.index === d.index || tgt.index === d.index) {
            connectedLinks.add(i);
            connectedNodes.add(src.index ?? 0);
            connectedNodes.add(tgt.index ?? 0);
          }
        }
        svg
          .selectAll<SVGPathElement, SankeyLink<SNode, SLink>>("path")
          .attr("stroke-opacity", (_l, i) =>
            connectedLinks.has(i) ? 0.7 : 0.1,
          );
        svg
          .selectAll<SVGRectElement, SankeyNode<SNode, SLink>>("rect")
          .attr("opacity", (_n, i) => (connectedNodes.has(i) ? 1 : 0.3));
      })
      .on("mouseleave", function () {
        svg.selectAll("path").attr("stroke-opacity", 0.35);
        svg.selectAll("rect").attr("opacity", 1);
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
        return x0 < width / 2 ? x1 + 6 : x0 - 6;
      })
      .attr("y", (d) => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", (d) => ((d.x0 ?? 0) < width / 2 ? "start" : "end"))
      .attr("fill", "#e2e8f0")
      .attr("font-size", 12)
      .attr("font-weight", 500)
      .attr("font-family", "'Inter', sans-serif")
      .text((d) => d.name ?? "");
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
