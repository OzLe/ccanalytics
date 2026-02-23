# ccanalytics V0 Deep Analysis

> Comprehensive extraction of all requirements, technology decisions, data surfaces,
> constraints, and architectural drivers from the ccanalytics V0 plan document.
>
> Source: `docs/ccanalytics-V0.md`
> Analysis date: 2026-02-23

---

## 1. Project Overview

**ccanalytics** is a local-first CLI analytics engine for Claude Code. It aggregates
token usage, cost, tool call patterns, caching efficiency, and session behavior from
Claude Code's native data surfaces -- JSONL session transcripts, OpenTelemetry
metrics/events, and lifecycle hooks -- into a DuckDB-backed analytical store. The tool
is distributed as an npx-installable TypeScript CLI and is designed to scale from a
single developer's laptop to team-wide observability without a rewrite.

### Core thesis

Claude Code already computes and stores `costUSD` per turn and full token breakdowns.
ccanalytics' job is **aggregation and visualization, not calculation**. The richest
path combines direct JSONL ingestion into DuckDB with OTel event hooks for real-time
streaming.

---

## 2. Functional Requirements

| ID | Requirement | V0 Section |
|----|-------------|------------|
| FR-01 | Parse JSONL session transcripts from `~/.claude/projects/` | Data surfaces, DuckDB section |
| FR-02 | Deduplicate streaming entries using `requestId` (last entry wins) | JSONL surface description |
| FR-03 | Ingest data incrementally using byte-offset tracking per file | DuckDB section (ingestion_state) |
| FR-04 | Watch for new/changed JSONL files in real time (Chokidar) | DuckDB section |
| FR-05 | Handle partial writes with `awaitWriteFinish` (2-second stability threshold) | DuckDB section |
| FR-06 | Store data in a star schema with 5 core tables | DuckDB section |
| FR-07 | Calculate and expose cache hit rate metric | Analytics dimensions |
| FR-08 | Calculate and expose context window utilization metric | Analytics dimensions |
| FR-09 | Calculate and expose input/output token ratio metric | Analytics dimensions |
| FR-10 | Track tool call patterns including MCP server-level aggregation | Analytics dimensions |
| FR-11 | Track session duration distribution | Analytics dimensions |
| FR-12 | Track conversation depth (turns per session) | Analytics dimensions |
| FR-13 | Track error rates and retry patterns | Analytics dimensions |
| FR-14 | Track model selection patterns across sessions | Analytics dimensions |
| FR-15 | Track cost trending over time | Analytics dimensions |
| FR-16 | Support per-developer cost tracking | Analytics dimensions |
| FR-17 | Provide `ingest` CLI command | CLI packaging section |
| FR-18 | Provide `query` CLI command | CLI packaging section |
| FR-19 | Provide `watch` CLI command (live file watching) | CLI packaging section |
| FR-20 | Provide `dashboard` CLI command | CLI packaging section |
| FR-21 | Support model-specific pricing for cost calculation | Cost estimation section |
| FR-22 | Cross-validate `costUSD` from JSONL against computed cost | Cost estimation section |
| FR-23 | Archive older data to Parquet with ZSTD compression | DuckDB section |
| FR-24 | Parse sub-agent files (`agent-{shortId}.jsonl` with `isSidechain: true`) | Data storage section |
| FR-25 | Read pre-aggregated `stats-cache.json` for quick summaries | Data storage section |
| FR-26 | Support OTel metric and event ingestion (Surface 2) | Data surfaces |
| FR-27 | Support hooks-based event ingestion (Surface 3) | Data surfaces |
| FR-28 | Support `--output-format json` and `--output-format stream-json` structured output | Data surfaces |
| FR-29 | Identify tool call chains (e.g., Read -> Edit -> Bash sequences) | Analytics dimensions |
| FR-30 | Track success/failure rates per tool | Analytics dimensions |
| FR-31 | Recommend `/compact` when context window utilization exceeds 60% | Analytics dimensions |
| FR-32 | Idempotent upserts via DuckDB `MERGE INTO` for reprocessing | DuckDB section |

---

## 3. Non-Functional Requirements

| ID | Requirement | Detail | V0 Section |
|----|-------------|--------|------------|
| NFR-01 | Local-first processing | All data processed on the developer's machine; nothing leaves by default | Scaling, Privacy |
| NFR-02 | 30-day default data retention | Matches Claude Code's default `logRetentionDays`; configurable in `settings.json` | Data storage |
| NFR-03 | Zero-ETL querying | DuckDB queries JSONL files directly via `read_ndjson()` without a separate ETL step | DuckDB section |
| NFR-04 | npx-installable distribution | Single `npx claude-analytics` invocation to run | CLI packaging |
| NFR-05 | Minimal bundle size | picocolors (7 KB) over chalk (101 KB); nanospinner (20 KB); zero-dep libraries preferred | CLI packaging |
| NFR-06 | Node.js 20+ target | `tsup` target set to `node20` | CLI packaging |
| NFR-07 | CJS bin entry point | ESM bin scripts have cross-version compatibility issues | CLI packaging |
| NFR-08 | Single-writer DuckDB constraint | DuckDB supports concurrent reads but writes are single-threaded | Scaling section |
| NFR-09 | Privacy by default | MCP tool/server names redacted in OTel; prompts not exported unless opted in | Scaling/Privacy |
| NFR-10 | 5-10x storage savings via Parquet archival | ZSTD-compressed Parquet for older data | DuckDB section |
| NFR-11 | Cross-platform file watching | Chokidar v5 provides battle-tested cross-platform filesystem events | CLI packaging |
| NFR-12 | Schema detection reliability | Explicitly specify `columns` types to avoid `read_ndjson` auto-detect surprises | DuckDB section |
| NFR-13 | Scalable to team-wide without rewrite | Architecture supports 4 scaling stages with the same SQL and schema | Scaling section |

---

## 4. Technology Decisions

### 4.1. Core Runtime and Database

| Technology | Version | Role | Rationale (from V0) |
|------------|---------|------|----------------------|
| **@duckdb/node-api** | v1.4.x ("Neo") | Analytical database binding | Official, Promise-native, TypeScript-first, lossless type handling (STRUCT, LIST). Older `duckdb` and `duckdb-async` packages are deprecated and will not receive updates past DuckDB 1.4.x. |
| **DuckDB** | 1.4.x | Embedded OLAP engine | In-process, zero-server, direct JSONL querying via `read_ndjson()`, window functions with QUALIFY, date_trunc for time-bucketing, ASOF JOIN, SUMMARIZE, GROUPING SETS / ROLLUP. |
| **Node.js** | >= 20 | Runtime | Target runtime for tsup build |

### 4.2. CLI Framework and UX

| Technology | Version | Role | Rationale (from V0) |
|------------|---------|------|----------------------|
| **Commander** | v12 | CLI framework | 109M weekly downloads, zero deps, TypeScript types, subcommand support, auto-generated help text |
| **picocolors** | latest | Terminal colors | 7 KB vs chalk's 101 KB, 2x faster, zero deps |
| **nanospinner** | latest | Progress spinner | 20 KB, single dep (picocolors), CJS+ESM compatible |
| **cli-table3** | latest | Table rendering | Unicode table rendering with column spanning |

### 4.3. Build and Infrastructure

| Technology | Version | Role | Rationale (from V0) |
|------------|---------|------|----------------------|
| **tsup** | latest | Build tool | esbuild-powered, zero-config, preserves shebangs, dual CJS/ESM output |
| **Vitest** | latest | Test framework | Fast, TypeScript-native |
| **Chokidar** | v5 | File watching | Battle-tested, cross-platform, `awaitWriteFinish` for partial write safety |

### 4.4. Key technology constraints

- **CJS for bin entry point**: ESM bin scripts still have compatibility issues across Node.js versions. tsup is configured to output `.cjs` format for the CLI entry.
- **DuckDB single-writer**: Concurrent reads from multiple connections work fine; writes are single-threaded. Acceptable for single-process ingestion.
- **@duckdb/node-api is mandatory**: The older `duckdb` and `duckdb-async` npm packages are deprecated and frozen at DuckDB 1.4.x.

---

## 5. Data Collection Surfaces

### Surface 1: JSONL File Parsing (Passive, Complete History)

| Aspect | Detail |
|--------|--------|
| **Mechanism** | Read `~/.claude/projects/` directory tree and parse JSONL files |
| **Latency** | After-the-fact (file must be written first) |
| **Completeness** | Every conversation turn, tool call, token count, and cost |
| **Deduplication** | Required -- streaming can produce duplicate entries sharing the same `requestId`; last entry per `requestId` wins |
| **File structure** | `~/.claude/projects/{encoded-path}/{sessionId}.jsonl` |
| **Path encoding** | Dashes replace slashes in project paths (e.g., `-Users-sam-Projects-my-app/`) |
| **Sub-agents** | Separate files: `agent-{shortId}.jsonl` with `isSidechain: true` |
| **Retention** | Default 30 days, configurable via `logRetentionDays` in `settings.json` |
| **Supplementary files** | `sessions-index.json` (session metadata), `stats-cache.json` (pre-aggregated usage), `history.jsonl` (global prompt history), `debug/{sessionId}.txt` (debug logs) |
| **Proven by** | ccusage, goccc |

### Surface 2: Native OpenTelemetry Export (Real-Time, Structured Metrics)

| Aspect | Detail |
|--------|--------|
| **Activation** | `CLAUDE_CODE_ENABLE_TELEMETRY=1` |
| **Metric export interval** | Default 60 seconds; configurable via `OTEL_METRIC_EXPORT_INTERVAL` |
| **Log export interval** | Default 5 seconds; configurable via `OTEL_LOGS_EXPORT_INTERVAL` |
| **Supported exporters** | OTLP (gRPC/HTTP), Prometheus, console |
| **Standard attributes** | `session.id`, `app.version`, `organization.id`, `user.account_uuid`, `terminal.type` |
| **Privacy controls** | MCP tool/server names redacted by default (`OTEL_LOG_TOOL_DETAILS=1` to enable); prompt content requires `OTEL_LOG_USER_PROMPTS=1` |
| **Metrics** | 8 counter/gauge metrics (see Section 12) |
| **Events** | 4 event types via logs protocol (see Section 12) |

### Surface 3: Hooks System (Event-Driven, Programmable)

| Aspect | Detail |
|--------|--------|
| **Configuration** | `settings.json` under the `hooks` key |
| **Hook types** | Shell commands, LLM evaluations, agent checks |
| **Lifecycle events** | 14 events (see Section 13) |
| **Stdin payload** | JSON with `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and event-specific fields (`tool_name`, `tool_input` for tool hooks) |
| **Matchers** | Filter by tool name patterns (e.g., `"matcher": "mcp__github__.*"`) |
| **statusLine API** | Rich JSON after every assistant message: real-time `context_window` utilization (used/remaining percentage), cumulative `cost` data, model information |

### Additional Data Access

| Method | Detail |
|--------|--------|
| `--output-format json` | Complete result object: `total_cost_usd`, `duration_ms`, `num_turns`, per-model `modelUsage` breakdowns (including `contextWindow`, `maxOutputTokens`), `permission_denials` |
| `--output-format stream-json` | NDJSON stream: `init`, `content_block_delta`, `assistant`, `user`, `result` message types |

---

## 6. JSONL Message Schema

### 6.1. Message Types

The four message types found in session JSONL files:

| Type | Description |
|------|-------------|
| `user` | User prompts and input |
| `assistant` | Model responses with billing payload |
| `file-history-snapshot` | File state snapshots |
| `queue-operation` | Queue management events |

### 6.2. Assistant Message Fields (Billing Payload)

This is the richest message type for analytics:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"assistant"` |
| `sessionId` | UUID string | Session identifier |
| `timestamp` | ISO 8601 string | Turn timestamp (e.g., `"2025-12-22T21:19:24.929Z"`) |
| `costUSD` | float | Pre-calculated cost for this turn |
| `usage.input_tokens` | integer | Uncached input tokens |
| `usage.output_tokens` | integer | Output tokens (includes thinking tokens) |
| `usage.cache_creation_input_tokens` | integer | Tokens written to cache |
| `usage.cache_read_input_tokens` | integer | Tokens read from cache |
| `requestId` | string | API request ID for deduplication (e.g., `"req_011CWfFS..."`) |
| `parentUuid` | string | Links request-response pairs |
| `version` | string | Claude Code version |
| `gitBranch` | string | Current git branch for project context |
| `message.content` | array | Array of content blocks |

### 6.3. Content Block Types

Content blocks inside `message.content`:

| Block type | Fields | Description |
|------------|--------|-------------|
| `thinking` | `thinking` (string), `signature` (string) | Model's chain-of-thought reasoning |
| `tool_use` | `id` (string), `name` (string), `input` (object) | Tool invocation; MCP tools follow `mcp__<server>__<tool>` naming |
| `text` | `text` (string) | Plain text response |

### 6.4. Deduplication Rule

Streaming can produce **duplicate JSONL entries** sharing the same `requestId`. The
canonical record is determined by **last entry wins** -- the final entry for a given
`requestId` is the authoritative one.

### 6.5. stats-cache.json Structure

| Field | Description |
|-------|-------------|
| `dailyActivity` | Message, session, and tool call counts per day |
| `dailyModelTokens` | Token usage broken down by model and day |
| `modelUsage` | Cumulative token breakdowns per model |
| `totalSessions` | Total session count |
| `totalMessages` | Total message count |
| `longestSession` | Duration of the longest session |
| `hourCounts` | Activity distribution by hour-of-day |
| `firstSessionDate` | Earliest recorded session date |

---

## 7. Star Schema Design

### 7.1. Table: sessions

| Column | Type | Constraint | Description |
|--------|------|------------|-------------|
| session_id | VARCHAR | PK | UUID from JSONL `sessionId` |
| start_time | TIMESTAMP | | First message timestamp |
| end_time | TIMESTAMP | | Last message timestamp |
| duration | INTERVAL | | end_time - start_time |
| model | VARCHAR | | Model used for the session |
| total_input_tokens | BIGINT | | Sum of input tokens |
| total_output_tokens | BIGINT | | Sum of output tokens |
| total_cache_write_tokens | BIGINT | | Sum of cache_creation_input_tokens |
| total_cache_read_tokens | BIGINT | | Sum of cache_read_input_tokens |
| total_cost | DECIMAL | | Sum of costUSD across turns |
| num_turns | INTEGER | | Count of conversation turns |
| num_tool_calls | INTEGER | | Count of tool_use blocks |
| cwd | VARCHAR | | Working directory |
| source_file | VARCHAR | | Path to the JSONL file |

### 7.2. Table: conversation_turns

| Column | Type | Constraint | Description |
|--------|------|------------|-------------|
| turn_id | VARCHAR | PK | Generated turn identifier |
| session_id | VARCHAR | FK -> sessions | Parent session |
| role | VARCHAR | | `user`, `assistant`, etc. |
| timestamp | TIMESTAMP | | Turn timestamp |
| input_tokens | BIGINT | | Input tokens for this turn |
| output_tokens | BIGINT | | Output tokens for this turn |
| cache_write_tokens | BIGINT | | Cache creation tokens |
| cache_read_tokens | BIGINT | | Cache read tokens |
| cost | DECIMAL | | costUSD for this turn |
| model | VARCHAR | | Model used |
| stop_reason | VARCHAR | | API stop reason |

### 7.3. Table: tool_calls

| Column | Type | Constraint | Description |
|--------|------|------------|-------------|
| tool_call_id | VARCHAR | PK | From `tool_use` content block `id` |
| session_id | VARCHAR | FK -> sessions | Parent session |
| turn_id | VARCHAR | FK -> conversation_turns | Parent turn |
| tool_name | VARCHAR | | Tool name (e.g., `Bash`, `mcp__github__create_pr`) |
| duration_ms | BIGINT | | Execution duration |
| success | BOOLEAN | | Whether the tool call succeeded |
| error_message | VARCHAR | | Error message if failed |
| parameters | JSON | | Tool input parameters (DuckDB JSON type) |

### 7.4. Table: errors

| Column | Type | Constraint | Description |
|--------|------|------------|-------------|
| error_id | VARCHAR | PK | Generated error identifier |
| session_id | VARCHAR | FK -> sessions | Parent session |
| timestamp | TIMESTAMP | | Error timestamp |
| error_type | VARCHAR | | Error classification |
| message | VARCHAR | | Error message text |
| is_retryable | BOOLEAN | | Whether the error is retryable |
| retry_count | INTEGER | | Number of retries attempted |

### 7.5. Table: ingestion_state

| Column | Type | Constraint | Description |
|--------|------|------------|-------------|
| file_path | VARCHAR | PK | Absolute path to JSONL file |
| last_byte_offset | BIGINT | | Byte position of last ingested data |
| last_line_number | BIGINT | | Line number of last ingested line |
| last_ingested_at | TIMESTAMP | | Timestamp of last ingestion |
| checksum | VARCHAR | | File checksum for integrity |

---

## 8. Analytics Metrics

### 8.1. Cache Hit Rate

**The single most impactful optimization metric.**

```
cache_hit_rate = cache_read_tokens / (cache_read_tokens + cache_write_tokens + uncached_input_tokens)
```

| Threshold | Interpretation |
|-----------|----------------|
| > 80% | Effective caching |
| < 50% | Wasted spend; each cache hit saves 90% of input cost |
| Declining trend | Prompt structures changing too frequently |

Track per session and over time.

### 8.2. Context Window Utilization

```
context_window_utilization = total_input_tokens / max_context_window
```

| Threshold | Interpretation |
|-----------|----------------|
| > 60% | Risk of degraded quality; recommend `/compact` |
| MCP overhead | Tool definitions alone can consume 30-70% of context before conversation starts |

The `context_window` data from the statusLine API provides real-time tracking.

### 8.3. Input/Output Token Ratio

```
io_ratio = total_input_tokens / total_output_tokens
```

| Ratio | Workload Type |
|-------|---------------|
| 3-5:1 | Typical coding session (large code context, moderate output) |
| > 10:1 | Model is mostly reading context with minimal generation |
| < 1:1 | Heavy generation tasks |

Track per tool to reveal which tools consume disproportionate tokens.

### 8.4. Tool Call Patterns

- **Call frequency**: Which tools dominate
- **Call chains**: Common sequences (e.g., Read -> Edit -> Bash)
- **Success/failure rates**: Per tool
- **Per-tool token cost**: Token expenditure attributed to each tool
- **MCP naming convention**: `mcp__<server>__<tool>` enables server-level aggregation
- **Key insight**: GitHub's MCP server alone uses ~25% of Sonnet's context window
- **Mitigation**: Anthropic's Tool Search (January 2026) loads definitions on-demand, reducing overhead by 85%

### 8.5. Additional Dimensions

| Dimension | Description |
|-----------|-------------|
| Session duration distribution | Histogram of session lengths |
| Conversation depth | Turns per session |
| Error rates and retry patterns | Via `claude_code.api_error` OTel events (`status_code`, `attempt` fields) |
| Model selection patterns | Which models are used across sessions |
| Cost trending over time | Daily/weekly/monthly cost aggregation |
| Per-developer cost | Average ~$6/developer/day; 90% of users under $12/day |

---

## 9. CLI Command Patterns

| Command | Purpose | Notes |
|---------|---------|-------|
| `ingest` | Parse JSONL files and load into DuckDB | Batch ingestion with incremental byte-offset tracking |
| `query` | Run analytical queries against the DuckDB store | Ad-hoc SQL or pre-built query templates |
| `watch` | Live file watching with real-time ingestion | Chokidar-based, `awaitWriteFinish` for safety |
| `dashboard` | Terminal-based analytics dashboard | Aggregated views of key metrics |

All commands are subcommands of the main CLI binary (e.g., `claude-analytics ingest`,
`claude-analytics query`). Commander v12 provides auto-generated help text for each
subcommand.

### Package distribution

```json
{
  "name": "claude-analytics",
  "bin": { "claude-analytics": "./dist/cli.cjs" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "prepublishOnly": "npm run build"
  }
}
```

Verify with `npm pack --dry-run` before publishing.

---

## 10. Model Pricing

### 10.1. Pricing Table (per million tokens, as of early 2026)

| Model | Input | Cache Write (5-min TTL) | Cache Read | Output |
|-------|-------|-------------------------|------------|--------|
| Claude Opus 4.5 | $5.00 | $6.25 | $0.50 | $25.00 |
| Claude Sonnet 4.5 | $3.00 | $3.75 | $0.30 | $15.00 |
| Claude Haiku 4.5 | $1.00 | $1.25 | $0.10 | $5.00 |

### 10.2. Cost Formula (per turn)

```
cost = (uncached_input * base_input / 1_000_000)
     + (cache_write   * base_input * 1.25 / 1_000_000)
     + (cache_read    * base_input * 0.10 / 1_000_000)
     + (output        * output_price / 1_000_000)
```

### 10.3. Important notes

- **Thinking tokens bill as output tokens** -- they are included in `output_tokens`.
- The JSONL `costUSD` field contains the **pre-calculated** cost per turn from the
  server, making manual price tracking optional but useful for **cross-validation**.
- Cache write cost is 1.25x base input price.
- Cache read cost is 0.10x base input price (90% savings).

---

## 11. Scaling Stages

### Stage 1: Local DuckDB File

| Aspect | Detail |
|--------|--------|
| Storage | Single `analytics.duckdb` file on disk |
| Target | Individual developer analytics |
| Setup | Zero server setup (in-process engine) |
| Concurrency | Concurrent reads OK; writes single-threaded |
| Ad-hoc queries | `duckdb analytics.duckdb -json -c "SELECT ..."` |

### Stage 2: MotherDuck (Team Sharing)

| Aspect | Detail |
|--------|--------|
| Migration | Change connection string from local path to `md:team_analytics` |
| Compatibility | Same SQL, same schema |
| Execution | Hybrid -- quick queries locally, heavy aggregations in cloud |
| Cost | Free tier available |

### Stage 3: PostgreSQL via pg_duckdb

| Aspect | Detail |
|--------|--------|
| Target | Teams already running PostgreSQL |
| Extension | `pg_duckdb` v1.0 |
| Performance | Up to 1,500x faster analytical queries on existing tables |
| Architecture | DuckDB handles reads; PostgreSQL handles transactions and access control |

### Stage 4: ClickHouse or Dedicated OLAP

| Aspect | Detail |
|--------|--------|
| Target | Large organizations processing billions of log entries |
| Export | Partitioned Parquet: `COPY ... TO 'archive/' (FORMAT PARQUET, PARTITION_BY (date_month))` |
| Hybrid option | DuckDB can query ClickHouse directly as a remote data source |

### Data Export Formats

DuckDB natively supports export to: Parquet (ZSTD compression), CSV, JSON, and direct
PostgreSQL writes via the `postgres` extension (`ATTACH 'postgres:dbname=...'`).

### Privacy Considerations Across Stages

- Strip or hash personal identifiers before team aggregation
- OTel redacts prompts and MCP tool names by default (opt-in only)
- Community tools (ccusage) process data locally with nothing leaving the machine
- Implement RBAC: individuals see only their data; admins access team aggregates

---

## 12. OpenTelemetry Details

### 12.1. Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Activate OTel export | `0` (disabled) |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval | 60 seconds |
| `OTEL_LOGS_EXPORT_INTERVAL` | Log/event export interval | 5 seconds |
| `OTEL_LOG_TOOL_DETAILS` | Enable MCP tool/server name export (redacted by default) | `0` (redacted) |
| `OTEL_LOG_USER_PROMPTS` | Enable prompt content export | `0` (disabled) |

### 12.2. Counter/Gauge Metrics (8 total)

| # | Metric Name | Type | Description |
|---|-------------|------|-------------|
| 1 | `claude_code.session.count` | Counter | Number of sessions |
| 2 | `claude_code.token.usage` | Counter | Token consumption |
| 3 | `claude_code.cost.usage` | Counter | Cost in USD |
| 4 | `claude_code.lines_of_code.count` | Counter | Lines of code changed |
| 5 | `claude_code.pull_request.count` | Counter | Pull requests created |
| 6 | `claude_code.commit.count` | Counter | Commits made |
| 7 | `claude_code.code_edit_tool.decision` | Counter | Code edit tool decisions |
| 8 | `claude_code.active_time.total` | Gauge | Total active time |

### 12.3. Event Types (4 total, via logs protocol)

| # | Event Name | Description |
|---|------------|-------------|
| 1 | `claude_code.user_prompt` | User prompt submitted (requires `OTEL_LOG_USER_PROMPTS=1` for content) |
| 2 | `claude_code.tool_result` | Tool execution result |
| 3 | `claude_code.api_request` | API request to Anthropic |
| 4 | `claude_code.api_error` | API error (includes `status_code` and `attempt` fields) |

### 12.4. Standard Attributes (on every metric)

| Attribute | Description |
|-----------|-------------|
| `session.id` | Session identifier |
| `app.version` | Claude Code version |
| `organization.id` | Organization identifier |
| `user.account_uuid` | User account UUID |
| `terminal.type` | Terminal type |

### 12.5. Supported Exporters

- OTLP (gRPC)
- OTLP (HTTP)
- Prometheus
- Console

---

## 13. Hooks System Details

### 13.1. All 14 Lifecycle Events

| # | Event | Description | Category |
|---|-------|-------------|----------|
| 1 | `SessionStart` | Session begins | Session lifecycle |
| 2 | `SessionEnd` | Session ends | Session lifecycle |
| 3 | `UserPromptSubmit` | User submits a prompt | User interaction |
| 4 | `PreToolUse` | Before a tool is executed | Tool lifecycle |
| 5 | `PostToolUse` | After a tool executes successfully | Tool lifecycle |
| 6 | `PostToolUseFailure` | After a tool execution fails | Tool lifecycle |
| 7 | `PermissionRequest` | Permission requested for an action | Security |
| 8 | `Stop` | Agent stops | Agent lifecycle |
| 9 | `SubagentStop` | Sub-agent stops | Agent lifecycle |
| 10 | `SubagentStart` | Sub-agent starts | Agent lifecycle |
| 11 | `Notification` | Notification emitted | Notification |
| 12 | `PreCompact` | Before context compaction | Context management |
| 13 | `TeammateIdle` | Teammate agent becomes idle | Multi-agent |
| 14 | `TaskCompleted` | A task is completed | Task management |

### 13.2. Hook Types

- Shell commands
- LLM evaluations
- Agent checks

### 13.3. Stdin JSON Payload

All hooks receive JSON via stdin with these base fields:

| Field | Description |
|-------|-------------|
| `session_id` | Session identifier |
| `transcript_path` | Path to the session JSONL file |
| `cwd` | Current working directory |
| `hook_event_name` | Name of the hook event |

Tool-specific hooks additionally receive:

| Field | Description |
|-------|-------------|
| `tool_name` | Name of the tool |
| `tool_input` | Input parameters for the tool |

### 13.4. Matcher Support

Hooks support matchers for filtering by tool name patterns:
```json
{ "matcher": "mcp__github__.*" }
```

### 13.5. statusLine API

Complementary to hooks; sends rich JSON after every assistant message:

| Data | Description |
|------|-------------|
| `context_window` | Real-time utilization: used/remaining percentage |
| `cost` | Cumulative cost data |
| Model information | Current model details |

### 13.6. Ideal Ingestion Triggers

- `PostToolUse` -- for real-time tool call tracking
- `SessionEnd` -- for session-complete ingestion

---

## 14. Constraints and Gotchas

| # | Constraint | Detail | Mitigation |
|---|-----------|--------|------------|
| 1 | 30-day log retention | Default retention; older files auto-deleted by Claude Code | Archive to Parquet before expiration; or increase `logRetentionDays` in `settings.json` |
| 2 | Streaming deduplication | Streaming produces duplicate JSONL entries with the same `requestId` | Last entry per `requestId` wins; use `MERGE INTO` for idempotent upserts |
| 3 | Partial writes | JSONL files may be read before a write completes | Chokidar's `awaitWriteFinish` with 2-second stability threshold |
| 4 | MCP tool name redaction | OTel redacts MCP tool/server names by default | Set `OTEL_LOG_TOOL_DETAILS=1` to enable |
| 5 | DuckDB single-writer | Only one process can write at a time | Acceptable for single-process ingestion; architect ingestion as a single writer |
| 6 | Schema detection surprises | `read_ndjson()` auto-detects schema by sampling up to 20,480 rows | Explicitly specify `columns` types in production |
| 7 | ESM bin compatibility | ESM bin scripts have cross-version Node.js issues | Use CJS (`.cjs`) for the bin entry point |
| 8 | Prompt content privacy | Prompts not exported via OTel by default | Requires explicit `OTEL_LOG_USER_PROMPTS=1` |
| 9 | MCP context overhead | GitHub MCP server alone uses ~25% of Sonnet's context window | Anthropic's Tool Search (Jan 2026) reduces overhead by 85% |
| 10 | Thinking token billing | Thinking tokens are billed as output tokens | Include in output token accounting |
| 11 | Path encoding | Project paths use dashes replacing slashes | Decode `-Users-sam-Projects-my-app` -> `/Users/sam/Projects/my-app` |
| 12 | Sub-agent separation | Sub-agents write to `agent-{shortId}.jsonl` with `isSidechain: true` | Must discover and parse these files separately |
| 13 | Config path variation | `~/.claude/` on older versions; `~/.config/claude/` on v1.0.30+ | Check both paths |
| 14 | Cache TTL | Cache write has a 5-minute TTL | Cache hit rate is affected by prompt timing patterns |

---

## 15. Existing Tools and Prior Art

| Tool | Language | Approach | Key Insight |
|------|----------|----------|-------------|
| **ccusage** | -- | Parses local JSONL files; daily/monthly/session views with per-model breakdowns | Proves JSONL parsing works end-to-end |
| **goccc** | Go | Handles streaming deduplication via `requestId` | Validates deduplication strategy |
| **claude-code-otel** | -- | OTel Collector -> Prometheus + Loki -> Grafana; pre-built dashboards | Proves OTel surface is production-ready |
| **claude-code-hooks-multi-agent-observability** | -- | Real-time hook event monitoring; SQLite + WebSocket + Vue | Validates hooks as a data surface |
| **Langfuse** | -- | Open-source (Apache 2.0) LLM observability; native Anthropic support | Enterprise-scale alternative |
| **Helicone** | -- | Full LLM observability with native Anthropic support | Enterprise-scale alternative |
| **LiteLLM** | Python | Gateway for multi-cloud Claude Code deployments (Bedrock/Vertex) | Multi-provider aggregation |

---

## 16. Requirements Traceability Matrix

| Requirement ID | Requirement | V0 Document Section |
|----------------|-------------|---------------------|
| FR-01 | Parse JSONL session transcripts | "Three data collection surfaces" (Surface 1); "DuckDB as the analytics engine" |
| FR-02 | Deduplicate via requestId (last wins) | "Claude Code stores structured gold" (requestId discussion) |
| FR-03 | Incremental ingestion via byte offsets | "DuckDB as the analytics engine" (ingestion_state table) |
| FR-04 | Real-time file watching | "DuckDB as the analytics engine" (Chokidar paragraph) |
| FR-05 | Handle partial writes (awaitWriteFinish) | "DuckDB as the analytics engine" (awaitWriteFinish mention) |
| FR-06 | Star schema with 5 tables | "DuckDB as the analytics engine" (schema listing) |
| FR-07 | Cache hit rate metric | "Analytics dimensions" (Cache hit rate subsection) |
| FR-08 | Context window utilization metric | "Analytics dimensions" (Context window utilization subsection) |
| FR-09 | Input/output token ratio metric | "Analytics dimensions" (Input/output token ratio subsection) |
| FR-10 | Tool call pattern tracking | "Analytics dimensions" (Tool call patterns subsection) |
| FR-11 | Session duration distribution | "Analytics dimensions" (Additional high-value dimensions) |
| FR-12 | Conversation depth tracking | "Analytics dimensions" (Additional high-value dimensions) |
| FR-13 | Error rate and retry tracking | "Analytics dimensions" (Additional high-value dimensions) |
| FR-14 | Model selection pattern tracking | "Analytics dimensions" (Additional high-value dimensions) |
| FR-15 | Cost trending over time | "Analytics dimensions" (Additional high-value dimensions) |
| FR-16 | Per-developer cost tracking | "Analytics dimensions" (budget management) |
| FR-17 | `ingest` CLI command | "Packaging as an npx-installable TypeScript CLI" |
| FR-18 | `query` CLI command | "Packaging as an npx-installable TypeScript CLI" |
| FR-19 | `watch` CLI command | "Packaging as an npx-installable TypeScript CLI" |
| FR-20 | `dashboard` CLI command | "Packaging as an npx-installable TypeScript CLI" |
| FR-21 | Model-specific pricing support | "Analytics dimensions" (Cost estimation per model) |
| FR-22 | Cross-validate costUSD | "Analytics dimensions" (cost formula note) |
| FR-23 | Parquet archival with ZSTD | "DuckDB as the analytics engine" (archive paragraph) |
| FR-24 | Parse sub-agent files | "Claude Code stores structured gold" (sub-agents) |
| FR-25 | Read stats-cache.json | "Claude Code stores structured gold" (stats-cache paragraph) |
| FR-26 | OTel metric/event ingestion | "Three data collection surfaces" (Surface 2) |
| FR-27 | Hooks-based event ingestion | "Three data collection surfaces" (Surface 3) |
| FR-28 | JSON/stream-json output formats | "Three data collection surfaces" (output-format flags) |
| FR-29 | Tool call chain detection | "Analytics dimensions" (Tool call patterns -- call chains) |
| FR-30 | Per-tool success/failure rates | "Analytics dimensions" (Tool call patterns -- success/failure) |
| FR-31 | Recommend /compact at 60% utilization | "Analytics dimensions" (Context window utilization) |
| FR-32 | Idempotent upserts via MERGE INTO | "DuckDB as the analytics engine" (MERGE INTO mention) |
| NFR-01 | Local-first processing | "Scaling from local DuckDB" (Privacy paragraph) |
| NFR-02 | 30-day default retention | "Claude Code stores structured gold" (retention) |
| NFR-03 | Zero-ETL querying | "DuckDB as the analytics engine" (title and first paragraph) |
| NFR-04 | npx-installable distribution | "Packaging as an npx-installable TypeScript CLI" (title) |
| NFR-05 | Minimal bundle size | "Packaging as an npx-installable TypeScript CLI" (technology table rationale) |
| NFR-06 | Node.js 20+ target | "Packaging as an npx-installable TypeScript CLI" (tsup config) |
| NFR-07 | CJS bin entry point | "Packaging as an npx-installable TypeScript CLI" (CJS note) |
| NFR-08 | Single-writer DuckDB constraint | "Scaling from local DuckDB" (Stage 1) |
| NFR-09 | Privacy by default | "Scaling from local DuckDB" (Privacy paragraph); "Three data collection surfaces" (Surface 2 privacy) |
| NFR-10 | 5-10x storage savings via Parquet | "DuckDB as the analytics engine" (archive paragraph) |
| NFR-11 | Cross-platform file watching | "Packaging as an npx-installable TypeScript CLI" (Chokidar rationale) |
| NFR-12 | Schema detection reliability | "DuckDB as the analytics engine" (columns types note) |
| NFR-13 | Scalable without rewrite | "Scaling from local DuckDB" (opening statement) |

---

## 17. DuckDB SQL Features Referenced

The V0 document specifically calls out these DuckDB analytical features as suited to
the ccanalytics workload:

| Feature | Use Case |
|---------|----------|
| `read_ndjson()` / `read_json()` | Direct JSONL querying without ETL |
| Glob patterns in `read_ndjson()` | Multi-file reads across project directories |
| `filename` virtual column | Data lineage tracking |
| `MERGE INTO` | Idempotent upserts for reprocessing |
| Window functions with `QUALIFY` | Ranking tools per session |
| `date_trunc()` | Time-bucket aggregations |
| `ASOF JOIN` | Correlating logs from different sources |
| `SUMMARIZE` | Instant statistical profiles |
| `GROUPING SETS` / `ROLLUP` | Multi-level aggregations in a single pass |
| `COPY ... TO ... (FORMAT PARQUET)` | Parquet export with ZSTD and partitioning |
| `ATTACH 'postgres:...'` | Direct PostgreSQL writes |
| JSON type | Storing tool parameters without schema |

---

## 18. Filesystem Layout

```
~/.claude/                                   (or ~/.config/claude/ on v1.0.30+)
  projects/
    {encoded-path}/
      {sessionId}.jsonl                      <- Full session transcript
      agent-{shortId}.jsonl                  <- Sub-agent transcript (isSidechain: true)
      sessions-index.json                    <- Session metadata
  stats-cache.json                           <- Pre-aggregated usage stats
  history.jsonl                              <- Global prompt history
  debug/
    {sessionId}.txt                          <- Debug logs
  settings.json                              <- Config (hooks, OTel, retention)
```

Path encoding: slashes replaced with dashes. Example:
`/Users/sam/Projects/my-app` -> `-Users-sam-Projects-my-app`

---

## 19. Summary Statistics

| Dimension | Count |
|-----------|-------|
| Functional requirements | 32 |
| Non-functional requirements | 13 |
| Technology decisions | 9 |
| Data collection surfaces | 3 |
| Star schema tables | 5 |
| OTel metrics | 8 |
| OTel event types | 4 |
| OTel environment variables | 5 |
| Hook lifecycle events | 14 |
| CLI commands | 4 |
| Scaling stages | 4 |
| Model pricing entries | 3 |
| Constraints/gotchas | 14 |
| Existing tools analyzed | 7 |
