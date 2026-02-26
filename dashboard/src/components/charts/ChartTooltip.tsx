/**
 * Custom Recharts tooltip component styled for the dark dashboard theme.
 * Pass as the `content` prop of a Recharts <Tooltip />.
 */
import type { TooltipProps } from "recharts";

interface ChartTooltipProps extends TooltipProps<number, string> {
  /** Optional formatter for the value display. */
  valueFormatter?: (value: number) => string;
  /** Optional formatter for the tooltip label (timestamp, category, etc). */
  labelFormatter?: (label: string) => string;
}

export default function ChartTooltip({
  active,
  payload,
  label,
  valueFormatter,
  labelFormatter,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const formattedLabel = labelFormatter ? labelFormatter(String(label)) : String(label);

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-elevated)] px-[var(--space-3)] py-[var(--space-2)] shadow-[var(--shadow-xl)]">
      <p className="mb-1.5 text-xs font-semibold text-[var(--text-tertiary)]">
        {formattedLabel}
      </p>
      <div className="space-y-1">
        {payload.map((entry) => {
          const val = typeof entry.value === "number" ? entry.value : 0;
          const displayValue = valueFormatter ? valueFormatter(val) : val.toLocaleString();
          return (
            <div key={entry.dataKey as string} className="flex items-center gap-2 text-xs">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-[var(--text-secondary)]">{entry.name ?? entry.dataKey}</span>
              <span className="ml-auto font-semibold text-[var(--text-primary)]">
                {displayValue}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
