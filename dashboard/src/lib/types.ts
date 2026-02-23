/** A single Claude Code session. */
export interface Session {
  session_id: string;
  project: string;
  model: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  num_turns: number;
  tools_used: string[];
}

/** Summary statistics for the overview dashboard. */
export interface DashboardSummary {
  total_sessions: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_cost_per_session: number;
  avg_duration_seconds: number;
  active_projects: number;
  models_used: string[];
}

/** Daily cost data point for time-series charts. */
export interface DailyCost {
  date: string;
  cost: number;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
}

/** Model usage breakdown. */
export interface ModelUsage {
  model: string;
  sessions: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_cost_per_session: number;
}

/** Project usage breakdown. */
export interface ProjectUsage {
  project: string;
  sessions: number;
  total_cost: number;
  total_tokens: number;
  last_active: string;
}

/** A single conversation turn within a session. */
export interface Turn {
  turn_index: number;
  role: "user" | "assistant";
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  tools_used: string[];
  content_preview: string;
}

/** Detailed session data including turns. */
export interface SessionDetail extends Session {
  turns: Turn[];
}

/** Tool usage statistics. */
export interface ToolUsage {
  tool: string;
  invocations: number;
  sessions: number;
  avg_per_session: number;
}

/** API list response wrapper. */
export interface ListResponse<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
}

/** Date range filter. */
export interface DateRange {
  start: string;
  end: string;
}

/** Common query parameters for list endpoints. */
export interface ListParams {
  page?: number;
  page_size?: number;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  project?: string;
  model?: string;
  date_start?: string;
  date_end?: string;
}

// ---------------------------------------------------------------------------
// API response envelope
// ---------------------------------------------------------------------------

/** Standard API response wrapper from the server. */
export interface ApiEnvelope<T> {
  data: T;
  meta: {
    period: string;
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Cost API responses
// ---------------------------------------------------------------------------

/** GET /api/cost/total */
export interface CostTotal {
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

/** GET /api/cost/trend row */
export interface CostTrendPoint {
  timestamp: string;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
}

/** GET /api/cost/daily row */
export interface CostDailyRow {
  date: string;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turnCount: number;
  sessionCount: number;
}

/** GET /api/cost/by-model row */
export interface CostByModel {
  model: string;
  sessionCount: number;
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

/** GET /api/cost/by-project row */
export interface CostByProject {
  projectPath: string;
  totalCostUSD: number;
  sessionCount: number;
  tokenBreakdown: {
    totalCostUSD: number;
    inputCostUSD: number;
    outputCostUSD: number;
    cacheWriteCostUSD: number;
    cacheReadCostUSD: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheWriteTokens: number;
    totalCacheReadTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Sessions API responses
// ---------------------------------------------------------------------------

/** GET /api/sessions/stats */
export interface SessionStats {
  totalSessions: number;
  totalTurns: number;
  avgTurnsPerSession: number;
  avgDurationMinutes: number;
  medianDurationMinutes: number;
  totalCostUSD: number;
  avgCostPerSession: number;
  uniqueModels: string[];
}

// ---------------------------------------------------------------------------
// Tools API responses
// ---------------------------------------------------------------------------

/** GET /api/tools/usage row */
export interface ToolUsageRow {
  toolName: string;
  toolType: string;
  mcpServer: string | null;
  callCount: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  avgDurationMs: number;
  sessionsUsingTool: number;
}

/** GET /api/tools/success-rates row */
export interface ToolSuccessRate {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  commonErrors: string[];
}

/** GET /api/tools/chains row */
export interface ToolChain {
  chain: string[];
  occurrences: number;
  avgDurationMs: number;
}

// ---------------------------------------------------------------------------
// Cache API responses
// ---------------------------------------------------------------------------

/** GET /api/cache/metrics */
export interface CacheMetrics {
  cacheHitRate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  estimatedSavingsUSD: number;
  interpretation: "effective" | "moderate" | "ineffective";
}

/** GET /api/cache/trend row */
export interface CacheTrendPoint {
  timestamp: string;
  cacheHitRate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// ---------------------------------------------------------------------------
// Activity API responses
// ---------------------------------------------------------------------------

/** GET /api/activity/hourly row */
export interface ActivityHourly {
  hourOfDay: number;
  messageCount: number;
  sessionCount: number;
  avgCost: number;
  totalTokens: number;
  totalCost: number;
  avgTokensPerTurn: number;
}

/** GET /api/activity/daily row */
export interface ActivityDaily {
  timestamp: string;
  value: number;
}

/** GET /api/activity/heatmap row */
export interface ActivityHeatmap {
  dayOfWeek: number;
  hourOfDay: number;
  value: number;
}

// ---------------------------------------------------------------------------
// Sessions List & Detail API responses
// ---------------------------------------------------------------------------

/** GET /api/sessions row – summary for the sessions table. */
export interface SessionListItem {
  sessionId: string;
  startTime: string;
  endTime: string | null;
  durationMinutes: number;
  model: string;
  totalCostUSD: number;
  numTurns: number;
  numToolCalls: number;
  cacheHitRate: number;
  projectPath: string;
  sourceType: string;
  /** Per-turn cost values used for sparkline rendering. */
  costPerTurn?: number[];
}

/** A single conversation turn within a detailed session view. */
export interface SessionTurn {
  turnId: string;
  role: "user" | "assistant";
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  model: string;
  stopReason: string;
}

/** A single tool invocation within a session. */
export interface SessionToolCall {
  toolCallId: string;
  turnId: string;
  toolName: string;
  toolType: string;
  mcpServer: string | null;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
}

/** An error that occurred during a session. */
export interface SessionError {
  errorId: string;
  timestamp: string;
  errorType: string;
  message: string;
  isRetryable: boolean;
  retryCount: number;
}

/** GET /api/sessions/:id – full session detail response. */
export interface SessionDetailResponse {
  sessionId: string;
  startTime: string;
  endTime: string | null;
  durationMinutes: number;
  model: string;
  totalCostUSD: number;
  numTurns: number;
  numToolCalls: number;
  cacheHitRate: number;
  projectPath: string;
  sourceType: string;
  turns: SessionTurn[];
  toolCalls: SessionToolCall[];
  errors: SessionError[];
}

/** Meta envelope for paginated session list responses. */
export interface SessionListMeta {
  period: string;
  timestamp: string;
  total: number;
  limit: number;
  offset: number;
}

/** GET /api/sessions response shape. */
export interface SessionListResponse {
  data: SessionListItem[];
  meta: SessionListMeta;
}

/** GET /api/sessions/:id response shape. */
export interface SessionDetailEnvelope {
  data: SessionDetailResponse;
  meta: { timestamp: string };
}
