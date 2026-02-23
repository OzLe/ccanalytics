import type { ReactNode } from "react";
import Skeleton from "./Skeleton";
import EmptyState from "./EmptyState";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  className?: string;
  action?: ReactNode;
}

export default function ChartCard({
  title,
  subtitle,
  children,
  loading = false,
  empty = false,
  emptyMessage,
  className = "",
  action,
}: ChartCardProps) {
  return (
    <div
      className={`rounded-xl border transition-colors duration-200 ${className}`}
      style={{
        backgroundColor: "var(--bg-card)",
        borderColor: "var(--border)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
      }}
    >
      <div
        className="flex items-start justify-between border-b px-5 py-4"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <h3
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h3>
          {subtitle && (
            <p
              className="mt-0.5 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {action && <div>{action}</div>}
      </div>

      <div className="p-5">
        {loading ? (
          <div className="space-y-3 py-8">
            <Skeleton height="1rem" width="80%" />
            <Skeleton height="8rem" />
            <div className="flex gap-4">
              <Skeleton height="0.75rem" width="25%" />
              <Skeleton height="0.75rem" width="25%" />
              <Skeleton height="0.75rem" width="25%" />
            </div>
          </div>
        ) : empty ? (
          <EmptyState
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
