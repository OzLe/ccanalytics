import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHealth } from "@/hooks/useHealth";
import type { HealthStatus } from "@/lib/types";

type UnpricedModel = NonNullable<HealthStatus["pricing"]>["unpricedModels"][number];

/**
 * Surfaces problems from /api/health: why the database cannot be opened (the
 * server never repairs the file on its own), or models whose costs use the
 * fallback rate because they have no pricing entry. Each clears on its own
 * once the cause is fixed.
 */
export default function HealthBanner() {
  const { data } = useHealth();
  if (!data) return null;

  const db = data.database;
  if (!db.connected) {
    return (
      <Banner tone="danger" title="The database could not be opened. Nothing was deleted.">
        {db.hint && <p className="text-small text-[var(--text-secondary)]">{db.hint}</p>}
        {db.error && (
          <p className="break-words font-mono text-caption text-[var(--text-tertiary)]">
            {db.error}
          </p>
        )}
      </Banner>
    );
  }

  const unpriced = data.pricing?.unpricedModels ?? [];
  if (unpriced.length === 0) return null;
  return (
    <Banner
      tone="warning"
      title={`Costs for ${unpriced.length === 1 ? "1 model use" : `${unpriced.length} models use`} a fallback rate.`}
    >
      <p className="text-small text-[var(--text-secondary)]">
        {unpriced.map(describeUsage).join(", ")} {unpriced.length === 1 ? "has" : "have"} no
        pricing entry, so {unpriced.length === 1 ? "its" : "their"} costs use Sonnet rates. Add{" "}
        {unpriced.length === 1 ? "it" : "them"} to <code>src/utils/pricing.ts</code>, then run{" "}
        <code>npm run backfill:costs</code>.
      </p>
    </Banner>
  );
}

function describeUsage({ model, turns, subAgents }: UnpricedModel): string {
  const parts = [
    turns > 0 ? `${turns.toLocaleString()} turns` : null,
    subAgents > 0 ? `${subAgents.toLocaleString()} sub-agents` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${model} (${parts.join(", ")})` : model;
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: "danger" | "warning";
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "mb-[var(--space-6)] rounded-[var(--radius-lg)] border p-[var(--space-4)]",
        tone === "danger"
          ? "border-[var(--danger-muted)] bg-[var(--danger-subtle)]"
          : "border-[var(--warning-muted)] bg-[var(--warning-subtle)]"
      )}
    >
      <div className="flex items-start gap-[var(--space-3)]">
        <AlertTriangle
          size={16}
          className={cn(
            "mt-0.5 shrink-0",
            tone === "danger" ? "text-[var(--danger)]" : "text-[var(--warning)]"
          )}
        />
        <div className="min-w-0 space-y-[var(--space-1)]">
          <p className="text-body font-medium text-[var(--text-primary)]">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
