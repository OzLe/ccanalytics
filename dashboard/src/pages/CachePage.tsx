import { useMemo } from "react";
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
  Legend,
} from "recharts";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import Badge from "@/components/ui/Badge";
import { useCacheMetrics, useCacheTrend } from "@/hooks/useCacheData";
import { formatCost, formatPercent, formatDate, formatTokens } from "@/lib/formatters";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
} from "@/lib/chartTheme";

export default function CachePage() {
  const metrics = useCacheMetrics();
  const trend = useCacheTrend();

  // Cache efficiency trend data
  const trendData = useMemo(() => {
    if (!trend.data) return [];
    return trend.data.map((d) => ({
      date: formatDate(d.timestamp),
      hitRate: d.cacheHitRate * 100,
      cacheRead: d.cacheReadTokens,
      cacheWrite: d.cacheWriteTokens,
    }));
  }, [trend.data]);

  // Token breakdown data for stacked bar
  const tokenBreakdown = useMemo(() => {
    if (!metrics.data) return [];
    return [
      {
        name: "Tokens",
        cacheRead: metrics.data.cacheReadTokens,
        cacheWrite: metrics.data.cacheWriteTokens,
        uncached: metrics.data.uncachedInputTokens,
      },
    ];
  }, [metrics.data]);

  // Trend data for cache read vs write per day
  const dailyTokenData = useMemo(() => {
    if (!trend.data) return [];
    return trend.data.map((d) => ({
      date: formatDate(d.timestamp),
      "Cache Read": d.cacheReadTokens,
      "Cache Write": d.cacheWriteTokens,
    }));
  }, [trend.data]);

  // Interpretation badge
  const interpretationVariant = useMemo(() => {
    if (!metrics.data) return "neutral" as const;
    switch (metrics.data.interpretation) {
      case "effective":
        return "success" as const;
      case "moderate":
        return "warning" as const;
      case "ineffective":
        return "danger" as const;
      default:
        return "neutral" as const;
    }
  }, [metrics.data]);

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--text-primary)" }}
        >
          Cache Performance
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Monitor prompt caching efficiency and estimated cost savings.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          label="Cache Hit Rate"
          value={
            metrics.data
              ? formatPercent(metrics.data.cacheHitRate)
              : "--"
          }
          type="cache"
          loading={metrics.isLoading}
        />
        <KPICard
          label="Estimated Savings"
          value={
            metrics.data
              ? formatCost(metrics.data.estimatedSavingsUSD)
              : "--"
          }
          type="cost"
          loading={metrics.isLoading}
        />
        <KPICard
          label="Cache Read Tokens"
          value={
            metrics.data
              ? formatTokens(metrics.data.cacheReadTokens)
              : "--"
          }
          type="tokens"
          loading={metrics.isLoading}
        />
        <div
          className="rounded-xl border p-5 flex flex-col justify-between"
          style={{
            backgroundColor: "var(--bg-card)",
            borderColor: "var(--border)",
          }}
        >
          <p
            className="text-xs font-medium uppercase tracking-wider"
            style={{ color: "var(--text-secondary)" }}
          >
            Interpretation
          </p>
          <div className="mt-2">
            {metrics.isLoading ? (
              <div
                className="h-6 w-24 animate-pulse rounded"
                style={{ backgroundColor: "var(--bg-hover)" }}
              />
            ) : metrics.data ? (
              <Badge variant={interpretationVariant}>
                {metrics.data.interpretation.charAt(0).toUpperCase() +
                  metrics.data.interpretation.slice(1)}{" "}
                caching
              </Badge>
            ) : (
              <span style={{ color: "var(--text-muted)" }}>--</span>
            )}
          </div>
          <p
            className="mt-2 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            {metrics.data?.interpretation === "effective"
              ? "Cache is working well, saving significant tokens."
              : metrics.data?.interpretation === "moderate"
                ? "Some cache benefit detected; room for improvement."
                : "Low cache utilization; check prompt structure."}
          </p>
        </div>
      </div>

      {/* Cache Efficiency Trend */}
      <ChartCard
        title="Cache Efficiency Trend"
        subtitle="Daily cache hit rate over time"
        loading={trend.isLoading}
        empty={trendData.length === 0}
      >
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={trendData}>
            <defs>
              <linearGradient id="cacheGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="date" {...X_AXIS_PROPS} />
            <YAxis
              {...Y_AXIS_PROPS}
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              content={
                <ChartTooltip
                  valueFormatter={(v) => `${v.toFixed(1)}%`}
                  labelFormatter={(l) => l}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="hitRate"
              name="Hit Rate"
              stroke="#22c55e"
              strokeWidth={2}
              fill="url(#cacheGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Token Breakdown - stacked horizontal bar */}
        <ChartCard
          title="Token Breakdown"
          subtitle="Cache read vs write vs uncached input tokens"
          loading={metrics.isLoading}
          empty={tokenBreakdown.length === 0}
        >
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={tokenBreakdown} layout="vertical">
              <XAxis
                type="number"
                {...X_AXIS_PROPS}
                tickFormatter={(v: number) => formatTokens(v)}
              />
              <YAxis type="category" dataKey="name" hide />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => formatTokens(v)}
                  />
                }
              />
              <Legend wrapperStyle={{ color: "#94a3b8", fontSize: 12 }} />
              <Bar
                dataKey="cacheRead"
                name="Cache Read"
                stackId="tokens"
                fill={CHART_COLORS[4]}
                maxBarSize={40}
              />
              <Bar
                dataKey="cacheWrite"
                name="Cache Write"
                stackId="tokens"
                fill={CHART_COLORS[1]}
                maxBarSize={40}
              />
              <Bar
                dataKey="uncached"
                name="Uncached"
                stackId="tokens"
                fill={CHART_COLORS[3]}
                maxBarSize={40}
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
          {/* Breakdown summary */}
          {metrics.data && (
            <div className="mt-4 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Cache Read
                </p>
                <p
                  className="text-sm font-semibold"
                  style={{ color: CHART_COLORS[4] }}
                >
                  {formatTokens(metrics.data.cacheReadTokens)}
                </p>
              </div>
              <div>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Cache Write
                </p>
                <p
                  className="text-sm font-semibold"
                  style={{ color: CHART_COLORS[1] }}
                >
                  {formatTokens(metrics.data.cacheWriteTokens)}
                </p>
              </div>
              <div>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Uncached
                </p>
                <p
                  className="text-sm font-semibold"
                  style={{ color: CHART_COLORS[3] }}
                >
                  {formatTokens(metrics.data.uncachedInputTokens)}
                </p>
              </div>
            </div>
          )}
        </ChartCard>

        {/* Daily Cache Token Volumes */}
        <ChartCard
          title="Daily Cache Token Volume"
          subtitle="Cache read and write tokens per day"
          loading={trend.isLoading}
          empty={dailyTokenData.length === 0}
        >
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={dailyTokenData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="date" {...X_AXIS_PROPS} />
              <YAxis
                {...Y_AXIS_PROPS}
                tickFormatter={(v: number) => formatTokens(v)}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => formatTokens(v)}
                    labelFormatter={(l) => l}
                  />
                }
              />
              <Legend wrapperStyle={{ color: "#94a3b8", fontSize: 12 }} />
              <Bar
                dataKey="Cache Read"
                fill={CHART_COLORS[4]}
                stackId="tokens"
                maxBarSize={32}
              />
              <Bar
                dataKey="Cache Write"
                fill={CHART_COLORS[1]}
                stackId="tokens"
                maxBarSize={32}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
