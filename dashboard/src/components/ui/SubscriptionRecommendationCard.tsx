/**
 * @module components/ui/SubscriptionRecommendationCard
 *
 * The "Should I up/downgrade?" recommendation card, rendered inside the Cost
 * Analysis "Subscription Value" section right below the ROI card. It consumes
 * the read-only `useRecommendation()` hook (GET /api/recommendation) for the
 * active period and presents the verdict, a confidence chip, the monthly $
 * delta, the short rationale, the per-model weekly breakdown, the ceiling
 * provenance (estimate vs. calibrated), and the mandatory estimate caveat.
 *
 * Design discipline: NO new component library. It reuses the existing
 * `ChartCard` shell, `Badge` chips, `KPICard` for the $ delta, `BandStat` for
 * the compact window/weekly stats, the shared `formatCost` / `formatPercent`
 * formatters, and the established CSS tokens — matching the house style of
 * `SubscriptionValueSection` / `SubscriptionValueBand`. Every numeric ceiling
 * arrives via the API payload; none are hard-coded here.
 *
 * Verdict treatment uses the existing colour language:
 *   - downgrade (saves money) → success / "saved"
 *   - upgrade   (needs headroom) → warning / "extra"
 *   - stay      → accent (healthy band)
 *   - neutral   (tier "none")  → info, stats only, no verdict claim
 */

import { ArrowDownRight, ArrowUpRight, Check, Info } from "lucide-react";
import ChartCard from "@/components/ui/ChartCard";
import KPICard from "@/components/ui/KPICard";
import Badge, { type BadgeProps } from "@/components/ui/Badge";
import { BandStat } from "@/components/ui/BandStat";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";
import { formatCost, formatPercent } from "@/lib/formatters";
import { useRecommendation } from "@/hooks/useRecommendation";
import type {
  RecommendationConfidence,
  RecommendationVerdict,
  WindowStats,
} from "@/lib/types";

/** Visual treatment for a verdict — icon, tone, and badge variant. */
interface VerdictTreatment {
  Icon: typeof ArrowUpRight;
  badgeVariant: NonNullable<BadgeProps["variant"]>;
  badgeLabel: string;
  /** Card accent border + tint, reusing the band tokens. */
  containerClass: string;
  /** Icon chip background + foreground. */
  iconClass: string;
}

const VERDICT_TREATMENT: Record<RecommendationVerdict, VerdictTreatment> = {
  // Downgrading SAVES money → the positive/success treatment.
  downgrade: {
    Icon: ArrowDownRight,
    badgeVariant: "success",
    badgeLabel: "Downgrade",
    containerClass: "border-[var(--success-muted)] bg-[var(--success-subtle)]",
    iconClass: "bg-[var(--success-muted)] text-[var(--success)]",
  },
  // Upgrading costs more but is the "you're hitting limits" attention signal.
  upgrade: {
    Icon: ArrowUpRight,
    badgeVariant: "warning",
    badgeLabel: "Upgrade",
    containerClass: "border-[var(--warning-muted)] bg-[var(--warning-subtle)]",
    iconClass: "bg-[var(--warning-muted)] text-[var(--warning)]",
  },
  // Healthy band — the neutral/accent "all good" treatment.
  stay: {
    Icon: Check,
    badgeVariant: "accent",
    badgeLabel: "Stay",
    containerClass: "border-[var(--accent-muted)] bg-[var(--accent-subtle)]",
    iconClass: "bg-[var(--accent-muted)] text-[var(--accent)]",
  },
  // Tier "none" (API pay-as-you-go) — informational, stats only.
  neutral: {
    Icon: Info,
    badgeVariant: "info",
    badgeLabel: "No tier",
    containerClass: "border-[var(--border)] bg-[var(--bg-surface)]",
    iconClass: "bg-[var(--bg-overlay)] text-[var(--info)]",
  },
};

/** Confidence chip variant — low is muted, high is informational. */
const CONFIDENCE_VARIANT: Record<
  RecommendationConfidence,
  NonNullable<BadgeProps["variant"]>
> = {
  low: "default",
  medium: "outline",
  high: "info",
};

/** Format a window's peak fill as a clamped percentage (display clamp at 100%). */
function fillPctLabel(fill: number): string {
  // The raw fill can exceed 1.0 (over the estimate); clamp display at 100% but
  // append a "+" so an over-limit window is still visibly distinct.
  if (fill > 1) return "100%+";
  return formatPercent(fill, 0);
}

/** One compact weekly per-model stat (all / sonnet / opus). */
function WeeklyStat({ label, stats }: { label: string; stats: WindowStats }) {
  // No windows for this class in the period → render a clear "—".
  if (stats.activeWindows === 0) {
    return <BandStat label={label} value="—" />;
  }
  return (
    <BandStat
      label={label}
      value={fillPctLabel(stats.peakFill)}
      tooltip={`Peak weekly API-equivalent cost reached ~${fillPctLabel(
        stats.peakFill,
      )} of the estimated weekly limit across ${stats.activeWindows} window${
        stats.activeWindows === 1 ? "" : "s"
      }.`}
    />
  );
}

export default function SubscriptionRecommendationCard() {
  const { data, isLoading, isError } = useRecommendation();

  // Loading — let ChartCard render its shared skeleton (matches every surface).
  if (isLoading) {
    return (
      <ChartCard title="Subscription Recommendation" loading empty={false}>
        {null}
      </ChartCard>
    );
  }

  // Error / no payload — keep it quiet rather than throwing; the rest of the
  // Subscription Value section still renders. (ChartCard's empty state.)
  if (isError || !data) {
    return (
      <ChartCard
        title="Subscription Recommendation"
        empty
        emptyMessage="Recommendation is unavailable right now."
      >
        {null}
      </ChartCard>
    );
  }

  const { recommendation: rec, perModelWeekly, windowStats5h, ceilingSource } =
    data;
  const treatment = VERDICT_TREATMENT[rec.verdict];
  const { Icon } = treatment;

  // $ delta phrasing reuses the existing "saved"/"extra" ROI language, keyed
  // on the SIGN of the delta (not the verdict): a "subscribe" upgrade from
  // pay-as-you-go carries a NEGATIVE delta (the flat fee undercuts the API
  // run-rate), and must read as savings, not additional cost.
  const deltaAbs = Math.abs(rec.monthlyDeltaUSD);
  const deltaLabel =
    rec.monthlyDeltaUSD < 0
      ? "Est. monthly savings"
      : rec.monthlyDeltaUSD > 0
        ? "Est. additional cost"
        : "Monthly delta";
  const deltaValue =
    rec.monthlyDeltaUSD === 0
      ? "$0.00"
      : `${formatCost(deltaAbs)}/mo`;
  const deltaVariant =
    rec.monthlyDeltaUSD < 0
      ? "success"
      : rec.monthlyDeltaUSD > 0
        ? "warning"
        : "default";

  // Usage-trend chip (optional payload field; older servers omit it). The
  // "unknown" state (too few windows to claim a direction) renders nothing.
  const trend = rec.trend;
  const showTrend = trend === "rising" || trend === "falling" || trend === "flat";
  const trendLabel =
    trend === "rising" ? "usage rising" : trend === "falling" ? "usage falling" : "usage flat";
  const trendTooltip =
    "Direction of your 5-hour window costs: the recent half of the period compared to the earlier half.";

  // ceilingSource indicator wording — "calibrated" vs the honest "estimate".
  const ceilingLabel =
    ceilingSource === "calibrated" ? "Calibrated to your usage" : "Default estimate";
  const ceilingTooltip =
    ceilingSource === "calibrated"
      ? "Your observed peak usage exceeded the default estimated limit, so the limit was raised to at least your peak before computing these percentages."
      : "Percentages are measured against the default estimated tier limits (your usage stayed within them).";

  // The neutral (tier "none") variant shows stats + the explanation, but makes
  // no up/down claim and shows no $ delta KPI.
  const isNeutral = rec.verdict === "neutral";

  return (
    <div
      className={cn(
        "rounded-[var(--radius-xl)] border p-[var(--space-6)]",
        "transition-all duration-[var(--duration-normal)]",
        treatment.containerClass,
      )}
    >
      <div className="flex flex-col gap-[var(--space-5)]">
        {/* ── Headline row: icon + verdict + confidence chip ── */}
        <div className="flex flex-col gap-[var(--space-4)] md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-[var(--space-3)]">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
                treatment.iconClass,
              )}
            >
              <Icon size={20} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                <p className="text-overline text-[var(--text-secondary)]">
                  Recommendation
                </p>
                <Badge variant={treatment.badgeVariant} size="sm" dot>
                  {treatment.badgeLabel}
                </Badge>
                <Tooltip
                  content={rec.confidenceReason}
                  position="top"
                  className="max-w-xs whitespace-normal"
                >
                  <Badge
                    variant={CONFIDENCE_VARIANT[rec.confidence]}
                    size="sm"
                    className="cursor-help"
                  >
                    {rec.confidence} confidence
                  </Badge>
                </Tooltip>
                {showTrend && (
                  <Tooltip
                    content={trendTooltip}
                    position="top"
                    className="max-w-xs whitespace-normal"
                  >
                    <Badge variant="outline" size="sm" className="cursor-help">
                      {trendLabel}
                    </Badge>
                  </Tooltip>
                )}
              </div>
              <p className="mt-[var(--space-1)] text-h2 text-[var(--text-primary)]">
                {rec.headline}
              </p>
              <p className="mt-[var(--space-1)] text-small text-[var(--text-secondary)]">
                {rec.detail}
              </p>
            </div>
          </div>

          {/* $ delta KPI (hidden for the neutral / no-tier case). */}
          {!isNeutral && (
            <div className="w-full shrink-0 md:w-56">
              <KPICard
                label={deltaLabel}
                value={deltaValue}
                type="cost"
                variant={deltaVariant}
              />
            </div>
          )}
        </div>

        {/* ── Usage stats: 5h peak + weekly per-model peaks ── */}
        <div
          className={cn(
            "grid grid-cols-2 gap-[var(--space-4)] border-t border-[var(--border)] pt-[var(--space-4)]",
            perModelWeekly.fable ? "sm:grid-cols-5" : "sm:grid-cols-4",
          )}
        >
          <BandStat
            label="5-hour peak"
            value={fillPctLabel(windowStats5h.peakFill)}
            tooltip={`Highest 5-hour-window API-equivalent cost in this period, as a share of the estimated 5-hour limit. ${windowStats5h.nearLimitWindows} of ${windowStats5h.activeWindows} windows reached ≥90%.`}
          />
          <WeeklyStat label="Weekly peak (all)" stats={perModelWeekly.all} />
          <WeeklyStat label="Weekly (Sonnet)" stats={perModelWeekly.sonnet} />
          <WeeklyStat label="Weekly (Opus)" stats={perModelWeekly.opus} />
          {perModelWeekly.fable && (
            <WeeklyStat label="Weekly (Fable)" stats={perModelWeekly.fable} />
          )}
        </div>

        {/* ── Ceiling provenance + the mandatory estimate caveat ── */}
        <div className="flex flex-col gap-[var(--space-2)] border-t border-[var(--border)] pt-[var(--space-4)]">
          <div className="flex items-center gap-[var(--space-2)]">
            <Tooltip
              content={ceilingTooltip}
              position="top"
              className="max-w-xs whitespace-normal"
            >
              <Badge
                variant={ceilingSource === "calibrated" ? "accent" : "outline"}
                size="sm"
                className="cursor-help"
              >
                {ceilingLabel}
              </Badge>
            </Tooltip>
          </div>
          <p className="text-caption text-[var(--text-tertiary)]">
            {rec.caveat}
          </p>
        </div>
      </div>
    </div>
  );
}
