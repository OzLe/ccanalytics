/**
 * React Query hook for GET /api/health.
 *
 * Polled so the health banner appears when the database stops opening and
 * clears on its own once it opens again. A 503 still carries the JSON body,
 * so the response is read directly rather than through `apiGet` (which
 * throws on any non-2xx status).
 */
import { useQuery } from "@tanstack/react-query";
import type { HealthStatus } from "@/lib/types";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: async (): Promise<HealthStatus> => {
      const response = await fetch("/api/health");
      return (await response.json()) as HealthStatus;
    },
    refetchInterval: 30_000,
    staleTime: 0,
    retry: false,
  });
}
