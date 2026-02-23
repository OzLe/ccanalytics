/**
 * React Query hooks for all /api/activity/* endpoints.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type {
  ApiEnvelope,
  ActivityHourly,
  ActivityDaily,
  ActivityHeatmap,
} from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

/** GET /api/activity/hourly */
export function useActivityHourly() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["activity", "hourly", filters],
    queryFn: () =>
      apiGet<ApiEnvelope<ActivityHourly[]>>(`/activity/hourly?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/activity/daily */
export function useActivityDaily() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["activity", "daily", filters],
    queryFn: () =>
      apiGet<ApiEnvelope<ActivityDaily[]>>(`/activity/daily?${qs}`),
    select: (res) => res.data,
  });
}

/** GET /api/activity/heatmap */
export function useActivityHeatmap() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["activity", "heatmap", filters],
    queryFn: () =>
      apiGet<ApiEnvelope<ActivityHeatmap[]>>(`/activity/heatmap?${qs}`),
    select: (res) => res.data,
  });
}
