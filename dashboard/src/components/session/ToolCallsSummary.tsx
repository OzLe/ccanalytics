import { useMemo } from "react";
import { cn } from "@/lib/utils";
import Badge from "@/components/ui/Badge";
import { Wrench, CheckCircle, XCircle } from "lucide-react";
import type { SessionToolCall } from "@/lib/types";

interface ToolSummaryRow {
  toolName: string;
  toolType: string;
  total: number;
  success: number;
  failure: number;
  avgDurationMs: number;
}

interface ToolCallsSummaryProps {
  toolCalls: SessionToolCall[];
}

export default function ToolCallsSummary({ toolCalls }: ToolCallsSummaryProps) {
  const summary = useMemo<ToolSummaryRow[]>(() => {
    const map = new Map<
      string,
      { toolType: string; total: number; success: number; failure: number; totalMs: number; msCount: number }
    >();

    for (const tc of toolCalls) {
      const existing = map.get(tc.toolName);
      if (existing) {
        existing.total++;
        if (tc.success) existing.success++;
        else existing.failure++;
        if (tc.durationMs != null) {
          existing.totalMs += tc.durationMs;
          existing.msCount++;
        }
      } else {
        map.set(tc.toolName, {
          toolType: tc.toolType,
          total: 1,
          success: tc.success ? 1 : 0,
          failure: tc.success ? 0 : 1,
          totalMs: tc.durationMs ?? 0,
          msCount: tc.durationMs != null ? 1 : 0,
        });
      }
    }

    return Array.from(map.entries())
      .map(([toolName, v]) => ({
        toolName,
        toolType: v.toolType,
        total: v.total,
        success: v.success,
        failure: v.failure,
        avgDurationMs: v.msCount > 0 ? Math.round(v.totalMs / v.msCount) : 0,
      }))
      .sort((a, b) => b.total - a.total);
  }, [toolCalls]);

  if (summary.length === 0) return null;

  return (
    <div className="space-y-[var(--space-2)]">
      {summary.map((row) => (
        <div
          key={row.toolName}
          className={cn(
            "flex items-center gap-[var(--space-3)]",
            "rounded-[var(--radius-lg)] border border-[var(--border-subtle)]",
            "bg-[var(--bg-surface)] px-[var(--space-4)] py-[var(--space-3)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:border-[var(--border-hover)]"
          )}
        >
          {/* Tool icon */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--bg-overlay)] text-[var(--orange)]">
            <Wrench size={14} />
          </div>

          {/* Tool name & type */}
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-[var(--text-primary)] truncate">
              {row.toolName}
            </p>
            <p className="text-caption text-[var(--text-tertiary)]">
              {row.toolType}
            </p>
          </div>

          {/* Call count */}
          <span className="text-caption font-semibold tabular-nums text-[var(--text-secondary)]">
            {row.total}x
          </span>

          {/* Success / Failure */}
          {row.success > 0 && (
            <span className="inline-flex items-center gap-1 text-caption tabular-nums text-[var(--success)]">
              <CheckCircle size={12} />
              {row.success}
            </span>
          )}
          {row.failure > 0 && (
            <span className="inline-flex items-center gap-1 text-caption tabular-nums text-[var(--danger)]">
              <XCircle size={12} />
              {row.failure}
            </span>
          )}

          {/* Avg duration */}
          {row.avgDurationMs > 0 && (
            <Badge variant="default" size="sm">
              ~{row.avgDurationMs.toLocaleString()}ms
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}
