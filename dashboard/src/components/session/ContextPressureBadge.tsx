import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/formatters";

interface ContextPressureBadgeProps {
  /** Peak context-window utilization for the session (0..1+). */
  peakPct: number;
}

/**
 * NEW-001: a compact color-coded badge showing a session's peak context-window
 * utilization. CLAUDE.md flags >60% as a quality-degradation risk:
 *   green  < 60%   — healthy
 *   amber  60-80%  — under pressure
 *   red    > 80%   — critical (consider splitting / compacting the session)
 *
 * The denominator behind peakPct is already model-aware (200k default, 1M for
 * 1M-context models), so a 1M-context Opus session does not falsely read red.
 */
export default function ContextPressureBadge({ peakPct }: ContextPressureBadgeProps) {
  const pct = (peakPct || 0) * 100;

  const tone =
    pct > 80
      ? { dot: "bg-[var(--danger)]", text: "text-[var(--danger)]", bg: "bg-[var(--danger-subtle)]" }
      : pct > 60
        ? { dot: "bg-[var(--warning)]", text: "text-[var(--warning)]", bg: "bg-[var(--warning-subtle)]" }
        : { dot: "bg-[var(--success)]", text: "text-[var(--success)]", bg: "bg-[var(--success-subtle)]" };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[var(--space-1\\.5)] rounded-[var(--radius-full)]",
        "px-[var(--space-2)] py-px text-[11px] font-medium tabular-nums leading-[18px]",
        tone.bg,
        tone.text,
      )}
      title={`Peak context-window utilization: ${formatPercent(peakPct)}`}
    >
      <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} />
      {formatPercent(peakPct)}
    </span>
  );
}
