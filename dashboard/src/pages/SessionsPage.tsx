import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import Badge from "@/components/ui/Badge";
import DataTable from "@/components/ui/DataTable";
import type { Column } from "@/components/ui/DataTable";
import CacheRateBadge from "@/components/session/CacheRateBadge";
import ContextPressureBadge from "@/components/session/ContextPressureBadge";
import {
  formatCost,
  formatDuration,
  formatDateTime,
} from "@/lib/formatters";
import {
  useSessions,
  useSessionStats,
  useContextPressure,
} from "@/hooks/useSessionsQuery";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";
import type { SessionListItem } from "@/lib/types";

/**
 * NEW-001: fixed buckets for the peak context-window utilization histogram.
 * Colors mirror ContextPressureBadge: green < 60%, amber 60-80%, red > 80%.
 */
const CONTEXT_BUCKETS: { label: string; min: number; max: number; fill: string }[] = [
  { label: "0–20%", min: 0, max: 0.2, fill: "var(--success)" },
  { label: "20–40%", min: 0.2, max: 0.4, fill: "var(--success)" },
  { label: "40–60%", min: 0.4, max: 0.6, fill: "var(--success)" },
  { label: "60–80%", min: 0.6, max: 0.8, fill: "var(--warning)" },
  { label: "80–100%", min: 0.8, max: 1.0, fill: "var(--danger)" },
  { label: ">100%", min: 1.0, max: Infinity, fill: "var(--danger)" },
];

const PAGE_SIZE = 100;

type SortField =
  | "startTime"
  | "projectPath"
  | "model"
  | "sourceType"
  | "durationMinutes"
  | "numTurns"
  | "numToolCalls"
  | "cacheHitRate"
  | "totalCostUSD";

/** Return human-readable project name, preferring the API-provided projectName. */
function shortProject(
  projectName: string | null | undefined,
  projectPath: string | null | undefined,
): string {
  if (projectName) return projectName;
  if (!projectPath) return "Unknown";
  return projectPath.split("/").pop() ?? projectPath;
}

/** Extract model short name. */
function shortModel(model: string | null | undefined): string {
  if (!model) return "Unknown";
  return model.split("/").pop() ?? model;
}

export default function SessionsPage() {
  const navigate = useNavigate();

  // Sorting & pagination
  const [sortField, setSortField] = useState<SortField>("startTime");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);

  // Data
  const stats = useSessionStats();
  const sessions = useSessions({
    sort: sortField,
    order: sortOrder,
    limit: PAGE_SIZE,
    offset,
  });
  // NEW-001: per-session context-window utilization (capped at 500 sessions
  // server-side, ordered by peak desc — plenty for the distribution shape).
  const contextPressure = useContextPressure(500);

  const items: SessionListItem[] = sessions.data?.data ?? [];
  const total = sessions.data?.meta?.total ?? 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // NEW-001: peak context-utilization histogram + headline summary.
  const contextSummary = contextPressure.data?.summary ?? null;
  const contextDistData = useMemo(() => {
    const rows = contextPressure.data?.sessions ?? [];
    return CONTEXT_BUCKETS.map((b) => ({
      label: b.label,
      fill: b.fill,
      count: rows.filter(
        (s) => s.peakContextPct >= b.min && s.peakContextPct < b.max,
      ).length,
    }));
  }, [contextPressure.data]);

  // NEW-001: sessionId → peak context utilization, for the per-row badge.
  const peakContextBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of contextPressure.data?.sessions ?? []) {
      map.set(s.sessionId, s.peakContextPct);
    }
    return map;
  }, [contextPressure.data]);

  // Sort handler
  const handleSort = useCallback((field: string) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortOrder((o) => (o === "desc" ? "asc" : "desc"));
        return prev;
      }
      setSortOrder("desc");
      return field as SortField;
    });
    setOffset(0);
  }, []);

  // Row click
  const handleRowClick = useCallback(
    (row: SessionListItem) => {
      navigate(`/sessions/${row.sessionId}`);
    },
    [navigate],
  );

  // Pagination
  const handlePageChange = useCallback((page: number) => {
    setOffset((page - 1) * PAGE_SIZE);
  }, []);

  // KPI values
  const kpiTotalSessions = stats.data?.totalSessions ?? 0;
  const kpiAvgCost = stats.data?.avgCostPerSession ?? 0;
  const kpiAvgDuration = stats.data?.avgDurationMinutes ?? 0;
  const kpiAvgTurns = stats.data?.avgTurnsPerSession ?? 0;

  // Column definitions
  const columns = useMemo<Column<SessionListItem>[]>(
    () => [
      {
        key: "startTime",
        header: "Start Time",
        sortable: true,
        render: (row) => (
          <span className="whitespace-nowrap font-medium text-[var(--text-primary)]">
            {formatDateTime(row.startTime)}
          </span>
        ),
      },
      {
        key: "projectPath",
        header: "Project",
        sortable: true,
        render: (row) => (
          <span
            className="block max-w-[200px] truncate text-[var(--text-primary)]"
            title={row.projectPath}
          >
            {shortProject(row.projectName, row.projectPath)}
          </span>
        ),
      },
      {
        key: "model",
        header: "Model",
        sortable: true,
        render: (row) => (
          <Badge variant="accent" size="sm">
            {shortModel(row.model)}
          </Badge>
        ),
      },
      {
        key: "sourceType",
        header: "Source",
        sortable: true,
        render: (row) => (
          <Badge
            variant={row.sourceType === "claude-desktop" ? "warning" : "default"}
            size="sm"
          >
            {row.sourceType === "claude-desktop" ? "Desktop" : "CLI"}
          </Badge>
        ),
      },
      {
        key: "durationMinutes",
        header: "Duration",
        sortable: true,
        align: "right",
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {formatDuration(row.durationMinutes * 60)}
          </span>
        ),
      },
      {
        key: "numTurns",
        header: "Turns",
        sortable: true,
        align: "right",
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.numTurns}
          </span>
        ),
      },
      {
        key: "numToolCalls",
        header: "Tools",
        sortable: true,
        align: "right",
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.numToolCalls}
          </span>
        ),
      },
      {
        key: "cacheHitRate",
        header: "Cache Rate",
        sortable: true,
        width: "140px",
        render: (row) => <CacheRateBadge rate={row.cacheHitRate} />,
      },
      {
        // NEW-001: per-session peak context-window utilization badge.
        // Not sortable — the value comes from a separate endpoint, not the
        // session-list query the table sorts on.
        key: "peakContextPct",
        header: "Context",
        align: "right",
        render: (row) => {
          const peak = peakContextBySession.get(row.sessionId);
          if (peak == null) {
            return <span className="text-[var(--text-tertiary)]">—</span>;
          }
          return <ContextPressureBadge peakPct={peak} />;
        },
      },
      {
        key: "totalCostUSD",
        header: "Cost",
        sortable: true,
        align: "right",
        render: (row) => (
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">
            {formatCost(row.totalCostUSD)}
          </span>
        ),
      },
    ],
    [peakContextBySession],
  );

  return (
    <ErrorBoundary>
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-8)]">
      {/* KPI Stats Bar */}
      <section>
      <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-4">
        <KPICard
          label="Total Sessions"
          value={kpiTotalSessions.toLocaleString()}
          type="sessions"
          loading={stats.isLoading}
        />
        <KPICard
          label="Avg Cost / Session"
          value={formatCost(kpiAvgCost)}
          type="cost"
          loading={stats.isLoading}
        />
        <KPICard
          label="Avg Duration"
          value={formatDuration(kpiAvgDuration * 60)}
          type="duration"
          loading={stats.isLoading}
        />
        <KPICard
          label="Avg Turns / Session"
          value={kpiAvgTurns.toFixed(1)}
          type="sessions"
          loading={stats.isLoading}
        />
      </div>
      </section>

      {/* NEW-001: Context-Window Pressure distribution.
          Per assistant turn, context = input + cache tokens; utilization =
          context / model-aware window (1M for 1M-context models, 200k else).
          CLAUDE.md flags >60% peak as a quality-degradation risk. */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Context-Window Pressure"
          subtitle="Distribution of sessions by their peak context-window utilization"
        />
        <ChartCard
          title="Peak Context Utilization"
          subtitle={
            contextSummary
              ? `${contextSummary.sessionsOver60.toLocaleString()} of ${contextSummary.totalSessions.toLocaleString()} sessions peaked above 60%` +
                (contextSummary.sessionsOver80 > 0
                  ? ` · ${contextSummary.sessionsOver80.toLocaleString()} critical (>80%)`
                  : "") +
                (contextSummary.maxTokensTurns > 0
                  ? ` · ${contextSummary.maxTokensTurns.toLocaleString()} max_tokens truncation${contextSummary.maxTokensTurns === 1 ? "" : "s"}`
                  : "")
              : "Per-session peak of (input + cache tokens) / model context window"
          }
          loading={contextPressure.isLoading}
          empty={contextDistData.every((b) => b.count === 0)}
          emptyMessage="No assistant turns in the selected period."
        >
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={contextDistData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="label"
                {...X_AXIS_PROPS}
                tick={{ fill: AXIS_TICK_FILL, fontSize: 11 }}
              />
              <YAxis {...Y_AXIS_PROPS} allowDecimals={false} />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => `${v.toLocaleString()} sessions`}
                    labelFormatter={(l) => `Peak utilization: ${l}`}
                  />
                }
              />
              <Bar dataKey="count" name="Sessions" radius={[4, 4, 0, 0]} maxBarSize={48}>
                {contextDistData.map((entry, i) => (
                  <Cell key={`ctx-cell-${i}`} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </section>

      {/* Sessions DataTable */}
      <DataTable<SessionListItem>
        columns={columns}
        data={items}
        sortField={sortField}
        sortOrder={sortOrder}
        onSort={handleSort}
        onRowClick={handleRowClick}
        loading={sessions.isLoading}
        emptyMessage="No sessions found. Try adjusting your filters or time period."
        pagination={{
          page: currentPage,
          pageSize: PAGE_SIZE,
          total,
          onPageChange: handlePageChange,
        }}
      />
    </div>
    </ErrorBoundary>
  );
}
