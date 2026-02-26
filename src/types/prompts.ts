/**
 * @module types/prompts
 *
 * Types for the Prompt Analyzer — request-response pair analysis.
 * Each "prompt" is a user turn paired with its subsequent assistant turn(s),
 * scored by a composite complexity metric.
 */

// ---------------------------------------------------------------------------
// Distribution Bucket
// ---------------------------------------------------------------------------

/** A single bucket in a histogram distribution. */
export interface DistributionBucket {
  /** Label for the bucket (e.g., "$0–$0.01", "0–25"). */
  label: string;
  /** Lower bound of the bucket (inclusive). */
  min: number;
  /** Upper bound of the bucket (exclusive). */
  max: number;
  /** Number of prompts in this bucket. */
  count: number;
}

// ---------------------------------------------------------------------------
// Prompt Ranking
// ---------------------------------------------------------------------------

/** A single row in the ranked prompt listing. */
export interface PromptRankingRow {
  /** Turn ID of the user turn (the prompt). */
  turnId: string;
  /** Session ID that contains this prompt. */
  sessionId: string;
  /** Truncated preview of the user's prompt text. */
  promptPreview: string;
  /** Total cost (USD) of the assistant response(s). */
  responseCost: number;
  /** Composite complexity score (0–100). */
  complexityScore: number;
  /** Number of tool calls triggered by this prompt. */
  toolCallCount: number;
  /** Total tokens consumed (input + output + cache). */
  totalTokens: number;
  /** Number of consecutive assistant turns before the next user message. */
  multiTurnDepth: number;
  /** Whether the assistant response used extended thinking. */
  hasThinking: boolean;
  /** Model used for the assistant response. */
  model: string;
  /** Timestamp of the user turn. */
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Prompt Stats (Aggregates)
// ---------------------------------------------------------------------------

/** Aggregate statistics across all prompts in a filtered range. */
export interface PromptStats {
  /** Total number of user prompts. */
  totalPrompts: number;
  /** Average cost per prompt-response pair (USD). */
  avgCost: number;
  /** Maximum cost of a single prompt-response pair (USD). */
  maxCost: number;
  /** Average complexity score (0–100). */
  avgComplexity: number;
  /** Cost distribution histogram buckets. */
  costDistribution: DistributionBucket[];
  /** Complexity distribution histogram buckets. */
  complexityDistribution: DistributionBucket[];
}

// ---------------------------------------------------------------------------
// Prompt Detail
// ---------------------------------------------------------------------------

/** Associated tool call for a prompt detail view. */
export interface PromptToolCall {
  toolCallId: string;
  toolName: string;
  toolType: string;
  mcpServer: string | null;
  durationMs: number | null;
  success: boolean | null;
}

/** Full detail for a single prompt-response pair. */
export interface PromptDetail {
  /** Turn ID of the user turn. */
  turnId: string;
  /** Session this prompt belongs to. */
  sessionId: string;
  /** Full prompt text from the user. */
  promptText: string | null;
  /** Full response text from the assistant. */
  responseText: string | null;
  /** Cost (USD) of the assistant response(s). */
  responseCost: number;
  /** Composite complexity score (0–100). */
  complexityScore: number;
  /** Number of tool calls triggered. */
  toolCallCount: number;
  /** Total tokens consumed. */
  totalTokens: number;
  /** Input tokens. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Cache creation tokens. */
  cacheCreationTokens: number;
  /** Cache read tokens. */
  cacheReadTokens: number;
  /** Number of consecutive assistant turns. */
  multiTurnDepth: number;
  /** Whether extended thinking was used. */
  hasThinking: boolean;
  /** Model used. */
  model: string;
  /** Timestamp of the user turn. */
  timestamp: Date;
  /** Tool calls associated with the assistant response(s). */
  toolCalls: PromptToolCall[];
}

// ---------------------------------------------------------------------------
// Filter Options
// ---------------------------------------------------------------------------

/** Sortable columns for prompt ranking. */
export type PromptSortColumn =
  | "timestamp"
  | "response_cost"
  | "complexity_score"
  | "tool_call_count"
  | "total_tokens"
  | "multi_turn_depth";

/** Filter and pagination options for prompt queries. */
export interface PromptFilterOptions {
  /** Filter by time period (ISO date string or Date). */
  period?: { start: Date; end: Date };
  /** Filter by model name (LIKE match). */
  model?: string;
  /** Filter by project path (LIKE match). */
  project?: string;
  /** Column to sort by (default: complexity_score). */
  sort?: PromptSortColumn;
  /** Sort order (default: desc). */
  order?: "asc" | "desc";
  /** Page number (1-based, default: 1). */
  page?: number;
  /** Results per page (default: 50). */
  limit?: number;
}
