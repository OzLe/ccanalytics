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
  ToolFailureTrendPoint,
  FailureChainsData,
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

/**
 * NEW-002: GET /api/tools/failure-trend — tool failure-rate over time, split
 * builtin-vs-MCP. Automatically includes the global filter params.
 */
export function useToolFailureTrend(bucket: "day" | "week" | "month" = "day") {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["tools", "failure-trend", bucket, filters],
    queryFn: () =>
      apiGet<ApiEnvelope<ToolFailureTrendPoint[]>>(
        `/tools/failure-trend?bucket=${bucket}&${qs}`,
      ),
    select: (res) => res.data,
  });
}

/**
 * NEW-003: GET /api/tools/failure-chains — consecutive tool-failure streaks
 * (rework signal): dataset summary + worst-offender sessions. Automatically
 * includes the global filter params.
 */
export function useToolFailureChains(limit = 20) {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["tools", "failure-chains", limit, filters],
    queryFn: () =>
      apiGet<ApiEnvelope<FailureChainsData>>(
        `/tools/failure-chains?limit=${limit}&${qs}`,
      ),
    select: (res) => res.data,
  });
}
