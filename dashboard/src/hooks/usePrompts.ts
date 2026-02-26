/**
 * React Query hooks for all /api/prompts/* endpoints.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type {
  PromptRankingResponse,
  PromptStatsResponse,
  PromptDetailResponse,
} from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

// ---------------------------------------------------------------------------
// Hook options
// ---------------------------------------------------------------------------

export interface UsePromptRankingOptions {
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * GET /api/prompts/ranked — paginated, sorted prompt ranking.
 * Automatically includes global filter params (period, model, project).
 */
export function usePromptRanking(options?: UsePromptRankingOptions) {
  const { filters, qs: filterQs } = useFilterParams();

  const extra = new URLSearchParams();
  if (options?.sort) extra.set("sort", options.sort);
  if (options?.order) extra.set("order", options.order);
  if (options?.page != null) extra.set("page", String(options.page));
  if (options?.limit != null) extra.set("limit", String(options.limit));

  const extraQs = extra.toString();
  const fullQs = [filterQs, extraQs].filter(Boolean).join("&");
  const endpoint = `/prompts/ranked?${fullQs}`;

  return useQuery({
    queryKey: ["prompts", "ranked", filters, options],
    queryFn: () => apiGet<PromptRankingResponse>(endpoint),
  });
}

/**
 * GET /api/prompts/stats — aggregate prompt statistics.
 * Automatically includes global filter params (period, model, project).
 */
export function usePromptStats() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["prompts", "stats", filters],
    queryFn: () => apiGet<PromptStatsResponse>(`/prompts/stats?${qs}`),
    select: (res) => res.data,
  });
}

/**
 * GET /api/prompts/:turnId — full detail for a single prompt.
 * Only enabled when turnId is provided.
 */
export function usePromptDetail(turnId: string | undefined) {
  return useQuery({
    queryKey: ["prompts", "detail", turnId],
    queryFn: () => apiGet<PromptDetailResponse>(`/prompts/${turnId}`),
    select: (res) => res.data,
    enabled: !!turnId,
  });
}
