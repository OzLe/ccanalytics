import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Inbox, type LucideIcon } from "lucide-react";
import { Button } from "./Button";

interface EmptyStateProps {
  /** Main heading */
  title?: string;
  /** Supporting description text */
  message?: string;
  /** Lucide icon component to display */
  icon?: LucideIcon;
  /** Optional action button */
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Optional custom content below the message */
  children?: ReactNode;
  className?: string;
}

export default function EmptyState({
  title = "No data available",
  message = "There is no data to display for the selected filters.",
  icon: Icon = Inbox,
  action,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-[var(--space-4)] py-[var(--space-12)]",
        className
      )}
    >
      {/* Icon circle */}
      <div className="mb-[var(--space-4)] flex h-16 w-16 items-center justify-center rounded-full bg-[var(--bg-hover)] text-[var(--text-tertiary)]">
        <Icon size={28} strokeWidth={1.5} />
      </div>

      {/* Title */}
      <h3 className="text-h3 text-[var(--text-primary)]">{title}</h3>

      {/* Message */}
      <p className="mt-[var(--space-1)] max-w-sm text-center text-[var(--font-small-size)] text-[var(--text-tertiary)]">
        {message}
      </p>

      {/* Action button */}
      {action && (
        <Button
          variant="primary"
          size="md"
          onClick={action.onClick}
          className="mt-[var(--space-4)]"
        >
          {action.label}
        </Button>
      )}

      {/* Custom children */}
      {children && <div className="mt-[var(--space-4)]">{children}</div>}
    </div>
  );
}
