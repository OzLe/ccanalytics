/**
 * @module lib/costLabels
 *
 * Canonical wording for cost labels across the dashboard.
 *
 * Every displayed cost figure is *API-equivalent* cost — what the metered usage
 * WOULD cost at standard pay-as-you-go API rates — NOT the user's flat Claude
 * subscription fee. A MAX subscriber pays $0.00 per token, so an unlabeled
 * "Total Cost" of thousands of dollars is actively misleading.
 *
 * All cost-label strings live here so the phrasing is changed in exactly one
 * place. CostLabel.tsx and any ad-hoc usage import from this module.
 */

import type { SubscriptionTier } from "./types";

/** Primary label for a cost figure. */
export const API_EQUIVALENT_LABEL = "API-equivalent cost";

/** Label for a "Total Cost" KPI card. */
export const API_EQUIVALENT_KPI_LABEL = "Total Cost (API-equivalent)";

/** Short suffix for inline sentence usage (e.g. InsightCard descriptions). */
export const API_EQUIVALENT_SHORT = "API-equiv.";

/**
 * Tooltip body shown next to cost figures. Explains that flat-fee subscribers
 * are not charged these amounts and points to the Subscription Value view.
 */
export const API_EQUIVALENT_TOOLTIP =
  "What this usage would cost at standard pay-as-you-go API rates. " +
  "You're on a flat-fee subscription, so this is not money charged to you — " +
  "it's the value of your usage. See the Subscription Value section for your ROI.";

/** Label for the Cache page "Estimated Savings" KPI (MAX-004). */
export const CACHE_SAVINGS_LABEL = "Estimated Cache Savings";

/**
 * Tooltip body for cache "savings" figures (MAX-004).
 *
 * Caching saves rate-limit budget and latency, not cash, for a flat-fee
 * subscriber — the dollar figure is purely "vs. uncached API list pricing".
 */
export const CACHE_SAVINGS_TOOLTIP =
  "Estimated savings vs. paying uncached API list pricing for the same tokens. " +
  "On a flat-fee subscription this is not money saved — caching saves rate-limit " +
  "budget and latency, not cash. It's the API-pricing value of your cache reuse.";

/**
 * Tier-aware cost label.
 *
 * When the user is on a subscription (tier !== "none"), every cost figure is
 * "API-equivalent cost". When tier === "none", the same figures ARE the user's
 * actual API spend, so the label softens to plain "Cost" (the tooltip still
 * explains the rate basis).
 */
export function costLabel(tier: SubscriptionTier | undefined): string {
  return tier && tier !== "none" ? API_EQUIVALENT_LABEL : "Cost";
}

/**
 * Tier-aware label for a "Total Cost" KPI card.
 *
 * "Total Cost (API-equivalent)" on a subscription; plain "Total Cost" on the
 * pay-as-you-go ("none") tier.
 */
export function totalCostKpiLabel(tier: SubscriptionTier | undefined): string {
  return tier && tier !== "none" ? API_EQUIVALENT_KPI_LABEL : "Total Cost";
}
