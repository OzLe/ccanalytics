import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Line,
  ComposedChart,
} from "recharts";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import CostTreemap from "@/components/charts/CostTreemap";
import TokenFlowSankey from "@/components/charts/TokenFlowSankey";
import {
  useCostTotal,
  useCostDaily,
  useCostByModel,
  useCostByProject,
} from "@/hooks/useCostData";
import { formatCost, formatDate } from "@/lib/formatters";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
} from "@/lib/chartTheme";

/**
 * Pivots the flat daily-by-model rows into one row per date
 * with each model as a separate key, suitable for a StackedBarChart.
 */
function pivotDailyByModel(
  rows: Array<{ date: string; model: string; totalCost: number }>,
): { data: Array<Record<string, unknown>>; models: string[] } {
  const modelSet = new Set<string>();
  const dateMap = new Map<string, Record<string, unknown>>();

  for (const r of rows) {
    const shortModel = r.model.split("/").pop() ?? r.model;
    modelSet.add(shortModel);
    const existing = dateMap.get(r.date) ?? { date: r.date };
    existing[shortModel] = ((existing[shortModel] as number) ?? 0) + r.totalCost;
    dateMap.set(r.date, existing);
  }

  // Sort by date ascending
  const data = Array.from(dateMap.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );

  return { data, models: Array.from(modelSet) };
}

export default function CostAnalysisPage() {
  const costTotal = useCostTotal();
  const costDaily = useCostDaily();
  const costByModel = useCostByModel();
  const costByProject = useCostByProject();

  const isLoading = costTotal.isLoading;

  // KPI values
  const totalCost = costTotal.data?.totalCostUSD ?? 0;

  // Compute avg daily cost from daily data
  const avgDailyCost = useMemo(() => {
    if (!costDaily.data || costDaily.data.length === 0) return 0;
    // Get unique dates
    const dates = new Set(costDaily.data.map((d) => d.date));
    const totalDailyCost = costDaily.data.reduce((s, d) => s + d.totalCost, 0);
    return dates.size > 0 ? totalDailyCost / dates.size : 0;
  }, [costDaily.data]);

  // Top model by cost
  const topModelCost = useMemo(() => {
    if (!costByModel.data || costByModel.data.length === 0)
      return { model: "--", cost: 0 };
    const top = costByModel.data[0]!;
    return {
      model: (top.model.split("/").pop() ?? top.model),
      cost: top.totalCostUSD,
    };
  }, [costByModel.data]);

  // Pivoted daily stacked bar data
  const { data: stackedData, models } = useMemo(() => {
    if (!costDaily.data) return { data: [], models: [] };
    return pivotDailyByModel(costDaily.data);
  }, [costDaily.data]);

  // Format dates for the stacked chart
  const formattedStackedData = useMemo(
    () =>
      stackedData.map((d) => ({
        ...d,
        date: formatDate(d.date as string),
      })),
    [stackedData],
  );

  // Cost by project (horizontal bar, top 10)
  const projectData = useMemo(() => {
    if (!costByProject.data) return [];
    return costByProject.data
      .slice(0, 10)
      .map((p) => ({
        name: p.projectPath.split("/").pop() ?? p.projectPath,
        cost: p.totalCostUSD,
        sessions: p.sessionCount,
        fullPath: p.projectPath,
      }))
      .reverse();
  }, [costByProject.data]);

  // Model comparison table data
  const modelTableData = useMemo(() => {
    if (!costByModel.data) return [];
    return costByModel.data.map((m) => ({
      model: m.model.split("/").pop() ?? m.model,
      fullModel: m.model,
      sessions: m.sessionCount,
      totalCost: m.totalCostUSD,
      inputCost: m.inputCostUSD,
      outputCost: m.outputCostUSD,
      cacheCost: m.cacheReadCostUSD + m.cacheWriteCostUSD,
    }));
  }, [costByModel.data]);

  // Max cost for sparkline scaling
  const maxModelCost = useMemo(
    () => Math.max(...modelTableData.map((m) => m.totalCost), 0.01),
    [modelTableData],
  );

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KPICard
          label="Total Cost"
          value={formatCost(totalCost)}
          type="cost"
          loading={isLoading}
        />
        <KPICard
          label="Avg Daily Cost"
          value={formatCost(avgDailyCost)}
          type="cost"
          loading={costDaily.isLoading}
        />
        <KPICard
          label="Top Model Cost"
          value={`${formatCost(topModelCost.cost)}`}
          type="cost"
          loading={costByModel.isLoading}
          trend={
            topModelCost.model !== "--"
              ? { value: 0, label: topModelCost.model }
              : undefined
          }
        />
      </div>

      {/* Daily Cost by Model - Stacked Bar */}
      <ChartCard
        title="Daily Cost by Model"
        subtitle="Stacked daily spending breakdown"
        loading={costDaily.isLoading}
        empty={formattedStackedData.length === 0}
      >
        <ResponsiveContainer width="100%" height={350}>
          <ComposedChart data={formattedStackedData}>
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
            <Legend
              wrapperStyle={{ color: "#94a3b8", fontSize: 12 }}
            />
            {models.map((model, i) => (
              <Bar
                key={model}
                dataKey={model}
                name={model}
                stackId="cost"
                fill={CHART_COLORS[i % CHART_COLORS.length]}
                maxBarSize={40}
              />
            ))}
            {/* Trend line showing total per day */}
            <Line
              type="monotone"
              dataKey={(row: Record<string, unknown>) => {
                let sum = 0;
                for (const m of models) {
                  sum += (row[m] as number) ?? 0;
                }
                return sum;
              }}
              name="Total"
              stroke="#e2e8f0"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              legendType="none"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost by Project - Horizontal Bar */}
        <ChartCard
          title="Cost by Project"
          subtitle="Top projects by total spend"
          loading={costByProject.isLoading}
          empty={projectData.length === 0}
        >
          <ResponsiveContainer
            width="100%"
            height={Math.max(280, projectData.length * 36)}
          >
            <BarChart
              data={projectData}
              layout="vertical"
              margin={{ left: 120 }}
            >
              <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
              <XAxis
                type="number"
                {...X_AXIS_PROPS}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <YAxis
                type="category"
                dataKey="name"
                {...Y_AXIS_PROPS}
                width={110}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => formatCost(v)}
                  />
                }
              />
              <Bar
                dataKey="cost"
                name="Cost"
                fill="#ec4899"
                radius={[0, 4, 4, 0]}
                maxBarSize={24}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Model Comparison Table with Bar Indicators */}
        <ChartCard
          title="Model Comparison"
          subtitle="Cost and usage per model"
          loading={costByModel.isLoading}
          empty={modelTableData.length === 0}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr
                  className="border-b text-xs uppercase tracking-wider"
                  style={{
                    borderColor: "var(--border)",
                    color: "var(--text-muted)",
                  }}
                >
                  <th className="py-2 pr-4 whitespace-nowrap">Model</th>
                  <th className="py-2 pr-4 text-right whitespace-nowrap">Sessions</th>
                  <th className="py-2 pr-6 text-right whitespace-nowrap">Cost</th>
                  <th className="py-2 pl-4 w-24 whitespace-nowrap">Dist.</th>
                </tr>
              </thead>
              <tbody>
                {modelTableData.map((row) => (
                  <tr
                    key={row.fullModel}
                    className="border-b"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <td
                      className="py-2.5 pr-4 font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {row.model}
                    </td>
                    <td
                      className="py-2.5 pr-4 text-right tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {row.sessions.toLocaleString()}
                    </td>
                    <td
                      className="py-2.5 pr-4 text-right font-semibold tabular-nums"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {formatCost(row.totalCost)}
                    </td>
                    <td className="py-2.5 pl-3">
                      <div
                        className="h-2 rounded-full"
                        style={{ backgroundColor: "var(--bg-hover)" }}
                      >
                        <div
                          className="h-2 rounded-full"
                          style={{
                            width: `${(row.totalCost / maxModelCost) * 100}%`,
                            backgroundColor: "#6366f1",
                            minWidth: row.totalCost > 0 ? "4px" : "0px",
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      {/* Cost Treemap */}
      <ChartCard
        title="Cost by Project"
        subtitle="Hierarchical cost breakdown"
        loading={costByProject.isLoading}
        empty={!costByProject.data || costByProject.data.length === 0}
      >
        <CostTreemap data={costByProject.data} />
      </ChartCard>

      {/* Token Flow Sankey */}
      <ChartCard
        title="Token Flow"
        subtitle="How tokens flow through the system"
        loading={costTotal.isLoading}
        empty={!costTotal.data}
      >
        <TokenFlowSankey data={costTotal.data} />
      </ChartCard>
    </div>
  );
}
