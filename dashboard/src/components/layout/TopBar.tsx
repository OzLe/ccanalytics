import { useLocation } from "react-router-dom";
import { useFilters, type Period } from "@/hooks/useFilters";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { pages } from "@/lib/pages";
import { Menu, Command } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";

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
};

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

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: ["filters", "models", filters.period],
    queryFn: () =>
      apiGet<{ data: string[] }>(`/filters/models?period=${filters.period}`),
  });

  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ["filters", "projects", filters.period],
    queryFn: () =>
      apiGet<{
        data: { projectPath: string; sessionCount: number }[];
      }>(`/filters/projects?period=${filters.period}`),
  });

  const { data: sourcesData, isLoading: sourcesLoading } = useQuery({
    queryKey: ["filters", "sources", filters.period],
    queryFn: () =>
      apiGet<{
        data: { sourceType: string; sessionCount: number }[];
      }>(`/filters/sources?period=${filters.period}`),
  });

  const modelOptions = (modelsData?.data ?? []).map((m) => ({
    value: m,
    label: m,
  }));

  const projectOptions = (projectsData?.data ?? []).map((p) => ({
    value: p.projectPath,
    label: p.projectPath.split("/").pop() ?? p.projectPath,
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

  return (
    <header
      className={cn(
        "sticky top-0 z-10",
        "flex flex-col gap-[var(--space-3)] sm:flex-row sm:items-center sm:justify-between",
        "border-b border-[var(--border)]",
        "bg-[var(--bg-raised)]",
        "px-[var(--space-6)] py-[var(--space-5)]",
      )}
    >
      {/* Left: menu + title */}
      <div className="flex items-center gap-[var(--space-3)]">
        {/* Mobile menu button */}
        <button
          onClick={onMenuClick}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] lg:hidden",
            "text-[var(--text-secondary)] bg-transparent border-none cursor-pointer",
            "hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
            "transition-colors duration-[var(--duration-fast)]",
          )}
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>

        <div>
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
                "px-[14px] py-[5px]",
                "text-[12px] font-medium leading-[1.25] whitespace-nowrap",
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
            /* Dispatch keyboard event to trigger CommandPalette */
            document.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "k",
                metaKey: true,
                bubbles: true,
              }),
            );
          }}
          className={cn(
            "hidden items-center gap-1 rounded-[var(--radius-full)] sm:inline-flex",
            "border border-[var(--border)] bg-[var(--bg-surface)]",
            "px-[10px] py-[4px]",
            "text-[11px] font-medium text-[var(--text-tertiary)]",
            "cursor-pointer",
            "hover:border-[var(--border-hover)] hover:text-[var(--text-secondary)]",
            "transition-all duration-[var(--duration-fast)]",
          )}
          aria-label="Open command palette"
        >
          <Command size={11} className="shrink-0" />
          <span>K</span>
        </button>
      </div>
    </header>
  );
}
