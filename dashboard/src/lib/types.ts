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
// Subscription settings (GET/PUT /api/settings)
// ---------------------------------------------------------------------------

/**
 * The user's Claude subscription plan. Mirrors `SubscriptionTier` in
 * src/types/config.ts — kept in sync manually because the dashboard build does
 * not import the CLI source for types.
 */
export type SubscriptionTier = "none" | "pro" | "max-5x" | "max-20x";

/** Resolved subscription settings returned by GET /api/settings. */
export interface SubscriptionSettings {
  tier: SubscriptionTier;
  monthlyUSD: number;
}

/**
 * Display preferences returned by GET /api/settings. Tied to ACT-001 /
 * SEM2-293 — `userTimezone` controls how the dashboard projects
 * tz-naive UTC timestamps into local hour-of-day / date math.
 */
export interface DisplaySettings {
  userTimezone: string;
}

/** A selectable subscription tier option for the Settings tier picker. */
export interface SubscriptionTierOption {
  id: SubscriptionTier;
  label: string;
  monthlyUSD: number;
}

/**
 * Canonical tier list for the UI selector. Mirrors SUBSCRIPTION_TIERS in
 * src/config/subscription.ts (the server-side single source of truth). The
 * server still validates every PUT, so this is presentation-only.
 */
export const SUBSCRIPTION_TIER_OPTIONS: ReadonlyArray<SubscriptionTierOption> = [
  { id: "none", label: "None (API pay-as-you-go)", monthlyUSD: 0 },
  { id: "pro", label: "Pro", monthlyUSD: 20 },
  { id: "max-5x", label: "MAX 5x", monthlyUSD: 100 },
  { id: "max-20x", label: "MAX 20x", monthlyUSD: 200 },
];

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

// ---------------------------------------------------------------------------
// Tokens API responses (F1)
// ---------------------------------------------------------------------------

/**
 * F1: a token-count breakdown over the canonical cost-row population — the
 * SAME predicate `/api/cost/total` aggregates, so token totals reconcile 1:1
 * with cost totals. `cacheWriteTokens` is `cache_creation_tokens` surfaced
 * under the "cache write" wording used everywhere else.
 *
 * TOK-001 / TOK-002 (SEM2-288 / SEM2-289): canonical `totalTokens` is the
 * 2-way (input + output) Anthropic-API style sum. The 4-way sum is surfaced
 * separately as `contextVolumeTokens` ("Context Volume" — model-processed
 * volume INCLUDING cached prompt replay).
 */
export interface TokenBreakdown {
  /** TOK-001: canonical headline — 2-way `input + output`. */
  totalTokens: number;
  /**
   * TOK-002: 4-way `input + output + cacheWrite + cacheRead`. Surfaced as
   * "Context Volume" — model-processed volume including cached prompt replay.
   * Never the headline.
   */
  contextVolumeTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** `cache_creation_tokens`, surfaced as "cache write". */
  cacheWriteTokens: number;
}

/**
 * GET /api/tokens/total — the filtered period block plus the fully unfiltered,
 * dataset-wide all-time block (D7). `allTime` is a fixed per-request constant:
 * it never responds to the period/model/project/source filters.
 */
export interface TokenTotals {
  /** Token breakdown for the selected period, respecting all active filters. */
  period: TokenBreakdown;
  /** Dataset-wide token breakdown — no timestamp bound, no filters (D7). */
  allTime: TokenBreakdown;
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
  projectName?: string;
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
  /**
   * @deprecated SEM2-281: raw arithmetic mean — long-tailed and dominated by
   * unclosed "zombie" sessions on real data. Use {@link medianDurationMinutes}
   * (primary) or {@link cappedMeanDurationMinutes} (secondary, 12h-clamped).
   * Kept in the payload as a sanity-check / back-compat field.
   */
  avgDurationMinutes: number;
  /**
   * SEM2-281: arithmetic mean with each session's duration clamped at 12h
   * before averaging — robust secondary KPI.
   */
  cappedMeanDurationMinutes: number;
  /** SEM2-281: median session duration in minutes — primary KPI. */
  medianDurationMinutes: number;
  totalCostUSD: number;
  avgCostPerSession: number;
  uniqueModels: string[];
}

/** NEW-001: per-session context-window utilization. */
export interface SessionContextPressure {
  sessionId: string;
  assistantTurns: number;
  /** MAX(context_utilization) across the session (0..n; >1 impossible given
   *  the model-aware window). */
  peakContextPct: number;
  peakContextTokens: number;
  avgContextPct: number;
  turnsOver60: number;
  turnsOver80: number;
  pressureShare: number;
  maxTokensTurns: number;
}

/** GET /api/sessions/context-pressure — dataset summary + per-session rows. */
export interface ContextPressureData {
  summary: {
    totalSessions: number;
    sessionsOver60: number;
    sessionsOver80: number;
    /** sessionsOver60 / totalSessions (the headline KPI). */
    pressureRate: number;
    /** sessionsOver80 / totalSessions ("critical" band). */
    criticalRate: number;
    worstPeakPct: number;
    maxTokensTurns: number;
  };
  sessions: SessionContextPressure[];
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
  /**
   * TOOL-001 (SEM2-282): null when every underlying tool_calls.duration_ms
   * is NULL ("no data"). Both ingestion adapters currently write NULL, so
   * every value is null today. UI renders "n/a".
   */
  avgDurationMs: number | null;
  sessionsUsingTool: number;
  /** KPI-009: avg calls of this tool per session that used it. */
  avgPerSession: number;
}

/** GET /api/tools/success-rates row */
export interface ToolSuccessRate {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  /** KPI-006: null when the tool has only NULL-success calls ("no data"). */
  successRate: number | null;
  /** TOOL-001 (SEM2-282): null when no duration_ms was captured. */
  avgDurationMs: number | null;
  commonErrors: string[];
}

/** GET /api/tools/chains row */
export interface ToolChain {
  chain: string[];
  occurrences: number;
  /** TOOL-001 (SEM2-282): null when no chain instance had captured durations. */
  avgDurationMs: number | null;
}

/** NEW-002: failure stats for one tool class within a time bucket. */
export interface ToolFailureTrendSeries {
  totalCalls: number;
  evaluatedCalls: number;
  failureCount: number;
  /** failureCount / evaluatedCalls, or null when no evaluated calls. */
  failureRate: number | null;
}

/** GET /api/tools/failure-trend row — one point per time bucket. */
export interface ToolFailureTrendPoint {
  timestamp: string;
  builtin: ToolFailureTrendSeries;
  mcp: ToolFailureTrendSeries;
  overall: ToolFailureTrendSeries;
}

/** NEW-003: per-session tool-failure-chain (rework) stats. */
export interface SessionFailureChain {
  sessionId: string;
  maxFailureStreak: number;
  failureChains2Plus: number;
  failureChains3Plus: number;
  totalFailedInChains: number;
}

/** GET /api/tools/failure-chains — dataset summary + worst-offender sessions. */
export interface FailureChainsData {
  summary: {
    sessionsWithToolCalls: number;
    sessionsWithChains2Plus: number;
    sessionsWithChains3Plus: number;
    /** sessionsWithChains3Plus / sessionsWithToolCalls (the headline KPI). */
    chainRate3Plus: number;
    worstStreak: number;
  };
  topSessions: SessionFailureChain[];
}

// ---------------------------------------------------------------------------
// Skills API responses (F2K)
// ---------------------------------------------------------------------------

/**
 * GET /api/skills/summary — the page-level skill KPI bundle plus the
 * "too many skills active" flags (D11). Powers the KPI row and the conditional
 * advisory banner. `skillSuccessRate` follows the KPI-006 NULL rule (`null`
 * when no `Skill` row has a non-NULL `success`). `tooManySkillsActive` is
 * `deadWeightRatio > 0.50 OR loadedContextShare > 0.05`; `tooManyReasons`
 * carries one human-readable string per tripped sub-condition.
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

/**
 * GET /api/skills/loaded row — one loaded skill with its est. context weight,
 * how many sessions loaded it, its invocation count, and the dead-weight flag.
 * `estContextTokens` is estimated from the skill description's character
 * length via the 4-chars-per-token heuristic (SEM2-287), with
 * `FLAT_SKILL_TOKEN_ESTIMATE` as the documented NULL/empty fallback.
 */
export interface SkillLoadedRow {
  skill: string;
  loadedInSessions: number;
  /**
   * `loadedInSessions × estimateSkillTokens(skill_description)` —
   * `COALESCE(CEIL(LENGTH(description)/4), FLAT_SKILL_TOKEN_ESTIMATE)`.
   */
  estContextTokens: number;
  invocations: number;
  /** loaded in the period but never invoked in it (§4.3). */
  isDeadWeight: boolean;
}

/**
 * GET /api/skills/invocations row — per-skill invocation stats. Skill names use
 * `COALESCE(skill_name, parameters->>'skill')` so historical rows still appear.
 * `successRate` is `null` when no row has a non-NULL `success` (KPI-006).
 */
export interface SkillInvocationRow {
  skill: string;
  invocations: number;
  sessionsUsing: number;
  successCount: number;
  failureCount: number;
  /** KPI-006: null when the skill has only NULL-success calls ("no data"). */
  successRate: number | null;
  avgPerSession: number;
}

/** GET /api/skills/trend row — one Skills-Per-Session trend point. */
export interface SkillTrendPoint {
  timestamp: string;
  /** AVG over the bucket's sessions of distinct skills loaded per session. */
  avgLoadedPerSession: number;
  /** AVG over the bucket's sessions of distinct skills invoked per session. */
  avgInvokedPerSession: number;
}

/**
 * A single same-session thrash row — a `(sessionId, skill)` pair whose
 * `invocationsInSession` reached `SKILL_THRASH_MIN` (= 2, D12).
 * `isKnownReentrant` is true for skills in `KNOWN_REENTRANT_SKILLS` (those rows
 * are still shown but should be de-emphasised).
 */
export interface SkillThrashRow {
  sessionId: string;
  skill: string;
  invocationsInSession: number;
  isKnownReentrant: boolean;
}

/**
 * GET /api/skills/not-required — the same-session thrash signal: flagged rows
 * plus a small summary. Powers the "Possibly-Unnecessary Invocations" table.
 */
export interface SkillNotRequiredData {
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
  projectName?: string;
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
  projectName?: string;
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

// ---------------------------------------------------------------------------
// Prompts API responses
// ---------------------------------------------------------------------------

/** A single bucket in a histogram distribution. */
export interface DistributionBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

/** GET /api/prompts/ranked row — a single ranked prompt entry. */
export interface PromptRankingRow {
  turnId: string;
  sessionId: string;
  promptPreview: string;
  responseCost: number;
  complexityScore: number;
  toolCallCount: number;
  totalTokens: number;
  multiTurnDepth: number;
  hasThinking: boolean;
  model: string;
  timestamp: string;
}

/** GET /api/prompts/stats — aggregate prompt statistics. */
export interface PromptStatsData {
  /** User prompts that received an assistant response (KPI-004). */
  totalPrompts: number;
  /** KPI-004: user prompts with no assistant response (excluded from totals). */
  promptsWithNoResponse: number;
  avgCost: number;
  maxCost: number;
  avgComplexity: number;
  costDistribution: DistributionBucket[];
  complexityDistribution: DistributionBucket[];
}

/** GET /api/prompts/throughput — agentic-depth / throughput metrics. */
export interface PromptThroughputData {
  /** Responded prompts (multi_turn_depth > 0) in the filtered range. */
  totalPrompts: number;
  /** Distinct sessions those prompts span. */
  totalSessions: number;
  /** Responded prompts per session. */
  promptsPerSession: number;
  /** Average assistant turns per prompt (agentic depth). */
  turnsPerPrompt: number;
  /** Average tool calls per prompt. */
  toolCallsPerPrompt: number;
}

/** GET /api/prompts/throughput response shape. */
export interface PromptThroughputResponse {
  data: PromptThroughputData;
  meta: {
    period: string;
    timestamp: string;
  };
}

/** Tool call associated with a prompt detail. */
export interface PromptToolCall {
  toolCallId: string;
  toolName: string;
  toolType: string;
  mcpServer: string | null;
  durationMs: number | null;
  success: boolean | null;
}

/** GET /api/prompts/:turnId — full prompt detail. */
export interface PromptDetailData {
  turnId: string;
  sessionId: string;
  promptText: string | null;
  responseText: string | null;
  responseCost: number;
  complexityScore: number;
  toolCallCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  multiTurnDepth: number;
  hasThinking: boolean;
  model: string;
  timestamp: string;
  toolCalls: PromptToolCall[];
}

/** GET /api/prompts/ranked response shape. */
export interface PromptRankingResponse {
  data: PromptRankingRow[];
  meta: {
    total: number;
    page: number;
    limit: number;
    period: string;
    timestamp: string;
  };
}

/** GET /api/prompts/stats response shape. */
export interface PromptStatsResponse {
  data: PromptStatsData;
  meta: {
    period: string;
    timestamp: string;
  };
}

/** GET /api/prompts/:turnId response shape. */
export interface PromptDetailResponse {
  data: PromptDetailData | null;
  meta: {
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Ingest (POST /api/ingest)
// ---------------------------------------------------------------------------

/**
 * Summary of one ingestion pass. Mirrors `IngestionResult` in the parent
 * package (`src/types/index.ts`) — kept in sync manually because the dashboard
 * build does not import the CLI source for types.
 */
export interface IngestResult {
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
