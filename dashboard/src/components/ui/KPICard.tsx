import Skeleton from "./Skeleton";

type KPIType = "cost" | "cache" | "sessions" | "tools" | "tokens" | "duration";

interface KPICardProps {
  label: string;
  value: string;
  type?: KPIType;
  trend?: {
    value: number;
    label?: string;
  };
  loading?: boolean;
}

const typeBg: Record<KPIType, string> = {
  cost: "var(--accent-subtle)",
  cache: "var(--success-subtle)",
  sessions: "var(--purple-subtle)",
  tools: "var(--orange-subtle)",
  tokens: "var(--info-subtle)",
  duration: "var(--warning-subtle)",
};

const typeBorder: Record<KPIType, string> = {
  cost: "var(--accent-muted)",
  cache: "var(--success-muted)",
  sessions: "var(--purple-muted)",
  tools: "var(--orange-muted)",
  tokens: "var(--info-muted)",
  duration: "var(--warning-muted)",
};

function TrendIndicator({ value, label }: { value: number; label?: string }) {
  const isPositive = value >= 0;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-medium"
      style={{
        color: isPositive ? "var(--success)" : "var(--danger)",
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          transform: isPositive ? "none" : "rotate(180deg)",
        }}
      >
        <path d="M18 15l-6-6-6 6" />
      </svg>
      {Math.abs(value).toFixed(1)}%
      {label && (
        <span style={{ color: "var(--text-muted)" }}>{label}</span>
      )}
    </span>
  );
}

export default function KPICard({
  label,
  value,
  type = "sessions",
  trend,
  loading = false,
}: KPICardProps) {
  if (loading) {
    return (
      <div
        className="rounded-xl border p-6"
        style={{
          backgroundColor: "var(--bg-card)",
          borderColor: "var(--border)",
        }}
      >
        <Skeleton height="0.75rem" width="40%" className="mb-3" />
        <Skeleton height="2rem" width="60%" className="mb-2" />
        <Skeleton height="0.75rem" width="30%" />
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border p-6 transition-all duration-200 hover:border-[var(--border-hover)]"
      style={{
        backgroundColor: typeBg[type],
        borderColor: typeBorder[type],
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <p
        className="text-[11px] font-semibold uppercase"
        style={{ color: "var(--text-secondary)", letterSpacing: "0.05em" }}
      >
        {label}
      </p>
      <p
        className="mt-3 text-[30px] font-bold tracking-tight leading-tight"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </p>
      {trend && (
        <div className="mt-2">
          <TrendIndicator value={trend.value} label={trend.label} />
        </div>
      )}
    </div>
  );
}
