/**
 * Toast — a minimal fixed-position notification.
 *
 * Deliberately self-contained: there is no global ToastProvider/context. The
 * only producer in the app today is the TopBar ingest button, which owns the
 * toast's lifecycle locally and renders this component directly. It floats via
 * `position: fixed`, so it does not need a portal.
 */
import { useEffect } from "react";
import { CheckCircle2, AlertCircle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastVariant = "loading" | "success" | "error";

export interface ToastProps {
  variant: ToastVariant;
  /** Bold first line. */
  title: string;
  /** Optional detail lines shown beneath the title. */
  lines?: string[];
  /** Called when dismissed — via the close button or auto-dismiss. */
  onDismiss: () => void;
  /**
   * Auto-dismiss after this many ms. Ignored for the "loading" variant (it
   * stays until the operation resolves). Omit / 0 to disable.
   */
  autoDismissMs?: number;
}

const VARIANT: Record<
  ToastVariant,
  { Icon: typeof CheckCircle2; iconColor: string; border: string }
> = {
  loading: {
    Icon: Loader2,
    iconColor: "text-[var(--accent)]",
    border: "border-[var(--border)]",
  },
  success: {
    Icon: CheckCircle2,
    iconColor: "text-[var(--success)]",
    border: "border-[var(--success-muted)]",
  },
  error: {
    Icon: AlertCircle,
    iconColor: "text-[var(--danger)]",
    border: "border-[var(--danger-muted)]",
  },
};

export default function Toast({
  variant,
  title,
  lines,
  onDismiss,
  autoDismissMs,
}: ToastProps) {
  useEffect(() => {
    if (variant === "loading" || !autoDismissMs) return;
    const timer = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [variant, autoDismissMs, onDismiss]);

  const { Icon, iconColor, border } = VARIANT[variant];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed bottom-[var(--space-6)] right-[var(--space-6)]",
        "w-[min(360px,calc(100vw-2*var(--space-6)))]",
        "rounded-[var(--radius-xl)] border",
        "bg-[var(--bg-elevated)] shadow-[var(--shadow-lg)]",
        "p-[var(--space-4)] animate-fade-in",
        border,
      )}
      style={{ zIndex: "var(--z-modal)" }}
    >
      <div className="flex items-start gap-[var(--space-3)]">
        <Icon
          size={18}
          strokeWidth={2}
          className={cn(
            "mt-px shrink-0",
            iconColor,
            variant === "loading" && "animate-spin",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium text-[var(--text-primary)]">
            {title}
          </p>
          {lines && lines.length > 0 && (
            <div className="mt-[var(--space-1)] space-y-px">
              {lines.map((line, i) => (
                <p key={i} className="text-caption text-[var(--text-secondary)]">
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>
        {variant !== "loading" && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className={cn(
              "shrink-0 rounded-[var(--radius-sm)] p-px",
              "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
              "transition-colors duration-[var(--duration-fast)]",
            )}
          >
            <X size={14} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
