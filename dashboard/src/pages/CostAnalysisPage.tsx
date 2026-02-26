import { useMemo } from "react";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
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
import DataTable from "@/components/ui/DataTable";
import type { Column } from "@/components/ui/DataTable";
import { formatCost, formatDate } from "@/lib/formatters";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";

/* ── Model table row type ────────────────────────────────────── */
interface ModelTableRow {
  model: string;
  fullModel: string;
  sessions: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheCost: number;
}

/* ── Pivot daily-by-model rows into one row per date ────────── */
function pivotDailyByModel(
  rows: Array<{ date: string; model: string; totalCost: number }>,
): { data: Array<Record<string, unknown>>; models: string[] } {
  const modelSet = new Set<string>();
  const dateMap = new Map<string, Record<string, unknown>>();

  for (const r of rows) {
    const shortModel = r.model.split("/").pop() ?? r.model;
    modelSet.add(shortModel);
    const existing = dateMap.get(r.date) ?? { date: r.date };
    existing[shortModel] =
      ((existing[shortModel] as number) ?? 0) + r.totalCost;
    dateMap.set(r.date, existing);
  }

  const data = Array.from(dateMap.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );

  return { data, models: Array.from(modelSet) };
}

/* ── Custom legend for the cost trend chart ─────────────────── */
function CostTrendLegend({
  models,
}: {
  models: string[];
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-2">
      {models.map((model, i) => (
        <div key={model} className="flex items-center gap-[var(--space-2)]">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
          />
          <span className="text-caption text-[var(--text-secondary)]">
            {model}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Donut center label ─────────────────────────────────────── */
function DonutCenter({ total }: { total: number }) {
  return (
    <text
      x="50%"
      y="50%"
      textAnchor="middle"
      dominantBaseline="central"
      className="fill-[var(--text-primary)]"
    >
      <tspan
        x="50%"
        dy="-0.4em"
        fontSize={22}
        fontWeight={600}
      >
        {formatCost(total)}
      </tspan>
      <tspan
        x="50%"
        dy="1.6em"
        fontSize={11}
        className="fill-[var(--text-tertiary)]"
      >
        total
      </tspan>
    </text>
  );
}

/* ════════════════════════════════════════════════════════════════
   Main Page
   ════════════════════════════════════════════════════════════════ */
export default function CostAnalysisPage() {
  const costTotal = useCostTotal();
  const costDaily = useCostDaily();
  const costByModel = useCostByModel();
  const costByProject = useCostByProject();

  const isLoading = costTotal.isLoading;

  /* ── KPI computations ──────────────────────────────────────── */
  const totalCost = costTotal.data?.totalCostUSD ?? 0;

  const cacheSavings = useMemo(() => {
    if (!costTotal.data) return 0;
    return costTotal.data.cacheReadCostUSD;
  }, [costTotal.data]);

  const avgDailyCost = useMemo(() => {
    if (!costDaily.data || costDaily.data.length === 0) return 0;
    const dates = new Set(costDaily.data.map((d) => d.date));
    const totalDailyCost = costDaily.data.reduce((s, d) => s + d.totalCost, 0);
    return dates.size > 0 ? totalDailyCost / dates.size : 0;
  }, [costDaily.data]);

  const topModelCost = useMemo(() => {
    if (!costByModel.data || costByModel.data.length === 0)
      return { model: "--", cost: 0, pct: 0 };
    const top = costByModel.data[0]!;
    const allCosts = costByModel.data.reduce((s, m) => s + m.totalCostUSD, 0);
    return {
      model: top.model.split("/").pop() ?? top.model,
      cost: top.totalCostUSD,
      pct: allCosts > 0 ? (top.totalCostUSD / allCosts) * 100 : 0,
    };
  }, [costByModel.data]);

  /* ── Stacked area chart data ───────────────────────────────── */
  const { data: stackedData, models } = useMemo(() => {
    if (!costDaily.data) return { data: [], models: [] };
    return pivotDailyByModel(costDaily.data);
  }, [costDaily.data]);

  const formattedStackedData = useMemo(
    () =>
      stackedData.map((d) => ({
        ...d,
        date: formatDate(d.date as string),
      })),
    [stackedData],
  );

  /* ── Model donut chart data ────────────────────────────────── */
  const donutData = useMemo(() => {
    if (!costByModel.data) return [];
    const allCosts = costByModel.data.reduce((s, m) => s + m.totalCostUSD, 0);
    return costByModel.data.map((m) => ({
      name: m.model.split("/").pop() ?? m.model,
      value: m.totalCostUSD,
      pct: allCosts > 0 ? (m.totalCostUSD / allCosts) * 100 : 0,
    }));
  }, [costByModel.data]);

  const donutTotal = useMemo(
    () => donutData.reduce((s, d) => s + d.value, 0),
    [donutData],
  );

  /* ── Model comparison table ────────────────────────────────── */
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

  const maxModelCost = useMemo(
    () => Math.max(...modelTableData.map((m) => m.totalCost), 0.01),
    [modelTableData],
  );

  /* ── Model comparison table columns ──────────────────────── */
  const modelColumns: Column<ModelTableRow>[] = useMemo(
    () => [
      {
        key: "model",
        header: "Model",
        render: (row) => (
          <span className="whitespace-nowrap font-medium text-[var(--text-primary)]">
            {row.model}
          </span>
        ),
      },
      {
        key: "sessions",
        header: "Sessions",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.sessions.toLocaleString()}
          </span>
        ),
      },
      {
        key: "inputCost",
        header: "Input",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-tertiary)]">
            {formatCost(row.inputCost)}
          </span>
        ),
      },
      {
        key: "outputCost",
        header: "Output",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-tertiary)]">
            {formatCost(row.outputCost)}
          </span>
        ),
      },
      {
        key: "totalCost",
        header: "Total",
        align: "right" as const,
        render: (row) => (
          <span className="whitespace-nowrap font-semibold tabular-nums text-[var(--text-primary)]">
            {formatCost(row.totalCost)}
          </span>
        ),
      },
      {
        key: "share",
        header: "Share",
        width: "7rem",
        render: (row) => (
          <div className="h-2 rounded-full bg-[var(--bg-hover)]">
            <div
              className="h-2 rounded-full transition-all duration-[var(--duration-slow)]"
              style={{
                width: `${(row.totalCost / maxModelCost) * 100}%`,
                backgroundColor: CHART_COLORS[0],
                minWidth: row.totalCost > 0 ? "4px" : "0px",
              }}
            />
          </div>
        ),
      },
    ],
    [maxModelCost],
  );

  /* ── Cost by project (horizontal bar, top 10) ─────────────── */
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

  /* ════════════════════════════════════════════════════════════
     Render
     ════════════════════════════════════════════════════════════ */
  return (
    <ErrorBoundary>
    <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">
      {/* ── KPI Cards ──────────────────────────────────────────── */}
      <section>
        <div className="mb-[var(--space-5)]">
          <SectionHeader
            title="Cost Overview"
            subtitle="Aggregate spending metrics for the selected period"
          />
        </div>
        <div className="grid grid-cols-1 gap-[var(--space-5)] sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Total Cost"
          value={formatCost(totalCost)}
          type="cost"
          variant="accent"
          loading={isLoading}
        />
        <KPICard
          label="Daily Average"
          value={formatCost(avgDailyCost)}
          type="cost"
          loading={costDaily.isLoading}
          trend={
            avgDailyCost > 0
              ? { value: 0, label: "per day" }
              : undefined
          }
        />
        <KPICard
          label="Top Model"
          value={formatCost(topModelCost.cost)}
          type="tokens"
          loading={costByModel.isLoading}
          trend={
            topModelCost.model !== "--"
              ? {
                  value: topModelCost.pct,
                  label: topModelCost.model,
                }
              : undefined
          }
        />
        <KPICard
          label="Cache Read Cost"
          value={formatCost(cacheSavings)}
          type="cache"
          variant="success"
          loading={isLoading}
        />
        </div>
      </section>

      {/* ── Cost Trend ─────────────────────────────────────────── */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Cost Trend"
          subtitle="Daily spending breakdown by model"
        />
        <ChartCard
          title="Daily Cost by Model"
          subtitle="Stacked area showing spend distribution over time"
          loading={costDaily.isLoading}
          empty={formattedStackedData.length === 0}
        >
          <ResponsiveContainer width="100%" height={360}>
            <AreaChart
              data={formattedStackedData}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                {models.map((model, i) => {
                  const color =
                    CHART_COLORS[i % CHART_COLORS.length];
                  return (
                    <linearGradient
                      key={model}
                      id={`gradient-${i}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor={color}
                        stopOpacity={0.4}
                      />
                      <stop
                        offset="100%"
                        stopColor={color}
                        stopOpacity={0.05}
                      />
                    </linearGradient>
                  );
                })}
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
              {models.map((model, i) => (
                <Area
                  key={model}
                  type="monotone"
                  dataKey={model}
                  name={model}
                  stackId="cost"
                  stroke={CHART_COLORS[i % CHART_COLORS.length]}
                  strokeWidth={1.5}
                  fill={`url(#gradient-${i})`}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          <CostTrendLegend models={models} />
        </ChartCard>
      </section>

      {/* ── Model Breakdown ────────────────────────────────────── */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Model Breakdown"
          subtitle="Cost distribution and comparison across models"
        />
        <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-5">
          {/* Donut chart */}
          <ChartCard
            title="Cost Distribution"
            subtitle="Share of total spend"
            loading={costByModel.isLoading}
            empty={donutData.length === 0}
            className="lg:col-span-2"
          >
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={donutData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="80%"
                  paddingAngle={2}
                  strokeWidth={0}
                >
                  {donutData.map((_entry, i) => (
                    <Cell
                      key={i}
                      fill={CHART_COLORS[i % CHART_COLORS.length]}
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
                <DonutCenter total={donutTotal} />
              </PieChart>
            </ResponsiveContainer>
            {/* Legend underneath donut */}
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 pt-1">
              {donutData.map((d, i) => (
                <div
                  key={d.name}
                  className="flex items-center gap-[var(--space-2)]"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      backgroundColor:
                        CHART_COLORS[i % CHART_COLORS.length],
                    }}
                  />
                  <span className="text-caption text-[var(--text-secondary)]">
                    {d.name}
                  </span>
                  <span className="text-caption font-semibold text-[var(--text-tertiary)]">
                    {d.pct.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </ChartCard>

          {/* Model comparison table */}
          <ChartCard
            title="Model Comparison"
            subtitle="Cost and usage per model"
            loading={costByModel.isLoading}
            empty={modelTableData.length === 0}
            className="lg:col-span-3"
          >
            <DataTable<ModelTableRow>
              columns={modelColumns}
              data={modelTableData}
              loading={costByModel.isLoading}
              emptyMessage="No model cost data available."
            />
          </ChartCard>
        </div>
      </section>

      {/* ── Project Breakdown ──────────────────────────────────── */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Project Breakdown"
          subtitle="Top projects ranked by total spend"
        />
        <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-2">
          <ChartCard
            title="Cost by Project"
            subtitle="Top 10 projects by total spend"
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
                margin={{ left: 120, right: 16 }}
              >
                <CartesianGrid
                  {...GRID_PROPS}
                  horizontal={false}
                  vertical
                />
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
                  tick={{ fill: AXIS_TICK_FILL, fontSize: 11 }}
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
                  fill={CHART_COLORS[2]}
                  radius={[0, 4, 4, 0]}
                  maxBarSize={24}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Treemap */}
          <ChartCard
            title="Project Cost Map"
            subtitle="Hierarchical cost breakdown"
            loading={costByProject.isLoading}
            empty={!costByProject.data || costByProject.data.length === 0}
          >
            <CostTreemap data={costByProject.data} />
          </ChartCard>
        </div>
      </section>

      {/* ── Token Flow ─────────────────────────────────────────── */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Token Flow"
          subtitle="How tokens flow through the system from input to output"
        />
        <ChartCard
          title="Token Flow Diagram"
          subtitle="Sankey visualization of token routing"
          loading={costTotal.isLoading}
          empty={!costTotal.data}
        >
          <TokenFlowSankey data={costTotal.data} />
        </ChartCard>
      </section>
    </div>
    </ErrorBoundary>
  );
}
