import { cn } from "@/lib/utils";
import Badge from "@/components/ui/Badge";
import { AlertTriangle, Clock, RotateCcw } from "lucide-react";
import { formatDateTime } from "@/lib/formatters";
import type { SessionError } from "@/lib/types";

interface ErrorPanelProps {
  errors: SessionError[];
}

export default function ErrorPanel({ errors }: ErrorPanelProps) {
  if (errors.length === 0) return null;

  return (
    <div className="space-y-[var(--space-3)]">
      {errors.map((err) => (
        <div
          key={err.errorId}
          className={cn(
            "rounded-[var(--radius-lg)] border p-[var(--space-4)]",
            "border-[var(--danger-muted)] bg-[var(--danger-subtle)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:border-[var(--danger)]"
          )}
        >
          {/* Header */}
          <div className="flex flex-wrap items-center gap-[var(--space-2)]">
            <AlertTriangle size={14} className="shrink-0 text-[var(--danger)]" />
            <Badge variant="danger" size="sm" dot>
              {err.errorType}
            </Badge>
            <Badge
              variant={err.isRetryable ? "warning" : "default"}
              size="sm"
            >
              {err.isRetryable ? "retryable" : "not retryable"}
            </Badge>
            {err.retryCount > 0 && (
              <span className="inline-flex items-center gap-1 text-caption text-[var(--text-tertiary)]">
                <RotateCcw size={11} />
                {err.retryCount} retries
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-1 text-caption text-[var(--text-tertiary)]">
              <Clock size={11} />
              {formatDateTime(err.timestamp)}
            </span>
          </div>

          {/* Error message */}
          <p className="mt-[var(--space-2)] text-small text-[var(--text-secondary)]">
            {err.message}
          </p>
        </div>
      ))}
    </div>
  );
}
