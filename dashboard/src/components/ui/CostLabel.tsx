/**
 * @module components/ui/CostLabel
 *
 * Shared presentational label for cost figures. Renders a tier-aware label
 * ("API-equivalent cost" on a subscription, plain "Cost" on pay-as-you-go) next
 * to a small `Info` affordance whose tooltip explains that flat-fee subscribers
 * are not charged these amounts.
 *
 * Centralizes the wording (all strings come from lib/costLabels.ts) and reuses
 * the existing Tooltip primitive — no new tooltip infra.
 */

import { Info } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";
import {
  API_EQUIVALENT_TOOLTIP,
  costLabel,
} from "@/lib/costLabels";
import type { SubscriptionTier } from "@/lib/types";

/**
 * - `kpi`     — small overline label, for KPI card label slots.
 * - `heading` — sits next to a SectionHeader / ChartCard title.
 * - `inline`  — caption-sized, for inline use within other text.
 */
type CostLabelVariant = "kpi" | "heading" | "inline";

interface CostLabelProps {
  /**
   * The active subscription tier. Drives the tier-aware label text — "none"
   * softens "API-equivalent cost" to plain "Cost".
   */
  tier?: SubscriptionTier;
  /** Explicit label override. Defaults to the tier-aware label. */
  text?: string;
  /** Visual sizing/treatment. Default: "inline". */
  variant?: CostLabelVariant;
  /** Tooltip body override. Defaults to the canonical API-equivalent tooltip. */
  tooltip?: string;
  className?: string;
}

const variantTextClass: Record<CostLabelVariant, string> = {
  kpi: "text-overline text-[var(--text-secondary)]",
  heading: "text-small font-medium text-[var(--text-secondary)]",
  inline: "text-caption text-[var(--text-tertiary)]",
};

const variantIconSize: Record<CostLabelVariant, number> = {
  kpi: 12,
  heading: 13,
  inline: 12,
};

export default function CostLabel({
  tier,
  text,
  variant = "inline",
  tooltip = API_EQUIVALENT_TOOLTIP,
  className,
}: CostLabelProps) {
  const label = text ?? costLabel(tier);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[var(--space-1)]",
        variantTextClass[variant],
        className,
      )}
    >
      {label}
      <Tooltip content={tooltip} position="top" className="max-w-xs whitespace-normal">
        <Info
          size={variantIconSize[variant]}
          strokeWidth={2}
          className="text-[var(--text-tertiary)]"
          aria-label="What does this cost mean?"
        />
      </Tooltip>
    </span>
  );
}

export type { CostLabelProps, CostLabelVariant };
