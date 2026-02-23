import type { ReactNode } from "react";

type BadgeVariant = "accent" | "success" | "warning" | "danger" | "neutral";

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantStyles: Record<BadgeVariant, { bg: string; color: string }> = {
  accent: { bg: "var(--accent-muted)", color: "var(--accent)" },
  success: { bg: "var(--success-muted)", color: "var(--success)" },
  warning: { bg: "var(--warning-muted)", color: "var(--warning)" },
  danger: { bg: "var(--danger-muted)", color: "var(--danger)" },
  neutral: { bg: "var(--bg-hover)", color: "var(--text-secondary)" },
};

export default function Badge({
  children,
  variant = "neutral",
  className = "",
}: BadgeProps) {
  const style = variantStyles[variant];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
      style={{
        backgroundColor: style.bg,
        color: style.color,
      }}
    >
      {children}
    </span>
  );
}
