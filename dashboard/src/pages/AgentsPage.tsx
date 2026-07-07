import { useMemo, useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import DataTable from "@/components/ui/DataTable";
import type { Column } from "@/components/ui/DataTable";
import { SectionHeader } from "@/components/ui/SectionHeader";
import AgentTreeGraph from "@/components/charts/AgentTreeGraph";
import AgentTimeline from "@/components/charts/AgentTimeline";
import {
  useAgentsSummary,
  useAgentsByType,
  useAgentWorkflows,
  useAgentCostAttribution,
  useAgentTree,
  useAgentTimeline,
} from "@/hooks/useAgentData";
import { formatCost, formatPercent, formatTokens } from "@/lib/formatters";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";
import type { AgentTypeRow, WorkflowRow } from "@/lib/types";

export default function AgentsPage() {
  const summary = useAgentsSummary();
  const byType = useAgentsByType();
  const workflows = useAgentWorkflows();
  const costAttribution = useAgentCostAttribution();

  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  // Default the explorer to the top orchestrating session once data loads.
  useEffect(() => {
    if (
      !selectedSession &&
      costAttribution.data &&
      costAttribution.data.length > 0
    ) {
      setSelectedSession(costAttribution.data[0]!.sessionId);
    }
  }, [costAttribution.data, selectedSession]);

  const tree = useAgentTree(selectedSession);
  const timeline = useAgentTimeline(selectedSession);

  const s = summary.data;

  const byTypeBar = useMemo(() => {
    if (!byType.data) return [];
    return byType.data
      .slice(0, 12)
      .map((d) => ({ name: d.subagentType, cost: d.totalCostUSD, agents: d.agentRuns }))
      .reverse();
  }, [byType.data]);

  const costAttribBar = useMemo(() => {
    if (!costAttribution.data) return [];
    return costAttribution.data
      .slice(0, 12)
      .map((d) => ({
        name: d.projectName ?? d.sessionId.slice(0, 8),
        main: d.mainCostUSD,
        orchestration: d.orchestrationCostUSD,
      }))
      .reverse();
  }, [costAttribution.data]);

  const byTypeColumns: Column<AgentTypeRow>[] = useMemo(
    () => [
      {
        key: "subagentType",
        header: "Sub-Agent Type",
        render: (r) => (
          <span className="font-medium text-[var(--text-primary)]">{r.subagentType}</span>
        ),
      },
      {
        key: "agentRuns",
        header: "Agents",
        align: "right",
        render: (r) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {r.agentRuns.toLocaleString()}
          </span>
        ),
      },
      {
        key: "totalCostUSD",
        header: "Cost",
        align: "right",
        render: (r) => (
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">
            {formatCost(r.totalCostUSD)}
          </span>
        ),
      },
      {
        key: "totalTokens",
        header: "Tokens",
        align: "right",
        render: (r) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {formatTokens(r.totalTokens)}
          </span>
        ),
      },
      {
        key: "totalToolCalls",
        header: "Tool Calls",
        align: "right",
        render: (r) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {r.totalToolCalls.toLocaleString()}
          </span>
        ),
      },
      {
        key: "avgTurns",
        header: "Avg Turns",
        align: "right",
        render: (r) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {r.avgTurns.toFixed(1)}
          </span>
        ),
      },
      {
        key: "successRate",
        header: "Success",
        align: "right",
        render: (r) =>
          r.successRate == null ? (
            <span className="text-[var(--text-tertiary)]">n/a</span>
          ) : (
            <span className="tabular-nums text-[var(--text-secondary)]">
              {formatPercent(r.successRate)}
            </span>
          ),
      },
    ],
    [],
  );

  const workflowColumns: Column<WorkflowRow>[] = useMemo(
    () => [
      {
        key: "workflowName",
        header: "Workflow",
        render: (r) => (
          <span className="font-medium text-[var(--text-primary)]">
            {r.workflowName ?? r.runId}
          </span>
        ),
      },
      {
        key: "agentsObserved",
        header: "Agents",
        align: "right",
        render: (r) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {r.agentsObserved.toLocaleString()}
          </span>
        ),
      },
      {
        key: "numPhases",
        header: "Phases",
        align: "right",
        render: (r) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {r.numPhases ?? "—"}
          </span>
        ),
      },
      {
        key: "fanOutPerPhase",
        header: "Fan-out / Phase",
        align: "right",
        render: (r) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {r.fanOutPerPhase != null ? r.fanOutPerPhase.toFixed(1) : "—"}
          </span>
        ),
      },
      {
        key: "totalCostUSD",
        header: "Cost",
        align: "right",
        render: (r) => (
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">
            {formatCost(r.totalCostUSD)}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        align: "right",
        render: (r) => (
          <span className="text-[var(--text-secondary)]">{r.status ?? "—"}</span>
        ),
      },
      {
        key: "explore",
        header: "",
        align: "right",
        render: (r) => {
          const pid = r.parentSessionId;
          return pid ? (
            <button
              onClick={() => setSelectedSession(pid)}
              className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]"
            >
              explore
            </button>
          ) : null;
        },
      },
    ],
    [],
  );

  return (
    <ErrorBoundary onRetry={() => window.location.reload()}>
      <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">
        {/* ── KPI Cards ──────────────────────────────────────── */}
        <section>
          <div className="mb-[var(--space-5)]">
            <SectionHeader
              title="Agents & Workflows"
              subtitle="Sub-agent and dynamic-workflow orchestration — previously uncounted spend, now measured"
            />
          </div>
          <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-3">
            <KPICard
              label="Sub-Agents"
              value={(s?.totalSubAgents ?? 0).toLocaleString()}
              type="sessions"
              loading={summary.isLoading}
            />
            <KPICard
              label="Workflow Runs"
              value={(s?.workflowRuns ?? 0).toLocaleString()}
              type="tools"
              loading={summary.isLoading}
            />
            <KPICard
              label="Orchestration Cost"
              value={formatCost(s?.orchestrationCostUSD ?? 0)}
              hint={s ? `${formatPercent(s.orchestrationCostPct)} of blended spend` : undefined}
              labelTooltip="Total API-equivalent cost of sub-agent + workflow transcripts. Kept in a separate table from main-thread cost, so it never inflates the cost SSOT. 'Blended' = main + orchestration for the orchestrating sessions."
              type="cost"
              variant="accent"
              loading={summary.isLoading}
            />
            <KPICard
              label="Avg Fan-out"
              value={(s?.avgFanOut ?? 0).toFixed(1)}
              hint={s ? `max ${s.maxFanOut} agents in one session` : undefined}
              type="sessions"
              loading={summary.isLoading}
            />
            <KPICard
              label="Max Spawn Depth"
              value={(s?.maxSpawnDepth ?? 0).toLocaleString()}
              hint={s ? `${s.totalToolCalls.toLocaleString()} sub-agent tool calls` : undefined}
              type="tools"
              loading={summary.isLoading}
            />
            <KPICard
              label="Top Sub-Agent Type"
              value={s?.topSubagentType ?? "—"}
              type="sessions"
              loading={summary.isLoading}
            />
          </div>
        </section>

        {/* ── Sub-Agent Type Breakdown ───────────────────────── */}
        <section className="space-y-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-4)]">
          <SectionHeader
            title="By Sub-Agent Type"
            subtitle="Cost and activity grouped by the agent type that was spawned"
          />
          <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-2">
            <ChartCard
              title="Cost by Sub-Agent Type"
              subtitle="API-equivalent cost per agent type"
              loading={byType.isLoading}
              empty={byTypeBar.length === 0}
              emptyMessage="No sub-agents in the selected period."
            >
              <ResponsiveContainer width="100%" height={Math.max(300, byTypeBar.length * 34)}>
                <BarChart
                  data={byTypeBar}
                  layout="vertical"
                  margin={{ left: 10, right: 20, top: 0, bottom: 0 }}
                >
                  <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
                  <XAxis type="number" {...X_AXIS_PROPS} tickFormatter={(v: number) => formatCost(v)} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    {...Y_AXIS_PROPS}
                    width={150}
                    tick={{ fill: AXIS_TICK_FILL, fontSize: 11 }}
                    tickFormatter={(v: string) => (v.length > 22 ? `…${v.slice(-20)}` : v)}
                  />
                  <Tooltip
                    content={<ChartTooltip valueFormatter={(v) => formatCost(Number(v))} />}
                  />
                  <Bar dataKey="cost" name="Cost" fill={CHART_COLORS[2]} radius={[0, 4, 4, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Sub-Agent Types"
              subtitle="Runs, cost, tokens and success per type"
              loading={byType.isLoading}
              empty={!byType.data || byType.data.length === 0}
              emptyMessage="No sub-agents in the selected period."
            >
              <DataTable<AgentTypeRow>
                columns={byTypeColumns}
                data={byType.data ?? []}
                loading={byType.isLoading}
                emptyMessage="No sub-agents in the selected period."
              />
            </ChartCard>
          </div>
        </section>

        {/* ── Dynamic Workflows ──────────────────────────────── */}
        <section className="space-y-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-4)]">
          <SectionHeader
            title="Dynamic Workflows"
            subtitle="Each Workflow-tool run, with its fan-out and cost (agent count is COUNT(sub_agents), not the manifest's estimate)"
          />
          <ChartCard
            title="Workflow Runs"
            subtitle="Ranked by cost — click 'explore' to open a run's session below"
            loading={workflows.isLoading}
            empty={!workflows.data || workflows.data.length === 0}
            emptyMessage="No dynamic-workflow runs in the selected period."
          >
            <DataTable<WorkflowRow>
              columns={workflowColumns}
              data={workflows.data ?? []}
              loading={workflows.isLoading}
              emptyMessage="No dynamic-workflow runs in the selected period."
            />
          </ChartCard>
        </section>

        {/* ── Main vs Orchestration Cost ─────────────────────── */}
        <section className="space-y-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-4)]">
          <SectionHeader
            title="Cost Attribution"
            subtitle="Main-thread vs sub-agent spend per orchestrating session — the share that was invisible before"
          />
          <ChartCard
            title="Main vs Sub-Agent Cost"
            subtitle="Stacked API-equivalent cost, top orchestrating sessions"
            loading={costAttribution.isLoading}
            empty={costAttribBar.length === 0}
            emptyMessage="No orchestrating sessions in the dataset."
          >
            <ResponsiveContainer width="100%" height={Math.max(320, costAttribBar.length * 36)}>
              <BarChart
                data={costAttribBar}
                layout="vertical"
                margin={{ left: 10, right: 20, top: 0, bottom: 0 }}
              >
                <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
                <XAxis type="number" {...X_AXIS_PROPS} tickFormatter={(v: number) => formatCost(v)} />
                <YAxis
                  type="category"
                  dataKey="name"
                  {...Y_AXIS_PROPS}
                  width={150}
                  tick={{ fill: AXIS_TICK_FILL, fontSize: 11 }}
                  tickFormatter={(v: string) => (v.length > 22 ? `…${v.slice(-20)}` : v)}
                />
                <Tooltip
                  content={<ChartTooltip valueFormatter={(v) => formatCost(Number(v))} />}
                />
                <Legend wrapperStyle={{ color: "var(--text-secondary)", fontSize: 13 }} />
                <Bar dataKey="main" name="Main thread" stackId="a" fill={CHART_COLORS[1]} maxBarSize={24} />
                <Bar dataKey="orchestration" name="Sub-agents" stackId="a" fill={CHART_COLORS[2]} radius={[0, 4, 4, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </section>

        {/* ── Orchestration Explorer (tree + timeline) ───────── */}
        <section className="space-y-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-4)]">
          <div className="flex flex-wrap items-end justify-between gap-[var(--space-3)]">
            <SectionHeader
              title="Orchestration Explorer"
              subtitle="Drill into one session: its agent tree and the parallel-agent timeline"
            />
            {costAttribution.data && costAttribution.data.length > 0 && (
              <select
                value={selectedSession ?? ""}
                onChange={(e) => setSelectedSession(e.target.value || null)}
                className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-elevated)] px-[var(--space-3)] py-[var(--space-2)] text-[var(--font-small-size)] text-[var(--text-primary)]"
                aria-label="Select session to explore"
              >
                {costAttribution.data.map((r) => (
                  <option key={r.sessionId} value={r.sessionId}>
                    {(r.projectName ?? r.sessionId.slice(0, 8)) +
                      ` — ${formatCost(r.orchestrationCostUSD)} · ${r.subAgentsSpawned} agents`}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="grid grid-cols-1 items-start gap-[var(--space-6)] xl:grid-cols-2">
            <ChartCard
              title="Agent Tree"
              subtitle="Session → workflow runs / agents → workflow agents"
              loading={tree.isLoading}
              empty={!tree.data || tree.data.children.length === 0}
              emptyMessage="This session spawned no sub-agents."
            >
              <div className="max-h-[520px] overflow-auto pr-[var(--space-1)]">
                <AgentTreeGraph data={tree.data} />
              </div>
            </ChartCard>
            <ChartCard
              title="Parallel-Agent Timeline"
              subtitle="One lane per sub-agent; overlapping bars ran concurrently"
              loading={timeline.isLoading}
              empty={!timeline.data || timeline.data.lanes.length === 0}
              emptyMessage="No timestamped sub-agents for this session."
            >
              <AgentTimeline data={timeline.data} />
            </ChartCard>
          </div>
        </section>
      </div>
    </ErrorBoundary>
  );
}
