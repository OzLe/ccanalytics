import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/formatters";

interface CacheRateBadgeProps {
  rate: number;
}

/**
 * A compact inline badge showing cache hit rate with a color-coded
 * progress indicator. Green > 70%, yellow 40-70%, red < 40%.
 */
export default function CacheRateBadge({ rate }: CacheRateBadgeProps) {
  const pct = (rate || 0) * 100;

  const colorClass =
    pct > 70
      ? "bg-[var(--success)]"
      : pct >= 40
        ? "bg-[var(--warning)]"
        : "bg-[var(--danger)]";

  const bgClass =
    pct > 70
      ? "bg-[var(--success-subtle)]"
      : pct >= 40
        ? "bg-[var(--warning-subtle)]"
        : "bg-[var(--danger-subtle)]";

  return (
    <div className="flex items-center gap-[var(--space-2)]">
      {/* Mini progress bar */}
      <div
        className={cn(
          "h-2 flex-1 rounded-[var(--radius-full)] min-w-[48px]",
          bgClass
        )}
      >
        <div
          className={cn(
            "h-2 rounded-[var(--radius-full)] transition-all duration-[var(--duration-normal)]",
            colorClass
          )}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <span className="text-caption tabular-nums text-[var(--text-secondary)] min-w-[40px] text-right">
        {formatPercent(rate)}
      </span>
    </div>
  );
}
