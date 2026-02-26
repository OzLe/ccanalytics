import { useState } from "react";
import { cn } from "@/lib/utils";
import Badge from "@/components/ui/Badge";
import {
  User,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Wrench,
  Zap,
} from "lucide-react";
import { formatCost, formatDateTime } from "@/lib/formatters";
import type { SessionTurn, SessionToolCall } from "@/lib/types";

interface TurnCardProps {
  turn: SessionTurn;
  index: number;
  isLast: boolean;
  toolCalls?: SessionToolCall[];
}

export default function TurnCard({
  turn,
  index,
  isLast,
  toolCalls = [],
}: TurnCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isUser = turn.role === "user";

  return (
    <div className="relative flex gap-[var(--space-4)]">
      {/* Timeline connector */}
      <div className="flex w-8 flex-col items-center">
        {/* Role icon dot */}
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            isUser
              ? "bg-[var(--accent-muted)] text-[var(--accent)]"
              : "bg-[var(--purple-muted)] text-[var(--purple)]"
          )}
        >
          {isUser ? <User size={14} strokeWidth={2.5} /> : <Bot size={14} strokeWidth={2.5} />}
        </div>
        {/* Vertical line */}
        {!isLast && (
          <div className="min-h-[var(--space-6)] flex-1 w-px bg-[var(--border-subtle)]" />
        )}
      </div>

      {/* Turn content card */}
      <div
        className={cn(
          "mb-[var(--space-3)] flex-1 rounded-[var(--radius-lg)] border p-[var(--space-4)]",
          "transition-all duration-[var(--duration-fast)]",
          isUser
            ? "border-[var(--accent-muted)] bg-[var(--accent-subtle)]"
            : "border-[var(--border-subtle)] bg-[var(--bg-surface)]",
          "hover:border-[var(--border-hover)]"
        )}
      >
        {/* Header row */}
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <Badge
            variant={isUser ? "accent" : "default"}
            size="sm"
            dot
          >
            {isUser ? "User" : "Assistant"}
          </Badge>
          <span className="text-overline text-[var(--text-tertiary)]">
            Turn {index + 1}
          </span>

          {/* Timestamp */}
          <span className="ml-auto inline-flex items-center gap-1 text-caption text-[var(--text-tertiary)]">
            <Clock size={11} />
            {formatDateTime(turn.timestamp)}
          </span>
        </div>

        {/* Stats row */}
        <div className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-4)]">
          {/* Token counts */}
          <span className="text-caption tabular-nums text-[var(--text-secondary)]">
            <span className="text-[var(--text-tertiary)]">In:</span>{" "}
            {turn.inputTokens.toLocaleString()}
          </span>
          <span className="text-caption tabular-nums text-[var(--text-secondary)]">
            <span className="text-[var(--text-tertiary)]">Out:</span>{" "}
            {turn.outputTokens.toLocaleString()}
          </span>
          {turn.cacheReadTokens > 0 && (
            <span className="text-caption tabular-nums text-[var(--text-secondary)]">
              <span className="text-[var(--text-tertiary)]">Cache:</span>{" "}
              {turn.cacheReadTokens.toLocaleString()}
            </span>
          )}
          {turn.stopReason && (
            <Badge variant="default" size="md">
              {turn.stopReason}
            </Badge>
          )}

          {/* Cost */}
          <span className="ml-auto text-caption font-semibold tabular-nums text-[var(--text-primary)]">
            {formatCost(turn.costUSD)}
          </span>
        </div>

        {/* Tool calls nested within assistant turns */}
        {toolCalls.length > 0 && (
          <div className="mt-[var(--space-3)]">
            <button
              onClick={() => setExpanded(!expanded)}
              className={cn(
                "inline-flex items-center gap-[var(--space-1)] text-caption font-medium",
                "text-[var(--text-secondary)] transition-colors duration-[var(--duration-fast)]",
                "hover:text-[var(--text-primary)]"
              )}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Wrench size={12} />
              {toolCalls.length} tool call{toolCalls.length !== 1 ? "s" : ""}
            </button>

            {expanded && (
              <div className="mt-[var(--space-2)] space-y-[var(--space-1)]">
                {toolCalls.map((tc) => (
                  <div
                    key={tc.toolCallId}
                    className={cn(
                      "flex items-center gap-[var(--space-2)] rounded-[var(--radius-md)]",
                      "border border-[var(--border-subtle)] bg-[var(--bg-overlay)]",
                      "px-[var(--space-3)] py-[var(--space-2)]"
                    )}
                  >
                    <Zap
                      size={12}
                      className={cn(
                        tc.success
                          ? "text-[var(--success)]"
                          : "text-[var(--danger)]"
                      )}
                    />
                    <span className="text-caption font-medium text-[var(--text-primary)]">
                      {tc.toolName}
                    </span>
                    {tc.toolType && (
                      <span className="text-caption text-[var(--text-tertiary)]">
                        {tc.toolType}
                      </span>
                    )}
                    {tc.durationMs != null && (
                      <span className="text-caption tabular-nums text-[var(--text-tertiary)]">
                        {tc.durationMs.toLocaleString()}ms
                      </span>
                    )}
                    <Badge
                      variant={tc.success ? "success" : "danger"}
                      size="sm"
                      className="ml-auto"
                    >
                      {tc.success ? "ok" : "fail"}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
