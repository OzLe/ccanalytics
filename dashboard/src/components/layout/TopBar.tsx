import { useLocation } from "react-router-dom";
import { useFilters, type Period } from "@/hooks/useFilters";
import { buildFilterQS } from "@/hooks/useFilterParams";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { useEffect, useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { pages } from "@/lib/pages";
import { Menu, Command, RotateCw } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import { Button } from "@/components/ui/Button";
import Toast, { type ToastVariant } from "@/components/ui/Toast";
import { useIngest } from "@/hooks/useIngest";

/* ── Period options ───────────────────────────────────────── */
const periodOptions: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

/* ── Route title lookup (fallback to PAGE_CONFIG) ─────────── */
const routeSubtitles: Record<string, string> = {
  "/": "Key metrics and trends at a glance",
  "/cost": "Spending patterns across models and projects",
  "/sessions": "Browse and filter your Claude Code sessions",
  "/prompts": "Prompt patterns and message analysis",
  "/tools": "Tool usage patterns and frequency",
  "/cache": "Cache hit rates and token savings",
  "/activity": "Timeline of coding activity",
  "/settings": "Application preferences and configuration",
};

/**
 * Pull a human-readable message out of a thrown error. The API client throws
 * `ApiError` whose `.message` is the raw response body — for our routes that
 * body is JSON like `{ "error": "...", "message": "..." }`, so unwrap it when
 * possible (e.g. the 409 "already running" case) and fall back to the raw text.
 */
function extractErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? raw;
  } catch {
    return raw;
  }
}

function getPageInfo(pathname: string): { title: string; subtitle: string } {
  /* Handle session detail */
  if (pathname.startsWith("/sessions/")) {
    const id = pathname.split("/").pop();
    return { title: "Session Detail", subtitle: `Session ${id}` };
  }

  /* Look up from PAGE_CONFIG first */
  const pageConfig = pages.find((p) => p.path === pathname);
  const title = pageConfig?.label ?? "Dashboard";
  const subtitle = routeSubtitles[pathname] ?? "";

  return { title, subtitle };
}

/* ── TopBar Component ────────────────────────────────────── */
interface TopBarProps {
  onMenuClick?: () => void;
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const location = useLocation();
  const { filters, setPeriod, setModel, setProject, setSource, resetFilters } =
    useFilters();

  const pathKey =
    location.pathname.replace(/\/[^/]+$/, "") || location.pathname;
  const pageInfo =
    getPageInfo(pathKey) ?? getPageInfo(location.pathname);

  /* ── Listen for reset-filters custom event from command palette ── */
  const handleResetFilters = useCallback(() => {
    resetFilters();
  }, [resetFilters]);

  useEffect(() => {
    document.addEventListener("reset-filters", handleResetFilters);
    return () =>
      document.removeEventListener("reset-filters", handleResetFilters);
  }, [handleResetFilters]);

  /* Cross-filter query strings: each dropdown is filtered by the *other*
     active filters so its options narrow dynamically. */
  const modelsQS = useMemo(
    () => buildFilterQS({ ...filters, model: null }),
    [filters],
  );
  const projectsQS = useMemo(
    () => buildFilterQS({ ...filters, project: null }),
    [filters],
  );
  const sourcesQS = useMemo(
    () => buildFilterQS({ ...filters, source: null }),
    [filters],
  );

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: ["filters", "models", modelsQS],
    queryFn: () =>
      apiGet<{ data: string[] }>(`/filters/models?${modelsQS}`),
  });

  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ["filters", "projects", projectsQS],
    queryFn: () =>
      apiGet<{
        data: { projectPath: string; projectName?: string; sessionCount: number }[];
      }>(`/filters/projects?${projectsQS}`),
  });

  const { data: sourcesData, isLoading: sourcesLoading } = useQuery({
    queryKey: ["filters", "sources", sourcesQS],
    queryFn: () =>
      apiGet<{
        data: { sourceType: string; sessionCount: number }[];
      }>(`/filters/sources?${sourcesQS}`),
  });

  const modelOptions = (modelsData?.data ?? []).map((m) => ({
    value: m,
    label: m,
  }));

  const projectOptions = (projectsData?.data ?? []).map((p) => ({
    value: p.projectPath,
    label: p.projectName ?? p.projectPath.split("/").pop() ?? p.projectPath,
  }));

  const sourceOptions = (sourcesData?.data ?? []).map((s) => ({
    value: s.sourceType,
    label:
      s.sourceType === "claude-desktop"
        ? "Desktop"
        : s.sourceType === "claude-code"
          ? "CLI"
          : s.sourceType,
  }));

  /* ── Ingest: POST /api/ingest, surface the result in a toast ──────── */
  const ingest = useIngest();
  const [toastDismissed, setToastDismissed] = useState(false);

  const handleIngest = useCallback(() => {
    setToastDismissed(false);
    ingest.mutate();
  }, [ingest]);

  /* Derive the toast content from the mutation state. */
  const toast = useMemo<{
    variant: ToastVariant;
    title: string;
    lines: string[];
    autoDismissMs?: number;
  } | null>(() => {
    if (ingest.isPending) {
      return {
        variant: "loading",
        title: "Ingesting sessions…",
        lines: ["Parsing JSONL files and loading new data."],
      };
    }
    if (ingest.isSuccess) {
      const r = ingest.data.data;
      const failed = r.filesFailed > 0;
      const lines = [
        `${r.filesProcessed} processed · ${r.filesSkipped} up to date · ${r.entriesIngested.toLocaleString()} entries`,
      ];
      const extras: string[] = [];
      if (r.duplicatesRemoved > 0)
        extras.push(`${r.duplicatesRemoved.toLocaleString()} duplicates`);
      if (r.parseErrors > 0) extras.push(`${r.parseErrors} parse errors`);
      if (r.filesFailed > 0) extras.push(`${r.filesFailed} files failed`);
      if (extras.length > 0) lines.push(extras.join(" · "));
      lines.push(`Done in ${(r.durationMs / 1000).toFixed(1)}s`);
      return {
        variant: failed ? "error" : "success",
        title: failed
          ? "Ingestion finished with errors"
          : "Ingestion complete",
        lines,
        autoDismissMs: failed ? undefined : 6000,
      };
    }
    if (ingest.isError) {
      return {
        variant: "error",
        title: "Ingestion failed",
        lines: [extractErrorMessage(ingest.error)],
      };
    }
    return null;
  }, [ingest.isPending, ingest.isSuccess, ingest.isError, ingest.data, ingest.error]);

  const showToast = toast !== null && !toastDismissed;

  return (
    <>
    <header
      className={cn(
        "sticky top-0 z-[var(--z-dropdown)]",
        "flex flex-col gap-[var(--space-3)] sm:flex-row sm:items-center sm:justify-between",
        "border-b border-[var(--border)]",
        "bg-[var(--bg-raised)]",
        "px-[var(--space-5)] py-[var(--space-4)] sm:px-[var(--space-6)] sm:py-[var(--space-5)]",
      )}
    >
      {/* Left: menu + title */}
      <div className="flex min-w-0 items-center gap-[var(--space-4)]">
        {/* Mobile menu button */}
        <button
          onClick={onMenuClick}
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] lg:hidden",
            "text-[var(--text-secondary)] bg-transparent border-none cursor-pointer",
            "hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
            "transition-colors duration-[var(--duration-fast)]",
          )}
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>

        <div className="min-w-0">
          <h1 className="text-h2 text-[var(--text-primary)]">
            {pageInfo.title}
          </h1>
          {pageInfo.subtitle && (
            <p className="text-small text-[var(--text-tertiary)]">
              {pageInfo.subtitle}
            </p>
          )}
        </div>
      </div>

      {/* Right: period + filters + cmd-k */}
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        {/* Period segmented control */}
        <div
          className={cn(
            "inline-flex gap-[2px] rounded-[var(--radius-full)]",
            "border border-[var(--border)] bg-[var(--bg-surface)]",
            "p-[3px]",
          )}
        >
          {periodOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className={cn(
                "rounded-[var(--radius-full)]",
                "px-[14px] py-[5px] min-h-[44px] sm:min-h-0 sm:py-[5px]",
                "text-caption whitespace-nowrap",
                "border border-transparent cursor-pointer",
                "transition-all duration-[var(--duration-normal)]",
                filters.period === opt.value
                  ? "bg-[var(--bg-elevated)] border-[var(--border-pill-active)] text-[var(--text-primary)]"
                  : "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-pill-hover)] hover:text-[var(--text-primary)]",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="hidden h-6 w-px shrink-0 bg-[var(--border-subtle)] sm:block" />

        {/* Filter chips — using reusable Dropdown */}
        <Dropdown
          label="Model"
          options={modelOptions}
          selected={filters.model ? [filters.model] : []}
          onToggle={(value) =>
            setModel(filters.model === value ? null : value)
          }
          loading={modelsLoading}
        />
        <Dropdown
          label="Project"
          options={projectOptions}
          selected={filters.project ? [filters.project] : []}
          onToggle={(value) =>
            setProject(filters.project === value ? null : value)
          }
          loading={projectsLoading}
        />
        <Dropdown
          label="Source"
          options={sourceOptions}
          selected={filters.source ? [filters.source] : []}
          onToggle={(value) =>
            setSource(filters.source === value ? null : value)
          }
          loading={sourcesLoading}
        />

        {/* Divider */}
        <div className="hidden h-6 w-px shrink-0 bg-[var(--border-subtle)] sm:block" />

        {/* Cmd+K hint */}
        <button
          onClick={() => {
            document.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "k",
                metaKey: true,
                bubbles: true,
              }),
            );
          }}
          className={cn(
            "hidden shrink-0 items-center gap-1 rounded-[var(--radius-full)] sm:inline-flex",
            "border border-[var(--border)] bg-[var(--bg-surface)]",
            "px-[10px] py-[4px]",
            "text-[length:var(--font-overline-size)] font-medium text-[var(--text-tertiary)]",
            "cursor-pointer whitespace-nowrap",
            "hover:border-[var(--border-hover)] hover:text-[var(--text-secondary)]",
            "transition-all duration-[var(--duration-fast)]",
          )}
          aria-label="Open command palette"
        >
          <Command size={11} className="shrink-0" />
          <span>K</span>
        </button>

        {/* Divider */}
        <div className="hidden h-6 w-px shrink-0 bg-[var(--border-subtle)] sm:block" />

        {/* Ingest button — runs POST /api/ingest (in-process, shared with the CLI) */}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleIngest}
          disabled={ingest.isPending}
          className="shrink-0"
          aria-label="Ingest sessions"
          title="Parse new JSONL session files into the database"
        >
          <RotateCw
            size={13}
            className={cn("shrink-0", ingest.isPending && "animate-spin")}
          />
          <span>{ingest.isPending ? "Ingesting…" : "Ingest"}</span>
        </Button>
      </div>
    </header>

    {showToast && toast && (
      <Toast
        variant={toast.variant}
        title={toast.title}
        lines={toast.lines}
        autoDismissMs={toast.autoDismissMs}
        onDismiss={() => setToastDismissed(true)}
      />
    )}
    </>
  );
}
