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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
        style={{
          backgroundColor: value ? "var(--accent-muted)" : "var(--bg-secondary)",
          borderColor: value ? "var(--accent)" : "var(--border)",
          color: value ? "var(--accent-hover)" : "var(--text-secondary)",
        }}
      >
        {label}
        {value && (
          <span
            className="max-w-[100px] truncate"
            style={{ color: "var(--accent-hover)" }}
          >
            : {value}
          </span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ml-0.5 flex-shrink-0"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border py-1 shadow-lg"
          style={{
            backgroundColor: "var(--bg-card)",
            borderColor: "var(--border)",
          }}
        >
          <button
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="w-full px-3 py-1.5 text-left text-xs transition-colors"
            style={{
              color: !value ? "var(--accent)" : "var(--text-secondary)",
              backgroundColor: !value ? "var(--accent-muted)" : "transparent",
            }}
            onMouseEnter={(e) => {
              if (value)
                e.currentTarget.style.backgroundColor = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (value)
                e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            All
          </button>
          {loading ? (
            <div
              className="px-3 py-2 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              Loading...
            </div>
          ) : (
            options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className="w-full truncate px-3 py-1.5 text-left text-xs transition-colors"
                style={{
                  color:
                    value === opt.value
                      ? "var(--accent)"
                      : "var(--text-secondary)",
                  backgroundColor:
                    value === opt.value ? "var(--accent-muted)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (value !== opt.value)
                    e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (value !== opt.value)
                    e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                {opt.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface TopBarProps {
  onMenuClick?: () => void;
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const location = useLocation();
  const { filters, setPeriod, setModel, setProject } = useFilters();

  const pathKey = location.pathname.replace(/\/[^/]+$/, "") || location.pathname;
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
      className="flex flex-col gap-3 border-b px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
      style={{
        backgroundColor: "var(--bg-primary)",
        borderColor: "var(--border)",
      }}
    >
      <div className="flex items-center gap-3">
        {/* Mobile menu button */}
        <button
          onClick={onMenuClick}
          className="rounded-lg p-1.5 transition-colors lg:hidden"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.backgroundColor = "var(--bg-hover)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.backgroundColor = "transparent")
          }
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
            className="text-lg font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Period selector */}
        <div
          className="inline-flex gap-1 rounded-lg border p-0.5"
          style={{
            backgroundColor: "var(--bg-secondary)",
            borderColor: "var(--border)",
          }}
        >
          {periodOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className="rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150"
              style={{
                backgroundColor:
                  filters.period === opt.value
                    ? "var(--accent)"
                    : "transparent",
                color:
                  filters.period === opt.value
                    ? "#ffffff"
                    : "var(--text-secondary)",
              }}
              onMouseEnter={(e) => {
                if (filters.period !== opt.value) {
                  e.currentTarget.style.backgroundColor = "var(--bg-hover)";
                }
              }}
              onMouseLeave={(e) => {
                if (filters.period !== opt.value) {
                  e.currentTarget.style.backgroundColor = "transparent";
                }
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Filter dropdowns */}
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
