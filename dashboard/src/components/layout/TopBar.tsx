import { useLocation } from "react-router-dom";
import { useFilters, type Period } from "@/hooks/useFilters";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { useState, useRef, useEffect } from "react";

const periodOptions: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

const routeTitles: Record<string, { title: string; subtitle: string }> = {
  "/": {
    title: "Overview",
    subtitle: "Key metrics and trends at a glance",
  },
  "/cost": {
    title: "Cost Analysis",
    subtitle: "Spending patterns across models and projects",
  },
  "/sessions": {
    title: "Sessions",
    subtitle: "Browse and filter your Claude Code sessions",
  },
  "/tools": {
    title: "Tools",
    subtitle: "Tool usage patterns and frequency",
  },
  "/cache": {
    title: "Cache",
    subtitle: "Cache hit rates and token savings",
  },
  "/activity": {
    title: "Activity",
    subtitle: "Timeline of coding activity",
  },
};

interface FilterOption {
  value: string;
  label: string;
}

function FilterDropdown({
  label,
  value,
  options,
  onChange,
  loading,
}: {
  label: string;
  value: string | null;
  options: FilterOption[];
  onChange: (value: string | null) => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const isActive = value !== null;

  const chipClasses = [
    "filter-chip",
    isActive && "filter-chip--active",
    open && "filter-chip--open",
  ]
    .filter(Boolean)
    .join(" ");

  const chevronClasses = [
    "filter-chip__chevron",
    open && "filter-chip__chevron--open",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className={chipClasses}>
        {isActive && <span className="filter-dot" />}
        <span>{label}</span>
        {isActive && (
          <span className="max-w-[100px] truncate opacity-70">
            {value}
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={chevronClasses}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="filter-dropdown">
          {/* "All" option */}
          <button
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={`filter-dropdown__item ${
              !value ? "filter-dropdown__item--selected" : ""
            }`}
          >
            {!value && <CheckIcon />}
            <span>All</span>
          </button>

          <div className="filter-dropdown__separator" />

          {loading ? (
            <div className="filter-dropdown__item" style={{ cursor: "default" }}>
              <LoadingDots />
            </div>
          ) : (
            options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`filter-dropdown__item ${
                  value === opt.value
                    ? "filter-dropdown__item--selected"
                    : ""
                }`}
              >
                {value === opt.value && <CheckIcon />}
                <span className="truncate">{opt.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function LoadingDots() {
  return (
    <div className="flex items-center gap-1">
      <span
        className="inline-block h-1 w-1 animate-pulse rounded-full"
        style={{ background: "var(--text-muted)", animationDelay: "0ms" }}
      />
      <span
        className="inline-block h-1 w-1 animate-pulse rounded-full"
        style={{
          background: "var(--text-muted)",
          animationDelay: "150ms",
        }}
      />
      <span
        className="inline-block h-1 w-1 animate-pulse rounded-full"
        style={{
          background: "var(--text-muted)",
          animationDelay: "300ms",
        }}
      />
    </div>
  );
}

interface TopBarProps {
  onMenuClick?: () => void;
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const location = useLocation();
  const { filters, setPeriod, setModel, setProject } = useFilters();

  const pathKey =
    location.pathname.replace(/\/[^/]+$/, "") || location.pathname;
  const pageInfo = routeTitles[pathKey] ??
    routeTitles[location.pathname] ?? {
      title: "Dashboard",
      subtitle: "",
    };

  // Handle session detail page title
  const isSessionDetail = location.pathname.startsWith("/sessions/");
  const title = isSessionDetail ? "Session Detail" : pageInfo.title;
  const subtitle = isSessionDetail
    ? `Session ${location.pathname.split("/").pop()}`
    : pageInfo.subtitle;

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

  const modelOptions: FilterOption[] = (modelsData?.data ?? []).map((m) => ({
    value: m,
    label: m,
  }));

  const projectOptions: FilterOption[] = (projectsData?.data ?? []).map(
    (p) => ({
      value: p.projectPath,
      label: p.projectPath.split("/").pop() ?? p.projectPath,
    }),
  );

  return (
    <header
      className="flex flex-col gap-3 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between"
      style={{
        backgroundColor: "var(--bg-primary)",
        borderColor: "var(--border)",
      }}
    >
      <div className="flex items-center gap-3">
        {/* Mobile menu button */}
        <button
          onClick={onMenuClick}
          className="mobile-menu-btn lg:hidden"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>

        <div>
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              {subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {/* Period selector - pill segmented control */}
        <div className="period-seg">
          {periodOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className={`period-btn ${
                filters.period === opt.value ? "period-btn--active" : ""
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="filter-divider hidden sm:block" />

        {/* Filter chips */}
        <FilterDropdown
          label="Model"
          value={filters.model}
          options={modelOptions}
          onChange={setModel}
          loading={modelsLoading}
        />
        <FilterDropdown
          label="Project"
          value={filters.project}
          options={projectOptions}
          onChange={setProject}
          loading={projectsLoading}
        />
      </div>
    </header>
  );
}
