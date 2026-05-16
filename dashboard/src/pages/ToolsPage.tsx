import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { ArrowRight } from "lucide-react";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import ToolChainSankey from "@/components/charts/ToolChainSankey";
import DataTable from "@/components/ui/DataTable";
import Badge from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  useToolUsage,
  useToolSuccessRates,
  useToolChains,
  useToolFailureTrend,
  useToolFailureChains,
} from "@/hooks/useToolData";
import { formatDuration, formatDate, formatPercent } from "@/lib/formatters";
import type { ToolChain, SessionFailureChain } from "@/lib/types";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";
import type { Column } from "@/components/ui/DataTable";

/* ── Success Rate row type ──────────────────────────────────── */
interface SuccessRateRow {
  toolName: string;
  totalCalls: number;
  /** KPI-006: null when the tool has only NULL-success calls ("n/a"). */
  successRate: number | null;
  /** TOOL-001 (SEM2-282): null when no duration_ms was captured ("n/a"). */
  avgDurationMs: number | null;
  successCount: number;
  failureCount: number;
  /** KPI-009: avg calls per session (from /api/tools/usage), 0 if unknown. */
  avgPerSession: number;
}

export default function ToolsPage() {
  const toolUsage = useToolUsage();
  const successRates = useToolSuccessRates();
  const toolChains = useToolChains(2);
  // NEW-002 / NEW-003: failure-rate trend and tool-failure chains.
  const failureTrend = useToolFailureTrend("day");
  const failureChains = useToolFailureChains(20);

  // KPI computations
  const totalToolCalls = useMemo(() => {
    if (!toolUsage.data) return 0;
    return toolUsage.data.reduce((sum, t) => sum + t.callCount, 0);
  }, [toolUsage.data]);

  // NEW-002: overall tool failure rate over the whole filtered period (the
  // KPI card). failureRate = failures / evaluated calls (NULL-success calls
  // excluded), summed across every bucket so it matches the trend chart.
  const overallFailureRate = useMemo(() => {
    if (!failureTrend.data || failureTrend.data.length === 0) return null;
    let failures = 0;
    let evaluated = 0;
    for (const pt of failureTrend.data) {
      failures += pt.overall.failureCount;
      evaluated += pt.overall.evaluatedCalls;
    }
    return evaluated > 0 ? failures / evaluated : null;
  }, [failureTrend.data]);

  // NEW-002: failure-rate trend chart data — builtin vs MCP vs overall, as
  // percentages. Buckets with no evaluated calls of a class render as gaps.
  const failureTrendData = useMemo(() => {
    if (!failureTrend.data) return [];
    return failureTrend.data.map((pt) => ({
      date: formatDate(pt.timestamp),
      builtin:
        pt.builtin.failureRate != null ? pt.builtin.failureRate * 100 : null,
      mcp: pt.mcp.failureRate != null ? pt.mcp.failureRate * 100 : null,
      overall:
        pt.overall.failureRate != null ? pt.overall.failureRate * 100 : null,
    }));
  }, [failureTrend.data]);

  // NEW-003: worst-offender sessions by consecutive tool-failure streak.
  const failureChainRows: SessionFailureChain[] = useMemo(
    () => failureChains.data?.topSessions ?? [],
    [failureChains.data],
  );
  const failureChainSummary = failureChains.data?.summary ?? null;

  const uniqueTools = useMemo(() => {
    if (!toolUsage.data) return 0;
    return toolUsage.data.length;
  }, [toolUsage.data]);

  // KPI-008: overall success rate is computed over success-KNOWN calls only
  // (successCount + failureCount), not all totalCalls. totalCalls includes
  // NULL-success calls, which would structurally cap the headline below 100%
  // and make it a different metric than the per-tool "Rate" column (which
  // also excludes NULLs). This is a call-weighted micro-average.
  const avgSuccessRate = useMemo(() => {
    if (!successRates.data || successRates.data.length === 0) return null;
    const totalSuccess = successRates.data.reduce((s, t) => s + t.successCount, 0);
    const totalFailure = successRates.data.reduce((s, t) => s + t.failureCount, 0);
    const known = totalSuccess + totalFailure;
    return known > 0 ? totalSuccess / known : null;
  }, [successRates.data]);

  // Top tools horizontal bar data (top 15)
  const topToolsData = useMemo(() => {
    if (!toolUsage.data) return [];
    return toolUsage.data
      .slice(0, 15)
      .map((d, i) => ({
        name: d.toolName,
        calls: d.callCount,
        sessions: d.sessionsUsingTool,
        fill: CHART_COLORS[i % CHART_COLORS.length],
      }))
      .reverse();
  }, [toolUsage.data]);

  // Success rate table data — KPI-009: avgPerSession joined in by tool name
  // from /api/tools/usage so the previously-orphaned v_tool_usage column is
  // actually surfaced on the page.
  const successRateRows: SuccessRateRow[] = useMemo(() => {
    if (!successRates.data) return [];
    const avgPerSessionByTool = new Map<string, number>();
    for (const u of toolUsage.data ?? []) {
      avgPerSessionByTool.set(u.toolName, u.avgPerSession);
    }
    return successRates.data.map((t) => ({
      toolName: t.toolName,
      totalCalls: t.totalCalls,
      successRate: t.successRate,
      avgDurationMs: t.avgDurationMs,
      successCount: t.successCount,
      failureCount: t.failureCount,
      avgPerSession: avgPerSessionByTool.get(t.toolName) ?? 0,
    }));
  }, [successRates.data, toolUsage.data]);

  // Tool chain rows
  const toolChainRows: ToolChain[] = useMemo(() => {
    if (!toolChains.data) return [];
    return toolChains.data;
  }, [toolChains.data]);

  // DataTable columns for tool chains
  const chainColumns: Column<ToolChain>[] = useMemo(
    () => [
      {
        key: "chain",
        header: "Chain",
        render: (row) => (
          <div className="flex flex-wrap items-center gap-1">
            {row.chain.map((tool, ti) => (
              <span key={ti} className="flex items-center gap-1">
                <Badge variant="accent">{tool}</Badge>
                {ti < row.chain.length - 1 && (
                  <ArrowRight
                    size={12}
                    className="text-[var(--text-tertiary)]"
                  />
                )}
              </span>
            ))}
          </div>
        ),
      },
      {
        key: "occurrences",
        header: "Count",
        align: "right" as const,
        render: (row) => (
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">
            {row.occurrences.toLocaleString()}
          </span>
        ),
      },
      {
        key: "avgDurationMs",
        header: "Avg Time",
        align: "right" as const,
        // TOOL-001 (SEM2-282): null = no captured duration → "n/a" (matches
        // KPI-006 success-rate treatment above). Both ingestion adapters
        // currently set duration_ms = NULL, so every chain renders "n/a"
        // today instead of a fake "0s".
        render: (row) =>
          row.avgDurationMs == null ? (
            <span className="tabular-nums text-[var(--text-tertiary)]">
              n/a
            </span>
          ) : (
            <span className="tabular-nums text-[var(--text-secondary)]">
              {formatDuration(row.avgDurationMs / 1000)}
            </span>
          ),
      },
    ],
    [],
  );

  // DataTable columns for success rates
  const successColumns: Column<SuccessRateRow>[] = useMemo(() => [
    {
      key: "toolName",
      header: "Tool",
      render: (row) => (
        <span className="font-medium text-[var(--text-primary)]">{row.toolName}</span>
      ),
    },
    {
      key: "totalCalls",
      header: "Calls",
      align: "right" as const,
      render: (row) => (
        <span className="tabular-nums text-[var(--text-secondary)]">
          {row.totalCalls.toLocaleString()}
        </span>
      ),
    },
    {
      key: "avgPerSession",
      header: "Per Session",
      align: "right" as const,
      render: (row) => (
        <span className="tabular-nums text-[var(--text-secondary)]">
          {row.avgPerSession > 0 ? row.avgPerSession.toFixed(1) : "—"}
        </span>
      ),
    },
    {
      key: "successRate",
      header: "Rate",
      align: "right" as const,
      render: (row) => {
        // KPI-006: null = results never captured → "n/a", not a red 0%.
        if (row.successRate == null) {
          return (
            <span className="font-medium tabular-nums text-[var(--text-tertiary)]">
              n/a
            </span>
          );
        }
        const pct = row.successRate * 100;
        const color =
          pct >= 95 ? "text-[var(--success)]" :
          pct >= 80 ? "text-[var(--warning)]" :
          "text-[var(--danger)]";
        return (
          <span className={cn("font-semibold tabular-nums", color)}>
            {pct.toFixed(1)}%
          </span>
        );
      },
    },
    {
      key: "bar",
      header: "Bar",
      width: "7rem",
      render: (row) => {
        // KPI-006: no bar for "no data" tools (null success rate).
        if (row.successRate == null) {
          return (
            <div className="h-2 rounded-full bg-[var(--bg-hover)]" />
          );
        }
        const pct = row.successRate * 100;
        const barColor =
          pct >= 95 ? "var(--success)" :
          pct >= 80 ? "var(--warning)" :
          "var(--danger)";
        return (
          <div className="h-2 rounded-full bg-[var(--bg-hover)]">
            <div
              className="h-2 rounded-full transition-all duration-[var(--duration-slow)]"
              style={{
                width: `${pct}%`,
                backgroundColor: barColor,
                minWidth: row.successCount > 0 ? "4px" : "0px",
              }}
            />
          </div>
        );
      },
    },
    {
      key: "avgDurationMs",
      header: "Avg Time",
      align: "right" as const,
      width: "120px",
      // TOOL-001 (SEM2-282): null = no captured duration → "n/a" (matches the
      // KPI-006 success-rate "n/a" rendering above). Both ingestion adapters
      // currently set duration_ms = NULL, so every tool renders "n/a" today
      // instead of a fake "0s".
      render: (row) =>
        row.avgDurationMs == null ? (
          <span className="tabular-nums text-[var(--text-tertiary)]">
            n/a
          </span>
        ) : (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {formatDuration(row.avgDurationMs / 1000)}
          </span>
        ),
    },
  ], []);

  // NEW-003: DataTable columns for the tool-failure-chain worst-offenders.
  const failureChainColumns: Column<SessionFailureChain>[] = useMemo(
    () => [
      {
        key: "sessionId",
        header: "Session",
        render: (row) => (
          <Link
            to={`/sessions/${row.sessionId}`}
            className="font-mono text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]"
            title={row.sessionId}
          >
            {row.sessionId.slice(0, 8)}…
          </Link>
        ),
      },
      {
        key: "maxFailureStreak",
        header: "Longest Streak",
        align: "right" as const,
        render: (row) => {
          const color =
            row.maxFailureStreak >= 3
              ? "text-[var(--danger)]"
              : "text-[var(--warning)]";
          return (
            <span className={cn("font-semibold tabular-nums", color)}>
              {row.maxFailureStreak}
            </span>
          );
        },
      },
      {
        key: "failureChains2Plus",
        header: "Chains ≥2",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.failureChains2Plus}
          </span>
        ),
      },
      {
        key: "failureChains3Plus",
        header: "Chains ≥3",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.failureChains3Plus}
          </span>
        ),
      },
      {
        key: "totalFailedInChains",
        header: "Failed in Chains",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.totalFailedInChains}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <ErrorBoundary onRetry={() => window.location.reload()}>
    <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">
      {/* ── KPI Cards ──────────────────────────────────────────── */}
      <section>
        <div className="mb-[var(--space-5)]">
          <SectionHeader
            title="Tool Usage"
            subtitle="Aggregate tool call metrics for the selected period"
          />
        </div>
        <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-4">
          <KPICard
            label="Total Tool Calls"
            value={totalToolCalls.toLocaleString()}
            type="tools"
            loading={toolUsage.isLoading}
          />
          <KPICard
            label="Unique Tools"
            value={uniqueTools.toLocaleString()}
            type="tools"
            loading={toolUsage.isLoading}
          />
          <KPICard
            label="Success Rate (known results)"
            value={
              avgSuccessRate != null
                ? `${(avgSuccessRate * 100).toFixed(1)}%`
                : "n/a"
            }
            type="cache"
            loading={successRates.isLoading}
          />
          {/* NEW-002: overall tool failure rate for the period — an
              early-warning signal for degraded MCP servers / broken
              workflows. Denominator = evaluated (non-NULL-success) calls. */}
          <KPICard
            label="Tool Failure Rate"
            labelTooltip="Share of evaluated tool calls (success known) that failed, across the selected period. A rising rate is an early warning that an MCP server is degraded or a workflow is broken."
            value={
              overallFailureRate != null
                ? formatPercent(overallFailureRate)
                : "n/a"
            }
            type="tools"
            variant={
              overallFailureRate != null && overallFailureRate > 0.1
                ? "warning"
                : "default"
            }
            loading={failureTrend.isLoading}
          />
        </div>
      </section>

      {/* ── Top Tools - Horizontal Bar Chart ────────────────────── */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Top Tools"
          subtitle="Most frequently invoked tools ranked by call count"
        />
        <ChartCard
          title="Top Tools by Frequency"
          subtitle="Most frequently invoked tools"
          loading={toolUsage.isLoading}
          empty={topToolsData.length === 0}
        >
          <ResponsiveContainer
            width="100%"
            height={Math.max(320, topToolsData.length * 32)}
          >
            <BarChart
              data={topToolsData}
              layout="vertical"
              margin={{ left: 10, right: 20, top: 0, bottom: 0 }}
            >
              <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
              <XAxis type="number" {...X_AXIS_PROPS} />
              <YAxis
                type="category"
                dataKey="name"
                {...Y_AXIS_PROPS}
                width={150}
                tick={{ fill: AXIS_TICK_FILL, fontSize: 11 }}
                tickFormatter={(v: string) => v.length > 22 ? `…${v.slice(-20)}` : v}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => `${v.toLocaleString()} calls`}
                  />
                }
              />
              <Bar
                dataKey="calls"
                name="Calls"
                fill={CHART_COLORS[1]}
                radius={[0, 4, 4, 0]}
                maxBarSize={22}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </section>

      {/* ── Success Rates & Tool Chains ─────────────────────────── */}
      <section className="space-y-[var(--space-3)] pt-[var(--space-4)] border-t border-[var(--border-subtle)]">
        <SectionHeader
          title="Reliability & Patterns"
          subtitle="Tool success rates and common call chain patterns"
        />
        <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-2">
          {/* Success Rate Table - using DataTable */}
          <ChartCard
            title="Tool Success Rates"
            subtitle="Success and failure breakdown per tool"
            loading={successRates.isLoading}
            empty={!successRates.data || successRates.data.length === 0}
          >
            <DataTable<SuccessRateRow>
              columns={successColumns}
              data={successRateRows}
              loading={successRates.isLoading}
              emptyMessage="No tool success rate data available."
            />
          </ChartCard>

          {/* Tool Chains Table */}
          <ChartCard
            title="Tool Chain Patterns"
            subtitle="Frequently occurring sequential tool call patterns"
            loading={toolChains.isLoading}
            empty={!toolChains.data || toolChains.data.length === 0}
            emptyMessage="No recurring tool chain patterns found."
          >
            <DataTable<ToolChain>
              columns={chainColumns}
              data={toolChainRows}
              loading={toolChains.isLoading}
              emptyMessage="No recurring tool chain patterns found."
            />
          </ChartCard>
        </div>
      </section>

      {/* ── NEW-002: Tool Failure-Rate Trend ─────────────────────── */}
      <section className="space-y-[var(--space-3)] pt-[var(--space-4)] border-t border-[var(--border-subtle)]">
        <SectionHeader
          title="Failure Trend"
          subtitle="Tool failure rate over time, split built-in vs MCP"
        />
        <ChartCard
          title="Tool Failure Rate Over Time"
          subtitle="failures / evaluated calls per day — a rising line is an early warning of a degraded MCP server or broken workflow"
          loading={failureTrend.isLoading}
          empty={failureTrendData.length === 0}
          emptyMessage="No tool calls with a known result in the selected period."
        >
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={failureTrendData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="date" {...X_AXIS_PROPS} interval="preserveStartEnd" />
              <YAxis
                {...Y_AXIS_PROPS}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => `${v.toFixed(1)}%`}
                    labelFormatter={(l) => l}
                  />
                }
              />
              <Legend
                wrapperStyle={{ color: "var(--text-secondary)", fontSize: 13 }}
              />
              <Line
                type="monotone"
                dataKey="overall"
                name="Overall"
                stroke={CHART_COLORS[0]}
                strokeWidth={2.5}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="builtin"
                name="Built-in"
                stroke={CHART_COLORS[1]}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="mcp"
                name="MCP"
                stroke={CHART_COLORS[6]}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </section>

      {/* ── NEW-003: Tool-Failure Chains (Rework Signal) ─────────── */}
      <section className="space-y-[var(--space-3)] pt-[var(--space-4)] border-t border-[var(--border-subtle)]">
        <SectionHeader
          title="Tool-Failure Chains"
          subtitle="Consecutive failed tool calls within a session — the closest proxy for the agent getting stuck and thrashing"
        />
        <ChartCard
          title="Sessions with Tool-Failure Chains"
          subtitle={
            failureChainSummary
              ? `${failureChainSummary.sessionsWithChains2Plus.toLocaleString()} of ${failureChainSummary.sessionsWithToolCalls.toLocaleString()} sessions had a 2+ failure chain · ` +
                `${failureChainSummary.sessionsWithChains3Plus.toLocaleString()} (${formatPercent(failureChainSummary.chainRate3Plus)}) had a 3+ chain · ` +
                `worst streak: ${failureChainSummary.worstStreak}`
              : "Maximal runs of consecutive success=FALSE tool calls, ordered within each session"
          }
          loading={failureChains.isLoading}
          empty={failureChainRows.length === 0}
          emptyMessage="No session had 2 or more consecutive tool failures — tool execution is running smoothly."
        >
          <DataTable<SessionFailureChain>
            columns={failureChainColumns}
            data={failureChainRows}
            loading={failureChains.isLoading}
            emptyMessage="No session had 2 or more consecutive tool failures."
          />
        </ChartCard>
      </section>

      {/* ── Tool Flow Sankey Diagram ─────────────────────────────── */}
      {toolChains.data && toolChains.data.length > 0 && (
        <section className="space-y-[var(--space-3)]">
          <SectionHeader
            title="Tool Flow"
            subtitle="Visual diagram of tool call sequences"
          />
          <ChartCard
            title="Tool Flow Patterns"
            subtitle="Sankey diagram of tool call sequences"
            loading={toolChains.isLoading}
            empty={!toolChains.data || toolChains.data.length === 0}
          >
            <ToolChainSankey data={toolChains.data} />
          </ChartCard>
        </section>
      )}
    </div>
    </ErrorBoundary>
  );
}
