/**
 * @module types/jsonl
 *
 * TypeScript types representing the structure of Claude Code JSONL session files.
 * These types map directly to the JSON objects written by Claude Code into
 * ~/.claude/projects/<encoded-path>/<session-id>.jsonl files.
 */

// ---------------------------------------------------------------------------
// Content Blocks — nested under message.content[]
// ---------------------------------------------------------------------------

/** A thinking block from extended thinking / chain-of-thought. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

/** A tool_use block representing a tool invocation by the assistant. */
export interface ToolUseBlock {
  type: "tool_use";
  /** Unique identifier for this tool call, e.g. "toolu_01..." */
  id: string;
  /** Tool name. MCP tools follow pattern: mcp__<server>__<tool> */
  name: string;
  /** Tool input parameters as a JSON object. */
  input: Record<string, unknown>;
}

/** A text block containing the assistant's textual response. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** A tool_result block containing the result of a tool invocation. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

/** Discriminated union of all content block types. */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ThinkingBlock
  | ToolResultBlock;

// ---------------------------------------------------------------------------
// Token Usage — nested under assistant message `usage` field
// ---------------------------------------------------------------------------

/** Token usage breakdown from the Anthropic API response. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

// ---------------------------------------------------------------------------
// Base Message — shared fields across all JSONL entry types
// ---------------------------------------------------------------------------

/** Fields common to all JSONL message types. */
export interface BaseMessage {
  type: string;
  sessionId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Message Types — discriminated by the `type` field
// ---------------------------------------------------------------------------

/** A user-initiated message (prompt). */
export interface UserMessage extends BaseMessage {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[];
  };
  parentUuid?: string;
  uuid?: string;
}

/** An assistant response with billing and token data. */
export interface AssistantMessage extends BaseMessage {
  type: "assistant";
  /** Cost in USD — not present in JSONL, computed during ingestion. */
  costUSD?: number;
  /** Top-level usage — not present in current JSONL format; actual data is at message.usage. */
  usage?: TokenUsage;
  requestId: string;
  parentUuid?: string;
  uuid?: string;
  version?: string;
  gitBranch?: string;
  cwd?: string;
  model?: string;
  message: {
    role: "assistant";
    content: ContentBlock[];
    stop_reason?: string;
    model?: string;
    /** Token usage from the Anthropic API response. */
    usage?: TokenUsage;
  };
}

/** A file history snapshot written at session boundaries. */
export interface FileHistorySnapshot extends BaseMessage {
  type: "file-history-snapshot";
  files: Record<string, unknown>;
}

/** A queue operation event (task queue management). */
export interface QueueOperation extends BaseMessage {
  type: "queue-operation";
  operation: string;
  data?: Record<string, unknown>;
}

/** Raw JSONL entry before type discrimination. */
export interface RawJSONLEntry {
  type: string;
  sessionId?: string;
  timestamp?: string;
  [key: string]: unknown;
}
