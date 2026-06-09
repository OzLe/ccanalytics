/**
 * React Query hooks for the /api/settings endpoint.
 *
 * `useSettings()` reads the resolved subscription config (GET /api/settings).
 * `useUpdateSettings()` saves it (PUT /api/settings) and, on success,
 * invalidates not just ['settings'] but every ['cost', …] and ['dashboard', …]
 * query key — because changing the subscription tier changes the prorated fee
 * the Subscription Value band and all relabeled cost figures derive from, so
 * they must recompute immediately.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "@/lib/api";
import type {
  ApiEnvelope,
  DisplaySettings,
  RecommendationSettings,
  SubscriptionSettings,
  SubscriptionTier,
  TierLimitOverrides,
} from "@/lib/types";

/** Response payload shape for GET/PUT /api/settings. */
interface SettingsData {
  subscription: SubscriptionSettings;
  /** ACT-001 / SEM2-293: optional for back-compat with older server builds. */
  display?: DisplaySettings;
  /**
   * Subscription-recommendation behaviour (auto-calibrate + sparse ceiling
   * overrides). Optional for back-compat with older server builds.
   */
  recommendation?: RecommendationSettings;
}

/**
 * Request body for PUT /api/settings. Any single key can be sent on its own;
 * the server preserves the other halves from disk (non-clobbering merge).
 */
interface UpdateSettingsBody {
  subscription?: { tier: SubscriptionTier; monthlyUSD?: number };
  display?: { userTimezone: string };
  recommendation?: { autoCalibrate?: boolean; ceilings?: TierLimitOverrides };
}

/** GET /api/settings — resolved subscription config. */
export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<ApiEnvelope<SettingsData>>("/settings"),
    select: (res) => res.data,
    // Settings rarely change and aren't time-scoped — keep them fresh longer.
    staleTime: 30 * 60 * 1000,
  });
}

/**
 * PUT /api/settings — persists the subscription tier and/or display block.
 *
 * On success, invalidates ['settings'] AND every query that depends on
 * either the subscription fee (cost/dashboard) OR the timezone projection
 * (activity/cache/tools/skills/cost) — the safest catch-all is to clear
 * the whole query cache when a `display` field changes, but to keep the UX
 * snappy we settle for invalidating the time-math query keys. The caller
 * passes only the keys it wants changed; the server preserves the rest.
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettingsBody) =>
      apiPut<ApiEnvelope<SettingsData>>("/settings", body),
    onSuccess: (res, variables) => {
      // Seed the settings cache with the server's authoritative response.
      queryClient.setQueryData<ApiEnvelope<SettingsData>>(["settings"], res);
      queryClient.invalidateQueries({ queryKey: ["settings"] });

      if (variables.subscription) {
        // The prorated fee changed — recompute everything cost-derived.
        queryClient.invalidateQueries({ queryKey: ["cost"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }

      if (variables.display) {
        // ACT-001: every hour-of-day / day-of-week / local-date / DATE_TRUNC
        // bucket on the server is re-projected through the new tz, so every
        // time-math query key needs to refetch.
        for (const key of ["activity", "cost", "cache", "tools", "skills", "dashboard"]) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      }

      if (variables.recommendation) {
        // The recommendation reads the auto-calibrate toggle + ceiling overrides
        // server-side, so changing either must recompute the verdict.
        queryClient.invalidateQueries({ queryKey: ["recommendation"] });
      }
    },
  });
}
