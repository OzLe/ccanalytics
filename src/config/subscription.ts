/**
 * @module config/subscription
 *
 * Single source of truth for Claude subscription tiers and their flat monthly
 * prices. Used by:
 *   - DEFAULT_CONFIG (the default tier),
 *   - the dashboard settings API (to sanitize PUT payloads), and
 *   - the dashboard UI (mirrored, to populate the tier selector).
 *
 * Prices confirmed against claude.com/pricing (2026-05): Free/None $0,
 * Pro $20/mo, MAX 5x $100/mo, MAX 20x $200/mo. Team ($30/seat) and Enterprise
 * (custom) are intentionally omitted — this is a single-user local tool.
 *
 * NOTE: this is presentation/ROI metadata only. Nothing here changes how cost
 * is computed; per-model rates live in src/utils/pricing.ts.
 */

import type { SubscriptionTier } from "../types/config.js";

/** A selectable subscription tier with its label and flat monthly price. */
export interface SubscriptionTierOption {
  /** Stable discriminator id stored in config. */
  id: SubscriptionTier;
  /** Human-readable label for the UI selector. */
  label: string;
  /** Flat monthly fee in USD. */
  monthlyUSD: number;
}

/** Canonical, ordered list of subscription tiers. Single source of truth. */
export const SUBSCRIPTION_TIERS: ReadonlyArray<SubscriptionTierOption> = [
  { id: "none", label: "None (API pay-as-you-go)", monthlyUSD: 0 },
  { id: "pro", label: "Pro", monthlyUSD: 20 },
  { id: "max-5x", label: "MAX 5x", monthlyUSD: 100 },
  { id: "max-20x", label: "MAX 20x", monthlyUSD: 200 },
];

/** Map of tier id -> flat monthly fee in USD, derived from SUBSCRIPTION_TIERS. */
export const DEFAULT_MONTHLY_USD: Record<SubscriptionTier, number> =
  Object.fromEntries(
    SUBSCRIPTION_TIERS.map((t) => [t.id, t.monthlyUSD]),
  ) as Record<SubscriptionTier, number>;

/** The set of valid tier ids, for fast membership checks. */
const KNOWN_TIER_IDS = new Set<string>(SUBSCRIPTION_TIERS.map((t) => t.id));

/** Type guard: is the given value one of the four known subscription tiers? */
export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return typeof value === "string" && KNOWN_TIER_IDS.has(value);
}
