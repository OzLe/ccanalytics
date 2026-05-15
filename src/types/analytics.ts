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
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Daily cost aggregation row from v_daily_cost view. */
export interface DailyCost {
  date: string;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turnCount: number;
  sessionCount: number;
}

// ---------------------------------------------------------------------------
// Token Analytics (F1)
// ---------------------------------------------------------------------------

/**
 * F1: a token-count breakdown over the canonical cost-row population
 * (`role='assistant' AND model IS NOT NULL AND model <> '<synthetic>'`) — the
 * SAME predicate `CostBreakdown` aggregates, so token totals reconcile 1:1 with
 * cost totals. `cacheWriteTokens` surfaces `cache_creation_tokens` under the
 * "cache write" wording used everywhere else (matches
 * `CostBreakdown.totalCacheWriteTokens`).
 */
export interface TokenBreakdown {
  /** input + output + cacheWrite + cacheRead. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** `cache_creation_tokens`, surfaced as "cache write". */
  cacheWriteTokens: number;
}

/**
 * F1: the Total Tokens KPI payload — both the filtered period block and the
 * fully unfiltered, dataset-wide all-time block (D7). `allTime` is a fixed
 * per-request constant: it never responds to the period/model/project filters.
 */
export interface TokenTotals {
  /** Token breakdown for the selected period, respecting all active filters. */
  period: TokenBreakdown;
  /** Dataset-wide token breakdown — no timestamp bound, no filters (D7). */
  allTime: TokenBreakdown;
}

// ---------------------------------------------------------------------------
// Skill Analytics (F2K)
// ---------------------------------------------------------------------------

/**
 * F2K: per-skill invocation stats — the INVOKED side of skill analysis.
 *
 * Sourced from `tool_calls` rows where `tool_name = 'Skill'`, with the skill
 * name resolved via `COALESCE(skill_name, parameters->>'skill')` so historical
 * rows ingested before migration 5 (no `skill_name`) still appear. `successRate`
 * follows the KPI-006 NULL rule — NULL `success` is excluded from the
 * denominator, and the rate is `null` when no row has a non-NULL `success`.
 */
export interface SkillInvocationStats {
  /** Resolved skill name (`COALESCE(skill_name, parameters->>'skill')`). */
  skill: string;
  /** Total `Skill` tool calls of this skill in the period. */
  invocations: number;
  /** Distinct sessions that invoked this skill. */
  sessionsUsing: number;
  /** Invocations with `success = TRUE`. */
  successCount: number;
  /** Invocations with `success = FALSE`. */
  failureCount: number;
  /** successCount / (successCount + failureCount); `null` when no non-NULL success (KPI-006). */
  successRate: number | null;
  /** invocations / sessionsUsing. */
  avgPerSession: number;
}

/**
 * F2K: per-skill loaded-vs-invoked row — the LOADED side of skill analysis.
 *
 * The LOADED side comes from `session_skills` (parsed `skill_listing`
 * attachments); `invocations` is joined from the INVOKED side. `estContextTokens`
 * uses the flat `FLAT_SKILL_TOKEN_ESTIMATE` constant (D10) — it is an estimate,
 * not a measured value. `isDeadWeight` is true when the skill was loaded in the
 * period but never invoked in it (§4.3 row-granularity rule).
 */
export interface SkillLoadedStats {
  /** Skill name from `session_skills`. */
  skill: string;
  /** Distinct sessions this skill was loaded into in the period. */
  loadedInSessions: number;
  /** `loadedInSessions * FLAT_SKILL_TOKEN_ESTIMATE` — estimated (flat model). */
  estContextTokens: number;
  /** `Skill` invocations of this skill in the period (0 = dead weight). */
  invocations: number;
  /** loaded-but-never-invoked in the period (§4.3). */
  isDeadWeight: boolean;
}

/**
 * F2K: a single same-session thrash row — the "invocation not required" v1
 * signal (D12). A `(sessionId, skill)` pair whose `invocationsInSession` reached
 * `SKILL_THRASH_MIN` (= 2). `isKnownReentrant` is true for skills in
 * `KNOWN_REENTRANT_SKILLS` (orchestrators / loops) — those rows are still shown
 * but should be de-emphasised.
 */
export interface SkillThrashRow {
  sessionId: string;
  skill: string;
  /** `COUNT(*)` of `Skill` invocations of this skill within this session. */
  invocationsInSession: number;
  /** True when `skill` is in `KNOWN_REENTRANT_SKILLS` (legit re-entrant). */
  isKnownReentrant: boolean;
}

/**
 * F2K: the same-session thrash result — flagged rows plus a small summary.
 */
export interface SkillThrashResult {
  /** Thrash rows, ordered by `invocationsInSession` desc. */
  thrash: SkillThrashRow[];
  summary: {
    /** Total flagged `(session, skill)` pairs. */
    flaggedRows: number;
    /** Flagged pairs whose skill is NOT a known re-entrant skill. */
    nonReentrantRows: number;
    /** Distinct sessions appearing in the thrash list. */
    sessionsAffected: number;
  };
}

/**
 * F2K: a single Skills-Per-Session trend point — one time bucket. Reveals
 * whether the loaded set is creeping up while invocation stays flat.
 */
export interface SkillTrendPoint {
  /** Start of the time bucket. */
  timestamp: Date;
  /** AVG over the bucket's sessions of distinct skills loaded per session. */
  avgLoadedPerSession: number;
  /** AVG over the bucket's sessions of distinct skills invoked per session. */
  avgInvokedPerSession: number;
}

/**
 * F2K: the page-level skill KPI bundle + the "too many skills active" flags.
 *
 * `skillSuccessRate` follows the KPI-006 NULL rule (`null` when no `Skill` row
 * has a non-NULL `success`). `tooManySkillsActive` is
 * `dead_weight_ratio > DEAD_WEIGHT_RATIO_THRESHOLD OR
 *  loaded_context_share > LOADED_CONTEXT_SHARE_THRESHOLD` (D11);
 * `tooManyReasons` carries one human-readable string per tripped sub-condition.
 */
export interface SkillSummary {
  /** AVG over period sessions of distinct skills loaded per session. */
  avgSkillsLoadedPerSession: number;
  /** MAX over period sessions of distinct skills loaded per session. */
  maxSkillsLoadedPerSession: number;
  /** `COUNT(DISTINCT skill)` invoked in the period. */
  distinctSkillsInvoked: number;
  /** `COUNT(DISTINCT skill_name)` loaded in the period. */
  distinctSkillsLoaded: number;
  /** Total `Skill` tool calls in the period. */
  totalInvocations: number;
  /** Skill-invocation success rate (KPI-006 NULL rule); `null` = no data. */
  skillSuccessRate: number | null;
  /** Distinct skills loaded in the period but never invoked in it. */
  deadWeightSkills: number;
  /** distinctSkillsInvoked / distinctSkillsLoaded; `null` when nothing loaded. */
  invocationRate: number | null;
  /** `deadWeightSkills / distinctSkillsLoaded`; `null` when nothing loaded. */
  deadWeightRatio: number | null;
  /** Estimated avg context tokens spent on loaded skill descriptions / session. */
  avgLoadedSkillTokens: number;
  /** Avg session context tokens (input + cache_read + cache_creation proxy). */
  avgSessionContextTokens: number;
  /** `avgLoadedSkillTokens / avgSessionContextTokens`; `null` when no context. */
  loadedContextShare: number | null;
  /** D11: `deadWeightRatio > 0.50 OR loadedContextShare > 0.05`. */
  tooManySkillsActive: boolean;
  /** One human-readable reason per tripped D11 sub-condition (may be empty). */
  tooManyReasons: string[];
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
  successCount?: number;
  failureCount?: number;
  successRate: number | null;
  avgDurationMs: number | null;
  sessionsUsingTool: number;
  /**
   * KPI-009: average calls of this tool per session that used it
   * (call_count / distinct sessions). Previously defined only in the
   * v_tool_usage view and never surfaced — now selected by getToolUsage
   * and /api/tools/usage so the view and the analyzers agree.
   */
  avgPerSession: number;
}

/** NEW-002: a tool failure-rate trend point for one time bucket. */
export interface ToolFailureTrendPoint {
  /** Start of the time bucket. */
  timestamp: Date;
  /** Built-in (native) tool calls in this bucket. */
  builtin: ToolFailureTrendSeries;
  /** MCP tool calls in this bucket. */
  mcp: ToolFailureTrendSeries;
  /** Combined (builtin + mcp) for this bucket. */
  overall: ToolFailureTrendSeries;
}

/** NEW-002: failure stats for one tool class within a time bucket. */
export interface ToolFailureTrendSeries {
  /** All calls of this class in the bucket (incl. NULL-success). */
  totalCalls: number;
  /** Calls with a non-NULL success value (the failure-rate denominator). */
  evaluatedCalls: number;
  /** Calls with success = FALSE. */
  failureCount: number;
  /** failureCount / evaluatedCalls, or null when no evaluated calls. */
  failureRate: number | null;
}

/** NEW-003: per-session tool-failure-chain (rework) stats. */
export interface SessionFailureChainStats {
  sessionId: string;
  /** Longest run of consecutive success = FALSE tool calls in the session. */
  maxFailureStreak: number;
  /** Count of failure streaks of length >= 2. */
  failureChains2Plus: number;
  /** Count of failure streaks of length >= 3. */
  failureChains3Plus: number;
  /** Total failed tool calls that are part of a streak >= 2. */
  totalFailedInChains: number;
}

/** NEW-003: dataset-level tool-failure-chain summary. */
export interface FailureChainSummary {
  /** Sessions that have at least one evaluated (non-NULL) tool call. */
  sessionsWithToolCalls: number;
  /** Sessions containing a failure chain of length >= 2. */
  sessionsWithChains2Plus: number;
  /** Sessions containing a failure chain of length >= 3. */
  sessionsWithChains3Plus: number;
  /** sessionsWithChains3Plus / sessionsWithToolCalls (the headline KPI). */
  chainRate3Plus: number;
  /** Longest failure streak observed across all sessions. */
  worstStreak: number;
  /** Top sessions by max failure streak (descending). */
  topSessions: SessionFailureChainStats[];
}

// ---------------------------------------------------------------------------
// Context Pressure Analytics (NEW-001)
// ---------------------------------------------------------------------------

/**
 * NEW-001: per-session context-window utilization.
 * context_tokens (per assistant turn) = input + cache_read + cache_creation;
 * utilization = context_tokens / window, where window is MODEL-AWARE
 * (1,000,000 for 1M-context models, 200,000 otherwise).
 */
export interface SessionContextPressure {
  sessionId: string;
  /** Assistant turns in the session. */
  assistantTurns: number;
  /** MAX(context_utilization) across the session's assistant turns (0..n). */
  peakContextPct: number;
  /** Largest single-turn context token count. */
  peakContextTokens: number;
  /** AVG(context_utilization) across assistant turns. */
  avgContextPct: number;
  /** Assistant turns whose utilization exceeded 0.60. */
  turnsOver60: number;
  /** Assistant turns whose utilization exceeded 0.80. */
  turnsOver80: number;
  /** turnsOver60 / assistantTurns. */
  pressureShare: number;
  /** Assistant turns with stop_reason = 'max_tokens' (hard truncation). */
  maxTokensTurns: number;
}

/** NEW-001: dataset-level context-pressure summary for the Overview KPI. */
export interface ContextPressureStats {
  /** Sessions that have at least one assistant turn. */
  totalSessions: number;
  /** Sessions whose peak context utilization exceeded 0.60. */
  sessionsOver60: number;
  /** Sessions whose peak context utilization exceeded 0.80 ("critical"). */
  sessionsOver80: number;
  /** sessionsOver60 / totalSessions (the headline KPI). */
  pressureRate: number;
  /** sessionsOver80 / totalSessions. */
  criticalRate: number;
  /** Highest peak context utilization observed across all sessions. */
  worstPeakPct: number;
  /** Total assistant turns with stop_reason = 'max_tokens'. */
  maxTokensTurns: number;
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
  project_name: string | null;
  source_type: string | null;
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
  content_text: string | null;
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
  /**
   * S-04: invoked skill name for `tool_name = 'Skill'` rows — `block.input.skill`
   * captured at ingest. NULL for every non-Skill tool call (and for historical
   * Skill rows ingested before migration 5, where the
   * COALESCE(skill_name, parameters->>'skill') fallback applies).
   */
  skill_name: string | null;
  /**
   * S-05: the `caller.type` from the Skill tool_use block (100% `'direct'` on
   * current data, captured as future-proofing). NULL for non-Skill rows.
   */
  skill_caller_type: string | null;
}

/**
 * Row type for the `session_skills` table (S-01).
 * One row per `(session_id, record_uuid, skill_name)` — i.e. one row per skill
 * per `skill_listing` attachment record.
 */
export interface SessionSkillRow {
  /**
   * Deterministic primary key (D4):
   * `session_id || ':' || (record_uuid ?? timestamp) || ':' || skill_name`.
   * Deterministic so re-ingest is idempotent via ON CONFLICT DO NOTHING.
   */
  session_skill_id: string;
  session_id: string;
  /** The `skill_listing` record's `uuid`, or null when absent. */
  record_uuid: string | null;
  skill_name: string;
  /** Skill description parsed from the attachment content (may be multi-line). */
  skill_description: string | null;
  /** Upstream-reported skill count of the source attachment record. */
  skill_count: number | null;
  /** TRUE for the session-start injection; FALSE for a mid-session re-listing. */
  is_initial: boolean;
  /** Timestamp of the source attachment record. */
  captured_at: Date | null;
  /** Provenance marker — always 'skill_listing' for now. */
  source: string;
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
