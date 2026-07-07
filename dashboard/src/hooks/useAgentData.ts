/**
 * React Query hooks for all /api/agents/* endpoints (F-SA).
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type {
  ApiEnvelope,
  AgentsSummary,
  AgentTypeRow,
  WorkflowRow,
  AgentTreeNode,
  AgentTimeline,
  AgentCostAttributionRow,
} from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

/** GET /api/agents/summary */
export function useAgentsSummary() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["agents", "summary", filters],
    queryFn: () => apiGet<ApiEnvelope<AgentsSummary>>(`/agents/summary?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/agents/by-type */
export function useAgentsByType() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["agents", "by-type", filters],
    queryFn: () => apiGet<ApiEnvelope<AgentTypeRow[]>>(`/agents/by-type?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/agents/workflows */
export function useAgentWorkflows() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["agents", "workflows", filters],
    queryFn: () => apiGet<ApiEnvelope<WorkflowRow[]>>(`/agents/workflows?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/agents/cost-attribution */
export function useAgentCostAttribution() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["agents", "cost-attribution", filters],
    queryFn: () =>
      apiGet<ApiEnvelope<AgentCostAttributionRow[]>>(`/agents/cost-attribution?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/agents/tree?sessionId= — only fires when a session is selected. */
export function useAgentTree(sessionId: string | null) {
  return useQuery({
    queryKey: ["agents", "tree", sessionId],
    queryFn: () =>
      apiGet<ApiEnvelope<AgentTreeNode>>(
        `/agents/tree?sessionId=${encodeURIComponent(sessionId ?? "")}`,
      ),
    select: (res) => res.data,
    enabled: !!sessionId,
  });
}

/** GET /api/agents/timeline?sessionId= — only fires when a session is selected. */
export function useAgentTimeline(sessionId: string | null) {
  return useQuery({
    queryKey: ["agents", "timeline", sessionId],
    queryFn: () =>
      apiGet<ApiEnvelope<AgentTimeline>>(
        `/agents/timeline?sessionId=${encodeURIComponent(sessionId ?? "")}`,
      ),
    select: (res) => res.data,
    enabled: !!sessionId,
  });
}
