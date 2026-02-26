import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import Badge from "@/components/ui/Badge";
import { cn } from "@/lib/utils";

interface InsightCardProps {
  icon: React.ElementType;
  iconColor: string;
  title: string;
  description: string;
  linkTo: string;
  linkLabel: string;
  badge?: { text: string; variant: "success" | "warning" | "accent" | "info" | "danger" };
}

export default function InsightCard({
  icon: Icon,
  iconColor,
  title,
  description,
  linkTo,
  linkLabel,
  badge,
}: InsightCardProps) {
  return (
    <div
      className={cn(
        "group flex flex-col justify-between gap-[var(--space-4)]",
        "rounded-[var(--radius-xl)] border border-[var(--border)]",
        "bg-[var(--bg-elevated)] p-[var(--space-5)]",
        "transition-all duration-[var(--duration-normal)]",
        "hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)]",
      )}
    >
      <div className="flex items-start gap-[var(--space-3)]">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center",
            "rounded-[var(--radius-md)] bg-[var(--bg-overlay)]",
            iconColor,
          )}
        >
          <Icon size={18} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              {title}
            </p>
            {badge && (
              <Badge variant={badge.variant} size="sm">
                {badge.text}
              </Badge>
            )}
          </div>
          <p className="mt-[var(--space-1)] text-xs leading-relaxed text-[var(--text-tertiary)]">
            {description}
          </p>
        </div>
      </div>
      <Link
        to={linkTo}
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          "text-[var(--accent)] transition-colors duration-[var(--duration-fast)]",
          "hover:text-[var(--accent-hover)]",
        )}
      >
        {linkLabel}
        <ArrowRight
          size={12}
          className="transition-transform duration-[var(--duration-fast)] group-hover:translate-x-0.5"
        />
      </Link>
    </div>
  );
}

export type { InsightCardProps };
