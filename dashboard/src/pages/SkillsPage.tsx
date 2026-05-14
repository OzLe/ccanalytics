import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Lightbulb } from "lucide-react";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import DataTable from "@/components/ui/DataTable";
import Badge from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  useSkillSummary,
  useSkillLoaded,
  useSkillInvocations,
  useSkillTrend,
  useSkillNotRequired,
} from "@/hooks/useSkillData";
import { formatDate, formatPercent } from "@/lib/formatters";
import type {
  SkillLoadedRow,
  SkillInvocationRow,
  SkillThrashRow,
} from "@/lib/types";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";
import type { Column } from "@/components/ui/DataTable";

export default function SkillsPage() {
  const summary = useSkillSummary();
  const loaded = useSkillLoaded();
  const invocations = useSkillInvocations();
  const trend = useSkillTrend("day");
  const notRequired = useSkillNotRequired();

  /* ── KPI row values ─────────────────────────────────────── */
  const avgLoaded = summary.data?.avgSkillsLoadedPerSession ?? 0;
  const maxLoaded = summary.data?.maxSkillsLoadedPerSession ?? 0;
  const deadWeight = summary.data?.deadWeightSkills ?? 0;
  const invocationRate = summary.data?.invocationRate ?? null;
  const loadedContextShare = summary.data?.loadedContextShare ?? null;

  /* ── Section 3: Top Skills bar chart (top 15 by invocations) ── */
  const topSkillsData = useMemo(() => {
    if (!invocations.data) return [];
    return invocations.data
      .slice(0, 15)
      .map((d, i) => ({
        name: d.skill,
        invocations: d.invocations,
        sessions: d.sessionsUsing,
        fill: CHART_COLORS[i % CHART_COLORS.length],
      }))
      .reverse();
  }, [invocations.data]);

  /* ── Section 4 left: Loaded Skills by Context Weight ─────── */
  const loadedRows: SkillLoadedRow[] = useMemo(() => {
    if (!loaded.data) return [];
    return [...loaded.data].sort((a, b) => b.estContextTokens - a.estContextTokens);
  }, [loaded.data]);

  const loadedColumns: Column<SkillLoadedRow>[] = useMemo(
    () => [
      {
        key: "skill",
        header: "Skill",
        render: (row) => (
          <span className="font-medium text-[var(--text-primary)]">
            {row.skill}
          </span>
        ),
      },
      {
        key: "loadedInSessions",
        header: "Loaded In",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.loadedInSessions.toLocaleString()}
          </span>
        ),
      },
      {
        key: "estContextTokens",
        header: "Est. Context Tokens",
        align: "right" as const,
        render: (row) => (
          <span
            className="tabular-nums text-[var(--text-secondary)]"
            title="Estimated (flat per-skill model)"
          >
            {row.estContextTokens.toLocaleString()}
          </span>
        ),
      },
      {
        key: "invocations",
        header: "Invocations",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.invocations.toLocaleString()}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (row) =>
          row.isDeadWeight ? (
            <Badge variant="warning">dead weight</Badge>
          ) : (
            <Badge variant="success">used</Badge>
          ),
      },
    ],
    [],
  );

  /* ── Section 4 right: Skill Invocation Detail ────────────── */
  const invocationRows: SkillInvocationRow[] = useMemo(() => {
    if (!invocations.data) return [];
    return [...invocations.data].sort((a, b) => b.invocations - a.invocations);
  }, [invocations.data]);

  const invocationColumns: Column<SkillInvocationRow>[] = useMemo(
    () => [
      {
        key: "skill",
        header: "Skill",
        render: (row) => (
          <span className="font-medium text-[var(--text-primary)]">
            {row.skill}
          </span>
        ),
      },
      {
        key: "invocations",
        header: "Invocations",
        align: "right" as const,
        render: (row) => (
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">
            {row.invocations.toLocaleString()}
          </span>
        ),
      },
      {
        key: "sessionsUsing",
        header: "Sessions Using",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.sessionsUsing.toLocaleString()}
          </span>
        ),
      },
      {
        key: "successRate",
        header: "Success Rate",
        align: "right" as const,
        render: (row) => {
          // KPI-006: null = results never captured → "n/a", not a red 0%.
          if (row.successRate == null) {
            return (
              <span className="font-medium tabular-nums text-[var(--text-tertiary)]">
                n/a
              </span>
            );
          }
          const pct = row.successRate * 100;
          const color =
            pct >= 95
              ? "text-[var(--success)]"
              : pct >= 80
                ? "text-[var(--warning)]"
                : "text-[var(--danger)]";
          return (
            <span className={cn("font-semibold tabular-nums", color)}>
              {pct.toFixed(1)}%
            </span>
          );
        },
      },
      {
        key: "avgPerSession",
        header: "Inv. / Session",
        align: "right" as const,
        render: (row) => (
          <span className="tabular-nums text-[var(--text-secondary)]">
            {row.avgPerSession > 0 ? row.avgPerSession.toFixed(1) : "—"}
          </span>
        ),
      },
    ],
    [],
  );

  /* ── Section 5: Skills-Per-Session trend ─────────────────── */
  const trendData = useMemo(() => {
    if (!trend.data) return [];
    return trend.data.map((pt) => ({
      date: formatDate(pt.timestamp),
      loaded: pt.avgLoadedPerSession,
      invoked: pt.avgInvokedPerSession,
    }));
  }, [trend.data]);

  /* ── Section 6: Possibly-Unnecessary Invocations ─────────── */
  const thrashRows: SkillThrashRow[] = useMemo(
    () => notRequired.data?.thrash ?? [],
    [notRequired.data],
  );
  const thrashSummary = notRequired.data?.summary ?? null;

  const thrashColumns: Column<SkillThrashRow>[] = useMemo(
    () => [
      {
        key: "sessionId",
        header: "Session",
        render: (row) => (
          <Link
            to={`/sessions/${row.sessionId}`}
            className="font-mono text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]"
            title={row.sessionId}
          >
            {row.sessionId.slice(0, 8)}…
          </Link>
        ),
      },
      {
        key: "skill",
        header: "Skill",
        render: (row) => (
          <span className="flex items-center gap-[var(--space-2)]">
            <span className="font-medium text-[var(--text-primary)]">
              {row.skill}
            </span>
            {row.isKnownReentrant && (
              <Badge variant="outline">re-entrant</Badge>
            )}
          </span>
        ),
      },
      {
        key: "invocationsInSession",
        header: "Times In Session",
        align: "right" as const,
        render: (row) => (
          <span
            className={cn(
              "font-semibold tabular-nums",
              row.isKnownReentrant
                ? "text-[var(--text-tertiary)]"
                : "text-[var(--warning)]",
            )}
          >
            {row.invocationsInSession}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <ErrorBoundary onRetry={() => window.location.reload()}>
      <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto">
        {/* ── 1. Skill Usage — KPI Cards ──────────────────────── */}
        <section>
          <div className="mb-[var(--space-5)]">
            <SectionHeader
              title="Skill Usage"
              subtitle="How many skills are loaded into context vs. actually invoked"
            />
          </div>
          <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-4">
            <KPICard
              label="Avg Skills Loaded / Session"
              value={avgLoaded.toFixed(1)}
              hint={`max ${maxLoaded.toLocaleString()}`}
              type="tools"
              loading={summary.isLoading}
            />
            <KPICard
              label="Dead-Weight Skills"
              labelTooltip="Heuristic: skills loaded into context during the period but never invoked in it. Each one costs context tokens every turn for zero use."
              value={deadWeight.toLocaleString()}
              type="tools"
              variant={deadWeight > 0 ? "warning" : "default"}
              loading={summary.isLoading}
            />
            <KPICard
              label="Invocation Rate"
              labelTooltip="Distinct skills invoked ÷ distinct skills loaded over the period. A low rate means most loaded skills never fire."
              value={
                invocationRate != null ? formatPercent(invocationRate) : "n/a"
              }
              type="tools"
              loading={summary.isLoading}
            />
            <KPICard
              label="Loaded-Skills Context Share"
              labelTooltip="Heuristic: estimated share of average session context taken by loaded skill descriptions. These descriptions sit in context every single turn, invoked or not."
              value={
                loadedContextShare != null
                  ? formatPercent(loadedContextShare)
                  : "n/a"
              }
              type="tokens"
              variant={
                loadedContextShare != null && loadedContextShare > 0.05
                  ? "warning"
                  : "default"
              }
              loading={summary.isLoading}
            />
          </div>
        </section>

        {/* ── 2. Conditional advisory banner ──────────────────── */}
        {summary.data?.tooManySkillsActive && (
          <section>
            <div
              className={cn(
                "flex items-start gap-[var(--space-3)]",
                "rounded-[var(--radius-xl)] border border-[var(--warning-muted)]",
                "bg-[var(--warning-subtle)] p-[var(--space-5)]",
              )}
            >
              <Lightbulb
                size={18}
                className="mt-0.5 shrink-0 text-[var(--warning)]"
              />
              <div className="space-y-[var(--space-1)]">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  Heuristic: too many skills active
                </p>
                <ul className="space-y-0.5 text-sm text-[var(--text-secondary)]">
                  {summary.data.tooManyReasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
                <p className="text-sm text-[var(--text-secondary)]">
                  Consider trimming rarely-used skills from your harness.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* ── 3. Top Skills — Horizontal Bar Chart ────────────── */}
        <section className="space-y-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-4)]">
          <SectionHeader
            title="Top Skills"
            subtitle="Most frequently invoked skills ranked by invocation count"
          />
          <ChartCard
            title="Top Skills by Invocation"
            subtitle="Top 15 skills by invocation count"
            loading={invocations.isLoading}
            empty={topSkillsData.length === 0}
            emptyMessage="No skill invocations in the selected period."
          >
            <ResponsiveContainer
              width="100%"
              height={Math.max(320, topSkillsData.length * 32)}
            >
              <BarChart
                data={topSkillsData}
                layout="vertical"
                margin={{ left: 10, right: 20, top: 0, bottom: 0 }}
              >
                <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
                <XAxis type="number" {...X_AXIS_PROPS} />
                <YAxis
                  type="category"
                  dataKey="name"
                  {...Y_AXIS_PROPS}
                  width={150}
                  tick={{ fill: AXIS_TICK_FILL, fontSize: 11 }}
                  tickFormatter={(v: string) =>
                    v.length > 22 ? `…${v.slice(-20)}` : v
                  }
                />
                <Tooltip
                  content={
                    <ChartTooltip
                      valueFormatter={(v) =>
                        `${v.toLocaleString()} invocations`
                      }
                    />
                  }
                />
                <Bar
                  dataKey="invocations"
                  name="Invocations"
                  fill={CHART_COLORS[1]}
                  radius={[0, 4, 4, 0]}
                  maxBarSize={22}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </section>

        {/* ── 4. Loaded Skills & Invocation Detail (two-up) ───── */}
        <section className="space-y-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-4)]">
          <SectionHeader
            title="Loaded Skills & Context Weight"
            subtitle="Per-skill context cost versus how much each skill is actually used"
          />
          <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-2">
            <ChartCard
              title="Loaded Skills by Context Weight"
              subtitle="Estimated context tokens spent per loaded skill, sorted by weight"
              loading={loaded.isLoading}
              empty={!loaded.data || loaded.data.length === 0}
              emptyMessage="No loaded skills recorded for the selected period."
            >
              <DataTable<SkillLoadedRow>
                columns={loadedColumns}
                data={loadedRows}
                loading={loaded.isLoading}
                emptyMessage="No loaded skills recorded for the selected period."
              />
            </ChartCard>

            <ChartCard
              title="Skill Invocation Detail"
              subtitle="Per-skill invocation stats and success rate"
              loading={invocations.isLoading}
              empty={!invocations.data || invocations.data.length === 0}
              emptyMessage="No skill invocations in the selected period."
            >
              <DataTable<SkillInvocationRow>
                columns={invocationColumns}
                data={invocationRows}
                loading={invocations.isLoading}
                emptyMessage="No skill invocations in the selected period."
              />
            </ChartCard>
          </div>
        </section>

        {/* ── 5. Skills-Per-Session Trend ─────────────────────── */}
        <section className="space-y-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-4)]">
          <SectionHeader
            title="Skills-Per-Session Trend"
            subtitle="Whether the loaded set is creeping up while invocation stays flat"
          />
          <ChartCard
            title="Skills Per Session Over Time"
            subtitle="Avg skills loaded vs. avg distinct skills invoked, per day"
            loading={trend.isLoading}
            empty={trendData.length === 0}
            emptyMessage="No skill activity in the selected period."
          >
            <ResponsiveContainer width="100%" height={300}>
              <LineChart
                data={trendData}
                margin={{ top: 4, right: 20, bottom: 0, left: 0 }}
              >
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  {...X_AXIS_PROPS}
                  interval="preserveStartEnd"
                />
                <YAxis {...Y_AXIS_PROPS} />
                <Tooltip
                  content={
                    <ChartTooltip
                      valueFormatter={(v) => v.toFixed(1)}
                      labelFormatter={(l) => l}
                    />
                  }
                />
                <Legend
                  wrapperStyle={{
                    color: "var(--text-secondary)",
                    fontSize: 13,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="loaded"
                  name="Avg Loaded / Session"
                  stroke={CHART_COLORS[0]}
                  strokeWidth={2.5}
                  dot={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="invoked"
                  name="Avg Invoked / Session"
                  stroke={CHART_COLORS[4]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </section>

        {/* ── 6. Possibly-Unnecessary Invocations ─────────────── */}
        <section className="space-y-[var(--space-3)] border-t border-[var(--border-subtle)] pt-[var(--space-4)]">
          <SectionHeader
            title="Possibly-Unnecessary Invocations"
            subtitle="Same-session skill thrash — a skill invoked repeatedly within one session"
          />
          <ChartCard
            title="Possibly-Unnecessary Invocations"
            subtitle={
              thrashSummary
                ? `Heuristic · ${thrashSummary.flaggedRows.toLocaleString()} flagged (session, skill) pairs ` +
                  `across ${thrashSummary.sessionsAffected.toLocaleString()} sessions · ` +
                  `${thrashSummary.nonReentrantRows.toLocaleString()} excluding known re-entrant skills`
                : "Heuristic — a skill invoked 2+ times in the same session, worth a look"
            }
            loading={notRequired.isLoading}
            empty={thrashRows.length === 0}
            emptyMessage="No skill invocations looked unnecessary."
          >
            <DataTable<SkillThrashRow>
              columns={thrashColumns}
              data={thrashRows}
              loading={notRequired.isLoading}
              emptyMessage="No skill invocations looked unnecessary."
            />
          </ChartCard>
        </section>
      </div>
    </ErrorBoundary>
  );
}
