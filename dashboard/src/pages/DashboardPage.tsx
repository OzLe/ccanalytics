import { useMemo } from "react";
import { Link } from "react-router-dom";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
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
import {
  DollarSign,
  Database,
  Zap,
  Lightbulb,
} from "lucide-react";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import InsightCard from "@/components/ui/InsightCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import { useCostTotal, useCostTrend, useCostByModel } from "@/hooks/useCostData";
import { useSessionStats } from "@/hooks/useSessionsQuery";
import { useCacheMetrics } from "@/hooks/useCacheData";
import { useToolUsage } from "@/hooks/useToolData";
import { useActivityHourly } from "@/hooks/useActivityData";
import { formatCost, formatPercent, formatDate } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

function formatHour(hour: number): string {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/**
 * Compute a simple trend percentage from an array of daily cost values.
 * Compares the last half to the first half of the data.
 */
function computeTrendPercent(data: { costUSD: number }[]): number | null {
  if (!data || data.length < 4) return null;
  const mid = Math.floor(data.length / 2);
  const firstHalf = data.slice(0, mid);
  const secondHalf = data.slice(mid);
  const avgFirst = firstHalf.reduce((s, d) => s + d.costUSD, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, d) => s + d.costUSD, 0) / secondHalf.length;
  if (avgFirst === 0) return null;
  return ((avgSecond - avgFirst) / avgFirst) * 100;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Dashboard Page                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

export default function DashboardPage() {
  /* ── Data hooks ────────────────────────────────────────────── */
  const costTotal = useCostTotal();
  const sessionStats = useSessionStats();
  const cacheMetrics = useCacheMetrics();
  const costTrend = useCostTrend("day");
  const costByModel = useCostByModel();
  const toolUsage = useToolUsage();
  const activityHourly = useActivityHourly();

  const isLoading =
    costTotal.isLoading || sessionStats.isLoading || cacheMetrics.isLoading;

  /* ── Cost trend chart data ─────────────────────────────────── */
  const trendData = useMemo(() => {
    if (!costTrend.data) return [];
    return costTrend.data.map((d) => ({
      date: formatDate(d.timestamp),
      cost: d.costUSD,
    }));
  }, [costTrend.data]);

  /* ── Cost trend percentage ─────────────────────────────────── */
  const costTrendPercent = useMemo(() => {
    if (!costTrend.data) return null;
    return computeTrendPercent(costTrend.data);
  }, [costTrend.data]);

  /* ── Cost by model pie data ────────────────────────────────── */
  const modelPieData = useMemo(() => {
    if (!costByModel.data) return [];
    return costByModel.data.map((d) => ({
      name: d.model.split("/").pop() ?? d.model,
      value: d.totalCostUSD,
      fullName: d.model,
    }));
  }, [costByModel.data]);

  /* ── Top 10 tools bar data ─────────────────────────────────── */
  const topToolsData = useMemo(() => {
    if (!toolUsage.data) return [];
    return toolUsage.data
      .slice(0, 10)
      .map((d) => ({
        name: d.toolName,
        calls: d.callCount,
      }))
      .reverse();
  }, [toolUsage.data]);

  /* ── Total tool calls ──────────────────────────────────────── */
  const totalToolCalls = useMemo(() => {
    if (!toolUsage.data) return 0;
    return toolUsage.data.reduce((sum, t) => sum + t.callCount, 0);
  }, [toolUsage.data]);

  /* ── Activity hourly chart data ────────────────────────────── */
  const hourlyChartData = useMemo(() => {
    if (!activityHourly.data) return [];
    return activityHourly.data.map((d) => ({
      hour: formatHour(d.hourOfDay),
      messages: d.messageCount,
      sessions: d.sessionCount,
    }));
  }, [activityHourly.data]);

  /* ── Peak activity insight ─────────────────────────────────── */
  const peakActivity = useMemo(() => {
    if (!activityHourly.data || activityHourly.data.length === 0) return null;
    const peak = activityHourly.data.reduce((max, d) =>
      d.messageCount > max.messageCount ? d : max
    );
    return {
      hour: formatHour(peak.hourOfDay),
      messages: peak.messageCount,
    };
  }, [activityHourly.data]);

  /* ── Most expensive model insight ──────────────────────────── */
  const mostExpensiveModel = useMemo(() => {
    if (!costByModel.data || costByModel.data.length === 0) return null;
    const top = costByModel.data.reduce((max, d) =>
      d.totalCostUSD > max.totalCostUSD ? d : max
    );
    const totalCost = costByModel.data.reduce((s, d) => s + d.totalCostUSD, 0);
    const pct = totalCost > 0 ? (top.totalCostUSD / totalCost) * 100 : 0;
    return {
      model: top.model.split("/").pop() ?? top.model,
      cost: top.totalCostUSD,
      pct,
    };
  }, [costByModel.data]);

  /* ── Cache interpretation ──────────────────────────────────── */
  const cacheInterpretation = useMemo(() => {
    if (!cacheMetrics.data) return null;
    const { interpretation, cacheHitRate, estimatedSavingsUSD } = cacheMetrics.data;
    const badgeVariant: "success" | "warning" | "danger" =
      interpretation === "effective" ? "success" :
      interpretation === "moderate" ? "warning" : "danger";
    return {
      interpretation,
      badgeVariant,
      hitRate: cacheHitRate,
      savings: estimatedSavingsUSD,
    };
  }, [cacheMetrics.data]);

  /* ── Session trend (simple, computed from stats vs cost) ──── */
  const sessionTrend = useMemo(() => {
    // We don't have historical session counts from the API, so we skip trend for sessions
    return undefined;
  }, []);

  return (
    <ErrorBoundary>
    <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">

      {/* ================================================================ */}
      {/*  KPI Cards                                                       */}
      {/* ================================================================ */}
      <section>
        <div className="mb-[var(--space-5)]">
          <SectionHeader
            title="Overview"
            subtitle="Key metrics for the selected period"
          />
        </div>
        <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-4">
          {[
            <KPICard
              key="total-cost"
              label="Total Cost"
              value={costTotal.data ? formatCost(costTotal.data.totalCostUSD) : "--"}
              type="cost"
              variant="default"
              trend={
                costTrendPercent !== null
                  ? { value: costTrendPercent, label: "vs prior" }
                  : undefined
              }
              loading={isLoading}
            />,
            <KPICard
              key="total-sessions"
              label="Total Sessions"
              value={
                sessionStats.data
                  ? sessionStats.data.totalSessions.toLocaleString()
                  : "--"
              }
              type="sessions"
              variant="default"
              trend={sessionTrend}
              loading={isLoading}
            />,
            <KPICard
              key="cache-hit-rate"
              label="Cache Hit Rate"
              value={
                cacheMetrics.data
                  ? formatPercent(cacheMetrics.data.cacheHitRate)
                  : "--"
              }
              type="cache"
              variant={
                cacheInterpretation?.badgeVariant === "success" ? "success" :
                cacheInterpretation?.badgeVariant === "warning" ? "warning" : "default"
              }
              loading={isLoading}
            />,
            <KPICard
              key="tool-calls"
              label="Tool Calls"
              value={totalToolCalls > 0 ? totalToolCalls.toLocaleString() : "--"}
              type="tools"
              variant="default"
              loading={isLoading || toolUsage.isLoading}
            />,
          ].map((card, index) => (
            <div
              key={index}
              className="animate-fade-in"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              {card}
            </div>
          ))}
        </div>
      </section>

      {/* ================================================================ */}
      {/*  Charts Section                                                  */}
      {/* ================================================================ */}
      <section>
        <div className="mb-[var(--space-5)]">
          <SectionHeader
            title="Trends"
            subtitle="How your usage is changing over time"
          />
        </div>
        <div className="grid grid-cols-1 gap-[var(--space-6)] md:grid-cols-2">

          {/* ── Cost Trend Area Chart ──────────────────────────── */}
          <ChartCard
            title="Cost Over Time"
            subtitle="Daily spending trend"
            loading={costTrend.isLoading}
            empty={trendData.length === 0}
            action={
              <Link
                to="/cost"
                className="text-xs font-medium text-[var(--accent-hover)] transition-colors hover:text-[var(--text-primary)]"
              >
                View details
              </Link>
            }
          >
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trendData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="costAreaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={CHART_COLORS[0]} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="date" {...X_AXIS_PROPS} interval="preserveStartEnd" />
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
                  strokeWidth={2.5}
                  fill="url(#costAreaGradient)"
                  dot={false}
                  activeDot={{
                    r: 5,
                    strokeWidth: 2,
                    fill: CHART_COLORS[0],
                    stroke: "var(--bg-elevated)",
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* ── Cost by Model Donut Chart ─────────────────────── */}
          <ChartCard
            title="Cost by Model"
            subtitle="Spending distribution across models"
            loading={costByModel.isLoading}
            empty={modelPieData.length === 0}
            action={
              <Link
                to="/cost"
                className="text-xs font-medium text-[var(--accent-hover)] transition-colors hover:text-[var(--text-primary)]"
              >
                View details
              </Link>
            }
          >
            <div className="flex flex-col items-center md:flex-row md:items-center md:gap-[var(--space-4)]">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={modelPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                    nameKey="name"
                    strokeWidth={0}
                  >
                    {modelPieData.map((_, index) => (
                      <Cell
                        key={`model-cell-${index}`}
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
              <div className="mt-[var(--space-3)] flex shrink-0 flex-col gap-y-[var(--space-2)] md:mt-0">
                {modelPieData.map((entry, i) => (
                  <div key={entry.name} className="flex items-center gap-1.5 text-xs">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                      }}
                    />
                    <span className="text-[var(--text-secondary)]">{entry.name}</span>
                    <span className="font-medium text-[var(--text-primary)]">
                      {formatCost(entry.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </ChartCard>

          {/* ── Top Tools Horizontal Bar ──────────────────────── */}
          <ChartCard
            title="Top Tools by Usage"
            subtitle="Most frequently invoked tools"
            loading={toolUsage.isLoading}
            empty={topToolsData.length === 0}
            action={
              <Link
                to="/tools"
                className="text-xs font-medium text-[var(--accent-hover)] transition-colors hover:text-[var(--text-primary)]"
              >
                View all
              </Link>
            }
          >
            <ResponsiveContainer width="100%" height={Math.max(260, topToolsData.length * 30)}>
              <BarChart data={topToolsData} layout="vertical" margin={{ left: 10, right: 20, top: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
                <XAxis type="number" {...X_AXIS_PROPS} />
                <YAxis
                  type="category"
                  dataKey="name"
                  {...Y_AXIS_PROPS}
                  width={120}
                  tick={{ fill: AXIS_TICK_FILL, fontSize: 11 }}
                  tickFormatter={(v: string) => v.length > 18 ? `…${v.slice(-16)}` : v}
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
                  radius={[0, 6, 6, 0]}
                  maxBarSize={22}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* ── Activity Overview (hourly distribution) ────────── */}
          <ChartCard
            title="Activity Overview"
            subtitle="Message distribution by hour of day"
            loading={activityHourly.isLoading}
            empty={hourlyChartData.length === 0}
            action={
              <Link
                to="/activity"
                className="text-xs font-medium text-[var(--accent-hover)] transition-colors hover:text-[var(--text-primary)]"
              >
                View heatmap
              </Link>
            }
          >
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={hourlyChartData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="hour"
                  {...X_AXIS_PROPS}
                  interval={3}
                />
                <YAxis {...Y_AXIS_PROPS} />
                <Tooltip
                  content={
                    <ChartTooltip
                      valueFormatter={(v) => `${v.toLocaleString()}`}
                      labelFormatter={(l) => `Hour: ${l}`}
                    />
                  }
                />
                <Bar
                  dataKey="messages"
                  name="Messages"
                  fill={CHART_COLORS[5]}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={18}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </section>

      {/* ================================================================ */}
      {/*  Quick Insights                                                  */}
      {/* ================================================================ */}
      <section className="pb-[var(--space-4)]">
        <div className="mb-[var(--space-5)]">
          <SectionHeader
            title="Quick Insights"
            subtitle="Auto-generated observations from your data"
          />
        </div>
        <div className="grid grid-cols-1 gap-[var(--space-5)] lg:grid-cols-3">

          {/* Insight: Most expensive model */}
          {mostExpensiveModel && (
            <InsightCard
              icon={DollarSign}
              iconColor="text-[var(--accent)]"
              title={`Top spender: ${mostExpensiveModel.model}`}
              description={`This model accounts for ${mostExpensiveModel.pct.toFixed(0)}% of your total spend at ${formatCost(mostExpensiveModel.cost)}. Consider reviewing usage patterns for cost optimization.`}
              linkTo="/cost"
              linkLabel="Explore cost breakdown"
              badge={{ text: `${mostExpensiveModel.pct.toFixed(0)}%`, variant: "accent" }}
            />
          )}

          {/* Insight: Cache efficiency */}
          {cacheInterpretation && (
            <InsightCard
              icon={Database}
              iconColor="text-[var(--success)]"
              title={`Cache: ${formatPercent(cacheInterpretation.hitRate)} hit rate`}
              description={
                cacheInterpretation.savings > 0
                  ? `Your cache strategy is ${cacheInterpretation.interpretation}, saving an estimated ${formatCost(cacheInterpretation.savings)}. ${cacheInterpretation.interpretation === "effective" ? "Keep it up!" : "There may be room for improvement."}`
                  : `Your cache strategy is rated as ${cacheInterpretation.interpretation}. Review your prompting patterns to improve cache reuse.`
              }
              linkTo="/cache"
              linkLabel="View cache analytics"
              badge={{
                text: cacheInterpretation.interpretation,
                variant: cacheInterpretation.badgeVariant,
              }}
            />
          )}

          {/* Insight: Peak activity */}
          {peakActivity && (
            <InsightCard
              icon={Zap}
              iconColor="text-[var(--warning)]"
              title={`Peak usage at ${peakActivity.hour}`}
              description={`Your highest activity window is around ${peakActivity.hour} with ${peakActivity.messages.toLocaleString()} messages. Understanding your usage patterns can help with capacity planning.`}
              linkTo="/activity"
              linkLabel="View activity patterns"
              badge={{ text: "peak", variant: "warning" }}
            />
          )}

          {/* Fallback: if no insights are available yet */}
          {!mostExpensiveModel && !cacheInterpretation && !peakActivity && !isLoading && (
            <div
              className={cn(
                "col-span-full flex items-center justify-center gap-[var(--space-3)]",
                "rounded-[var(--radius-xl)] border border-dashed border-[var(--border)]",
                "bg-[var(--bg-elevated)] p-[var(--space-8)] text-sm text-[var(--text-tertiary)]"
              )}
            >
              <Lightbulb size={18} />
              <span>Insights will appear once there is enough data to analyze.</span>
            </div>
          )}
        </div>
      </section>
    </div>
    </ErrorBoundary>
  );
}
