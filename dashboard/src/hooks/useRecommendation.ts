/**
 * @module hooks/useRecommendation
 *
 * React Query hook for the read-only GET /api/recommendation endpoint.
 *
 * Mirrors the established cost/subscription hook conventions
 * (`useCostTotal` / `useSubscriptionValue`): it keys the query by the ACTIVE
 * period + the rest of the filter state (via `useFilterParams`), reuses the
 * shared `apiGet` fetch wrapper, and unwraps the standard `{ data, meta }`
 * envelope in `select`. No new fetch machinery is introduced.
 *
 * The payload is the full structured {@link RecommendationAnalysis} — window
 * stats, per-model weekly split, default + calibrated ceilings, the verdict,
 * and the honest estimate caveat. Every figure is an ESTIMATE; the consuming
 * UI surfaces `data.caveat` verbatim.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { ApiEnvelope, RecommendationAnalysis } from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

/**
 * GET /api/recommendation — the subscription up/down/stay recommendation for
 * the active period, respecting the model/project filters exactly as the cost
 * surfaces do. The query string carries the active `period` (the route accepts
 * today|7d|30d|90d|all and defaults to 30d only when absent).
 */
export function useRecommendation() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["recommendation", filters],
    queryFn: () =>
      apiGet<ApiEnvelope<RecommendationAnalysis>>(`/recommendation?${qs}`),
    select: (res) => res.data,
  });
}
