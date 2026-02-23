import { useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  LineChart,
  Line,
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
import Skeleton from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import {
  formatCost,
  formatPercent,
  formatDuration,
  formatDateTime,
} from "@/lib/formatters";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
} from "@/lib/chartTheme";
import { useSessionDetail } from "@/hooks/useSessionsQuery";
import type { SessionTurn, SessionToolCall, SessionError } from "@/lib/types";

/** Back arrow SVG icon. */
function BackArrow() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

/** Cumulative cost data point for the cost accumulation chart. */
interface CostAccumPoint {
  turn: number;
  cumCost: number;
  turnCost: number;
}

/** Token waterfall data point for the stacked bar chart. */
interface TokenWaterfallPoint {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: session, isLoading, isError } = useSessionDetail(id);

  // Derive cost accumulation data
  const costAccumData = useMemo<CostAccumPoint[]>(() => {
    if (!session?.turns) return [];
    let cumulative = 0;
    return session.turns.map((t, i) => {
      cumulative += t.costUSD;
      return { turn: i + 1, cumCost: cumulative, turnCost: t.costUSD };
    });
  }, [session?.turns]);

  // Derive token waterfall data
  const tokenWaterfallData = useMemo<TokenWaterfallPoint[]>(() => {
    if (!session?.turns) return [];
    return session.turns.map((t, i) => ({
      turn: i + 1,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
    }));
  }, [session?.turns]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton height="2rem" width="12rem" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <KPICard key={i} label="" value="" loading />
          ))}
        </div>
        <Skeleton height="20rem" />
      </div>
    );
  }

  if (isError || !session) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => navigate("/sessions")}
          className="inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          <BackArrow /> Back to Sessions
        </button>
        <EmptyState
          title="Session not found"
          message={`Could not load session ${id ?? "unknown"}.`}
        />
      </div>
    );
  }

  const turns: SessionTurn[] = session.turns ?? [];
  const toolCalls: SessionToolCall[] = session.toolCalls ?? [];
  const errors: SessionError[] = session.errors ?? [];

  return (
    <div className="space-y-6">
      {/* Back Button & Header */}
      <div>
        <button
          onClick={() => navigate("/sessions")}
          className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          <BackArrow /> Back to Sessions
        </button>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--text-primary)" }}
        >
          Session Detail
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {formatDateTime(session.startTime)}
            {session.endTime ? ` - ${formatDateTime(session.endTime)}` : ""}
          </p>
          <Badge variant="accent">
            {session.model.split("/").pop() ?? session.model}
          </Badge>
          <span
            className="text-sm"
            style={{ color: "var(--text-muted)" }}
            title={session.projectPath}
          >
            {session.projectPath.split("/").pop() ?? session.projectPath}
          </span>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KPICard
          label="Total Cost"
          value={formatCost(session.totalCostUSD)}
          type="cost"
        />
        <KPICard
          label="Duration"
          value={formatDuration(session.durationMinutes * 60)}
          type="duration"
        />
        <KPICard
          label="Turns"
          value={session.numTurns.toLocaleString()}
          type="sessions"
        />
        <KPICard
          label="Tool Calls"
          value={session.numToolCalls.toLocaleString()}
          type="tools"
        />
        <KPICard
          label="Cache Hit Rate"
          value={formatPercent(session.cacheHitRate)}
          type="cache"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost Accumulation Line Chart */}
        <ChartCard
          title="Cost Accumulation"
          subtitle="Cumulative cost over turns"
          empty={costAccumData.length === 0}
        >
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={costAccumData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="turn"
                {...X_AXIS_PROPS}
                label={{
                  value: "Turn",
                  position: "insideBottom",
                  offset: -5,
                  fill: "#94a3b8",
                  fontSize: 12,
                }}
              />
              <YAxis
                {...Y_AXIS_PROPS}
                tickFormatter={(v: number) => `$${v.toFixed(3)}`}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => formatCost(v)}
                    labelFormatter={(l) => `Turn ${l}`}
                  />
                }
              />
              <Line
                type="monotone"
                dataKey="cumCost"
                name="Cumulative Cost"
                stroke={CHART_COLORS[0]}
                strokeWidth={2}
                dot={costAccumData.length <= 30}
                activeDot={{ r: 4, fill: CHART_COLORS[0] }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Token Waterfall Stacked Bar Chart */}
        <ChartCard
          title="Token Waterfall"
          subtitle="Token breakdown per turn"
          empty={tokenWaterfallData.length === 0}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={tokenWaterfallData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="turn"
                {...X_AXIS_PROPS}
                label={{
                  value: "Turn",
                  position: "insideBottom",
                  offset: -5,
                  fill: "#94a3b8",
                  fontSize: 12,
                }}
              />
              <YAxis
                {...Y_AXIS_PROPS}
                tickFormatter={(v: number) => {
                  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
                  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
                  return String(v);
                }}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    valueFormatter={(v) => v.toLocaleString()}
                    labelFormatter={(l) => `Turn ${l}`}
                  />
                }
              />
              <Legend
                wrapperStyle={{ color: "#94a3b8", fontSize: 12 }}
              />
              <Bar
                dataKey="inputTokens"
                name="Input"
                stackId="tokens"
                fill={CHART_COLORS[0]}
                maxBarSize={24}
              />
              <Bar
                dataKey="outputTokens"
                name="Output"
                stackId="tokens"
                fill={CHART_COLORS[1]}
                maxBarSize={24}
              />
              <Bar
                dataKey="cacheReadTokens"
                name="Cache Read"
                stackId="tokens"
                fill={CHART_COLORS[4]}
                maxBarSize={24}
              />
              <Bar
                dataKey="cacheWriteTokens"
                name="Cache Write"
                stackId="tokens"
                fill={CHART_COLORS[3]}
                maxBarSize={24}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Turn-by-Turn Timeline */}
      <ChartCard
        title="Turn-by-Turn Timeline"
        subtitle={`${turns.length} turns in this session`}
        empty={turns.length === 0}
        emptyMessage="No turn data available for this session."
      >
        <div className="space-y-0">
          {turns.map((turn, idx) => (
            <div
              key={turn.turnId}
              className="relative flex gap-4"
              style={{ paddingBottom: idx < turns.length - 1 ? 0 : undefined }}
            >
              {/* Vertical line */}
              <div className="flex flex-col items-center" style={{ width: 24 }}>
                <div
                  className="h-3 w-3 rounded-full border-2 flex-shrink-0"
                  style={{
                    borderColor:
                      turn.role === "user" ? "var(--accent)" : "var(--success)",
                    backgroundColor:
                      turn.role === "user"
                        ? "rgba(99, 102, 241, 0.3)"
                        : "rgba(34, 197, 94, 0.3)",
                    marginTop: 4,
                  }}
                />
                {idx < turns.length - 1 && (
                  <div
                    className="flex-1"
                    style={{
                      width: 1,
                      backgroundColor: "var(--border)",
                      minHeight: 24,
                    }}
                  />
                )}
              </div>

              {/* Turn content */}
              <div
                className="flex-1 rounded-lg border p-3 mb-3"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={turn.role === "user" ? "accent" : "success"}
                  >
                    {turn.role}
                  </Badge>
                  <span
                    className="text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {formatDateTime(turn.timestamp)}
                  </span>
                  <span
                    className="ml-auto text-xs font-semibold tabular-nums"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {formatCost(turn.costUSD)}
                  </span>
                </div>
                <div
                  className="mt-2 flex flex-wrap gap-3 text-xs"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <span>
                    In: {turn.inputTokens.toLocaleString()}
                  </span>
                  <span>
                    Out: {turn.outputTokens.toLocaleString()}
                  </span>
                  {turn.cacheReadTokens > 0 && (
                    <span>
                      Cache Read: {turn.cacheReadTokens.toLocaleString()}
                    </span>
                  )}
                  {turn.cacheWriteTokens > 0 && (
                    <span>
                      Cache Write: {turn.cacheWriteTokens.toLocaleString()}
                    </span>
                  )}
                  {turn.stopReason && (
                    <span style={{ color: "var(--text-muted)" }}>
                      Stop: {turn.stopReason}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </ChartCard>

      {/* Tool Calls Table */}
      <ChartCard
        title="Tool Calls"
        subtitle={`${toolCalls.length} tool invocations`}
        empty={toolCalls.length === 0}
        emptyMessage="No tool calls recorded in this session."
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
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4 text-right">Duration</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {toolCalls.map((tc) => (
                <tr
                  key={tc.toolCallId}
                  className="border-b"
                  style={{ borderColor: "var(--border)" }}
                >
                  <td
                    className="py-2.5 pr-4 font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {tc.toolName}
                  </td>
                  <td
                    className="py-2.5 pr-4"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {tc.toolType}
                    {tc.mcpServer && (
                      <span style={{ color: "var(--text-muted)" }}>
                        {" "}
                        ({tc.mcpServer})
                      </span>
                    )}
                  </td>
                  <td
                    className="py-2.5 pr-4 text-right tabular-nums"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {tc.durationMs != null
                      ? `${tc.durationMs.toLocaleString()}ms`
                      : "--"}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge variant={tc.success ? "success" : "danger"}>
                      {tc.success ? "success" : "fail"}
                    </Badge>
                  </td>
                  <td
                    className="max-w-[300px] truncate py-2.5 text-xs"
                    style={{ color: "var(--text-muted)" }}
                    title={tc.errorMessage ?? undefined}
                  >
                    {tc.errorMessage ?? "--"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      {/* Errors Panel */}
      {errors.length > 0 && (
        <ChartCard
          title="Errors"
          subtitle={`${errors.length} error${errors.length !== 1 ? "s" : ""} recorded`}
        >
          <div className="space-y-3">
            {errors.map((err) => (
              <div
                key={err.errorId}
                className="rounded-lg border p-4"
                style={{
                  borderColor: "rgba(239, 68, 68, 0.3)",
                  backgroundColor: "rgba(239, 68, 68, 0.05)",
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="danger">{err.errorType}</Badge>
                  <Badge variant={err.isRetryable ? "warning" : "neutral"}>
                    {err.isRetryable ? "retryable" : "not retryable"}
                  </Badge>
                  {err.retryCount > 0 && (
                    <span
                      className="text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {err.retryCount} retries
                    </span>
                  )}
                  <span
                    className="ml-auto text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {formatDateTime(err.timestamp)}
                  </span>
                </div>
                <p
                  className="mt-2 text-sm"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {err.message}
                </p>
              </div>
            ))}
          </div>
        </ChartCard>
      )}
    </div>
  );
}
