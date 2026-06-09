import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import { Moon, Check } from "lucide-react";
import { useSettings, useUpdateSettings } from "@/hooks/useSettings";
import {
  SUBSCRIPTION_TIER_OPTIONS,
  type SubscriptionTier,
  type TierLimitCeilings,
  type TierLimitOverrides,
} from "@/lib/types";
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

/**
 * Timezone picker — controls how the dashboard projects tz-naive UTC
 * timestamps into local hour-of-day / date math. Mirrors the
 * `display.userTimezone` half of /api/settings (ACT-001 / SEM2-293). The
 * `Intl.supportedValuesOf('timeZone')` list is the IANA gold standard but
 * excludes the universal ids; we prepend "UTC" so users on UTC can still
 * pick it.
 */
function TimezoneSection() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  // The list the picker offers: UTC + the browser-known IANA zones.
  // Computed once; the runtime never changes its IANA database mid-session.
  const zoneOptions = useMemo<string[]>(() => {
    const intlAny = Intl as unknown as {
      supportedValuesOf?: (k: string) => string[];
    };
    const supported =
      typeof intlAny.supportedValuesOf === "function"
        ? intlAny.supportedValuesOf("timeZone")
        : [];
    return ["UTC", ...supported.filter((z) => z !== "UTC")];
  }, []);

  const browserTz =
    (Intl.DateTimeFormat().resolvedOptions().timeZone as string) || "UTC";

  // Staged value (the picker). When the server reports an empty/UTC value
  // AND the browser is in a different zone, we silently auto-PUT the
  // browser zone — that's the "default on first load" behaviour the plan
  // requires, so the dashboard works out of the box without an explicit
  // settings visit.
  const [selectedTz, setSelectedTz] = useState<string>("UTC");
  const [autoSeeded, setAutoSeeded] = useState(false);

  useEffect(() => {
    const serverTz = settings.data?.display?.userTimezone;
    if (serverTz) setSelectedTz(serverTz);
  }, [settings.data?.display?.userTimezone]);

  useEffect(() => {
    if (autoSeeded) return;
    if (!settings.data) return;
    const serverTz = settings.data.display?.userTimezone;
    // Auto-seed only if the server explicitly returned UTC AND the user is
    // in a different zone — never overwrite an explicit non-UTC server
    // value, never auto-write when the server returns nothing (let the
    // user opt in manually so we don't spam writes from every load).
    if (serverTz === "UTC" && browserTz !== "UTC" && zoneOptions.includes(browserTz)) {
      updateSettings.mutate({ display: { userTimezone: browserTz } });
      setSelectedTz(browserTz);
    }
    setAutoSeeded(true);
  }, [settings.data, browserTz, autoSeeded, updateSettings, zoneOptions]);

  const serverTz = settings.data?.display?.userTimezone;
  const isDirty = serverTz !== undefined && selectedTz !== serverTz;
  const isSaving = updateSettings.isPending;
  const justSaved = updateSettings.isSuccess && !isDirty;

  const handleSave = () => {
    updateSettings.mutate({ display: { userTimezone: selectedTz } });
  };

  return (
    <section className="space-y-[var(--space-5)]">
      <SectionHeader
        title="Timezone"
        subtitle="Hour-of-day, day-of-week, and local-date charts are projected into this zone"
      />

      <div
        className={cn(
          "rounded-[var(--radius-xl)] border border-[var(--border)]",
          "bg-[var(--bg-surface)] p-[var(--space-6)] space-y-[var(--space-3)]"
        )}
      >
        <div>
          <label
            htmlFor="user-timezone"
            className="text-overline text-[var(--text-primary)]"
          >
            Display Timezone
          </label>
          <p className="mt-[var(--space-1)] text-small text-[var(--text-secondary)]">
            Stored timestamps remain UTC; this only changes how the
            dashboard re-projects them for the Activity, Cost, Cache, Tools
            and Skills surfaces. Detected browser zone:{" "}
            <span className="font-mono">{browserTz}</span>.
          </p>
        </div>

        <select
          id="user-timezone"
          value={selectedTz}
          disabled={settings.isLoading || isSaving}
          onChange={(e) => setSelectedTz(e.target.value)}
          className={cn(
            "w-full max-w-md rounded-[var(--radius-md)] border border-[var(--border)]",
            "bg-[var(--bg-elevated)] px-[var(--space-3)] py-[var(--space-2)]",
            "text-body text-[var(--text-primary)] font-mono",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:border-[var(--border-hover)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]",
            "disabled:opacity-50"
          )}
        >
          {zoneOptions.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
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
              Could not save timezone. Please try again.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/* ── Recommendation (ceilings + auto-calibrate) ────────────────── */

/**
 * The four editable ceiling dimensions, with human labels. These are TYPE-level
 * field identifiers (the keys of `TierLimitCeilings`), NOT ceiling numbers — the
 * numeric defaults live server-side in src/config/limits.ts and reach the UI
 * only through the API payload (every input is seeded from / saved to that).
 */
const CEILING_FIELDS: ReadonlyArray<{
  key: keyof TierLimitCeilings;
  label: string;
}> = [
  { key: "fiveHourRequests", label: "5h requests" },
  { key: "fiveHourTokens", label: "5h tokens" },
  { key: "weeklyRequests", label: "Weekly requests" },
  { key: "weeklyTokens", label: "Weekly tokens" },
];

/** Paid tiers get editable ceilings; "none" (pay-as-you-go) has no limits. */
const CEILING_TIERS = SUBSCRIPTION_TIER_OPTIONS.filter((t) => t.id !== "none");

/** Local edit state: per-tier, per-dimension string (blank = "use default"). */
type CeilingDraft = Partial<Record<SubscriptionTier, Partial<Record<keyof TierLimitCeilings, string>>>>;

/** Seed the local string draft from the server's sparse override payload. */
function draftFromOverrides(overrides: TierLimitOverrides | undefined): CeilingDraft {
  const draft: CeilingDraft = {};
  if (!overrides) return draft;
  for (const [tier, dims] of Object.entries(overrides) as [
    SubscriptionTier,
    Partial<TierLimitCeilings>,
  ][]) {
    if (!dims) continue;
    const row: Partial<Record<keyof TierLimitCeilings, string>> = {};
    for (const { key } of CEILING_FIELDS) {
      const v = dims[key];
      if (typeof v === "number" && Number.isFinite(v)) row[key] = String(v);
    }
    if (Object.keys(row).length > 0) draft[tier] = row;
  }
  return draft;
}

/** Build a sparse {@link TierLimitOverrides} from the local string draft. */
function overridesFromDraft(draft: CeilingDraft): TierLimitOverrides {
  const out: TierLimitOverrides = {};
  for (const tier of CEILING_TIERS) {
    const row = draft[tier.id];
    if (!row) continue;
    const dims: Partial<TierLimitCeilings> = {};
    for (const { key } of CEILING_FIELDS) {
      const raw = row[key];
      if (raw === undefined || raw.trim() === "") continue;
      const n = Number(raw);
      // Only finite, non-negative values become overrides; the server applies
      // the same gate, but keeping the client honest avoids a doomed PUT.
      if (Number.isFinite(n) && n >= 0) dims[key] = n;
    }
    if (Object.keys(dims).length > 0) out[tier.id] = dims;
  }
  return out;
}

/**
 * Recommendation controls — the `autoCalibrate` toggle and optional per-tier
 * ceiling overrides, persisted through the shared `useUpdateSettings` mutation
 * (PUT /api/settings preserves `subscription` / `display` on disk). Honest
 * "estimate" copy is mandatory: the underlying limits are not published.
 */
function RecommendationSection() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  const serverAuto = settings.data?.recommendation?.autoCalibrate;
  const serverOverrides = settings.data?.recommendation?.ceilings;

  // Staged local values, dirty-tracked for an explicit Save.
  const [autoCalibrate, setAutoCalibrate] = useState(true);
  const [draft, setDraft] = useState<CeilingDraft>({});

  // Sync staged values whenever the server (re)loads.
  useEffect(() => {
    if (typeof serverAuto === "boolean") setAutoCalibrate(serverAuto);
  }, [serverAuto]);

  useEffect(() => {
    setDraft(draftFromOverrides(serverOverrides));
  }, [serverOverrides]);

  const serverDraft = useMemo(
    () => draftFromOverrides(serverOverrides),
    [serverOverrides],
  );
  const autoDirty = serverAuto !== undefined && autoCalibrate !== serverAuto;
  const ceilingsDirty =
    JSON.stringify(overridesFromDraft(draft)) !==
    JSON.stringify(overridesFromDraft(serverDraft));
  const isDirty = autoDirty || ceilingsDirty;
  const isSaving = updateSettings.isPending;
  const justSaved = updateSettings.isSuccess && !isDirty;

  const setCell = (
    tier: SubscriptionTier,
    key: keyof TierLimitCeilings,
    value: string,
  ) => {
    setDraft((prev) => ({
      ...prev,
      [tier]: { ...prev[tier], [key]: value },
    }));
  };

  const handleSave = () => {
    const ceilings = overridesFromDraft(draft);
    updateSettings.mutate({
      recommendation: {
        autoCalibrate,
        // Send an empty object as "no overrides" so the server clears stale
        // ones; the resolver treats an empty set as sparse/absent.
        ceilings,
      },
    });
  };

  const inputClass = cn(
    "w-full rounded-[var(--radius-md)] border border-[var(--border)]",
    "bg-[var(--bg-elevated)] px-[var(--space-2)] py-[var(--space-1)]",
    "text-small text-[var(--text-primary)] tabular-nums",
    "transition-colors duration-[var(--duration-fast)]",
    "hover:border-[var(--border-hover)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]",
    "disabled:opacity-50",
  );

  return (
    <section className="space-y-[var(--space-5)]">
      <SectionHeader
        title="Recommendation"
        subtitle="Up/downgrade advice from local usage — every limit is an estimate (Anthropic's exact limits are not published)"
      />

      <div
        className={cn(
          "rounded-[var(--radius-xl)] border border-[var(--border)]",
          "bg-[var(--bg-surface)] p-[var(--space-6)] space-y-[var(--space-5)]",
        )}
      >
        {/* Auto-calibrate toggle */}
        <label className="flex items-start gap-[var(--space-3)] cursor-pointer">
          <input
            type="checkbox"
            checked={autoCalibrate}
            disabled={settings.isLoading || isSaving}
            onChange={(e) => setAutoCalibrate(e.target.checked)}
            className="mt-[var(--space-1)] h-4 w-4 shrink-0 accent-[var(--accent)] disabled:opacity-50"
          />
          <span>
            <span className="text-overline text-[var(--text-primary)]">
              Auto-calibrate limits
            </span>
            <span className="mt-[var(--space-1)] block text-small text-[var(--text-secondary)]">
              When your observed peak usage exceeds the estimated limit, raise
              the limit to at least your peak before computing fill percentages
              — so you're never pinned at a meaningless &gt;100%.
            </span>
          </span>
        </label>

        {/* Per-tier ceiling overrides */}
        <div className="space-y-[var(--space-3)]">
          <div>
            <span className="text-overline text-[var(--text-primary)]">
              Per-tier limit overrides
            </span>
            <p className="mt-[var(--space-1)] text-small text-[var(--text-secondary)]">
              Leave a field blank to use the built-in estimate for that tier.
              Values are model requests / blended tokens per rolling window.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse">
              <thead>
                <tr>
                  <th className="px-[var(--space-2)] py-[var(--space-1)] text-left text-caption text-[var(--text-tertiary)]">
                    Tier
                  </th>
                  {CEILING_FIELDS.map((f) => (
                    <th
                      key={f.key}
                      className="px-[var(--space-2)] py-[var(--space-1)] text-left text-caption text-[var(--text-tertiary)]"
                    >
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CEILING_TIERS.map((tier) => (
                  <tr key={tier.id}>
                    <td className="px-[var(--space-2)] py-[var(--space-1)] text-small text-[var(--text-primary)] whitespace-nowrap">
                      {tier.label}
                    </td>
                    {CEILING_FIELDS.map((f) => (
                      <td key={f.key} className="px-[var(--space-2)] py-[var(--space-1)]">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          placeholder="default"
                          value={draft[tier.id]?.[f.key] ?? ""}
                          disabled={settings.isLoading || isSaving}
                          onChange={(e) => setCell(tier.id, f.key, e.target.value)}
                          aria-label={`${tier.label} ${f.label}`}
                          className={inputClass}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

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
              Could not save recommendation settings. Please try again.
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

        {/* ── Timezone ─────────────────────────────────────────── */}
        <TimezoneSection />

        {/* ── Subscription ─────────────────────────────────────── */}
        <SubscriptionSection />

        {/* ── Recommendation ───────────────────────────────────── */}
        <RecommendationSection />

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
              <p
                className="mt-[var(--space-1)] text-body text-[var(--text-primary)]"
                title={__APP_FULL_VERSION__}
              >
                {__APP_VERSION__}
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
