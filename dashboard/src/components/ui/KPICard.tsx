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
  Info,
  type LucideIcon,
} from "lucide-react";
import Skeleton from "./Skeleton";
import { Tooltip } from "./Tooltip";

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
        "inline-flex items-center gap-[var(--space-1)] rounded-[var(--radius-full)] px-[var(--space-2)] py-px",
        "text-caption font-medium",
        color,
        bg
      )}
    >
      <Icon size={12} strokeWidth={2.5} />
      {Math.abs(value).toFixed(1)}%
      {label && (
        <span className="text-[var(--text-secondary)]">{label}</span>
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
  /**
   * Optional secondary caption shown below the value (e.g. KPI-004's
   * "N with no response" qualifier). Mutually compatible with `trend`.
   */
  hint?: string;
  /**
   * Optional info tooltip rendered as an `Info` icon next to the label.
   * MAX-001: cost KPIs across pages use this to carry the "API-equivalent cost"
   * explanation without bespoke markup — the single cleanest touch-point.
   */
  labelTooltip?: string;
  loading?: boolean;
  className?: string;
}

export default function KPICard({
  label,
  value,
  type = "sessions",
  variant = "default",
  trend,
  hint,
  labelTooltip,
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
        <Skeleton shape="text" className="mb-[var(--space-3)] h-3 w-2/5" />
        <Skeleton shape="text" className="mb-[var(--space-2)] h-9 w-3/5" />
        <Skeleton shape="text" className="h-3 w-1/4" />
      </div>
    );
  }

  const TypeIcon = typeIconMap[type];

  return (
    <div className={cn(cardVariants({ variant }), className)}>
      {/* Top row: label + icon */}
      <div className="flex items-start justify-between">
        <p className="inline-flex items-center gap-[var(--space-1)] text-overline text-[var(--text-secondary)]">
          {label}
          {labelTooltip && (
            <Tooltip
              content={labelTooltip}
              position="top"
              className="max-w-xs whitespace-normal"
            >
              <Info
                size={12}
                strokeWidth={2}
                className="text-[var(--text-tertiary)]"
                aria-label="More info"
              />
            </Tooltip>
          )}
        </p>
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
      <p className={cn(
        "mt-[var(--space-3)] text-[var(--text-primary)]",
        value.length > 12 ? "text-h1" : "text-display"
      )}>
        {value}
      </p>

      {/* Trend indicator */}
      {trend && (
        <div className="mt-[var(--space-2)]">
          <TrendIndicator value={trend.value} label={trend.label} />
        </div>
      )}

      {/* Optional secondary caption */}
      {hint && (
        <p className="mt-[var(--space-2)] text-caption text-[var(--text-tertiary)]">
          {hint}
        </p>
      )}
    </div>
  );
}

export type { KPICardProps, KPIType };
