import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import CalendarHeatmap from "@/components/charts/CalendarHeatmap";
import HourlyHeatmap from "@/components/charts/HourlyHeatmap";
import { useActivityHourly, useActivityDaily, useActivityHeatmap } from "@/hooks/useActivityData";
import { formatDate } from "@/lib/formatters";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
} from "@/lib/chartTheme";

/** Format hour number to readable label. */
function formatHour(hour: number): string {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

export default function ActivityPage() {
  const hourly = useActivityHourly();
  const daily = useActivityDaily();
  const heatmap = useActivityHeatmap();

  // Fill in all 24 hours (some may be missing from API)
  const hourlyData = useMemo(() => {
    if (!hourly.data) return [];
    const byHour = new Map(hourly.data.map((d) => [d.hourOfDay, d]));
    return Array.from({ length: 24 }, (_, i) => {
      const h = byHour.get(i);
      return {
        hour: formatHour(i),
        hourNum: i,
        messages: h?.messageCount ?? 0,
        sessions: h?.sessionCount ?? 0,
        cost: h?.totalCost ?? 0,
      };
    });
  }, [hourly.data]);

  // Peak hour
  const peakHour = useMemo(() => {
    if (hourlyData.length === 0) return "--";
    const peak = hourlyData.reduce((max, h) =>
      h.messages > max.messages ? h : max,
    );
    return peak.messages > 0 ? formatHour(peak.hourNum) : "--";
  }, [hourlyData]);

  // Total messages across all hours
  const totalMessages = useMemo(() => {
    return hourlyData.reduce((sum, h) => sum + h.messages, 0);
  }, [hourlyData]);

  // Sessions today (from daily data - last entry)
  const sessionsToday = useMemo(() => {
    if (!daily.data || daily.data.length === 0) return 0;
    // Today's date as ISO prefix
    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = daily.data.find((d) => d.timestamp.startsWith(today));
    return todayEntry?.value ?? 0;
  }, [daily.data]);

  // Daily bar chart data
  const dailyData = useMemo(() => {
    if (!daily.data) return [];
    return daily.data.map((d) => ({
      date: formatDate(d.timestamp),
      turns: d.value,
    }));
  }, [daily.data]);

  // Maximum messages for color scaling on hourly chart
  const maxMessages = useMemo(
    () => Math.max(...hourlyData.map((h) => h.messages), 1),
    [hourlyData],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--text-primary)" }}
        >
          Activity
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Usage patterns by time of day and daily volume.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KPICard
          label="Peak Hour"
          value={peakHour}
          type="duration"
          loading={hourly.isLoading}
        />
        <KPICard
          label="Total Messages"
          value={totalMessages.toLocaleString()}
          type="sessions"
          loading={hourly.isLoading}
        />
        <KPICard
          label="Turns Today"
          value={sessionsToday.toLocaleString()}
          type="sessions"
          loading={daily.isLoading}
        />
      </div>

      {/* Hourly Activity Distribution */}
      <ChartCard
        title="Hourly Activity Distribution"
        subtitle="Messages per hour of day"
        loading={hourly.isLoading}
        empty={hourlyData.every((h) => h.messages === 0)}
      >
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={hourlyData}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="hour" {...X_AXIS_PROPS} interval={1} />
            <YAxis {...Y_AXIS_PROPS} />
            <Tooltip
              content={
                <ChartTooltip
                  valueFormatter={(v) => `${v.toLocaleString()}`}
                  labelFormatter={(l) => `${l}`}
                />
              }
            />
            <Bar dataKey="messages" name="Messages" maxBarSize={28} radius={[4, 4, 0, 0]}>
              {hourlyData.map((entry, index) => {
                // Intensity-based coloring
                const intensity = maxMessages > 0 ? entry.messages / maxMessages : 0;
                const baseColor = CHART_COLORS[0]; // indigo
                const opacity = Math.max(0.15, intensity);
                return (
                  <Cell
                    key={`cell-${index}`}
                    fill={baseColor}
                    fillOpacity={opacity}
                  />
                );
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Daily Activity */}
      <ChartCard
        title="Daily Activity"
        subtitle="Assistant turns per day"
        loading={daily.isLoading}
        empty={dailyData.length === 0}
      >
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={dailyData}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis dataKey="date" {...X_AXIS_PROPS} />
            <YAxis {...Y_AXIS_PROPS} />
            <Tooltip
              content={
                <ChartTooltip
                  valueFormatter={(v) => `${v.toLocaleString()} turns`}
                  labelFormatter={(l) => l}
                />
              }
            />
            <Bar
              dataKey="turns"
              name="Turns"
              fill={CHART_COLORS[5]}
              maxBarSize={32}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Calendar Heatmap */}
      <ChartCard
        title="Activity Calendar"
        subtitle="Daily coding activity over the past year"
        loading={daily.isLoading}
        empty={!daily.data || daily.data.length === 0}
      >
        <CalendarHeatmap data={daily.data} />
      </ChartCard>

      {/* Hourly Heatmap */}
      <ChartCard
        title="Weekly Usage Patterns"
        subtitle="Message volume by day of week and hour"
        loading={heatmap.isLoading}
        empty={!heatmap.data || heatmap.data.length === 0}
      >
        <HourlyHeatmap data={heatmap.data} />
      </ChartCard>
    </div>
  );
}
