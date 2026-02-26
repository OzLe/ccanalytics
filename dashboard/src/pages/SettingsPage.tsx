import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/ui/SectionHeader";
import KPICard from "@/components/ui/KPICard";
import { Button } from "@/components/ui/Button";
import ErrorBoundary from "@/components/ui/ErrorBoundary";

export default function SettingsPage() {
  return (
    <ErrorBoundary onRetry={() => window.location.reload()}>
      <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">
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
            <label className="text-overline text-[var(--text-secondary)]">
              Database Path
            </label>
            <p className="mt-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--bg-elevated)] px-[var(--space-3)] py-[var(--space-2)] text-small text-[var(--text-primary)] border border-[var(--border)]">
              ~/.ccanalytics/ccanalytics.db
            </p>
          </div>

          {/* Theme card */}
          <div className="grid grid-cols-1 gap-[var(--space-5)] sm:grid-cols-2">
            <KPICard
              label="Theme"
              value="Dark"
              type="sessions"
              trend={{ value: 0, label: "(Only dark mode available)" }}
            />
          </div>
        </section>

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
                variant="secondary"
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
