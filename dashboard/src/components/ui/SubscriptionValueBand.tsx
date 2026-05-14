/**
 * @module components/ui/SubscriptionValueBand
 *
 * The Overview hero band — the single most important MAX-framing reframing,
 * placed at the TOP of the Overview page above the KPI grid.
 *
 * For the currently selected period it compares API-equivalent cost against the
 * PRORATED subscription fee and answers "is my MAX 20x worth it?" at a glance:
 * a headline ROI multiple, a savings sentence, and three compact stats
 * (API-equivalent cost / prorated fee / saved).
 *
 * Reads the shared `useSubscriptionValue` hook so its numbers can never diverge
 * from the detailed `SubscriptionValueSection` on the Cost Analysis page.
 * Renders nothing when `tier === "none"` (no subscription to compare against).
 */

import { TrendingUp, AlertTriangle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import Skeleton from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { useSubscriptionValue } from "@/hooks/useSubscriptionValue";
import { useSettings } from "@/hooks/useSettings";
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

/** A single compact stat in the band. */
function BandStat({
  label,
  value,
  tone = "default",
  tooltip,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
  tooltip?: string;
}) {
  const valueColor =
    tone === "positive"
      ? "text-[var(--success)]"
      : tone === "negative"
        ? "text-[var(--danger)]"
        : "text-[var(--text-primary)]";

  const labelNode = (
    <p className="text-caption text-[var(--text-tertiary)]">{label}</p>
  );

  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      {tooltip ? (
        <Tooltip content={tooltip} position="top" className="max-w-xs whitespace-normal">
          <span className="cursor-help border-b border-dotted border-[var(--text-tertiary)]">
            {labelNode}
          </span>
        </Tooltip>
      ) : (
        labelNode
      )}
      <p className={cn("text-h3 font-semibold tabular-nums", valueColor)}>
        {value}
      </p>
    </div>
  );
}

export default function SubscriptionValueBand() {
  const settings = useSettings();
  const sv = useSubscriptionValue();

  // No subscription to compare against — render nothing.
  if (!settings.isLoading && sv.isNeutral) {
    return null;
  }

  if (sv.isLoading) {
    return (
      <div
        className={cn(
          "rounded-[var(--radius-xl)] border border-[var(--accent-muted)]",
          "bg-[var(--accent-subtle)] p-[var(--space-6)]",
        )}
      >
        <Skeleton shape="text" className="mb-[var(--space-3)] h-4 w-1/3" />
        <Skeleton shape="text" className="mb-[var(--space-4)] h-8 w-2/3" />
        <div className="grid grid-cols-3 gap-[var(--space-4)]">
          <Skeleton shape="text" className="h-10" />
          <Skeleton shape="text" className="h-10" />
          <Skeleton shape="text" className="h-10" />
        </div>
      </div>
    );
  }

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
  } = sv;

  const periodText = periodLabel(period, periodDays, periodDaysIsEstimate);
  const roiText = roiMultiple !== null ? `${roiMultiple.toFixed(1)}x` : "N/A";
  const Icon = isUnderwater ? AlertTriangle : Sparkles;

  // Headline + sentence copy. Underwater (below break-even) is shown in a
  // warning tone, never as a bare scary red number without context.
  const headline = isUnderwater
    ? `Below break-even ${periodText}`
    : `${roiText} value`;

  const sentence = isUnderwater
    ? `${formatCost(proratedFeeUSD)} ${tierLabel(tier)} plan vs. ${formatCost(
        apiEquivalentUSD,
      )} of API-equivalent usage ${periodText}.`
    : `${formatCost(apiEquivalentUSD)} of API-equivalent usage for your ` +
      `${formatCost(monthlyUSD)}/mo plan — ${formatCost(
        Math.abs(savingsUSD),
      )} saved ${periodText}.`;

  return (
    <div
      className={cn(
        "rounded-[var(--radius-xl)] border p-[var(--space-6)]",
        "transition-all duration-[var(--duration-normal)]",
        isUnderwater
          ? "border-[var(--warning-muted)] bg-[var(--warning-subtle)]"
          : "border-[var(--accent-muted)] bg-[var(--accent-subtle)]",
      )}
    >
      <div className="flex flex-col gap-[var(--space-5)] md:flex-row md:items-center md:justify-between">
        {/* Headline + sentence */}
        <div className="flex items-start gap-[var(--space-3)]">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
              isUnderwater
                ? "bg-[var(--warning-muted)] text-[var(--warning)]"
                : "bg-[var(--accent-muted)] text-[var(--accent)]",
            )}
          >
            <Icon size={20} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-[var(--space-2)]">
              <p className="text-overline text-[var(--text-secondary)]">
                Subscription Value
              </p>
              {!isUnderwater && roiMultiple !== null && (
                <span className="inline-flex items-center gap-[var(--space-1)] text-caption text-[var(--success)]">
                  <TrendingUp size={12} strokeWidth={2.5} />
                  {roiText}
                </span>
              )}
            </div>
            <p className="mt-[var(--space-1)] text-h2 text-[var(--text-primary)]">
              {headline}
            </p>
            <p className="mt-[var(--space-1)] text-small text-[var(--text-secondary)]">
              {sentence}
            </p>
          </div>
        </div>

        {/* Three compact stats */}
        <div className="grid shrink-0 grid-cols-3 gap-[var(--space-5)] md:gap-[var(--space-6)]">
          <BandStat
            label="API-equivalent cost"
            value={formatCost(apiEquivalentUSD)}
            tooltip={API_EQUIVALENT_TOOLTIP}
          />
          <BandStat
            label="Prorated fee"
            value={formatCost(proratedFeeUSD)}
            tooltip={`Your ${formatCost(
              monthlyUSD,
            )}/mo plan prorated to ${periodText}.`}
          />
          <BandStat
            label="Saved"
            value={formatCost(savingsUSD)}
            tone={savingsUSD >= 0 ? "positive" : "negative"}
          />
        </div>
      </div>
    </div>
  );
}
