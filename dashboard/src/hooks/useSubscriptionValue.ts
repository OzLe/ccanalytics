/**
 * @module hooks/useSubscriptionValue
 *
 * Computes the "Subscription Value" / ROI numbers for the currently selected
 * period: API-equivalent cost vs. the PRORATED flat subscription fee.
 *
 * It is pure client-side math composed over hooks that already exist —
 * `useCostTotal()` (filter/period-aware → apiEquivalentUSD) and `useSettings()`
 * (tier + monthlyUSD) — plus the active period from `useFilters()`. No new API
 * endpoint is required.
 *
 * Prorating (from the design spec):
 *   proratedFeeUSD = monthlyUSD × (periodDays / 30.4375)   // 365.25 / 12
 *   savingsUSD     = apiEquivalentUSD − proratedFeeUSD
 *   roiMultiple    = proratedFeeUSD > 0 ? apiEquivalentUSD / proratedFeeUSD : null
 *
 * periodDays mapping: today=1, 7d=7, 30d=30, 90d=90, all=dataset day-span.
 * The dataset day-span is not cheaply available client-side, so "all" falls
 * back to 30 days with `periodDaysIsEstimate = true` so the UI can caveat it.
 *
 * When tier === "none" there is no subscription to compare against, so the hook
 * returns a neutral, disabled result and the ROI views hide/neutralize.
 */
import { useMemo } from "react";
import { useCostTotal } from "./useCostData";
import { useSettings } from "./useSettings";
import { useFilters, type Period } from "./useFilters";
import type { SubscriptionTier } from "@/lib/types";

/** Average days per month — 365.25 / 12. Used for fee proration. */
export const AVG_DAYS_PER_MONTH = 30.4375;

/** Days fallback for the "all" period when the true dataset span is unknown. */
const ALL_PERIOD_FALLBACK_DAYS = 30;

/** Result of the subscription-value computation for the active period. */
export interface SubscriptionValue {
  /** The user's subscription tier. */
  tier: SubscriptionTier;
  /** Flat monthly subscription fee in USD (0 for "none"). */
  monthlyUSD: number;
  /** API-equivalent cost for the selected period (= cost/total totalCostUSD). */
  apiEquivalentUSD: number;
  /** The monthly fee prorated to the selected period. 0 when tier is "none". */
  proratedFeeUSD: number;
  /** apiEquivalentUSD − proratedFeeUSD. Positive = the plan paid off. */
  savingsUSD: number;
  /** apiEquivalentUSD / proratedFeeUSD, or null when there is no fee. */
  roiMultiple: number | null;
  /** Number of days the selected period covers (used for proration). */
  periodDays: number;
  /** True when periodDays is an estimate (the "all" period fallback). */
  periodDaysIsEstimate: boolean;
  /** The active filter period. */
  period: Period;
  /**
   * True when there is no subscription to compare against (tier === "none") —
   * the ROI views should hide or render a neutral variant.
   */
  isNeutral: boolean;
  /** apiEquivalentUSD < proratedFeeUSD — below break-even this period. */
  isUnderwater: boolean;
  /** Whether the underlying cost/settings queries are still loading. */
  isLoading: boolean;
}

/** Map a filter period to the number of days it covers, for fee proration. */
function periodToDays(period: Period): {
  days: number;
  isEstimate: boolean;
} {
  switch (period) {
    case "today":
      // 1 for stability — a fraction-of-day prorated fee swings wildly.
      return { days: 1, isEstimate: false };
    case "7d":
      return { days: 7, isEstimate: false };
    case "30d":
      return { days: 30, isEstimate: false };
    case "90d":
      return { days: 90, isEstimate: false };
    case "all":
      // True dataset span isn't cheaply available client-side — fall back to
      // 30 days and let the UI caveat it.
      return { days: ALL_PERIOD_FALLBACK_DAYS, isEstimate: true };
    default:
      return { days: 7, isEstimate: false };
  }
}

/**
 * Compute the subscription-value / ROI numbers for the active period.
 *
 * Reads the API-equivalent cost from `useCostTotal()` and the subscription
 * tier/fee from `useSettings()`, then prorates the fee to the selected period.
 */
export function useSubscriptionValue(): SubscriptionValue {
  const costTotal = useCostTotal();
  const settings = useSettings();
  const { filters } = useFilters();
  const period = filters.period;

  return useMemo<SubscriptionValue>(() => {
    const tier: SubscriptionTier =
      settings.data?.subscription.tier ?? "max-20x";
    const monthlyUSD = settings.data?.subscription.monthlyUSD ?? 0;
    const apiEquivalentUSD = costTotal.data?.totalCostUSD ?? 0;
    const { days: periodDays, isEstimate: periodDaysIsEstimate } =
      periodToDays(period);

    const isNeutral = tier === "none";
    const proratedFeeUSD = isNeutral
      ? 0
      : monthlyUSD * (periodDays / AVG_DAYS_PER_MONTH);
    const savingsUSD = apiEquivalentUSD - proratedFeeUSD;
    const roiMultiple =
      proratedFeeUSD > 0 ? apiEquivalentUSD / proratedFeeUSD : null;
    const isUnderwater = !isNeutral && apiEquivalentUSD < proratedFeeUSD;

    return {
      tier,
      monthlyUSD,
      apiEquivalentUSD,
      proratedFeeUSD,
      savingsUSD,
      roiMultiple,
      periodDays,
      periodDaysIsEstimate,
      period,
      isNeutral,
      isUnderwater,
      isLoading: costTotal.isLoading || settings.isLoading,
    };
  }, [
    costTotal.data?.totalCostUSD,
    costTotal.isLoading,
    settings.data?.subscription.tier,
    settings.data?.subscription.monthlyUSD,
    settings.isLoading,
    period,
  ]);
}
