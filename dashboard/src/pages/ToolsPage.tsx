import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
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
import { useToolUsage, useToolSuccessRates, useToolChains } from "@/hooks/useToolData";
import { formatDuration } from "@/lib/formatters";
import type { ToolChain } from "@/lib/types";
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
  successRate: number;
  avgDurationMs: number;
  successCount: number;
}

export default function ToolsPage() {
  const toolUsage = useToolUsage();
  const successRates = useToolSuccessRates();
  const toolChains = useToolChains(2);

  // KPI computations
  const totalToolCalls = useMemo(() => {
    if (!toolUsage.data) return 0;
    return toolUsage.data.reduce((sum, t) => sum + t.callCount, 0);
  }, [toolUsage.data]);

  const uniqueTools = useMemo(() => {
    if (!toolUsage.data) return 0;
    return toolUsage.data.length;
  }, [toolUsage.data]);

  const avgSuccessRate = useMemo(() => {
    if (!successRates.data || successRates.data.length === 0) return 0;
    const totalCalls = successRates.data.reduce((s, t) => s + t.totalCalls, 0);
    const totalSuccess = successRates.data.reduce((s, t) => s + t.successCount, 0);
    return totalCalls > 0 ? totalSuccess / totalCalls : 0;
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

  // Success rate table data
  const successRateRows: SuccessRateRow[] = useMemo(() => {
    if (!successRates.data) return [];
    return successRates.data.map((t) => ({
      toolName: t.toolName,
      totalCalls: t.totalCalls,
      successRate: t.successRate,
      avgDurationMs: t.avgDurationMs,
      successCount: t.successCount,
    }));
  }, [successRates.data]);

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
        render: (row) => (
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
      key: "successRate",
      header: "Rate",
      align: "right" as const,
      render: (row) => {
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
      render: (row) => (
        <span className="tabular-nums text-[var(--text-secondary)]">
          {formatDuration(row.avgDurationMs / 1000)}
        </span>
      ),
    },
  ], []);

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
        <div className="grid grid-cols-1 gap-[var(--space-5)] sm:grid-cols-3">
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
            label="Avg Success Rate"
            value={`${(avgSuccessRate * 100).toFixed(1)}%`}
            type="cache"
            loading={successRates.isLoading}
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
              margin={{ left: 140 }}
            >
              <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
              <XAxis type="number" {...X_AXIS_PROPS} />
              <YAxis
                type="category"
                dataKey="name"
                {...Y_AXIS_PROPS}
                width={130}
                tick={{ fill: AXIS_TICK_FILL, fontSize: 11 }}
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
      <section className="space-y-[var(--space-3)]">
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
