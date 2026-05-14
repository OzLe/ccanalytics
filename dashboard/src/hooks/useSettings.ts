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
  SubscriptionSettings,
  SubscriptionTier,
} from "@/lib/types";

/** Response payload shape for GET/PUT /api/settings. */
interface SettingsData {
  subscription: SubscriptionSettings;
}

/** Request body for PUT /api/settings — only the tier is required. */
interface UpdateSettingsBody {
  subscription: { tier: SubscriptionTier; monthlyUSD?: number };
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
 * PUT /api/settings — persists the subscription tier.
 *
 * On success, invalidates ['settings'] AND all ['cost', …] / ['dashboard', …]
 * keys so every cost figure and the ROI band re-render with the new prorated
 * fee. monthlyUSD is derived server-side from the tier, so callers send only
 * `{ subscription: { tier } }`.
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettingsBody) =>
      apiPut<ApiEnvelope<SettingsData>>("/settings", body),
    onSuccess: (res) => {
      // Seed the settings cache with the server's authoritative response.
      queryClient.setQueryData<ApiEnvelope<SettingsData>>(["settings"], res);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      // The prorated fee changed — recompute everything cost-derived.
      queryClient.invalidateQueries({ queryKey: ["cost"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
