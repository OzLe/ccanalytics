/**
 * React Query hooks for the /api/tokens/* endpoints (F1 — Total Tokens KPI).
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { ApiEnvelope, TokenTotals } from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

/**
 * GET /api/tokens/total
 *
 * Mirrors `useCostTotal()`. Returns `{ period, allTime }` token breakdowns —
 * `period` respects the active filters, `allTime` is a fully unfiltered,
 * dataset-wide constant (D7).
 */
export function useTokenTotal() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["tokens", "total", filters],
    queryFn: () => apiGet<ApiEnvelope<TokenTotals>>(`/tokens/total?${qs}`),
    select: (res) => res.data,
  });
}
