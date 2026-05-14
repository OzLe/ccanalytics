/**
 * @module config
 *
 * Barrel export for the configuration module.
 * Provides config loading, defaults, and validation.
 */

export { loadConfig } from "./loader.js";
export { DEFAULT_CONFIG } from "./defaults.js";
export {
  SUBSCRIPTION_TIERS,
  DEFAULT_MONTHLY_USD,
  isSubscriptionTier,
  type SubscriptionTierOption,
} from "./subscription.js";
