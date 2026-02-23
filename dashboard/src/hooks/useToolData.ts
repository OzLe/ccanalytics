/**
 * React Query hooks for all /api/tools/* endpoints.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type {
  ApiEnvelope,
  ToolUsageRow,
  ToolSuccessRate,
  ToolChain,
} from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

/** GET /api/tools/usage */
export function useToolUsage() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["tools", "usage", filters],
    queryFn: () => apiGet<ApiEnvelope<ToolUsageRow[]>>(`/tools/usage?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/tools/success-rates */
export function useToolSuccessRates() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["tools", "success-rates", filters],
    queryFn: () =>
      apiGet<ApiEnvelope<ToolSuccessRate[]>>(`/tools/success-rates?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/tools/chains */
export function useToolChains(minOccurrences = 3) {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["tools", "chains", minOccurrences, filters],
    queryFn: () =>
      apiGet<ApiEnvelope<ToolChain[]>>(
        `/tools/chains?minOccurrences=${minOccurrences}&${qs}`,
      ),
    select: (res) => res.data,
  });
}
