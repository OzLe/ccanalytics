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
import { cn } from "@/lib/utils";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import Badge from "@/components/ui/Badge";
import Skeleton from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import TurnCard from "@/components/session/TurnCard";
import ToolCallsSummary from "@/components/session/ToolCallsSummary";
import ErrorPanel from "@/components/session/ErrorPanel";
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
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";
import { useSessionDetail } from "@/hooks/useSessionsQuery";
import {
  ArrowLeft,
  Calendar,
  Clock,
  Folder,
  MessageSquare,
} from "lucide-react";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import type { SessionTurn, SessionToolCall, SessionError } from "@/lib/types";

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

  // Map tool calls to their turns for nested display
  const toolCallsByTurn = useMemo(() => {
    if (!session?.toolCalls) return new Map<string, SessionToolCall[]>();
    const map = new Map<string, SessionToolCall[]>();
    for (const tc of session.toolCalls) {
      const existing = map.get(tc.turnId);
      if (existing) existing.push(tc);
      else map.set(tc.turnId, [tc]);
    }
    return map;
  }, [session?.toolCalls]);

  /* ── Loading state ─────────────────────────────────────── */
  if (isLoading) {
    return (
      <div className="min-h-0 flex-1 space-y-[var(--space-6)] overflow-y-auto">
        {/* Back link skeleton */}
        <Skeleton shape="text" className="h-5 w-32" />
        {/* Header skeleton */}
        <div className="flex items-center gap-[var(--space-3)]">
          <Skeleton shape="text" className="h-8 w-64" />
          <Skeleton shape="text" className="h-6 w-20" />
        </div>
        {/* KPIs skeleton */}
        <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <KPICard key={i} label="" value="" loading />
          ))}
        </div>
        <Skeleton shape="chart" />
      </div>
    );
  }

  /* ── Error / Not found state ───────────────────────────── */
  if (isError || !session) {
    return (
      <div className="min-h-0 flex-1 space-y-[var(--space-6)] overflow-y-auto">
        <button
          onClick={() => navigate("/sessions")}
          className={cn(
            "inline-flex min-h-[44px] items-center gap-[var(--space-2)] text-small font-medium",
            "text-[var(--text-secondary)] transition-colors duration-[var(--duration-fast)]",
            "hover:text-[var(--accent)]"
          )}
        >
          <ArrowLeft size={16} /> Back to Sessions
        </button>
        <EmptyState
          icon={MessageSquare}
          title="Session not found"
          message={`Could not load session ${id ?? "unknown"}.`}
        />
      </div>
    );
  }

  const turns: SessionTurn[] = session.turns ?? [];
  const toolCalls: SessionToolCall[] = session.toolCalls ?? [];
  const errors: SessionError[] = session.errors ?? [];
  const shortProject = session.projectPath.split("/").pop() ?? session.projectPath;
  const shortModel = session.model.split("/").pop() ?? session.model;

  return (
    <ErrorBoundary onRetry={() => window.location.reload()}>
    <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">
      {/* ── Header ────────────────────────────────────────────── */}
      <div>
        {/* Back link */}
        <button
          onClick={() => navigate("/sessions")}
          className={cn(
            "mb-[var(--space-5)] inline-flex min-h-[44px] items-center gap-[var(--space-2)]",
            "text-small font-medium text-[var(--text-secondary)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:text-[var(--accent)]"
          )}
        >
          <ArrowLeft size={16} /> Back to Sessions
        </button>

        {/* Title row */}
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          <h1 className="text-h1 text-[var(--text-primary)]">
            Session Detail
          </h1>
          <Badge variant="accent" size="md" dot>
            {shortModel}
          </Badge>
          <Badge variant="default" size="md" dot>
            <Folder size={13} className="shrink-0" />
            {shortProject}
          </Badge>
        </div>

        {/* Meta row */}
        <div className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-5)]">
          <span className="inline-flex items-center gap-[var(--space-2)] text-small text-[var(--text-secondary)]">
            <Calendar size={14} />
            {formatDateTime(session.startTime)}
            {session.endTime ? ` – ${formatDateTime(session.endTime)}` : ""}
          </span>
          <span className="inline-flex items-center gap-[var(--space-2)] text-small text-[var(--text-secondary)]">
            <Clock size={14} />
            {formatDuration(session.durationMinutes * 60)}
          </span>
          <Badge variant="default" size="sm">
            {session.sourceType === "claude-desktop" ? "Desktop" : "CLI"}
          </Badge>
        </div>
      </div>

      {/* ── KPI Cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-5">
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

      {/* ── Charts Row ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-2">
        {/* Cost Accumulation Line Chart */}
        <ChartCard
          title="Cost Accumulation"
          subtitle="Cumulative cost over turns"
          empty={costAccumData.length === 0}
        >
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={costAccumData} margin={{ top: 4, right: 20, bottom: 4, left: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="turn"
                {...X_AXIS_PROPS}
                interval="preserveStartEnd"
                label={{
                  value: "Turn",
                  position: "insideBottom",
                  offset: -5,
                  fill: AXIS_TICK_FILL,
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

        {/* Token Waterfall */}
        <ChartCard
          title="Token Waterfall"
          subtitle="Token breakdown per turn"
          empty={tokenWaterfallData.length === 0}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={tokenWaterfallData} margin={{ top: 4, right: 20, bottom: 4, left: 0 }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="turn"
                {...X_AXIS_PROPS}
                interval="preserveStartEnd"
                label={{
                  value: "Turn",
                  position: "insideBottom",
                  offset: -5,
                  fill: AXIS_TICK_FILL,
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
                wrapperStyle={{ color: "var(--text-secondary)", fontSize: 13 }}
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

      {/* ── Conversation Timeline ─────────────────────────────── */}
      <ChartCard
        title="Conversation Timeline"
        subtitle={`${turns.length} turns in this session`}
        empty={turns.length === 0}
        emptyMessage="No turn data available for this session."
      >
        <div>
          {turns.map((turn, idx) => (
            <TurnCard
              key={turn.turnId}
              turn={turn}
              index={idx}
              isLast={idx === turns.length - 1}
              toolCalls={toolCallsByTurn.get(turn.turnId)}
            />
          ))}
        </div>
      </ChartCard>

      {/* ── Tool Calls Summary ────────────────────────────────── */}
      {toolCalls.length > 0 && (
        <ChartCard
          title="Tool Calls Summary"
          subtitle={`${toolCalls.length} tool invocations across ${new Set(toolCalls.map((tc) => tc.toolName)).size} unique tools`}
        >
          <ToolCallsSummary toolCalls={toolCalls} />
        </ChartCard>
      )}

      {/* ── Errors Panel ──────────────────────────────────────── */}
      {errors.length > 0 && (
        <ChartCard
          title="Errors"
          subtitle={`${errors.length} error${errors.length !== 1 ? "s" : ""} recorded`}
        >
          <ErrorPanel errors={errors} />
        </ChartCard>
      )}
    </div>
    </ErrorBoundary>
  );
}
