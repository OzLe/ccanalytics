# Building a local Claude Code analytics engine

Claude Code already exposes everything needed for deep local analytics — **JSONL session transcripts with per-turn token counts and costs, native OpenTelemetry export with 8+ metric types, and a 14-event hooks system** — making a custom analytics CLI entirely feasible without wrapping or proxying the CLI. The richest path combines direct JSONL ingestion into DuckDB with OTel event hooks for real-time streaming, packaged as an npx-installable TypeScript tool using `@duckdb/node-api`, Commander, and Chokidar.

This report maps every moving part: Claude Code's data surfaces, DuckDB's Node.js ecosystem, CLI packaging patterns, analytics dimensions worth tracking, and scaling from solo to team-wide.

---

## Claude Code stores structured gold in ~/.claude/

Claude Code maintains a rich local filesystem at `~/.claude/` (or `~/.config/claude/` on v1.0.30+). The critical directories for analytics are:

```
~/.claude/
├── projects/{encoded-path}/{sessionId}.jsonl   ← Full session transcripts
├── projects/{encoded-path}/sessions-index.json ← Session metadata
├── stats-cache.json                            ← Pre-aggregated usage stats
├── history.jsonl                               ← Global prompt history
├── debug/{sessionId}.txt                       ← Debug logs
└── settings.json                               ← Config including hooks/OTel
```

**Session transcripts** are JSONL files where each line is a typed message — `user`, `assistant`, `file-history-snapshot`, or `queue-operation`. Project paths are encoded with dashes replacing slashes (e.g., `-Users-sam-Projects-my-app/`). Sub-agents get separate files (`agent-{shortId}.jsonl`) with `isSidechain: true`. Default log retention is **30 days**, extendable via `settings.json` by setting `logRetentionDays`.

Assistant messages carry the billing payload — the fields that matter most for analytics:

```json
{
  "type": "assistant",
  "sessionId": "31f3f224-f440-41ac-9244-b27ff054116d",
  "timestamp": "2025-12-22T21:19:24.929Z",
  "costUSD": 0.0834,
  "usage": {
    "input_tokens": 1245,
    "output_tokens": 28756,
    "cache_creation_input_tokens": 512,
    "cache_read_input_tokens": 256
  },
  "requestId": "req_011CWfFS...",
  "message": {
    "content": [
      { "type": "thinking", "thinking": "...", "signature": "..." },
      { "type": "tool_use", "id": "toolu_01...", "name": "Bash", "input": {...} },
      { "type": "text", "text": "Done..." }
    ]
  }
}
```

Key fields include `costUSD` (per-turn cost), the full `usage` token breakdown, `requestId` for deduplication (streaming can produce duplicate entries — last entry per `requestId` wins), `parentUuid` for linking request-response pairs, `version` for Claude Code version, and `gitBranch` for project context. MCP tool calls appear with the naming pattern `mcp__<server>__<tool>` in tool_use content blocks.

The pre-aggregated `stats-cache.json` is also valuable — it contains `dailyActivity` (message/session/tool call counts per day), `dailyModelTokens`, cumulative `modelUsage` with full token breakdowns, `totalSessions`, `totalMessages`, `longestSession`, `hourCounts` by hour-of-day, and `firstSessionDate`.

---

## Three data collection surfaces, from passive to real-time

Claude Code provides three distinct mechanisms for collecting analytics data, each with different tradeoffs.

**Surface 1: JSONL file parsing (passive, complete history).** This is the simplest approach — read the `~/.claude/projects/` directory tree and parse JSONL files. Every conversation turn, tool call, token count, and cost is recorded. Tools like `ccusage` and `goccc` already prove this works. The limitation is latency: you're reading files after they're written, and you need deduplication logic for streaming entries sharing the same `requestId`.

**Surface 2: Native OpenTelemetry export (real-time, structured metrics).** Claude Code has built-in OTel support activated by setting `CLAUDE_CODE_ENABLE_TELEMETRY=1`. This exports eight counter/gauge metrics (`claude_code.session.count`, `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.lines_of_code.count`, `claude_code.pull_request.count`, `claude_code.commit.count`, `claude_code.code_edit_tool.decision`, `claude_code.active_time.total`) and four event types via the logs protocol (`claude_code.user_prompt`, `claude_code.tool_result`, `claude_code.api_request`, `claude_code.api_error`). Every metric carries `session.id`, `app.version`, `organization.id`, `user.account_uuid`, and `terminal.type` as standard attributes. Export interval defaults to **60 seconds for metrics, 5 seconds for logs**, configurable via `OTEL_METRIC_EXPORT_INTERVAL` and `OTEL_LOGS_EXPORT_INTERVAL`. Supported exporters include OTLP (gRPC/HTTP), Prometheus, and console. Privacy controls: MCP tool/server names are redacted by default (enable with `OTEL_LOG_TOOL_DETAILS=1`), and prompt content requires `OTEL_LOG_USER_PROMPTS=1`.

**Surface 3: Hooks system (event-driven, programmable).** The hooks system fires shell commands, LLM evaluations, or agent checks at 14 lifecycle points: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, `SubagentStop`, `SubagentStart`, `Notification`, `PreCompact`, `TeammateIdle`, and `TaskCompleted`. Each hook receives JSON via stdin containing `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and event-specific fields (tool_name, tool_input for tool hooks). Configured in `settings.json` under the `hooks` key, hooks support matchers for filtering by tool name patterns (e.g., `"matcher": "mcp__github__.*"`). A complementary **statusLine** API sends rich JSON after every assistant message, including real-time `context_window` utilization (used/remaining percentage), cumulative `cost` data, and model information.

The **`--output-format json`** and **`--output-format stream-json`** CLI flags also expose structured data. The JSON format returns a complete result object with `total_cost_usd`, `duration_ms`, `num_turns`, per-model `modelUsage` breakdowns (including `contextWindow` and `maxOutputTokens`), and `permission_denials`. The stream-json format emits NDJSON with init, content_block_delta, assistant, user, and result message types — useful for building real-time streaming analytics.

---

## DuckDB as the analytics engine: zero-ETL JSONL querying

**`@duckdb/node-api`** (v1.4.x, "Neo") is the correct binding choice. It's the officially recommended DuckDB Node.js client, binding to DuckDB's C API with native Promise support, TypeScript-first design, and lossless handling of all DuckDB types including STRUCT and LIST. The older `duckdb` and `duckdb-async` packages are **deprecated** and will not receive updates past DuckDB 1.4.x.

DuckDB can query JSONL files directly without any ETL step:

```sql
-- Query Claude Code logs with zero setup
SELECT 
  json->>'sessionId' AS session_id,
  (json->'usage'->>'input_tokens')::BIGINT AS input_tokens,
  json->>'costUSD' AS cost
FROM read_ndjson('~/.claude/projects/**/*.jsonl')
WHERE json->>'type' = 'assistant';
```

The `read_json()` / `read_ndjson()` functions use yyjson internally for high-performance parsing, support glob patterns for multi-file reads, auto-detect schemas by sampling up to 20,480 rows, handle compressed `.json.gz` files, and expose a `filename` virtual column for data lineage. For production reliability, explicitly specifying `columns` types avoids schema detection surprises.

The recommended schema follows a star pattern with five core tables:

- **`sessions`** — session_id (PK), start/end time, duration, model, total tokens by type, total cost, num_turns, num_tool_calls, cwd, source_file
- **`conversation_turns`** — turn_id (PK), session_id (FK), role, timestamp, token breakdown, cost, model, stop_reason
- **`tool_calls`** — tool_call_id (PK), session_id (FK), turn_id (FK), tool_name, duration_ms, success, error_message, parameters (JSON type)
- **`errors`** — error_id (PK), session_id (FK), timestamp, error_type, message, is_retryable, retry_count
- **`ingestion_state`** — file_path (PK), last_byte_offset, last_line_number, last_ingested_at, checksum

For incremental ingestion, the optimal pattern combines Chokidar file watching with batch `INSERT INTO ... SELECT FROM read_json_auto()` statements. Track ingestion progress in the `ingestion_state` table by storing byte offsets per file, reading only new bytes on each change event. Use Chokidar's `awaitWriteFinish` option (with a 2-second stability threshold) to avoid reading partial writes. DuckDB's `MERGE INTO` enables idempotent upserts for reprocessing. Periodically archive older data to Parquet with ZSTD compression for 5-10x storage savings and faster analytical reads.

DuckDB's analytical features are particularly suited to this workload: window functions with `QUALIFY` for ranking tools per session, `date_trunc()` for time-bucket aggregations, `ASOF JOIN` for correlating logs from different sources, `SUMMARIZE` for instant statistical profiles, and `GROUPING SETS` / `ROLLUP` for multi-level aggregations in a single pass.

---

## Packaging as an npx-installable TypeScript CLI

The recommended technology stack, selected for reliability and minimal bundle size:

| Component | Choice | Rationale |
|-----------|--------|-----------|
| CLI framework | **Commander** v12 | 109M weekly downloads, zero deps, TypeScript types, subcommand support |
| Build tool | **tsup** | esbuild-powered, zero-config, preserves shebangs, dual CJS/ESM output |
| File watching | **Chokidar** v5 | Battle-tested, cross-platform, `awaitWriteFinish` for log files |
| Colors | **picocolors** | 7 KB vs chalk's 101 KB, 2x faster, zero deps |
| Spinner | **nanospinner** | 20 KB, single dep (picocolors), CJS+ESM |
| Tables | **cli-table3** | Unicode table rendering with column spanning |
| DuckDB | **@duckdb/node-api** v1.4 | Official, Promise-native, TypeScript-first |
| Testing | **Vitest** | Fast, TypeScript-native |

For npx distribution, the `bin` field in `package.json` must point to a compiled JS file with `#!/usr/bin/env node` as its first line. **Use CJS (`.cjs`) for the bin entry point** — ESM bin scripts still have compatibility issues across Node.js versions. The `tsup` config handles this cleanly:

```typescript
// tsup.config.ts
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  target: 'node20',
  clean: true,
  banner: { js: '#!/usr/bin/env node' }
});
```

The `package.json` structure:

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

Use `npm pack --dry-run` to verify package contents before publishing. The `files` array restricts the published package to only the `dist/` output. Commander supports clean subcommand patterns (`claude-analytics ingest`, `claude-analytics query`, `claude-analytics watch`, `claude-analytics dashboard`) with auto-generated help text.

---

## Analytics dimensions that drive token optimization

### Cost estimation per model

Accurate cost calculation requires model-specific pricing. Current rates per million tokens (as of early 2026):

| Model | Input | Cache Write (5m) | Cache Read | Output |
|-------|-------|-------------------|------------|--------|
| Claude Opus 4.5 | $5 | $6.25 | $0.50 | $25 |
| Claude Sonnet 4.5 | $3 | $3.75 | $0.30 | $15 |
| Claude Haiku 4.5 | $1 | $1.25 | $0.10 | $5 |

The cost formula per turn:

```
cost = (uncached_input × base_input / 1M)
     + (cache_write × base_input × 1.25 / 1M)
     + (cache_read × base_input × 0.1 / 1M)
     + (output × output_price / 1M)
```

Note that **thinking tokens bill as output tokens** and the JSONL `costUSD` field already contains the pre-calculated cost per turn, making server-side price tracking optional but useful for cross-validation.

### The metrics that matter most

**Cache hit rate** is the single most impactful optimization metric: `cache_read_tokens / (cache_read + cache_write + uncached_input)`. Rates above **80%** indicate effective caching; below 50% signals wasted spend. Each cache hit saves 90% of input cost. Track this per session and over time — a declining trend often means prompt structures are changing too frequently.

**Context window utilization** (`total_input_tokens / max_context_window`) reveals when sessions approach limits. MCP tool definitions alone can consume **30-70% of context** before any conversation starts. The `context_window` data from the statusLine API provides real-time tracking. Sessions exceeding 60% utilization risk degraded quality and should trigger `/compact` recommendations.

**Input/output token ratio** characterizes workload type. Coding sessions typically run **3-5:1** (large code context, moderate output). Ratios above 10:1 suggest the model is mostly reading context with minimal generation. Ratios below 1:1 indicate heavy generation tasks. Tracking this per tool reveals which tools consume disproportionate tokens.

**Tool call patterns** expose automation efficiency. Track call frequency (which tools dominate), call chains (common sequences like Read → Edit → Bash), success/failure rates per tool, and per-tool token cost. MCP tools follow the `mcp__<server>__<tool>` naming convention, making server-level aggregation straightforward. One critical insight from the research: GitHub's MCP server alone uses ~25% of Sonnet's context window. Anthropic's Tool Search (shipped January 2026) mitigates this by loading tool definitions on-demand, reducing overhead by **85%**.

Additional high-value dimensions include: session duration distribution, conversation depth (turns per session), error rates and retry patterns (via `claude_code.api_error` OTel events with `status_code` and `attempt` fields), model selection patterns across sessions, and cost trending over time. Average Claude Code cost runs **~$6/developer/day** with 90% of users under $12/day, making per-developer cost tracking actionable for budget management.

---

## Scaling from local DuckDB to team analytics

The architecture scales through four natural stages without requiring a rewrite:

**Stage 1 — Local DuckDB file.** A single `analytics.duckdb` file on disk handles individual developer analytics. DuckDB's in-process engine requires zero server setup. Concurrent reads from multiple connections work fine; writes are single-threaded (acceptable for single-process ingestion). The DuckDB CLI enables ad-hoc querying: `duckdb analytics.duckdb -json -c "SELECT ..."`.

**Stage 2 — MotherDuck for team sharing.** MotherDuck is the serverless cloud DuckDB platform. Migration is trivial: change the connection string from a local path to `md:team_analytics`. Same SQL, same schema, but with shared access across team members. Hybrid execution routes quick queries locally and heavy aggregations to the cloud. Free tier available.

**Stage 3 — PostgreSQL via pg_duckdb.** For teams already running PostgreSQL, the `pg_duckdb` extension (v1.0 released) embeds DuckDB's analytical engine inside PostgreSQL, delivering up to **1,500x faster** analytical queries on existing tables. DuckDB handles reads; PostgreSQL handles transactions and access control.

**Stage 4 — ClickHouse or dedicated OLAP.** For large organizations processing billions of log entries, export DuckDB data as partitioned Parquet files (`COPY ... TO 'archive/' (FORMAT PARQUET, PARTITION_BY (date_month))`), then ingest into ClickHouse for distributed query execution. DuckDB can also query ClickHouse directly as a remote data source, enabling a hybrid query layer.

Data export from DuckDB supports multiple formats natively: Parquet (with ZSTD compression), CSV, JSON, and direct PostgreSQL writes via the `postgres` extension using `ATTACH 'postgres:dbname=...'`.

Privacy at every stage requires attention. Strip or hash personal identifiers before team aggregation. Claude Code's OTel integration redacts prompts and MCP tool names by default — opt-in only via `OTEL_LOG_USER_PROMPTS=1` and `OTEL_LOG_TOOL_DETAILS=1`. Community tools like `ccusage` process data locally with nothing leaving the machine. Implement RBAC so individuals see only their data while admins access team aggregates.

---

## Existing tools validate the approach

Several open-source projects already prove this architecture works. **ccusage** parses local JSONL files and provides daily/monthly/session views with per-model breakdowns. **claude-code-otel** ships a complete OTel Collector → Prometheus + Loki → Grafana stack with pre-built dashboards. **goccc** (Go) handles streaming deduplication via `requestId`. **claude-code-hooks-multi-agent-observability** demonstrates real-time hook event monitoring with SQLite + WebSocket + Vue. For enterprise-scale, **Langfuse** (open-source, Apache 2.0) and **Helicone** offer full LLM observability with native Anthropic support, while **LiteLLM** provides a gateway for multi-cloud Claude Code deployments on Bedrock/Vertex.

## Conclusion

The most architecturally sound approach combines **JSONL file watching for complete historical data** with **OTel export for real-time metrics** and **hooks for event-driven analytics** — covering all three data surfaces Claude Code exposes. DuckDB's ability to query JSONL files directly with `read_ndjson()` eliminates the traditional ETL step, while its `@duckdb/node-api` binding provides a TypeScript-native Promise API. The critical insight is that Claude Code already computes and stores `costUSD` per turn and full token breakdowns — the analytics tool's job is aggregation and visualization, not calculation. Cache hit rate and context window utilization are the two metrics with the highest optimization ROI, and the hooks system's `PostToolUse` and `SessionEnd` events provide the ideal ingestion triggers for a real-time pipeline. Start with JSONL parsing (proven by ccusage and others), layer on OTel for team observability, and scale to MotherDuck or pg_duckdb when collaboration demands it.