/**
 * React Query hooks for all /api/skills/* endpoints (F2K — Chunk D).
 *
 * Each hook reads the global filters internally via `useFilterParams()` — the
 * page must NOT pass period/model/project. The `filters` object is always the
 * LAST element of the query key so a filter change refetches every skill query.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type {
  ApiEnvelope,
  SkillSummary,
  SkillLoadedRow,
  SkillInvocationRow,
  SkillTrendPoint,
  SkillNotRequiredData,
} from "@/lib/types";
import { useFilterParams } from "./useFilterParams";

/**
 * GET /api/skills/summary — the page-level skill KPI bundle plus the
 * "too many skills active" flags. Powers the KPI row and the conditional
 * advisory banner.
 */
export function useSkillSummary() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["skills", "summary", filters],
    queryFn: () => apiGet<ApiEnvelope<SkillSummary>>(`/skills/summary?${qs}`),
    select: (res) => res.data,
  });
}

/**
 * GET /api/skills/loaded — every loaded skill with its est. context weight,
 * how many sessions loaded it, its invocation count, and the dead-weight flag.
 * Powers the "Loaded Skills by Context Weight" table.
 */
export function useSkillLoaded() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["skills", "loaded", filters],
    queryFn: () => apiGet<ApiEnvelope<SkillLoadedRow[]>>(`/skills/loaded?${qs}`),
    select: (res) => res.data,
  });
}

/**
 * GET /api/skills/invocations — per-skill invocation stats. Powers the Top
 * Skills bar chart, the "Skill Invocation Detail" table, and the invocation
 * KPIs.
 */
export function useSkillInvocations() {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["skills", "invocations", filters],
    queryFn: () =>
      apiGet<ApiEnvelope<SkillInvocationRow[]>>(`/skills/invocations?${qs}`),
    select: (res) => res.data,
  });
}

/**
 * GET /api/skills/trend — Skills-Per-Session over time (avgLoadedPerSession vs
 * avgInvokedPerSession per `?bucket`). Powers the trend line chart.
 */
export function useSkillTrend(bucket: "hour" | "day" | "week" | "month" = "day") {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["skills", "trend", bucket, filters],
    queryFn: () =>
      apiGet<ApiEnvelope<SkillTrendPoint[]>>(
        `/skills/trend?bucket=${bucket}&${qs}`,
      ),
    select: (res) => res.data,
  });
}

/**
 * GET /api/skills/not-required — the same-session thrash signal: flagged
 * `(session, skill)` rows plus a small summary. Powers the
 * "Possibly-Unnecessary Invocations" table.
 */
export function useSkillNotRequired(limit = 100) {
  const { filters, qs } = useFilterParams();
  return useQuery({
    queryKey: ["skills", "not-required", limit, filters],
    queryFn: () =>
      apiGet<ApiEnvelope<SkillNotRequiredData>>(
        `/skills/not-required?limit=${limit}&${qs}`,
      ),
    select: (res) => res.data,
  });
}
