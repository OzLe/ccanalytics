import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Database,
  Users,
  Wrench,
  Coins,
  Timer,
  type LucideIcon,
} from "lucide-react";
import Skeleton from "./Skeleton";

/* ── KPI types and their icon mappings ───────────────────── */
type KPIType = "cost" | "cache" | "sessions" | "tools" | "tokens" | "duration";

const typeIconMap: Record<KPIType, LucideIcon> = {
  cost: DollarSign,
  cache: Database,
  sessions: Users,
  tools: Wrench,
  tokens: Coins,
  duration: Timer,
};

/* ── Card variant system ─────────────────────────────────── */
const cardVariants = cva(
  [
    "group relative rounded-[var(--radius-xl)]",
    "border p-[var(--space-6)]",
    "transition-all duration-[var(--duration-normal)]",
    "hover:shadow-[var(--shadow-md)]",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-[var(--bg-surface)] border-[var(--border)] hover:border-[var(--border-hover)]",
        accent:
          "bg-[var(--accent-subtle)] border-[var(--accent-muted)] hover:border-[var(--accent)] hover:shadow-[var(--shadow-glow-accent)]",
        success:
          "bg-[var(--success-subtle)] border-[var(--success-muted)] hover:border-[var(--success)]",
        warning:
          "bg-[var(--warning-subtle)] border-[var(--warning-muted)] hover:border-[var(--warning)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

/* ── Icon accent color lookup ────────────────────────────── */
const typeIconColor: Record<KPIType, string> = {
  cost: "text-[var(--accent)]",
  cache: "text-[var(--success)]",
  sessions: "text-[var(--purple)]",
  tools: "text-[var(--orange)]",
  tokens: "text-[var(--info)]",
  duration: "text-[var(--warning)]",
};

/* ── Trend Indicator ─────────────────────────────────────── */
function TrendIndicator({ value, label }: { value: number; label?: string }) {
  const isPositive = value >= 0;
  const Icon = isPositive ? TrendingUp : TrendingDown;
  const color = isPositive ? "text-[var(--success)]" : "text-[var(--danger)]";
  const bg = isPositive ? "bg-[var(--success-subtle)]" : "bg-[var(--danger-subtle)]";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-full)] px-2 py-0.5",
        "text-xs font-medium",
        color,
        bg
      )}
    >
      <Icon size={12} strokeWidth={2.5} />
      {Math.abs(value).toFixed(1)}%
      {label && (
        <span className="text-[var(--text-tertiary)]">{label}</span>
      )}
    </span>
  );
}

/* ── Main KPICard Component ──────────────────────────────── */
interface KPICardProps extends VariantProps<typeof cardVariants> {
  label: string;
  value: string;
  type?: KPIType;
  trend?: {
    value: number;
    label?: string;
  };
  loading?: boolean;
  className?: string;
}

export default function KPICard({
  label,
  value,
  type = "sessions",
  variant = "default",
  trend,
  loading = false,
  className,
}: KPICardProps) {
  if (loading) {
    return (
      <div
        className={cn(
          "rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-elevated)] p-[var(--space-6)]",
          className
        )}
      >
        <Skeleton shape="text" className="mb-3 h-3 w-2/5" />
        <Skeleton shape="text" className="mb-2 h-9 w-3/5" />
        <Skeleton shape="text" className="h-3 w-1/4" />
      </div>
    );
  }

  const TypeIcon = typeIconMap[type];

  return (
    <div className={cn(cardVariants({ variant }), className)}>
      {/* Top row: label + icon */}
      <div className="flex items-start justify-between">
        <p className="text-overline text-[var(--text-secondary)]">{label}</p>
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)]",
            "bg-[var(--bg-overlay)] transition-colors duration-[var(--duration-fast)]",
            "group-hover:bg-[var(--bg-muted-bg)]",
            typeIconColor[type]
          )}
        >
          <TypeIcon size={16} strokeWidth={2} />
        </div>
      </div>

      {/* Display value */}
      <p className="text-display mt-[var(--space-3)] text-[var(--text-primary)]">
        {value}
      </p>

      {/* Trend indicator */}
      {trend && (
        <div className="mt-[var(--space-2)]">
          <TrendIndicator value={trend.value} label={trend.label} />
        </div>
      )}
    </div>
  );
}

export type { KPICardProps, KPIType };
