/**
 * @module types/analytics
 *
 * Result types returned by the Query module analyzers.
 * These types represent the shape of data after DuckDB queries,
 * ready for formatting and display by the CLI.
 */

// ---------------------------------------------------------------------------
// Common Query Types
// ---------------------------------------------------------------------------

/** Inclusive start, exclusive end time range. */
export interface TimeRange {
  start: Date;
  end: Date;
}

export type TimeBucket = "hour" | "day" | "week" | "month";

export type OutputFormat = "table" | "json" | "csv";

export type SortOrder = "asc" | "desc";

/** Optional filters applied to analytical queries. */
export interface QueryFilters {
  model?: string;
  project?: string;
}

// ---------------------------------------------------------------------------
// Session Analytics
// ---------------------------------------------------------------------------

/** Summary of a single session, used in session list views. */
export interface SessionSummary {
  sessionId: string;
  startTime: Date;
  endTime: Date | null;
  durationMinutes: number;
  model: string;
  totalCostUSD: number;
  numTurns: number;
  numToolCalls: number;
  cacheHitRate: number;
  projectPath: string | null;
}

/** Detailed session view including all turns and tool calls. */
export interface SessionDetail extends SessionSummary {
  turns: TurnDetail[];
  toolCalls: ToolCallDetail[];
  errors: ErrorDetail[];
}

/** Detail of a single conversation turn. */
export interface TurnDetail {
  turnId: string;
  role: string;
  timestamp: Date;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  model: string | null;
  stopReason: string | null;
}

/** Detail of a single tool call. */
export interface ToolCallDetail {
  toolCallId: string;
  turnId: string;
  toolName: string;
  toolType: string;
  mcpServer: string | null;
  durationMs: number | null;
  success: boolean | null;
  errorMessage: string | null;
}

/** Detail of an error event. */
export interface ErrorDetail {
  errorId: string;
  timestamp: Date;
  errorType: string;
  message: string;
  isRetryable: boolean;
  retryCount: number;
}

// ---------------------------------------------------------------------------
// Cost Analytics
// ---------------------------------------------------------------------------

/** Breakdown of costs by token category. */
export interface CostBreakdown {
  totalCostUSD: number;
  inputCostUSD: number;
  outputCostUSD: number;
  cacheWriteCostUSD: number;
  cacheReadCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
}

/** Cost breakdown for a specific model. */
export interface ModelCostBreakdown extends CostBreakdown {
  model: string;
  sessionCount: number;
}

/** A single point in a cost trend time series. */
export interface CostTrend {
  timestamp: Date;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
}

/** Daily cost aggregation row from v_daily_cost view. */
export interface DailyCost {
  date: string;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turnCount: number;
  sessionCount: number;
}

// ---------------------------------------------------------------------------
// Cache Analytics
// ---------------------------------------------------------------------------

/** Aggregate cache metrics over a time range. */
export interface CacheMetrics {
  cacheHitRate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  estimatedSavingsUSD: number;
  interpretation: "effective" | "moderate" | "ineffective";
}

/** A single point in a cache efficiency trend. */
export interface CacheEfficiencyTrend {
  timestamp: Date;
  cacheHitRate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// ---------------------------------------------------------------------------
// Tool Analytics
// ---------------------------------------------------------------------------

/** Usage statistics for a single tool. */
export interface ToolUsageStats {
  toolName: string;
  toolType: string;
  mcpServer: string | null;
  callCount: number;
  successRate: number | null;
  avgDurationMs: number | null;
  sessionsUsingTool: number;
}

// ---------------------------------------------------------------------------
// Time Series Analytics
// ---------------------------------------------------------------------------

/** A single point in a generic time series. */
export interface TimeSeriesPoint {
  timestamp: Date;
  value: number;
}

/** Hourly activity aggregation row from v_hourly_activity view. */
export interface HourlyActivity {
  hourOfDay: number;
  messageCount: number;
  sessionCount: number;
  avgCost: number;
  totalTokens: number;
  totalCost: number;
  avgTokensPerTurn: number;
}

// ---------------------------------------------------------------------------
// Ingestion Types
// ---------------------------------------------------------------------------

/** Progress report emitted during long-running operations. */
export interface IngestionProgress {
  phase: "discovery" | "parsing" | "dedup" | "inserting";
  filesTotal: number;
  filesProcessed: number;
  entriesTotal: number;
  entriesProcessed: number;
  bytesTotal: number;
  bytesProcessed: number;
  currentFile?: string;
}

/** Result of a complete ingestion run. */
export interface IngestionResult {
  filesDiscovered: number;
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: number;
  failedFiles: Array<{ path: string; error: string }>;
  entriesIngested: number;
  duplicatesRemoved: number;
  parseErrors: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Database Row Types
// ---------------------------------------------------------------------------

/** Row type for the sessions table. */
export interface SessionRow {
  session_id: string;
  start_time: Date;
  end_time: Date | null;
  duration_seconds: number | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_cost_usd: number;
  num_turns: number;
  num_tool_calls: number;
  cwd: string | null;
  source_file: string | null;
  git_branch: string | null;
  claude_version: string | null;
  project_path: string | null;
}

/** Row type for the conversation_turns table. */
export interface ConversationTurnRow {
  turn_id: string;
  session_id: string;
  role: string;
  timestamp: Date;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  model: string | null;
  stop_reason: string | null;
  request_id: string | null;
  parent_uuid: string | null;
  has_tool_use: boolean;
  has_thinking: boolean;
}

/** Row type for the tool_calls table. */
export interface ToolCallRow {
  tool_call_id: string;
  session_id: string;
  turn_id: string;
  tool_name: string;
  tool_type: string;
  mcp_server: string | null;
  duration_ms: number | null;
  success: boolean | null;
  error_message: string | null;
  parameters: Record<string, unknown> | null;
}

/** Row type for the errors table. */
export interface ErrorRow {
  error_id: string;
  session_id: string;
  timestamp: Date;
  error_type: string;
  message: string;
  is_retryable: boolean;
  retry_count: number;
}

/** Row type for the ingestion_state table. */
export interface IngestionState {
  file_path: string;
  last_byte_offset: number;
  last_line_number: number;
  last_ingested_at: Date;
  file_checksum: string | null;
  file_size_bytes: number | null;
}

// ---------------------------------------------------------------------------
// Watcher Types
// ---------------------------------------------------------------------------

/** Current status of the file watcher. */
export interface WatcherStatus {
  running: boolean;
  watchedFiles: number;
  lastEventAt: Date | null;
  lastEventFile: string | null;
  totalEventsProcessed: number;
  errors: number;
}

/** A single file system watch event. */
export interface WatchEvent {
  type: "add" | "change" | "unlink";
  filePath: string;
  timestamp: Date;
  sizeBytes?: number;
}
