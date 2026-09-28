import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHealth } from "@/hooks/useHealth";

/**
 * Explains why the database cannot be opened. The server never repairs the
 * file on its own, so the banner carries the reason and the next step from
 * /api/health until the database opens again.
 */
export default function HealthBanner() {
  const { data } = useHealth();
  const db = data?.database;
  if (!db || db.connected) return null;

  return (
    <div
      role="alert"
      className={cn(
        "mb-[var(--space-6)] rounded-[var(--radius-lg)] border p-[var(--space-4)]",
        "border-[var(--danger-muted)] bg-[var(--danger-subtle)]"
      )}
    >
      <div className="flex items-start gap-[var(--space-3)]">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--danger)]" />
        <div className="min-w-0 space-y-[var(--space-1)]">
          <p className="text-body font-medium text-[var(--text-primary)]">
            The database could not be opened. Nothing was deleted.
          </p>
          {db.hint && <p className="text-small text-[var(--text-secondary)]">{db.hint}</p>}
          {db.error && (
            <p className="break-words font-mono text-caption text-[var(--text-tertiary)]">
              {db.error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
