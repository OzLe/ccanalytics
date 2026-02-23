/**
 * Utility hook that converts the global filter state into
 * query string parameters for API calls.
 */
import { useMemo } from "react";
import { useFilters, type Filters } from "./useFilters";

/** Build a URLSearchParams-compatible query string from filters. */
export function buildFilterQS(filters: Filters): string {
  const params = new URLSearchParams();
  params.set("period", filters.period);
  if (filters.model) params.set("model", filters.model);
  if (filters.project) params.set("project", filters.project);
  return params.toString();
}

/**
 * Returns a memoized query string derived from the current global filters.
 * Also returns the raw filters object for use as a React Query key.
 */
export function useFilterParams() {
  const { filters } = useFilters();

  const qs = useMemo(() => buildFilterQS(filters), [filters]);

  return { filters, qs };
}
