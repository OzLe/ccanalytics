/**
 * Format a number as USD currency.
 *
 * Kept purely numeric — it is used inside chart tooltips/axes where a basis
 * suffix would be noise. Labeling cost figures as "API-equivalent" is done at
 * the component/heading level (see CostLabel.tsx), NOT inside formatCost.
 */
export function formatCost(value: number, decimals = 4): string {
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(decimals)}`;
}

/**
 * Format a cost with the "API-equiv." basis suffix baked in, for the few inline
 * spots that want it inside a sentence (e.g. InsightCard descriptions).
 *
 * Most cost figures should use plain `formatCost` plus a `CostLabel` heading
 * instead — this is only for prose where a separate label would not fit.
 */
export function formatCostWithBasis(value: number, decimals = 4): string {
  return `${formatCost(value, decimals)} API-equiv.`;
}

/**
 * Format a large token count with K/M suffixes.
 */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString();
}

/**
 * Format a number as a percentage.
 */
export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Format a duration in seconds to a human-readable string.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) {
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Format a date string to a locale-friendly short form.
 */
export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateShort(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Format a date string to include time.
 */
export function formatDateTime(date: string | Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
