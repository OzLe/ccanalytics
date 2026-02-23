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
  cost: "rgba(99, 102, 241, 0.08)",
  cache: "rgba(34, 197, 94, 0.08)",
  sessions: "rgba(168, 85, 247, 0.08)",
  tools: "rgba(249, 115, 22, 0.08)",
  tokens: "rgba(56, 189, 248, 0.08)",
  duration: "rgba(234, 179, 8, 0.08)",
};

const typeBorder: Record<KPIType, string> = {
  cost: "rgba(99, 102, 241, 0.2)",
  cache: "rgba(34, 197, 94, 0.2)",
  sessions: "rgba(168, 85, 247, 0.2)",
  tools: "rgba(249, 115, 22, 0.2)",
  tokens: "rgba(56, 189, 248, 0.2)",
  duration: "rgba(234, 179, 8, 0.2)",
};

const typeIconColor: Record<KPIType, string> = {
  cost: "#6366f1",
  cache: "#22c55e",
  sessions: "#a855f7",
  tools: "#f97316",
  tokens: "#38bdf8",
  duration: "#eab308",
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
        className="rounded-xl border p-5"
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
      className="rounded-xl border p-5 transition-all duration-200"
      style={{
        backgroundColor: typeBg[type],
        borderColor: typeBorder[type],
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = typeIconColor[type];
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = typeBorder[type];
      }}
    >
      <p
        className="text-xs font-medium uppercase tracking-wider"
        style={{ color: "var(--text-secondary)" }}
      >
        {label}
      </p>
      <p
        className="mt-2 text-2xl font-bold tracking-tight"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </p>
      {trend && (
        <div className="mt-1.5">
          <TrendIndicator value={trend.value} label={trend.label} />
        </div>
      )}
    </div>
  );
}
