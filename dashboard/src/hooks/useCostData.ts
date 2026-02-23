/**
 * React Query hooks for all /api/cost/* endpoints.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type {
  ApiEnvelope,
  CostTotal,
  CostTrendPoint,
  CostDailyRow,
  CostByModel,
  CostByProject,
} from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

/** GET /api/cost/total */
export function useCostTotal() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["cost", "total", filters],
    queryFn: () => apiGet<ApiEnvelope<CostTotal>>(`/cost/total?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/cost/trend */
export function useCostTrend(bucket: "hour" | "day" | "week" | "month" = "day") {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["cost", "trend", bucket, filters],
    queryFn: () =>
      apiGet<ApiEnvelope<CostTrendPoint[]>>(`/cost/trend?bucket=${bucket}&${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/cost/daily */
export function useCostDaily() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["cost", "daily", filters],
    queryFn: () => apiGet<ApiEnvelope<CostDailyRow[]>>(`/cost/daily?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/cost/by-model */
export function useCostByModel() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["cost", "by-model", filters],
    queryFn: () => apiGet<ApiEnvelope<CostByModel[]>>(`/cost/by-model?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/cost/by-project */
export function useCostByProject() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["cost", "by-project", filters],
    queryFn: () => apiGet<ApiEnvelope<CostByProject[]>>(`/cost/by-project?${qs}`),
    select: (res) => res.data,
  });
}
