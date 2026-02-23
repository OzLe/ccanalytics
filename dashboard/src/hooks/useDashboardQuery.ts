import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { DashboardSummary, DailyCost } from "@/lib/types";

export function useDashboardSummary() {
  return useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => apiGet<DashboardSummary>("/dashboard/summary"),
  });
}

export function useDailyCosts(days = 30) {
  return useQuery({
    queryKey: ["dashboard", "daily-costs", days],
    queryFn: () => apiGet<DailyCost[]>(`/dashboard/daily-costs?days=${days}`),
  });
}
