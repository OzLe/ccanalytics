/**
 * Pure helpers for the orchestration tree (AgentTreeGraph). Kept JSX-free so
 * the degrade decision is unit-testable without a DOM.
 */
// Relative (not "@/lib/types") so this JSX-free helper is importable from a
// root-level vitest test without the dashboard's "@" path alias.
import type { AgentTreeNode } from "./types";

/** The largest single-node fan-out anywhere in the tree. */
export function maxBranching(node: AgentTreeNode): number {
  let max = node.children.length;
  for (const c of node.children) {
    max = Math.max(max, maxBranching(c));
  }
  return max;
}

/** Total descendant count (root excluded). */
export function countDescendants(node: AgentTreeNode): number {
  let n = node.children.length;
  for (const c of node.children) {
    n += countDescendants(c);
  }
  return n;
}

/**
 * A d3 tidy tree crowds badly once a node fans out past ~15 children (the
 * verified real-world max is 44 sub-agents in one session). Above the
 * threshold, the component renders an indented collapsible list instead.
 */
export const WIDE_TREE_THRESHOLD = 15;

export function shouldUseIndentedTree(
  node: AgentTreeNode,
  threshold: number = WIDE_TREE_THRESHOLD,
): boolean {
  return maxBranching(node) > threshold;
}
