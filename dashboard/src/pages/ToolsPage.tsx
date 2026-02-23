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
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import ToolChainSankey from "@/components/charts/ToolChainSankey";
import Badge from "@/components/ui/Badge";
import { useToolUsage, useToolSuccessRates, useToolChains } from "@/hooks/useToolData";
import { formatDuration } from "@/lib/formatters";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";

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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto space-y-8">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
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

      {/* Top Tools - Horizontal Bar Chart */}
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Success Rate Table */}
        <ChartCard
          title="Tool Success Rates"
          subtitle="Success and failure breakdown per tool"
          loading={successRates.isLoading}
          empty={!successRates.data || successRates.data.length === 0}
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
                  <th className="py-3 px-4">Tool</th>
                  <th className="py-3 px-4 text-right">Calls</th>
                  <th className="py-3 px-4 text-right">Rate</th>
                  <th className="py-3 px-4 w-28">Bar</th>
                  <th className="py-3 px-4 text-right">Avg Time</th>
                </tr>
              </thead>
              <tbody>
                {successRates.data?.map((tool) => {
                  const ratePercent = tool.successRate * 100;
                  const barColor =
                    ratePercent >= 95
                      ? "var(--success)"
                      : ratePercent >= 80
                        ? "var(--warning)"
                        : "var(--danger)";
                  return (
                    <tr
                      key={tool.toolName}
                      className="table-row-hover border-b"
                      style={{ borderColor: "var(--border)" }}
                      tabIndex={0}
                    >
                      <td
                        className="py-3 px-4 font-medium"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {tool.toolName}
                      </td>
                      <td
                        className="py-3 px-4 text-right tabular-nums"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {tool.totalCalls.toLocaleString()}
                      </td>
                      <td
                        className="py-3 px-4 text-right font-semibold tabular-nums"
                        style={{ color: barColor }}
                      >
                        {ratePercent.toFixed(1)}%
                      </td>
                      <td className="py-3 px-4">
                        <div
                          className="h-2 rounded-full"
                          style={{ backgroundColor: "var(--bg-hover)" }}
                        >
                          <div
                            className="h-2 rounded-full"
                            style={{
                              width: `${ratePercent}%`,
                              backgroundColor: barColor,
                              minWidth:
                                tool.successCount > 0 ? "4px" : "0px",
                            }}
                          />
                        </div>
                      </td>
                      <td
                        className="py-3 px-4 text-right tabular-nums"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {formatDuration(tool.avgDurationMs / 1000)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>

        {/* Tool Chains Table */}
        <ChartCard
          title="Tool Chain Patterns"
          subtitle="Frequently occurring sequential tool call patterns"
          loading={toolChains.isLoading}
          empty={!toolChains.data || toolChains.data.length === 0}
          emptyMessage="No recurring tool chain patterns found."
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
                  <th className="py-3 px-4">Chain</th>
                  <th className="py-3 px-4 text-right">Count</th>
                  <th className="py-3 px-4 text-right">Avg Time</th>
                </tr>
              </thead>
              <tbody>
                {toolChains.data?.map((chain, idx) => (
                  <tr
                    key={idx}
                    className="table-row-hover border-b"
                    style={{ borderColor: "var(--border)" }}
                    tabIndex={0}
                  >
                    <td className="py-3 px-4">
                      <div className="flex flex-wrap items-center gap-1">
                        {chain.chain.map((tool, ti) => (
                          <span key={ti} className="flex items-center gap-1">
                            <Badge variant="accent">{tool}</Badge>
                            {ti < chain.chain.length - 1 && (
                              <span style={{ color: "var(--text-muted)" }}>
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M5 12h14M12 5l7 7-7 7" />
                                </svg>
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td
                      className="py-3 px-4 text-right font-semibold tabular-nums"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {chain.occurrences.toLocaleString()}
                    </td>
                    <td
                      className="py-3 px-4 text-right tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {formatDuration(chain.avgDurationMs / 1000)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      {/* Tool Flow Sankey Diagram */}
      {toolChains.data && toolChains.data.length > 0 && (
        <ChartCard
          title="Tool Flow Patterns"
          subtitle="Sankey diagram of tool call sequences"
          loading={toolChains.isLoading}
          empty={!toolChains.data || toolChains.data.length === 0}
        >
          <ToolChainSankey data={toolChains.data} />
        </ChartCard>
      )}
    </div>
  );
}
