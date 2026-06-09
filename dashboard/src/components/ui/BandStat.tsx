/**
 * @module components/ui/BandStat
 *
 * A single compact label/value stat used in the Subscription Value surfaces
 * (the Overview hero band and the Cost Analysis recommendation card). Extracted
 * from `SubscriptionValueBand` so both surfaces share one definition rather
 * than each re-declaring the same tone/tooltip treatment.
 *
 * Uses only existing CSS tokens + the shared `Tooltip` — no new design system.
 */

import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/Tooltip";

export interface BandStatProps {
  label: string;
  value: string;
  /** Colour treatment for the value text. */
  tone?: "default" | "positive" | "negative";
  /** Optional dotted-underline help tooltip on the label. */
  tooltip?: string;
}

/** A single compact stat (label over a tabular-nums value). */
export function BandStat({ label, value, tone = "default", tooltip }: BandStatProps) {
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

export default BandStat;
