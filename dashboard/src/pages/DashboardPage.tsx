import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import { useCostTotal, useCostTrend, useCostByModel } from "@/hooks/useCostData";
import { useSessionStats } from "@/hooks/useSessionsQuery";
import { useCacheMetrics } from "@/hooks/useCacheData";
import { useToolUsage } from "@/hooks/useToolData";
import { formatCost, formatPercent, formatDate } from "@/lib/formatters";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";

export default function DashboardPage() {
  const costTotal = useCostTotal();
  const sessionStats = useSessionStats();
  const cacheMetrics = useCacheMetrics();
  const costTrend = useCostTrend("day");
  const costByModel = useCostByModel();
  const toolUsage = useToolUsage();

  const isLoading =
    costTotal.isLoading ||
    sessionStats.isLoading ||
    cacheMetrics.isLoading;

  // Prepare cost trend data for the area chart
  const trendData = useMemo(() => {
    if (!costTrend.data) return [];
    return costTrend.data.map((d) => ({
      date: formatDate(d.timestamp),
      cost: d.costUSD,
    }));
  }, [costTrend.data]);

  // Prepare pie chart data for cost by model
  const modelPieData = useMemo(() => {
    if (!costByModel.data) return [];
    return costByModel.data.map((d) => ({
      name: d.model.split("/").pop() ?? d.model,
      value: d.totalCostUSD,
      fullName: d.model,
    }));
  }, [costByModel.data]);

  // Top 10 tools by call count (horizontal bar)
  const topToolsData = useMemo(() => {
    if (!toolUsage.data) return [];
    return toolUsage.data
      .slice(0, 10)
      .map((d) => ({
        name: d.toolName,
        calls: d.callCount,
      }))
      .reverse(); // reverse so highest appears at top of horizontal bar
  }, [toolUsage.data]);

  // Calculate tool call total from tool usage data
  const totalToolCalls = useMemo(() => {
    if (!toolUsage.data) return 0;
    return toolUsage.data.reduce((sum, t) => sum + t.callCount, 0);
  }, [toolUsage.data]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto space-y-8">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Total Cost"
          value={costTotal.data ? formatCost(costTotal.data.totalCostUSD) : "--"}
          type="cost"
          loading={isLoading}
        />
        <KPICard
          label="Cache Hit Rate"
          value={
            cacheMetrics.data
              ? formatPercent(cacheMetrics.data.cacheHitRate)
              : "--"
          }
          type="cache"
          loading={isLoading}
        />
        <KPICard
          label="Total Sessions"
          value={
            sessionStats.data
              ? sessionStats.data.totalSessions.toLocaleString()
              : "--"
          }
          type="sessions"
          loading={isLoading}
        />
        <KPICard
          label="Tool Calls"
          value={totalToolCalls > 0 ? totalToolCalls.toLocaleString() : "--"}
          type="tools"
          loading={isLoading || toolUsage.isLoading}
        />
      </div>

      {/* Charts Row 1: Cost trend + Cost by model */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Cost Trend Area Chart - takes 2/3 width */}
        <ChartCard
          title="Cost Over Time"
          subtitle="Daily cost trend"
          loading={costTrend.isLoading}
          empty={trendData.length === 0}
          className="lg:col-span-2"
        >
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={trendData}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="date" {...X_AXIS_PROPS} />
              <YAxis
                {...Y_AXIS_PROPS}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => formatCost(v)}
                    labelFormatter={(l) => l}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="cost"
                name="Cost"
                stroke={CHART_COLORS[0]}
                strokeWidth={2}
                fill="url(#costGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Cost by Model Donut Chart - takes 1/3 width */}
        <ChartCard
          title="Cost by Model"
          subtitle="Spending distribution"
          loading={costByModel.isLoading}
          empty={modelPieData.length === 0}
        >
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={modelPieData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                dataKey="value"
                nameKey="name"
              >
                {modelPieData.map((_, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => formatCost(v)}
                  />
                }
              />
            </PieChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            {modelPieData.map((entry, i) => (
              <div key={entry.name} className="flex items-center gap-1.5 text-xs">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                  }}
                />
                <span style={{ color: "var(--text-secondary)" }}>{entry.name}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      {/* Charts Row 2: Top Tools horizontal bar */}
      <ChartCard
        title="Top 10 Tools by Usage"
        subtitle="Most frequently invoked tools"
        loading={toolUsage.isLoading}
        empty={topToolsData.length === 0}
      >
        <ResponsiveContainer width="100%" height={Math.max(300, topToolsData.length * 36)}>
          <BarChart data={topToolsData} layout="vertical" margin={{ left: 120 }}>
            <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
            <XAxis type="number" {...X_AXIS_PROPS} />
            <YAxis
              type="category"
              dataKey="name"
              {...Y_AXIS_PROPS}
              width={110}
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
              maxBarSize={24}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
