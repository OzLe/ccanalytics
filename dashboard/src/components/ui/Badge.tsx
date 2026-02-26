import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

/* ── Badge variant system ────────────────────────────────── */
const badgeVariants = cva(
  "inline-flex items-center gap-[var(--space-1\\.5)] font-medium transition-colors duration-[var(--duration-fast)]",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--bg-hover)] text-[var(--text-secondary)]",
        /** @deprecated Use "default" — kept for backward compatibility */
        neutral:
          "bg-[var(--bg-hover)] text-[var(--text-secondary)]",
        accent:
          "bg-[var(--accent-muted)] text-[var(--accent-hover)]",
        success:
          "bg-[var(--success-muted)] text-[var(--success)]",
        warning:
          "bg-[var(--warning-muted)] text-[var(--warning)]",
        danger:
          "bg-[var(--danger-muted)] text-[var(--danger)]",
        info:
          "bg-[var(--info-muted)] text-[var(--info)]",
        outline:
          "bg-transparent border border-[var(--border)] text-[var(--text-secondary)]",
      },
      size: {
        sm: "rounded-[var(--radius-full)] px-[var(--space-2)] py-px text-[11px] leading-[18px]",
        md: "rounded-[var(--radius-full)] px-[10px] py-0.5 text-xs leading-[20px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
);

/* ── Dot color lookup ────────────────────────────────────── */
const dotColorMap: Record<string, string> = {
  default: "bg-[var(--text-tertiary)]",
  neutral: "bg-[var(--text-tertiary)]",
  accent: "bg-[var(--accent)]",
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
  danger: "bg-[var(--danger)]",
  info: "bg-[var(--info)]",
  outline: "bg-[var(--text-tertiary)]",
};

interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: ReactNode;
  className?: string;
  /** Show a small colored dot indicator before the text */
  dot?: boolean;
}

export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  className,
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)}>
      {dot && (
        <span
          className={cn(
            "inline-block shrink-0 rounded-full",
            size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
            dotColorMap[variant ?? "default"]
          )}
        />
      )}
      {children}
    </span>
  );
}

export { badgeVariants };
export type { BadgeProps };
