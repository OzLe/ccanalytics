import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import { Moon, Check } from "lucide-react";
import { useSettings, useUpdateSettings } from "@/hooks/useSettings";
import { SUBSCRIPTION_TIER_OPTIONS, type SubscriptionTier } from "@/lib/types";
import { formatCost } from "@/lib/formatters";

/* ── Subscription tier picker ─────────────────────────────────── */

/** Render a tier option label with its monthly price (e.g. "Pro — $20/mo"). */
function tierOptionLabel(label: string, monthlyUSD: number): string {
  if (monthlyUSD <= 0) return `${label}`;
  return `${label} — ${formatCost(monthlyUSD)}/mo`;
}

function SubscriptionSection() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  // Staged local value — initialized from the server, dirty-tracked for Save.
  const [selectedTier, setSelectedTier] = useState<SubscriptionTier>("max-20x");

  // Sync the staged value whenever the server value (re)loads.
  useEffect(() => {
    if (settings.data?.subscription.tier) {
      setSelectedTier(settings.data.subscription.tier);
    }
  }, [settings.data?.subscription.tier]);

  const serverTier = settings.data?.subscription.tier;
  const isDirty = serverTier !== undefined && selectedTier !== serverTier;
  const isSaving = updateSettings.isPending;
  const justSaved = updateSettings.isSuccess && !isDirty;

  const handleSave = () => {
    updateSettings.mutate({ subscription: { tier: selectedTier } });
  };

  return (
    <section className="space-y-[var(--space-5)]">
      <SectionHeader
        title="Subscription"
        subtitle="Your Claude plan, used for cost-vs-subscription ROI framing"
      />

      <div
        className={cn(
          "rounded-[var(--radius-xl)] border border-[var(--border)]",
          "bg-[var(--bg-surface)] p-[var(--space-6)] space-y-[var(--space-3)]"
        )}
      >
        <div>
          <label
            htmlFor="subscription-tier"
            className="text-overline text-[var(--text-primary)]"
          >
            Claude Subscription
          </label>
          <p className="mt-[var(--space-1)] text-small text-[var(--text-secondary)]">
            Used to show what your usage would cost at API rates vs. your flat
            monthly fee.
          </p>
        </div>

        <select
          id="subscription-tier"
          value={selectedTier}
          disabled={settings.isLoading || isSaving}
          onChange={(e) =>
            setSelectedTier(e.target.value as SubscriptionTier)
          }
          className={cn(
            "w-full max-w-sm rounded-[var(--radius-md)] border border-[var(--border)]",
            "bg-[var(--bg-elevated)] px-[var(--space-3)] py-[var(--space-2)]",
            "text-body text-[var(--text-primary)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:border-[var(--border-hover)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]",
            "disabled:opacity-50"
          )}
        >
          {SUBSCRIPTION_TIER_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {tierOptionLabel(opt.label, opt.monthlyUSD)}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-[var(--space-3)] pt-[var(--space-1)]">
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!isDirty || isSaving || settings.isLoading}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>

          {justSaved && (
            <span className="inline-flex items-center gap-[var(--space-1)] text-small text-[var(--success)]">
              <Check size={14} strokeWidth={2.5} />
              Saved
            </span>
          )}

          {updateSettings.isError && (
            <span className="text-small text-[var(--danger)]">
              Could not save settings. Please try again.
            </span>
          )}

          {settings.isError && (
            <span className="text-small text-[var(--danger)]">
              Could not load current settings.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

export default function SettingsPage() {
  return (
    <ErrorBoundary onRetry={() => window.location.reload()}>
      <div className="space-y-[var(--space-8)]">
        {/* ── General ──────────────────────────────────────────── */}
        <section className="space-y-[var(--space-5)]">
          <SectionHeader
            title="General"
            subtitle="Application preferences and configuration"
          />

          {/* Database path */}
          <div
            className={cn(
              "rounded-[var(--radius-xl)] border border-[var(--border)]",
              "bg-[var(--bg-surface)] p-[var(--space-6)]"
            )}
          >
            <label className="text-overline text-[var(--text-primary)]">
              Database Path
            </label>
            <p className="mt-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--bg-elevated)] px-[var(--space-3)] py-[var(--space-2)] text-body text-[var(--text-primary)] border border-[var(--border)] font-mono">
              ~/.ccanalytics/ccanalytics.db
            </p>
          </div>

          {/* Theme info card */}
          <div
            className={cn(
              "rounded-[var(--radius-xl)] border border-[var(--border)]",
              "bg-[var(--bg-surface)] p-[var(--space-6)]"
            )}
          >
            <div className="flex items-center gap-[var(--space-3)]">
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
                  "bg-[var(--bg-overlay)] text-[var(--accent)]"
                )}
              >
                <Moon size={16} strokeWidth={2} />
              </div>
              <div>
                <p className="text-overline text-[var(--text-primary)]">Theme</p>
                <p className="text-small text-[var(--text-secondary)]">
                  Dark — only dark mode is available
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Subscription ─────────────────────────────────────── */}
        <SubscriptionSection />

        {/* ── Data Management ──────────────────────────────────── */}
        <section className="space-y-[var(--space-5)]">
          <SectionHeader
            title="Data Management"
            subtitle="Export data or clear cached information"
          />

          <div
            className={cn(
              "rounded-[var(--radius-xl)] border border-[var(--border)]",
              "bg-[var(--bg-surface)] p-[var(--space-6)]"
            )}
          >
            <div className="flex flex-wrap items-center gap-[var(--space-4)]">
              <Button
                variant="primary"
                onClick={() => alert("Export coming soon")}
              >
                Export Data
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm("Are you sure you want to clear the cache? This action cannot be undone.")) {
                    alert("Cache cleared.");
                  }
                }}
              >
                Clear Cache
              </Button>
            </div>
          </div>
        </section>

        {/* ── About ────────────────────────────────────────────── */}
        <section className="space-y-[var(--space-5)]">
          <SectionHeader
            title="About"
            subtitle="Application information and links"
          />

          <div
            className={cn(
              "rounded-[var(--radius-xl)] border border-[var(--border)]",
              "bg-[var(--bg-surface)] p-[var(--space-6)] space-y-[var(--space-3)]"
            )}
          >
            <div>
              <span className="text-overline text-[var(--text-secondary)]">Version</span>
              <p className="mt-[var(--space-1)] text-body text-[var(--text-primary)]">
                0.1.0
              </p>
            </div>
            <div>
              <span className="text-overline text-[var(--text-secondary)]">Source Code</span>
              <p className="mt-[var(--space-1)]">
                <a
                  href="https://github.com/ccanalytics/ccanalytics"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-body text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors duration-[var(--duration-fast)]"
                >
                  github.com/ccanalytics/ccanalytics
                </a>
              </p>
            </div>
          </div>
        </section>
      </div>
    </ErrorBoundary>
  );
}
