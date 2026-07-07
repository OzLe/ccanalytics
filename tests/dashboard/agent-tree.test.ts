/**
 * @module tests/dashboard/agent-tree
 *
 * Unit tests for the AgentTreeGraph degrade decision (pure helpers). There is
 * no React Testing Library / jsdom in this repo, so we test the decision logic
 * that drives the "d3 tidy tree vs indented list" split rather than rendering.
 */

import { describe, it, expect } from "vitest";
import {
  maxBranching,
  countDescendants,
  shouldUseIndentedTree,
  WIDE_TREE_THRESHOLD,
} from "../../dashboard/src/lib/agentTree.js";
import type { AgentTreeNode } from "../../dashboard/src/lib/types.js";

function agent(id: string): AgentTreeNode {
  return { id, label: id, kind: "agent", children: [] };
}

describe("agentTree degrade helpers", () => {
  it("keeps a narrow tree on the tidy-tree path", () => {
    const node: AgentTreeNode = {
      id: "s",
      label: "s",
      kind: "session",
      children: [agent("a"), agent("b"), agent("c")],
    };
    expect(maxBranching(node)).toBe(3);
    expect(countDescendants(node)).toBe(3);
    expect(shouldUseIndentedTree(node)).toBe(false);
  });

  it("degrades to the indented list when a node fans out past the threshold", () => {
    const children = Array.from({ length: WIDE_TREE_THRESHOLD + 5 }, (_, i) =>
      agent(`a${i}`),
    );
    const node: AgentTreeNode = { id: "s", label: "s", kind: "session", children };
    expect(maxBranching(node)).toBe(WIDE_TREE_THRESHOLD + 5);
    expect(shouldUseIndentedTree(node)).toBe(true);
  });

  it("detects a wide fan-out nested under a workflow node", () => {
    const wfChildren = Array.from({ length: 20 }, (_, i) => agent(`w${i}`));
    const node: AgentTreeNode = {
      id: "s",
      label: "s",
      kind: "session",
      children: [
        agent("regular-1"),
        { id: "wf_1", label: "wf_1", kind: "workflow", children: wfChildren },
      ],
    };
    // The session itself only has 2 children, but the nested workflow node is wide.
    expect(maxBranching(node)).toBe(20);
    expect(shouldUseIndentedTree(node)).toBe(true);
    expect(countDescendants(node)).toBe(22);
  });
});
