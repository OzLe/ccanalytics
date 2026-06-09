/**
 * @module components/ui/SubscriptionValueSection
 *
 * The Cost Analysis "Subscription Value" section — the detailed "show your
 * work" home for the MAX-framing ROI view, placed right after the Cost Overview
 * KPIs on the Cost Analysis page.
 *
 * Same three stats as the Overview `SubscriptionValueBand` (API-equivalent cost
 * / prorated fee / saved) PLUS the prorating breakdown
 * ("$200/mo × 7/30.4 days = $46.05 prorated fee"), the ROI multiple as a KPI,
 * and a one-line interpretation. Reads the same `useSubscriptionValue` hook so
 * the numbers never diverge from the Overview band.
 *
 * It also hosts the read-only "Should I up/downgrade?" recommendation
 * (`SubscriptionRecommendationCard`, fed by GET /api/recommendation). The ROI
 * card renders only for a paid tier, but the recommendation card always renders
 * so the tier-"none" user still sees the neutral usage-stats variant.
 */

import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import SubscriptionRecommendationCard from "@/components/ui/SubscriptionRecommendationCard";
import { useSubscriptionValue, AVG_DAYS_PER_MONTH } from "@/hooks/useSubscriptionValue";
import { formatCost } from "@/lib/formatters";
import { API_EQUIVALENT_TOOLTIP } from "@/lib/costLabels";
import { SUBSCRIPTION_TIER_OPTIONS } from "@/lib/types";
import type { Period } from "@/hooks/useFilters";

/** Human-readable label for the active period. */
function periodLabel(period: Period, periodDays: number, isEstimate: boolean): string {
  switch (period) {
    case "today":
      return "today";
    case "7d":
      return "the last 7 days";
    case "30d":
      return "the last 30 days";
    case "90d":
      return "the last 90 days";
    case "all":
      return isEstimate ? `all time (≈${periodDays}-day estimate)` : "all time";
    default:
      return `the last ${periodDays} days`;
  }
}

/** Resolve the human label for a tier id (e.g. "max-20x" → "MAX 20x"). */
function tierLabel(tierId: string): string {
  return SUBSCRIPTION_TIER_OPTIONS.find((t) => t.id === tierId)?.label ?? tierId;
}

export default function SubscriptionValueSection() {
  const sv = useSubscriptionValue();

  const {
    apiEquivalentUSD,
    proratedFeeUSD,
    savingsUSD,
    roiMultiple,
    monthlyUSD,
    tier,
    period,
    periodDays,
    periodDaysIsEstimate,
    isUnderwater,
    isLoading,
    isNeutral,
  } = sv;

  const periodText = periodLabel(period, periodDays, periodDaysIsEstimate);
  const roiText = roiMultiple !== null ? `${roiMultiple.toFixed(1)}x` : "N/A";

  // Prorating breakdown, e.g. "$200/mo × 7 / 30.44 days = $46.05".
  const proratedBreakdown =
    `${formatCost(monthlyUSD)}/mo × ${periodDays} / ${AVG_DAYS_PER_MONTH} days ` +
    `= ${formatCost(proratedFeeUSD)} prorated fee`;

  // One-line interpretation.
  const interpretation = isUnderwater
    ? `Below break-even ${periodText} — your ${tierLabel(
        tier,
      )} plan costs more than your usage would at API rates. ` +
      `This is normal for short or light periods; ROI swings widely day to day.`
    : roiMultiple !== null
      ? `Your usage is worth ${roiText} your prorated fee ${periodText}.`
      : `Your usage is worth ${formatCost(apiEquivalentUSD)} ${periodText}.`;

  const shortPeriodCaveat =
    period === "today"
      ? "Short period — the prorated fee is tiny, so ROI swings widely day to day."
      : periodDaysIsEstimate
        ? "The all-time prorated fee uses a 30-day estimate; the true dataset span may differ."
        : null;

  return (
    <section className="space-y-[var(--space-3)]">
      <SectionHeader
        title="Subscription Value"
        subtitle={
          isNeutral
            ? "Usage-intensity stats and an up/downgrade recommendation (estimates)"
            : "What your usage would cost at API rates vs. your flat subscription fee"
        }
      />

      {/* ROI card — only meaningful on a paid tier (tier "none" has no fee). */}
      {!isNeutral && (
      <ChartCard
        title="ROI for the Selected Period"
        subtitle={proratedBreakdown}
        loading={isLoading}
        empty={false}
      >
        <div className="space-y-[var(--space-5)]">
          {/* The four sub-metrics, reusing KPICard. */}
          <div className="grid grid-cols-2 gap-[var(--space-4)] lg:grid-cols-4">
            <KPICard
              label="API-equivalent cost"
              labelTooltip={API_EQUIVALENT_TOOLTIP}
              value={formatCost(apiEquivalentUSD)}
              type="cost"
              variant="default"
              loading={isLoading}
            />
            <KPICard
              label="Prorated fee"
              labelTooltip={`Your ${formatCost(
                monthlyUSD,
              )}/mo plan prorated to ${periodText}: ${proratedBreakdown}.`}
              value={formatCost(proratedFeeUSD)}
              type="cost"
              variant="default"
              loading={isLoading}
            />
            <KPICard
              label={isUnderwater ? "Net cost" : "Saved"}
              value={formatCost(savingsUSD)}
              type="cost"
              variant={isUnderwater ? "warning" : "success"}
              loading={isLoading}
            />
            <KPICard
              label="ROI multiple"
              labelTooltip="API-equivalent cost ÷ prorated subscription fee. Above 1.0x means your usage is worth more than the plan costs for this period."
              value={roiText}
              type="tokens"
              variant={
                isUnderwater
                  ? "warning"
                  : roiMultiple !== null && roiMultiple >= 1
                    ? "accent"
                    : "default"
              }
              loading={isLoading}
            />
          </div>

          {/* Interpretation line + caveats. */}
          {!isLoading && (
            <div className="space-y-[var(--space-2)] border-t border-[var(--border)] pt-[var(--space-4)]">
              <p className="text-small text-[var(--text-secondary)]">
                {interpretation}
              </p>
              {shortPeriodCaveat && (
                <p className="text-caption text-[var(--text-tertiary)]">
                  {shortPeriodCaveat}
                </p>
              )}
            </div>
          )}
        </div>
      </ChartCard>
      )}

      {/* Up/downgrade recommendation — always rendered (handles the neutral
          tier-"none" stats-only variant itself). */}
      <SubscriptionRecommendationCard />
    </section>
  );
}
