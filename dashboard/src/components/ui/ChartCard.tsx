import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import Skeleton from "./Skeleton";
import EmptyState from "./EmptyState";
import { BarChart3 } from "lucide-react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  className?: string;
  /** Optional action slot — rendered top-right (e.g. export button) */
  action?: ReactNode;
}

export default function ChartCard({
  title,
  subtitle,
  children,
  loading = false,
  empty = false,
  emptyMessage,
  className,
  action,
}: ChartCardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-xl)] border border-[var(--border)]",
        "bg-[var(--bg-elevated)] shadow-[var(--shadow-sm)]",
        "transition-all duration-[var(--duration-normal)]",
        "hover:border-[var(--border-hover)]",
        className
      )}
    >
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-start justify-between border-b border-[var(--border)] px-[var(--space-6)] py-[var(--space-5)]">
        <div>
          <h3 className="text-h3 text-[var(--text-primary)]">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-[var(--font-small-size)] text-[var(--text-secondary)]">
              {subtitle}
            </p>
          )}
        </div>
        {action && <div className="ml-[var(--space-4)] shrink-0">{action}</div>}
      </div>

      {/* ── Body ────────────────────────────────────────────── */}
      <div className="p-[var(--space-6)]">
        {loading ? (
          <ChartCardSkeleton />
        ) : empty ? (
          <EmptyState
            icon={BarChart3}
            title="No chart data"
            message={emptyMessage ?? "No data available for the selected period."}
          />
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/* ── Shimmer loading skeleton ────────────────────────────── */
function ChartCardSkeleton() {
  return (
    <div className="flex flex-col gap-[var(--space-3)] py-[var(--space-8)]">
      <Skeleton shape="text" className="h-4 w-4/5" />
      <Skeleton shape="chart" />
      <div className="flex gap-[var(--space-4)]">
        <Skeleton shape="text" className="h-3 w-1/4" />
        <Skeleton shape="text" className="h-3 w-1/4" />
        <Skeleton shape="text" className="h-3 w-1/4" />
      </div>
    </div>
  );
}
