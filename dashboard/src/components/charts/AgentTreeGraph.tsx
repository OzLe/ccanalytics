import { useRef, useEffect, useCallback, useState } from "react";
import * as d3 from "d3";
import type { AgentTreeNode } from "@/lib/types";
import { formatCost } from "@/lib/formatters";
import { TOOLTIP_BG, TOOLTIP_BORDER, TOOLTIP_TEXT } from "@/lib/chartTheme";
import { shouldUseIndentedTree } from "@/lib/agentTree";

const WORKFLOW_COLOR = "#ec4899";
const AGENT_COLOR = "#22c55e";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Orchestration tree: session → workflow-run / regular-agent → workflow-agent.
 * A shallow, node-labeled left-to-right tidy tree. When any node fans out past
 * ~15 children it degrades to an indented collapsible list (readable at 44/
 * session; a radial/tidy layout would crowd the labels).
 */
export default function AgentTreeGraph({ data }: { data: AgentTreeNode | undefined }) {
  if (!data || data.children.length === 0) return null;
  return shouldUseIndentedTree(data) ? (
    <IndentedTree node={data} />
  ) : (
    <TidyTree data={data} />
  );
}

/* ── d3 tidy tree (SVG) ─────────────────────────────────────── */
function TidyTree({ data }: { data: AgentTreeNode }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    if (!svgRef.current || !containerRef.current) return;
    const style = getComputedStyle(document.documentElement);
    const colText = style.getPropertyValue("--text-primary").trim() || "#f1f5f9";
    const colSub = style.getPropertyValue("--text-secondary").trim() || "#94a3b8";
    const colLink = style.getPropertyValue("--border").trim() || "#2d3348";
    const accent = style.getPropertyValue("--accent").trim() || "#6366f1";
    const kindColor = (kind: AgentTreeNode["kind"]): string =>
      kind === "session" ? accent : kind === "workflow" ? WORKFLOW_COLOR : AGENT_COLOR;

    const marginL = 90;
    const marginR = 170;
    const width = containerRef.current.clientWidth || 640;

    const root = d3.hierarchy<AgentTreeNode>(data, (d) => d.children);
    const nodeCount = root.descendants().length;
    const height = Math.max(240, nodeCount * 22);

    const layout = d3
      .tree<AgentTreeNode>()
      .size([height - 20, Math.max(120, width - marginL - marginR)]);
    const pointRoot = layout(root);

    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height);
    svg.selectAll("*").remove();
    const g = svg.append("g").attr("transform", `translate(${marginL},10)`);

    const linkGen = d3
      .linkHorizontal<
        d3.HierarchyPointLink<AgentTreeNode>,
        d3.HierarchyPointNode<AgentTreeNode>
      >()
      .x((d) => d.y)
      .y((d) => d.x);

    g.append("g")
      .attr("fill", "none")
      .attr("stroke", colLink)
      .attr("stroke-width", 1.2)
      .selectAll("path")
      .data(pointRoot.links())
      .join("path")
      .attr("d", (d) => linkGen(d));

    const tooltip = d3.select(tooltipRef.current);

    const node = g
      .selectAll("g.node")
      .data(pointRoot.descendants())
      .join("g")
      .attr("class", "node")
      .attr("transform", (d) => `translate(${d.y},${d.x})`);

    node
      .append("circle")
      .attr("r", 4.5)
      .attr("fill", (d) => kindColor(d.data.kind))
      .style("cursor", "default")
      .on("mouseenter", function (event: MouseEvent, d) {
        const cost = d.data.costUSD != null ? ` · ${formatCost(d.data.costUSD)}` : "";
        tooltip
          .style("opacity", "1")
          .html(
            `<strong>${escapeHtml(d.data.label)}</strong><br/>${d.data.kind}${cost}`,
          )
          .style("left", `${event.offsetX + 12}px`)
          .style("top", `${event.offsetY - 20}px`);
      })
      .on("mousemove", function (event: MouseEvent) {
        tooltip
          .style("left", `${event.offsetX + 12}px`)
          .style("top", `${event.offsetY - 20}px`);
      })
      .on("mouseleave", () => tooltip.style("opacity", "0"));

    node
      .append("text")
      .attr("dy", "0.32em")
      .attr("x", (d) => (d.children ? -8 : 8))
      .attr("text-anchor", (d) => (d.children ? "end" : "start"))
      .attr("fill", (d) => (d.depth === 0 ? colText : colSub))
      .attr("font-size", 11)
      .attr("font-family", "'Inter', sans-serif")
      .text((d) => truncate(d.data.label, 26))
      .attr("pointer-events", "none");
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

/* ── Indented collapsible list (degrade path — pure React) ──── */
function IndentedTree({ node }: { node: AgentTreeNode }) {
  return (
    <ul role="tree" className="text-[var(--font-small-size)]">
      <TreeItem node={node} depth={0} defaultOpen />
    </ul>
  );
}

function TreeItem({
  node,
  depth,
  defaultOpen = false,
}: {
  node: AgentTreeNode;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || depth < 1);
  const hasChildren = node.children.length > 0;
  const dot =
    node.kind === "session"
      ? "var(--accent)"
      : node.kind === "workflow"
        ? WORKFLOW_COLOR
        : AGENT_COLOR;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined}>
      <div
        className="flex items-center gap-2 rounded py-0.5 hover:bg-[var(--bg-hover)]"
        style={{ paddingLeft: `${depth * 16}px`, cursor: hasChildren ? "pointer" : "default" }}
        onClick={hasChildren ? () => setOpen((o) => !o) : undefined}
      >
        <span className="w-3 select-none text-[var(--text-tertiary)]">
          {hasChildren ? (open ? "▾" : "▸") : ""}
        </span>
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dot }}
        />
        <span className="truncate text-[var(--text-primary)]">{node.label}</span>
        {node.subagentType && node.kind === "agent" && (
          <span className="truncate text-xs text-[var(--text-tertiary)]">
            {node.subagentType}
          </span>
        )}
        {hasChildren && (
          <span className="text-xs text-[var(--text-tertiary)]">
            ({node.children.length})
          </span>
        )}
        {node.costUSD != null && node.costUSD > 0 && (
          <span className="ml-auto shrink-0 tabular-nums text-xs text-[var(--text-secondary)]">
            {formatCost(node.costUSD)}
          </span>
        )}
      </div>
      {hasChildren && open && (
        <ul role="group">
          {node.children.map((c, i) => (
            <TreeItem key={`${c.id}-${i}`} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
