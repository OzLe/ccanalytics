import { useState, useMemo, useCallback } from "react";
import {
  ScatterChart,
  Scatter,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ZAxis,
} from "recharts";
import { ChevronRight } from "lucide-react";
import KPICard from "@/components/ui/KPICard";
import ChartCard from "@/components/ui/ChartCard";
import ChartTooltip from "@/components/charts/ChartTooltip";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import Badge from "@/components/ui/Badge";
import DataTable from "@/components/ui/DataTable";
import { cn } from "@/lib/utils";
import { usePromptRanking, usePromptStats } from "@/hooks/usePrompts";
import { formatCost, formatDateTime } from "@/lib/formatters";
import {
  CHART_COLORS,
  GRID_PROPS,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
  AXIS_TICK_FILL,
} from "@/lib/chartTheme";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { PromptRankingRow } from "@/lib/types";
import type { Column } from "@/components/ui/DataTable";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;

type SortField =
  | "responseCost"
  | "complexityScore"
  | "toolCallCount"
  | "totalTokens"
  | "multiTurnDepth"
  | "timestamp";

interface SortState {
  field: SortField;
  order: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Build a stable color map so each model gets a consistent color. */
function useModelColorMap(rows: PromptRankingRow[]) {
  return useMemo(() => {
    const map = new Map<string, string>();
    const seen = new Set<string>();
    for (const r of rows) {
      const short = r.model.split("/").pop() ?? r.model;
      if (!seen.has(short)) {
        map.set(short, CHART_COLORS[seen.size % CHART_COLORS.length] as string);
        seen.add(short);
      }
    }
    return map;
  }, [rows]);
}

/** Shorten a model name to its last segment. */
function shortModel(model: string): string {
  return model.split("/").pop() ?? model;
}

// ---------------------------------------------------------------------------
// Custom scatter tooltip
// ---------------------------------------------------------------------------

interface ScatterTooltipPayloadEntry {
  payload?: {
    promptPreview?: string;
    model?: string;
    cost?: number;
    complexity?: number;
  };
}

interface ScatterTooltipProps {
  active?: boolean;
  payload?: ScatterTooltipPayloadEntry[];
}

function ScatterTooltipContent({ active, payload }: ScatterTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div
      className={cn(
        "max-w-xs rounded-[var(--radius-lg)] border border-[var(--border)]",
        "bg-[var(--bg-elevated)] px-[var(--space-3)] py-[var(--space-2)] shadow-[var(--shadow-xl)]"
      )}
    >
      <p className="mb-1 text-xs font-medium text-[var(--text-primary)]">
        {d.promptPreview}
      </p>
      <div className="flex gap-[var(--space-4)] text-xs text-[var(--text-secondary)]">
        <span>Cost: {formatCost(d.cost ?? 0)}</span>
        <span>Complexity: {d.complexity ?? 0}/100</span>
      </div>
      <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
        {d.model}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function PromptsPage() {
  // Sorting & pagination
  const [sort, setSort] = useState<SortState>({ field: "responseCost", order: "desc" });
  const [page, setPage] = useState(1);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // Data hooks
  const stats = usePromptStats();
  const ranking = usePromptRanking({
    sort: sort.field,
    order: sort.order,
    page,
    limit: PAGE_SIZE,
  });

  const rows: PromptRankingRow[] = ranking.data?.data ?? [];
  const totalRows = ranking.data?.meta?.total ?? 0;

  const isStatsLoading = stats.isLoading;
  const statsData = stats.data;

  // Model color map for scatter chart
  const modelColorMap = useModelColorMap(rows);

  // Scatter data
  const scatterData = useMemo(() => {
    return rows.map((r) => ({
      cost: r.responseCost,
      complexity: r.complexityScore,
      model: r.model.split("/").pop() ?? r.model,
      promptPreview: r.promptPreview.length > 60
        ? r.promptPreview.slice(0, 60) + "..."
        : r.promptPreview,
      fill: modelColorMap.get(r.model.split("/").pop() ?? r.model) ?? CHART_COLORS[0],
    }));
  }, [rows, modelColorMap]);

  // Distribution chart data
  const costDistData = useMemo(() => {
    if (!statsData?.costDistribution) return [];
    return statsData.costDistribution.map((b) => ({
      label: b.label,
      count: b.count,
    }));
  }, [statsData]);

  const complexityDistData = useMemo(() => {
    if (!statsData?.complexityDistribution) return [];
    return statsData.complexityDistribution.map((b) => ({
      label: b.label,
      count: b.count,
    }));
  }, [statsData]);

  // Sort handler for DataTable
  const handleSort = useCallback(
    (field: string) => {
      setSort((prev) => ({
        field: field as SortField,
        order: prev.field === field && prev.order === "desc" ? "asc" : "desc",
      }));
      setPage(1);
    },
    [],
  );

  // Page handler for DataTable pagination
  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
  }, []);

  // Toggle expanded row
  const handleRowClick = useCallback((row: PromptRankingRow) => {
    setExpandedRow((prev) => (prev === row.turnId ? null : row.turnId));
  }, []);

  // Unique models for the scatter legend
  const uniqueModels = useMemo(() => {
    return Array.from(modelColorMap.entries());
  }, [modelColorMap]);

  // DataTable columns
  const columns: Column<PromptRankingRow>[] = useMemo(() => [
    {
      key: "promptPreview",
      header: "Prompt Preview",
      render: (row) => {
        const preview = row.promptPreview.length > 80
          ? row.promptPreview.slice(0, 80) + "..."
          : row.promptPreview;
        const isExpanded = expandedRow === row.turnId;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <ChevronRight
              size={14}
              className={cn(
                "flex-shrink-0 text-[var(--text-tertiary)] transition-transform duration-[var(--duration-fast)]",
                isExpanded && "rotate-90"
              )}
            />
            <span
              className="truncate font-medium text-[var(--text-primary)]"
              title={row.promptPreview}
            >
              {preview}
            </span>
          </div>
        );
      },
    },
    {
      key: "responseCost",
      header: "Cost",
      align: "right" as const,
      sortable: true,
      render: (row) => (
        <span className="font-semibold tabular-nums text-[var(--text-primary)]">
          {formatCost(row.responseCost)}
        </span>
      ),
    },
    {
      key: "complexityScore",
      header: "Complexity",
      align: "right" as const,
      sortable: true,
      render: (row) => (
        <span className="tabular-nums text-[var(--text-secondary)]">
          {row.complexityScore}
        </span>
      ),
    },
    {
      key: "toolCallCount",
      header: "Tool Calls",
      align: "right" as const,
      sortable: true,
      render: (row) => (
        <span className="tabular-nums text-[var(--text-secondary)]">
          {row.toolCallCount}
        </span>
      ),
    },
    {
      key: "totalTokens",
      header: "Tokens",
      align: "right" as const,
      sortable: true,
      render: (row) => (
        <span className="tabular-nums text-[var(--text-secondary)]">
          {row.totalTokens.toLocaleString()}
        </span>
      ),
    },
    {
      key: "multiTurnDepth",
      header: "Depth",
      align: "right" as const,
      sortable: true,
      render: (row) => (
        <span className="tabular-nums text-[var(--text-secondary)]">
          {row.multiTurnDepth}
        </span>
      ),
    },
    {
      key: "hasThinking",
      header: "Thinking",
      render: (row) => (
        <Badge variant={row.hasThinking ? "success" : "neutral"}>
          {row.hasThinking ? "Yes" : "No"}
        </Badge>
      ),
    },
    {
      key: "model",
      header: "Model",
      render: (row) => (
        <Badge variant="accent">{shortModel(row.model)}</Badge>
      ),
    },
    {
      key: "timestamp",
      header: "Timestamp",
      sortable: true,
      render: (row) => (
        <span className="whitespace-nowrap text-[var(--text-secondary)]">
          {formatDateTime(row.timestamp)}
        </span>
      ),
    },
  ], [expandedRow]);

  return (
    <ErrorBoundary onRetry={() => window.location.reload()}>
    <div className="min-h-0 flex-1 space-y-[var(--space-8)] overflow-y-auto pb-[var(--space-8)]">
      {/* ════════════════════════════════════════════════════════ */}
      {/* Section 1: KPI Cards                                    */}
      {/* ════════════════════════════════════════════════════════ */}
      <section>
        <div className="mb-[var(--space-5)]">
          <SectionHeader
            title="Prompt Analytics"
            subtitle="Cost, complexity, and usage statistics for analyzed prompts"
          />
        </div>
        <div className="grid grid-cols-2 gap-[var(--space-5)] lg:grid-cols-4">
          <KPICard
            label="Total Prompts Analyzed"
            value={statsData ? statsData.totalPrompts.toLocaleString() : "--"}
            type="sessions"
            loading={isStatsLoading}
          />
          <KPICard
            label="Avg Cost per Prompt"
            value={statsData ? formatCost(statsData.avgCost) : "--"}
            type="cost"
            loading={isStatsLoading}
          />
          <KPICard
            label="Most Expensive Prompt"
            value={statsData ? formatCost(statsData.maxCost) : "--"}
            type="cost"
            loading={isStatsLoading}
          />
          <KPICard
            label="Avg Complexity Score"
            value={statsData ? `${statsData.avgComplexity.toFixed(0)}/100` : "--"}
            type="tools"
            loading={isStatsLoading}
          />
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════ */}
      {/* Section 2: Ranked Table using DataTable                 */}
      {/* ════════════════════════════════════════════════════════ */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Prompt Ranking"
          subtitle="All prompts ranked by cost, complexity, or other metrics"
        />
        <DataTable<PromptRankingRow>
          columns={columns}
          data={rows}
          sortField={sort.field}
          sortOrder={sort.order}
          onSort={handleSort}
          onRowClick={handleRowClick}
          loading={ranking.isLoading}
          emptyMessage="No prompts found. Try adjusting your filters or time period."
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total: totalRows,
            onPageChange: handlePageChange,
          }}
        />

        {/* Expanded row detail (shown below table) */}
        {expandedRow && (() => {
          const row = rows.find((r) => r.turnId === expandedRow);
          if (!row) return null;
          return (
            <div
              className={cn(
                "animate-fade-in rounded-[var(--radius-xl)] border border-[var(--border)]",
                "bg-[var(--bg-surface)] p-[var(--space-6)]"
              )}
            >
              <p className="text-overline mb-[var(--space-2)] text-[var(--text-secondary)]">
                Full Prompt
              </p>
              <div className="max-h-96 overflow-y-auto overflow-x-hidden">
                <pre className="whitespace-pre-wrap break-words text-small leading-relaxed text-[var(--text-primary)]">
                  {row.promptPreview}
                </pre>
              </div>
            </div>
          );
        })()}
      </section>

      {/* ════════════════════════════════════════════════════════ */}
      {/* Section 3: Cost vs Complexity Scatter Chart              */}
      {/* ════════════════════════════════════════════════════════ */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Cost vs Complexity"
          subtitle="Explore the relationship between prompt cost and complexity"
        />
        <ChartCard
          title="Cost vs Complexity"
          subtitle="Each dot represents a prompt, colored by model"
          loading={ranking.isLoading}
          empty={scatterData.length === 0}
        >
          <ResponsiveContainer width="100%" height={350}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
              <CartesianGrid {...GRID_PROPS} vertical />
              <XAxis
                type="number"
                dataKey="cost"
                name="Cost"
                {...X_AXIS_PROPS}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                label={{
                  value: "Cost ($)",
                  position: "insideBottom",
                  offset: -5,
                  fill: AXIS_TICK_FILL,
                  fontSize: 12,
                }}
              />
              <YAxis
                type="number"
                dataKey="complexity"
                name="Complexity"
                {...Y_AXIS_PROPS}
                domain={[0, 100]}
                label={{
                  value: "Complexity",
                  angle: -90,
                  position: "insideLeft",
                  offset: 10,
                  fill: AXIS_TICK_FILL,
                  fontSize: 12,
                }}
              />
              <ZAxis range={[40, 40]} />
              <Tooltip
                content={<ScatterTooltipContent />}
                cursor={{ strokeDasharray: "3 3", stroke: "var(--border)" }}
              />
              <Scatter data={scatterData} isAnimationActive={false}>
                {scatterData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} fillOpacity={0.75} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div className="mt-[var(--space-2)] flex flex-wrap justify-center gap-[var(--space-3)]">
            {uniqueModels.map(([model, color]) => (
              <div key={model} className="flex items-center gap-1.5 text-xs">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-[var(--text-secondary)]">{model}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </section>

      {/* ════════════════════════════════════════════════════════ */}
      {/* Section 4: Distribution Charts                          */}
      {/* ════════════════════════════════════════════════════════ */}
      <section className="space-y-[var(--space-3)]">
        <SectionHeader
          title="Distributions"
          subtitle="Histograms showing the spread of cost and complexity"
        />
        <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-2">
          {/* Cost Distribution */}
          <ChartCard
            title="Cost Distribution"
            subtitle="Histogram of prompt costs"
            loading={isStatsLoading}
            empty={costDistData.length === 0}
          >
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={costDistData}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="label"
                  {...X_AXIS_PROPS}
                  tick={{ fill: AXIS_TICK_FILL, fontSize: 10 }}
                  angle={-30}
                  textAnchor="end"
                  height={50}
                />
                <YAxis {...Y_AXIS_PROPS} />
                <Tooltip
                  content={
                    <ChartTooltip
                      valueFormatter={(v) => `${v.toLocaleString()} prompts`}
                      labelFormatter={(l) => `Cost: ${l}`}
                    />
                  }
                />
                <Bar
                  dataKey="count"
                  name="Prompts"
                  fill={CHART_COLORS[0]}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={40}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Complexity Distribution */}
          <ChartCard
            title="Complexity Distribution"
            subtitle="Histogram of complexity scores"
            loading={isStatsLoading}
            empty={complexityDistData.length === 0}
          >
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={complexityDistData}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="label"
                  {...X_AXIS_PROPS}
                  tick={{ fill: AXIS_TICK_FILL, fontSize: 10 }}
                  angle={-30}
                  textAnchor="end"
                  height={50}
                />
                <YAxis {...Y_AXIS_PROPS} />
                <Tooltip
                  content={
                    <ChartTooltip
                      valueFormatter={(v) => `${v.toLocaleString()} prompts`}
                      labelFormatter={(l) => `Complexity: ${l}`}
                    />
                  }
                />
                <Bar
                  dataKey="count"
                  name="Prompts"
                  fill={CHART_COLORS[1]}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={40}
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
