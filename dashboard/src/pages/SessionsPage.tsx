import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  LineChart,
  Line,
  ResponsiveContainer,
} from "recharts";
import KPICard from "@/components/ui/KPICard";
import Badge from "@/components/ui/Badge";
import Skeleton from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { formatCost, formatPercent, formatDuration, formatDateTime } from "@/lib/formatters";
import { CHART_COLORS } from "@/lib/chartTheme";
import { useSessions, useSessionStats } from "@/hooks/useSessionsQuery";
import type { SessionListItem } from "@/lib/types";

const PAGE_SIZE = 20;

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

interface SortState {
  field: SortField;
  order: "asc" | "desc";
}

const COLUMNS: { key: SortField; label: string; align?: "right" }[] = [
  { key: "startTime", label: "Start Time" },
  { key: "projectPath", label: "Project" },
  { key: "model", label: "Model" },
  { key: "sourceType", label: "Source" },
  { key: "durationMinutes", label: "Duration", align: "right" },
  { key: "numTurns", label: "Turns", align: "right" },
  { key: "numToolCalls", label: "Tool Calls", align: "right" },
  { key: "cacheHitRate", label: "Cache Hit Rate" },
  { key: "totalCostUSD", label: "Cost", align: "right" },
];

/** Tiny cost-per-turn sparkline for a table row. */
function CostSparkline({ data }: { data: number[] }) {
  if (!data || data.length < 2) return null;
  const points = data.map((v, i) => ({ i, v }));
  return (
    <div style={{ width: 80, height: 30 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={CHART_COLORS[0]}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Colored progress bar for cache hit rate. */
function CacheBar({ rate }: { rate: number }) {
  const pct = rate * 100;
  let barColor: string;
  if (pct > 70) barColor = "var(--success)";
  else if (pct >= 40) barColor = "var(--warning)";
  else barColor = "var(--danger)";

  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2 flex-1 rounded-full"
        style={{ backgroundColor: "var(--bg-hover)", minWidth: 60 }}
      >
        <div
          className="h-2 rounded-full transition-all"
          style={{
            width: `${Math.max(pct, 2)}%`,
            backgroundColor: barColor,
          }}
        />
      </div>
      <span
        className="text-xs tabular-nums"
        style={{ color: "var(--text-secondary)", minWidth: 40, textAlign: "right" }}
      >
        {formatPercent(rate)}
      </span>
    </div>
  );
}

/** Sort arrow indicator. */
function SortArrow({ active, order }: { active: boolean; order: "asc" | "desc" }) {
  if (!active) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity={0.3}>
        <path d="M8 15l4 4 4-4M8 9l4-4 4 4" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5">
      {order === "asc" ? <path d="M8 15l4-4 4 4" /> : <path d="M8 9l4 4 4-4" />}
    </svg>
  );
}

export default function SessionsPage() {
  const navigate = useNavigate();

  // Sorting & pagination state
  const [sort, setSort] = useState<SortState>({ field: "startTime", order: "desc" });
  const [offset, setOffset] = useState(0);

  // Data hooks
  const stats = useSessionStats();
  const sessions = useSessions({
    sort: sort.field,
    order: sort.order,
    limit: PAGE_SIZE,
    offset,
  });

  const items: SessionListItem[] = sessions.data?.data ?? [];
  const total = sessions.data?.meta?.total ?? 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Sort handler
  const handleSort = useCallback(
    (field: SortField) => {
      setSort((prev) => ({
        field,
        order: prev.field === field && prev.order === "desc" ? "asc" : "desc",
      }));
      setOffset(0);
    },
    [],
  );

  // Pagination handlers
  const goNext = useCallback(() => {
    setOffset((prev) => Math.min(prev + PAGE_SIZE, (totalPages - 1) * PAGE_SIZE));
  }, [totalPages]);

  const goPrev = useCallback(() => {
    setOffset((prev) => Math.max(prev - PAGE_SIZE, 0));
  }, []);

  // Format project name (last segment)
  const shortProject = useCallback((path: string) => {
    return path.split("/").pop() ?? path;
  }, []);

  // Format model name (last segment)
  const shortModel = useCallback((model: string) => {
    return model.split("/").pop() ?? model;
  }, []);

  // KPI values
  const kpiTotalSessions = stats.data?.totalSessions ?? 0;
  const kpiAvgCost = stats.data?.avgCostPerSession ?? 0;
  const kpiAvgDuration = stats.data?.avgDurationMinutes ?? 0;
  const kpiMedianTurns = useMemo(() => {
    // Derive median turns from avgTurnsPerSession since stats exposes that
    return stats.data?.avgTurnsPerSession ?? 0;
  }, [stats.data]);

  // Loading skeleton rows
  const skeletonRows = Array.from({ length: 5 });

  return (
    <div className="space-y-8">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
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
          label="Median Turns / Session"
          value={kpiMedianTurns.toFixed(1)}
          type="sessions"
          loading={stats.isLoading}
        />
      </div>

      {/* Sessions Table */}
      <div
        className="overflow-hidden rounded-xl border"
        style={{
          backgroundColor: "var(--bg-card)",
          borderColor: "var(--border)",
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr
                className="border-b"
                style={{ borderColor: "var(--border)" }}
              >
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={`table-header-sortable cursor-pointer select-none px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors ${col.align === "right" ? "text-right" : ""}`}
                    onClick={() => handleSort(col.key)}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {col.label}
                      <SortArrow
                        active={sort.field === col.key}
                        order={sort.order}
                      />
                    </span>
                  </th>
                ))}
                {/* Sparkline column header */}
                <th
                  className="table-header-sortable px-4 py-3 text-xs font-semibold uppercase tracking-wider"
                >
                  Cost/Turn
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.isLoading ? (
                skeletonRows.map((_, i) => (
                  <tr
                    key={i}
                    className="border-b"
                    style={{ borderColor: "var(--border)" }}
                  >
                    {COLUMNS.map((col) => (
                      <td key={col.key} className="px-4 py-3">
                        <Skeleton height="0.875rem" width={col.key === "cacheHitRate" ? "100%" : "70%"} />
                      </td>
                    ))}
                    <td className="px-4 py-3">
                      <Skeleton height="1.875rem" width="5rem" />
                    </td>
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length + 1}>
                    <EmptyState
                      title="No sessions found"
                      message="Try adjusting your filters or time period."
                    />
                  </td>
                </tr>
              ) : (
                items.map((session) => (
                  <tr
                    key={session.sessionId}
                    className="table-row-hover cursor-pointer border-b"
                    tabIndex={0}
                    style={{ borderColor: "var(--border)" }}
                    onClick={() => navigate(`/sessions/${session.sessionId}`)}
                  >
                    {/* Start Time */}
                    <td
                      className="whitespace-nowrap px-4 py-3 font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {formatDateTime(session.startTime)}
                    </td>
                    {/* Project */}
                    <td
                      className="max-w-[160px] truncate px-4 py-3"
                      style={{ color: "var(--text-secondary)" }}
                      title={session.projectPath}
                    >
                      {shortProject(session.projectPath)}
                    </td>
                    {/* Model */}
                    <td className="px-4 py-3">
                      <Badge variant="accent">{shortModel(session.model)}</Badge>
                    </td>
                    {/* Source */}
                    <td className="px-4 py-3">
                      <Badge variant={session.sourceType === "claude-desktop" ? "warning" : "neutral"}>
                        {session.sourceType === "claude-desktop" ? "Desktop" : "CLI"}
                      </Badge>
                    </td>
                    {/* Duration */}
                    <td
                      className="px-4 py-3 text-right tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {formatDuration(session.durationMinutes * 60)}
                    </td>
                    {/* Turns */}
                    <td
                      className="px-4 py-3 text-right tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {session.numTurns}
                    </td>
                    {/* Tool Calls */}
                    <td
                      className="px-4 py-3 text-right tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {session.numToolCalls}
                    </td>
                    {/* Cache Hit Rate */}
                    <td className="px-4 py-3" style={{ minWidth: 140 }}>
                      <CacheBar rate={session.cacheHitRate} />
                    </td>
                    {/* Cost */}
                    <td
                      className="px-4 py-3 text-right font-semibold tabular-nums"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {formatCost(session.totalCostUSD)}
                    </td>
                    {/* Sparkline */}
                    <td className="px-4 py-3">
                      <CostSparkline data={session.costPerTurn ?? []} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {!sessions.isLoading && items.length > 0 && (
          <div
            className="flex items-center justify-between border-t px-4 py-3.5"
            style={{ borderColor: "var(--border)" }}
          >
            <p
              className="text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of{" "}
              {total.toLocaleString()} sessions
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={goPrev}
                disabled={offset === 0}
                className="pagination-btn rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
              >
                Prev
              </button>
              <span
                className="text-xs tabular-nums"
                style={{ color: "var(--text-secondary)" }}
              >
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={goNext}
                disabled={currentPage >= totalPages}
                className="pagination-btn rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
