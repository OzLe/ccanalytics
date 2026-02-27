import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import KPICard from "@/components/ui/KPICard";
import Badge from "@/components/ui/Badge";
import DataTable from "@/components/ui/DataTable";
import type { Column } from "@/components/ui/DataTable";
import CacheRateBadge from "@/components/session/CacheRateBadge";
import {
  formatCost,
  formatDuration,
  formatDateTime,
} from "@/lib/formatters";
import { useSessions, useSessionStats } from "@/hooks/useSessionsQuery";
import type { SessionListItem } from "@/lib/types";

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

  const items: SessionListItem[] = sessions.data?.data ?? [];
  const total = sessions.data?.meta?.total ?? 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

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
    [],
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
