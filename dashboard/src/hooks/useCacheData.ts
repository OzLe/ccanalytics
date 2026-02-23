/**
 * React Query hooks for all /api/cache/* endpoints.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type {
  ApiEnvelope,
  CacheMetrics,
  CacheTrendPoint,
} from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

/** GET /api/cache/metrics */
export function useCacheMetrics() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["cache", "metrics", filters],
    queryFn: () => apiGet<ApiEnvelope<CacheMetrics>>(`/cache/metrics?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/cache/trend */
export function useCacheTrend() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["cache", "trend", filters],
    queryFn: () =>
      apiGet<ApiEnvelope<CacheTrendPoint[]>>(`/cache/trend?${qs}`),
    select: (res) => res.data,
  });
}
