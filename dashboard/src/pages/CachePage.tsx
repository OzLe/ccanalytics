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
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useCacheMetrics, useCacheTrend } from "@/hooks/useCacheData";
import { formatCost, formatPercent, formatDate, formatTokens } from "@/lib/formatters";
import {
  CACHE_SAVINGS_LABEL,
  CACHE_SAVINGS_TOOLTIP,
} from "@/lib/costLabels";
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

  // KPICard variant for hero metric
  const heroVariant = useMemo(() => {
    if (!metrics.data) return "default" as const;
    switch (metrics.data.interpretation) {
      case "effective":
        return "success" as const;
      case "moderate":
        return "warning" as const;
      default:
        return "default" as const;
    }
  }, [metrics.data]);

  // Interpretation helper text
  const interpretationHelpText = useMemo(() => {
    if (!metrics.data) return "";
    switch (metrics.data.interpretation) {
      case "effective":
        return "Cache is working well, saving significant tokens.";
      case "moderate":
        return "Some cache benefit detected; room for improvement.";
      default:
        return "Low cache utilization; check prompt structure.";
    }
  }, [metrics.data]);

  return (
    <ErrorBoundary onRetry={() => window.location.reload()}>
    <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">
      {/* ── KPI Cards ──────────────────────────────────────────── */}
      <section>
        <div className="mb-[var(--space-5)]">
          <SectionHeader
            title="Cache Performance"
            subtitle="Token caching metrics and estimated savings vs. uncached API list pricing"
          />
        </div>
        <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-4">
          <KPICard
            label="Cache Hit Rate"
            value={
              metrics.data
                ? formatPercent(metrics.data.cacheHitRate)
                : "--"
            }
            type="cache"
            variant={heroVariant}
            loading={metrics.isLoading}
          />
          <KPICard
            label={CACHE_SAVINGS_LABEL}
            labelTooltip={CACHE_SAVINGS_TOOLTIP}
            value={
              metrics.data
                ? formatCost(metrics.data.estimatedSavingsUSD)
                : "--"
            }
            type="cost"
            loading={metrics.isLoading}
            hint="vs. uncached API list pricing"
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
          {/* Interpretation card — matches KPICard pattern */}
          <KPICard
            label="Interpretation"
            value={
              metrics.data
                ? `${metrics.data.interpretation.charAt(0).toUpperCase()}${metrics.data.interpretation.slice(1)} caching`
                : "--"
            }
            type="cache"
            variant={heroVariant}
            loading={metrics.isLoading}
            trend={
              interpretationHelpText
                ? { value: 0, label: interpretationHelpText }
                : undefined
            }
          />
        </div>
      </section>

      {/* ── Cache Efficiency Trend ──────────────────────────────── */}
      <section className="space-y-[var(--space-3)] pt-[var(--space-4)] border-t border-[var(--border-subtle)]">
        <SectionHeader
          title="Efficiency Trend"
          subtitle="How cache hit rate changes over time"
        />
        <ChartCard
          title="Cache Efficiency Trend"
          subtitle="Daily cache hit rate over time"
          loading={trend.isLoading}
          empty={trendData.length === 0}
        >
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={trendData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="cacheGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_COLORS[4]} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={CHART_COLORS[4]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="date" {...X_AXIS_PROPS} interval="preserveStartEnd" />
              <YAxis
                {...Y_AXIS_PROPS}
                domain={([dataMin, _dataMax]: [number, number]) => {
                  const floor = Math.max(0, Math.floor(dataMin / 10) * 10 - 10);
                  return [floor, 100];
                }}
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
                stroke={CHART_COLORS[4]}
                strokeWidth={2}
                fill="url(#cacheGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </section>

      {/* ── Token Breakdown ─────────────────────────────────────── */}
      <section className="space-y-[var(--space-3)] pt-[var(--space-4)] border-t border-[var(--border-subtle)]">
        <SectionHeader
          title="Token Breakdown"
          subtitle="How input tokens are distributed across cache layers"
        />
        <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-2">
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
                <Legend wrapperStyle={{ color: "var(--text-secondary)", fontSize: 13 }} />
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
              <div className="mt-[var(--space-4)] grid grid-cols-3 gap-[var(--space-4)] text-center">
                <div>
                  <p className="text-caption text-[var(--text-tertiary)]">
                    Cache Read
                  </p>
                  <p
                    className="text-small font-semibold"
                    style={{ color: CHART_COLORS[4] }}
                  >
                    {formatTokens(metrics.data.cacheReadTokens)}
                  </p>
                </div>
                <div>
                  <p className="text-caption text-[var(--text-tertiary)]">
                    Cache Write
                  </p>
                  <p
                    className="text-small font-semibold"
                    style={{ color: CHART_COLORS[1] }}
                  >
                    {formatTokens(metrics.data.cacheWriteTokens)}
                  </p>
                </div>
                <div>
                  <p className="text-caption text-[var(--text-tertiary)]">
                    Uncached
                  </p>
                  <p
                    className="text-small font-semibold"
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
              <BarChart data={dailyTokenData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="date" {...X_AXIS_PROPS} interval="preserveStartEnd" />
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
                <Legend wrapperStyle={{ color: "var(--text-secondary)", fontSize: 13 }} />
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
      </section>
    </div>
    </ErrorBoundary>
  );
}
