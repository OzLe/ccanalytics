import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type {
  ListResponse,
  Session,
  ListParams,
  ApiEnvelope,
  SessionStats,
  SessionListResponse,
  SessionDetailEnvelope,
} from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

export function useSessionsQuery(params?: ListParams) {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.page_size) searchParams.set("page_size", String(params.page_size));
  if (params?.sort_by) searchParams.set("sort_by", params.sort_by);
  if (params?.sort_order) searchParams.set("sort_order", params.sort_order);
  if (params?.project) searchParams.set("project", params.project);
  if (params?.model) searchParams.set("model", params.model);
  if (params?.date_start) searchParams.set("date_start", params.date_start);
  if (params?.date_end) searchParams.set("date_end", params.date_end);

  const qs = searchParams.toString();
  const endpoint = `/sessions${qs ? `?${qs}` : ""}`;

  return useQuery({
    queryKey: ["sessions", params],
    queryFn: () => apiGet<ListResponse<Session>>(endpoint),
  });
}

/** GET /api/sessions/stats */
export function useSessionStats() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["sessions", "stats", filters],
    queryFn: () => apiGet<ApiEnvelope<SessionStats>>(`/sessions/stats?${qs}`),
    select: (res) => res.data,
  });
}

// ---------------------------------------------------------------------------
// New hooks for the Sessions analytics pages
// ---------------------------------------------------------------------------

export interface UseSessionsParams {
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * GET /api/sessions – paginated, sortable list of sessions.
 * Automatically includes global filter params (period, model, project).
 */
export function useSessions(params?: UseSessionsParams) {
  const { filters, qs: filterQs } = useFilterParams();

  const extra = new URLSearchParams();
  if (params?.sort) extra.set("sort", params.sort);
  if (params?.order) extra.set("order", params.order);
  if (params?.limit != null) extra.set("limit", String(params.limit));
  if (params?.offset != null) extra.set("offset", String(params.offset));

  const extraQs = extra.toString();
  const fullQs = [filterQs, extraQs].filter(Boolean).join("&");
  const endpoint = `/sessions?${fullQs}`;

  return useQuery({
    queryKey: ["sessions", "list", filters, params],
    queryFn: () => apiGet<SessionListResponse>(endpoint),
  });
}

/**
 * GET /api/sessions/:id – full detail for a single session.
 */
export function useSessionDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["sessions", "detail", id],
    queryFn: () => apiGet<SessionDetailEnvelope>(`/sessions/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  });
}
