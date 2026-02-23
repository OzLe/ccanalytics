# ccanalytics C4 Architecture Documentation

> Comprehensive C4 model covering Context, Container, and Component levels for the
> ccanalytics local-first Claude Code analytics engine.
>
> Source: [00-v0-analysis.md](00-v0-analysis.md), [ccanalytics-V0.md](../ccanalytics-V0.md)
> Created: 2026-02-23

---

## Table of Contents

1. [C4 Context Diagram (Level 1)](#1-c4-context-diagram-level-1)
2. [C4 Container Diagram (Level 2)](#2-c4-container-diagram-level-2)
3. [C4 Component Diagrams (Level 3)](#3-c4-component-diagrams-level-3)
   - [Ingestion Engine Components](#31-ingestion-engine-components)
   - [Query Engine Components](#32-query-engine-components)
   - [CLI Shell Components](#33-cli-shell-components)
   - [Watcher Components](#34-watcher-components)
   - [Hooks Processor Components](#35-hooks-processor-components)
   - [Dashboard Renderer Components](#36-dashboard-renderer-components)
   - [Configuration Manager Components](#37-configuration-manager-components)
4. [Data Flow Diagram](#4-data-flow-diagram)
5. [Architecture Decision Records (ADR) Summary](#5-architecture-decision-records-adr-summary)
6. [Technology Stack Overview](#6-technology-stack-overview)

---

## 1. C4 Context Diagram (Level 1)

The Context diagram shows ccanalytics as a system boundary and its relationships with
external actors and systems. ccanalytics is a local-first CLI tool that ingests Claude
Code session data from the local filesystem, stores it in DuckDB, and presents analytics
through a terminal interface.

```mermaid
flowchart TB
    dev["<b>Developer</b><br/>(User Persona)<br/>Runs CLI commands to<br/>view analytics, costs,<br/>and usage patterns"]

    cc["<b>Claude Code</b><br/>(External System)<br/>AI coding assistant that<br/>produces JSONL session<br/>transcripts and emits<br/>OTel metrics + hook events"]

    subgraph ccanalytics_boundary [" "]
        cca["<b>ccanalytics</b><br/>(CLI Analytics Engine)<br/>Local-first analytics for<br/>Claude Code usage: ingests<br/>JSONL transcripts, queries<br/>DuckDB, renders dashboards"]
    end

    fs["<b>~/.claude/ Filesystem</b><br/>(Data Source)<br/>JSONL session transcripts,<br/>sessions-index.json,<br/>stats-cache.json,<br/>settings.json"]

    otel["<b>OTel Collector</b><br/>(Optional External System)<br/>Receives real-time metrics<br/>and events via OTLP<br/>gRPC/HTTP protocol"]

    md["<b>MotherDuck / PostgreSQL</b><br/>(Optional Scaling Targets)<br/>Team-wide analytics via<br/>cloud DuckDB or pg_duckdb<br/>extension"]

    dev -- "Runs ingest, query,<br/>watch, dashboard<br/>commands" --> cca
    cca -- "Displays analytics<br/>tables, charts, costs" --> dev

    cc -- "Writes JSONL files,<br/>sessions-index.json,<br/>stats-cache.json" --> fs
    cc -- "Emits OTel metrics<br/>(8 counters/gauges)<br/>and 4 event types" --> otel
    cc -- "Fires 14 lifecycle<br/>hook events via stdin<br/>JSON payloads" --> cca

    fs -- "JSONL session<br/>transcripts read<br/>via file watching<br/>and batch ingestion" --> cca

    otel -. "Optional: real-time<br/>metric ingestion" .-> cca

    cca -. "Optional: replicate<br/>analytics data for<br/>team sharing" .-> md

    style ccanalytics_boundary fill:none,stroke:#1168bd,stroke-width:3px,stroke-dasharray:0
    style cca fill:#1168bd,color:#fff,stroke:#0b4884
    style dev fill:#08427b,color:#fff,stroke:#052e56
    style cc fill:#999999,color:#fff,stroke:#6b6b6b
    style fs fill:#999999,color:#fff,stroke:#6b6b6b
    style otel fill:#999999,color:#fff,stroke:#6b6b6b,stroke-dasharray:5 5
    style md fill:#999999,color:#fff,stroke:#6b6b6b,stroke-dasharray:5 5
```

### Context Diagram Legend

| Element | Type | Description |
|---------|------|-------------|
| Developer | User Persona | Primary user who runs CLI commands and views analytics output |
| Claude Code | External System | AI coding assistant that generates the raw data (JSONL, OTel, hooks) |
| ~/.claude/ Filesystem | Data Source | Local filesystem where Claude Code writes session transcripts |
| OTel Collector | Optional External | Receives real-time metrics when `CLAUDE_CODE_ENABLE_TELEMETRY=1` |
| MotherDuck / PostgreSQL | Optional Scaling | Team-wide analytics targets for Stage 2-3 scaling |
| ccanalytics | System Under Design | The CLI analytics engine being architected |

---

## 2. C4 Container Diagram (Level 2)

The Container diagram zooms into ccanalytics and reveals its internal containers --
the separately deployable/runnable units that make up the system. All containers run
within a single Node.js process.

```mermaid
flowchart TB
    dev["<b>Developer</b>"]
    fs["<b>~/.claude/ Filesystem</b><br/>JSONL + metadata files"]
    cc_hooks["<b>Claude Code Hooks</b><br/>14 lifecycle events<br/>via stdin JSON"]
    otel_ext["<b>OTel Collector</b><br/>(Optional)"]

    subgraph ccanalytics ["ccanalytics CLI Application"]
        direction TB

        cli["<b>CLI Shell</b><br/>(Commander v12)<br/>Command routing, argument<br/>parsing, help generation,<br/>output formatting"]

        ingestion["<b>JSONL Ingestion Engine</b><br/>(Parser + Batch Inserter)<br/>Discovers, parses, deduplicates,<br/>and loads JSONL transcripts<br/>into DuckDB"]

        watcher["<b>File Watcher</b><br/>(Chokidar v5)<br/>Monitors ~/.claude/ for<br/>new/changed JSONL files,<br/>triggers incremental ingestion"]

        hooks["<b>Hooks Processor</b><br/>(Event Handler)<br/>Receives PostToolUse and<br/>SessionEnd events, triggers<br/>targeted ingestion"]

        otel_recv["<b>OTel Receiver</b><br/>(Optional Container)<br/>Ingests real-time metrics<br/>and events from OTel<br/>Collector"]

        query["<b>DuckDB Analytics Engine</b><br/>(@duckdb/node-api v1.4)<br/>Star schema storage, SQL<br/>queries, aggregations,<br/>window functions"]

        dashboard["<b>Dashboard Renderer</b><br/>(Terminal UI)<br/>Renders analytics tables,<br/>charts, and metrics in<br/>the terminal"]

        config["<b>Configuration Manager</b><br/>(Settings + State)<br/>Manages DB path, retention,<br/>watch settings, pricing<br/>tables, output formats"]
    end

    dev -- "ingest / query /<br/>watch / dashboard" --> cli
    cli -- "Routes commands" --> ingestion
    cli -- "Routes commands" --> query
    cli -- "Routes commands" --> watcher
    cli -- "Routes commands" --> dashboard

    fs -- "JSONL files" --> ingestion
    fs -- "File change events" --> watcher
    watcher -- "Triggers incremental<br/>ingestion on change" --> ingestion

    cc_hooks -- "stdin JSON<br/>payloads" --> hooks
    hooks -- "Triggers targeted<br/>ingestion" --> ingestion

    otel_ext -. "OTLP metrics<br/>and events" .-> otel_recv
    otel_recv -. "Inserts metric<br/>records" .-> query

    ingestion -- "INSERT / MERGE<br/>parsed records" --> query
    query -- "Query results" --> cli
    query -- "Aggregated metrics" --> dashboard
    dashboard -- "Formatted output" --> cli
    cli -- "Terminal output<br/>(tables, charts)" --> dev

    config -. "DB path, pricing,<br/>retention settings" .-> ingestion
    config -. "Query defaults,<br/>output format" .-> query
    config -. "Watch paths,<br/>debounce config" .-> watcher

    style ccanalytics fill:none,stroke:#1168bd,stroke-width:3px
    style cli fill:#438dd5,color:#fff,stroke:#2e6295
    style ingestion fill:#438dd5,color:#fff,stroke:#2e6295
    style watcher fill:#438dd5,color:#fff,stroke:#2e6295
    style hooks fill:#438dd5,color:#fff,stroke:#2e6295
    style otel_recv fill:#438dd5,color:#fff,stroke:#2e6295,stroke-dasharray:5 5
    style query fill:#438dd5,color:#fff,stroke:#2e6295
    style dashboard fill:#438dd5,color:#fff,stroke:#2e6295
    style config fill:#438dd5,color:#fff,stroke:#2e6295
    style dev fill:#08427b,color:#fff,stroke:#052e56
    style fs fill:#999999,color:#fff,stroke:#6b6b6b
    style cc_hooks fill:#999999,color:#fff,stroke:#6b6b6b
    style otel_ext fill:#999999,color:#fff,stroke:#6b6b6b,stroke-dasharray:5 5
```

### Container Responsibilities

| Container | Technology | Responsibility |
|-----------|-----------|----------------|
| CLI Shell | Commander v12, picocolors, nanospinner | Command routing, argument parsing, output formatting, help generation |
| JSONL Ingestion Engine | Custom TypeScript, DuckDB `read_ndjson()` | File discovery, JSONL parsing, schema validation, deduplication, batch insertion |
| File Watcher | Chokidar v5 | Cross-platform file monitoring with `awaitWriteFinish` for partial write safety |
| Hooks Processor | Custom TypeScript | Receives Claude Code hook events via stdin, triggers targeted ingestion |
| OTel Receiver | Optional, OTLP protocol | Ingests real-time metrics and events from OTel Collector |
| DuckDB Analytics Engine | @duckdb/node-api v1.4 | Star schema storage (5 tables), SQL queries, aggregations, MERGE INTO upserts |
| Dashboard Renderer | cli-table3, picocolors | Terminal UI rendering for analytics tables, metric summaries, trend charts |
| Configuration Manager | Custom TypeScript | Settings management (DB path, retention, pricing, output format, watch config) |

---

## 3. C4 Component Diagrams (Level 3)

Each container is decomposed into its internal components. These diagrams show the
classes, modules, and internal structure within each container.

### 3.1. Ingestion Engine Components

The Ingestion Engine is the most complex container. It handles the full pipeline from
file discovery through deduplication to batch insertion into DuckDB.

```mermaid
flowchart TB
    subgraph ingestion_engine ["JSONL Ingestion Engine"]
        direction TB

        fd["<b>FileDiscovery</b><br/>Scans ~/.claude/projects/<br/>for *.jsonl files using<br/>glob patterns. Handles<br/>path encoding (dashes to<br/>slashes). Discovers<br/>sub-agent files."]

        jp["<b>JSONLParser</b><br/>Reads JSONL files line<br/>by line. Extracts message<br/>type, sessionId, timestamp,<br/>costUSD, usage tokens,<br/>tool_use content blocks.<br/>Resumes from byte offset."]

        sv["<b>SchemaValidator</b><br/>Validates parsed records<br/>against expected schema.<br/>Ensures required fields<br/>present (type, sessionId,<br/>requestId). Handles<br/>malformed lines gracefully."]

        dedup["<b>Deduplicator</b><br/>Resolves streaming duplicates<br/>by requestId. Implements<br/>'last entry wins' rule.<br/>Groups entries by requestId<br/>and retains the final<br/>occurrence."]

        bi["<b>BatchInserter</b><br/>Executes batch INSERT or<br/>MERGE INTO statements.<br/>Maps parsed records to star<br/>schema tables (sessions,<br/>conversation_turns,<br/>tool_calls, errors)."]

        ist["<b>IngestionStateTracker</b><br/>Tracks per-file byte offset<br/>and line number in the<br/>ingestion_state table.<br/>Enables incremental reads.<br/>Stores file checksums for<br/>integrity verification."]
    end

    ext_fs["~/.claude/ Filesystem"]
    ext_db["DuckDB Analytics Engine"]

    ext_fs -- "*.jsonl files" --> fd
    fd -- "File paths +<br/>metadata" --> jp
    ist -- "Last byte offset<br/>for each file" --> jp
    jp -- "Raw parsed<br/>records" --> sv
    sv -- "Validated<br/>records" --> dedup
    dedup -- "Deduplicated<br/>records" --> bi
    bi -- "INSERT / MERGE<br/>INTO statements" --> ext_db
    bi -- "Update byte offset<br/>after successful insert" --> ist

    style ingestion_engine fill:none,stroke:#438dd5,stroke-width:2px
    style fd fill:#85bbf0,color:#000,stroke:#5d99d0
    style jp fill:#85bbf0,color:#000,stroke:#5d99d0
    style sv fill:#85bbf0,color:#000,stroke:#5d99d0
    style dedup fill:#85bbf0,color:#000,stroke:#5d99d0
    style bi fill:#85bbf0,color:#000,stroke:#5d99d0
    style ist fill:#85bbf0,color:#000,stroke:#5d99d0
    style ext_fs fill:#999999,color:#fff,stroke:#6b6b6b
    style ext_db fill:#438dd5,color:#fff,stroke:#2e6295
```

#### Ingestion Engine Component Details

| Component | Module | Key Behaviors |
|-----------|--------|---------------|
| FileDiscovery | `src/ingestion/file-discovery.ts` | Glob `~/.claude/projects/**/*.jsonl`, decode path encoding, detect `agent-*.jsonl` sub-agent files, check both `~/.claude/` and `~/.config/claude/` |
| JSONLParser | `src/ingestion/jsonl-parser.ts` | Line-by-line JSONL parsing, byte-offset resume, extract assistant billing payload, extract tool_use blocks from message.content array |
| SchemaValidator | `src/ingestion/schema-validator.ts` | Validate required fields per message type, reject malformed lines with error logging, enforce type constraints |
| Deduplicator | `src/ingestion/deduplicator.ts` | Group by `requestId`, retain last occurrence (last-entry-wins), handle entries without `requestId` as unique |
| BatchInserter | `src/ingestion/batch-inserter.ts` | Map records to star schema tables, execute `MERGE INTO` for idempotent upserts, batch inserts for performance |
| IngestionStateTracker | `src/ingestion/state-tracker.ts` | Read/write `ingestion_state` table, track `last_byte_offset`, `last_line_number`, `checksum` per file |

---

### 3.2. Query Engine Components

The Query Engine wraps DuckDB with pre-built analytical queries aligned to the key
metrics identified in the V0 analysis.

```mermaid
flowchart TB
    subgraph query_engine ["DuckDB Analytics Engine"]
        direction TB

        sa["<b>SessionAnalyzer</b><br/>Queries session-level<br/>metrics: duration, turns,<br/>model usage, token totals.<br/>Uses window functions<br/>with QUALIFY for rankings."]

        cc["<b>CostCalculator</b><br/>Computes per-turn cost<br/>from token breakdown +<br/>model pricing. Cross-<br/>validates against JSONL<br/>costUSD. Supports daily/<br/>weekly/monthly trends."]

        cm["<b>CacheMetrics</b><br/>Calculates cache hit rate:<br/>cache_read / (cache_read +<br/>cache_write + uncached).<br/>Flags sessions below 50%.<br/>Tracks trends over time."]

        tp["<b>ToolPatterns</b><br/>Analyzes tool call frequency,<br/>success/failure rates, call<br/>chains (Read-Edit-Bash).<br/>Aggregates MCP tools by<br/>server via naming convention."]

        tsa["<b>TimeSeriesAggregator</b><br/>Uses date_trunc() for time<br/>bucketing. Supports GROUPING<br/>SETS / ROLLUP for multi-level<br/>aggregations. Daily, weekly,<br/>monthly granularity."]
    end

    ext_db[("DuckDB<br/>analytics.duckdb<br/>Star Schema")]
    ext_cli["CLI Shell"]

    ext_db -- "SQL query<br/>results" --> sa
    ext_db -- "SQL query<br/>results" --> cc
    ext_db -- "SQL query<br/>results" --> cm
    ext_db -- "SQL query<br/>results" --> tp
    ext_db -- "SQL query<br/>results" --> tsa

    sa -- "Session summaries" --> ext_cli
    cc -- "Cost breakdowns" --> ext_cli
    cm -- "Cache efficiency<br/>reports" --> ext_cli
    tp -- "Tool usage<br/>analytics" --> ext_cli
    tsa -- "Time-series<br/>data points" --> ext_cli

    style query_engine fill:none,stroke:#438dd5,stroke-width:2px
    style sa fill:#85bbf0,color:#000,stroke:#5d99d0
    style cc fill:#85bbf0,color:#000,stroke:#5d99d0
    style cm fill:#85bbf0,color:#000,stroke:#5d99d0
    style tp fill:#85bbf0,color:#000,stroke:#5d99d0
    style tsa fill:#85bbf0,color:#000,stroke:#5d99d0
    style ext_db fill:#438dd5,color:#fff,stroke:#2e6295
    style ext_cli fill:#438dd5,color:#fff,stroke:#2e6295
```

#### Query Engine Component Details

| Component | Module | Key SQL Features |
|-----------|--------|-----------------|
| SessionAnalyzer | `src/query/session-analyzer.ts` | Window functions with QUALIFY, session duration/depth metrics, model selection patterns |
| CostCalculator | `src/query/cost-calculator.ts` | Model-specific pricing lookup, per-turn cost formula, cross-validation with `costUSD`, ROLLUP for period totals |
| CacheMetrics | `src/query/cache-metrics.ts` | Cache hit rate formula, threshold alerts (>80% good, <50% wasted), per-session and trend views |
| ToolPatterns | `src/query/tool-patterns.ts` | Tool frequency ranking, `mcp__<server>__<tool>` server aggregation, call chain detection, success/failure rates |
| TimeSeriesAggregator | `src/query/time-series.ts` | `date_trunc()` bucketing, GROUPING SETS/ROLLUP, daily/weekly/monthly aggregation, ASOF JOIN for correlation |

---

### 3.3. CLI Shell Components

The CLI Shell container manages user interaction -- parsing commands, routing to the
appropriate subsystem, and formatting output for the terminal.

```mermaid
flowchart TB
    subgraph cli_shell ["CLI Shell"]
        direction TB

        cr["<b>CommandRouter</b><br/>(Commander v12)<br/>Defines subcommands: ingest,<br/>query, watch, dashboard.<br/>Parses arguments and options.<br/>Generates help text."]

        of["<b>OutputFormatter</b><br/>(picocolors)<br/>Formats output for terminal.<br/>Supports --output-format:<br/>text (default), json,<br/>stream-json."]

        tr["<b>TableRenderer</b><br/>(cli-table3)<br/>Renders Unicode tables with<br/>column spanning, alignment,<br/>and color coding for<br/>thresholds."]

        sm["<b>SpinnerManager</b><br/>(nanospinner)<br/>Shows progress spinners<br/>during long operations<br/>(ingestion, queries).<br/>Displays byte/record counts."]
    end

    ext_dev["Developer"]
    ext_ingestion["Ingestion Engine"]
    ext_query["Query Engine"]
    ext_watcher["File Watcher"]
    ext_dashboard["Dashboard Renderer"]

    ext_dev -- "CLI arguments<br/>and options" --> cr
    cr -- "ingest command" --> ext_ingestion
    cr -- "query command" --> ext_query
    cr -- "watch command" --> ext_watcher
    cr -- "dashboard command" --> ext_dashboard

    ext_query -- "Raw query<br/>results" --> of
    of -- "Formatted<br/>strings" --> tr
    of -- "JSON output" --> ext_dev
    tr -- "Rendered<br/>tables" --> ext_dev
    sm -- "Progress<br/>indicators" --> ext_dev

    style cli_shell fill:none,stroke:#438dd5,stroke-width:2px
    style cr fill:#85bbf0,color:#000,stroke:#5d99d0
    style of fill:#85bbf0,color:#000,stroke:#5d99d0
    style tr fill:#85bbf0,color:#000,stroke:#5d99d0
    style sm fill:#85bbf0,color:#000,stroke:#5d99d0
    style ext_dev fill:#08427b,color:#fff,stroke:#052e56
    style ext_ingestion fill:#438dd5,color:#fff,stroke:#2e6295
    style ext_query fill:#438dd5,color:#fff,stroke:#2e6295
    style ext_watcher fill:#438dd5,color:#fff,stroke:#2e6295
    style ext_dashboard fill:#438dd5,color:#fff,stroke:#2e6295
```

#### CLI Shell Component Details

| Component | Module | Technology |
|-----------|--------|-----------|
| CommandRouter | `src/cli/commands.ts` | Commander v12 -- subcommand definitions, option parsing, auto-generated `--help` |
| OutputFormatter | `src/cli/output-formatter.ts` | picocolors for color, supports `--output-format text|json|stream-json` |
| TableRenderer | `src/cli/table-renderer.ts` | cli-table3 -- Unicode tables, column spanning, conditional color for thresholds |
| SpinnerManager | `src/cli/spinner.ts` | nanospinner -- progress indication during ingestion and long queries |

---

### 3.4. Watcher Components

The Watcher container implements real-time file monitoring for the `watch` command,
using Chokidar to detect changes and trigger incremental ingestion.

```mermaid
flowchart TB
    subgraph watcher_container ["File Watcher"]
        direction TB

        chk["<b>ChokidarManager</b><br/>(Chokidar v5)<br/>Initializes file watchers<br/>on ~/.claude/projects/.<br/>Configures awaitWriteFinish<br/>with 2-second stability<br/>threshold."]

        deb["<b>ChangeDebouncer</b><br/>Debounces rapid file change<br/>events to prevent redundant<br/>ingestion runs. Coalesces<br/>multiple changes to the<br/>same file within a window."]

        inc["<b>IncrementalIngester</b><br/>Reads only new bytes from<br/>changed files using byte<br/>offset from IngestionState-<br/>Tracker. Feeds new records<br/>to the ingestion pipeline."]
    end

    ext_fs["~/.claude/ Filesystem"]
    ext_ingestion["Ingestion Engine"]
    ext_state["IngestionStateTracker"]

    ext_fs -- "add / change<br/>filesystem events" --> chk
    chk -- "Stabilized<br/>file events" --> deb
    deb -- "Debounced<br/>change events" --> inc
    ext_state -- "Last byte<br/>offset" --> inc
    inc -- "New records<br/>for ingestion" --> ext_ingestion

    style watcher_container fill:none,stroke:#438dd5,stroke-width:2px
    style chk fill:#85bbf0,color:#000,stroke:#5d99d0
    style deb fill:#85bbf0,color:#000,stroke:#5d99d0
    style inc fill:#85bbf0,color:#000,stroke:#5d99d0
    style ext_fs fill:#999999,color:#fff,stroke:#6b6b6b
    style ext_ingestion fill:#438dd5,color:#fff,stroke:#2e6295
    style ext_state fill:#85bbf0,color:#000,stroke:#5d99d0
```

#### Watcher Component Details

| Component | Module | Key Behaviors |
|-----------|--------|---------------|
| ChokidarManager | `src/watcher/chokidar-manager.ts` | Watch `~/.claude/projects/**/*.jsonl`, `awaitWriteFinish: { stabilityThreshold: 2000 }`, cross-platform events |
| ChangeDebouncer | `src/watcher/debouncer.ts` | Coalesce rapid events per file path, configurable debounce window, prevent duplicate processing |
| IncrementalIngester | `src/watcher/incremental-ingester.ts` | Read from last byte offset, parse only new bytes, delegate to ingestion pipeline |

---

### 3.5. Hooks Processor Components

The Hooks Processor receives Claude Code lifecycle events and triggers targeted
ingestion based on specific hook types.

```mermaid
flowchart TB
    subgraph hooks_container ["Hooks Processor"]
        direction TB

        hr["<b>HookReceiver</b><br/>Reads JSON payloads from<br/>stdin. Parses session_id,<br/>transcript_path, cwd,<br/>hook_event_name, and<br/>event-specific fields."]

        ef["<b>EventFilter</b><br/>Filters events to ingestion-<br/>relevant hooks: PostToolUse<br/>for real-time tool tracking,<br/>SessionEnd for session-<br/>complete ingestion."]

        it["<b>IngestionTrigger</b><br/>Initiates targeted ingestion<br/>for a specific session file<br/>identified by transcript_path.<br/>Delegates to the Ingestion<br/>Engine."]
    end

    ext_cc["Claude Code<br/>Hook Events"]
    ext_ingestion["Ingestion Engine"]

    ext_cc -- "stdin JSON:<br/>PostToolUse,<br/>SessionEnd, etc." --> hr
    hr -- "Parsed hook<br/>event" --> ef
    ef -- "Filtered events<br/>(PostToolUse,<br/>SessionEnd)" --> it
    it -- "Trigger ingestion<br/>for transcript_path" --> ext_ingestion

    style hooks_container fill:none,stroke:#438dd5,stroke-width:2px
    style hr fill:#85bbf0,color:#000,stroke:#5d99d0
    style ef fill:#85bbf0,color:#000,stroke:#5d99d0
    style it fill:#85bbf0,color:#000,stroke:#5d99d0
    style ext_cc fill:#999999,color:#fff,stroke:#6b6b6b
    style ext_ingestion fill:#438dd5,color:#fff,stroke:#2e6295
```

#### Hooks Processor Component Details

| Component | Module | Key Behaviors |
|-----------|--------|---------------|
| HookReceiver | `src/hooks/hook-receiver.ts` | Parse stdin JSON, validate required fields (session_id, hook_event_name), handle tool-specific fields |
| EventFilter | `src/hooks/event-filter.ts` | Whitelist `PostToolUse` and `SessionEnd` for ingestion triggers, ignore non-data events |
| IngestionTrigger | `src/hooks/ingestion-trigger.ts` | Map `transcript_path` to ingestion target, call Ingestion Engine for single-file incremental ingest |

---

### 3.6. Dashboard Renderer Components

The Dashboard Renderer provides the terminal UI for the `dashboard` command,
presenting aggregated analytics in a structured layout.

```mermaid
flowchart TB
    subgraph dashboard_container ["Dashboard Renderer"]
        direction TB

        lm["<b>LayoutManager</b><br/>Manages terminal screen<br/>layout. Arranges metric<br/>panels, tables, and charts<br/>in a structured grid."]

        mp["<b>MetricPanels</b><br/>Renders key metric cards:<br/>total cost, cache hit rate,<br/>context utilization, session<br/>count, token totals."]

        tc["<b>TrendCharts</b><br/>Renders ASCII time-series<br/>charts for cost trending,<br/>token usage, and cache<br/>efficiency over time."]

        sr["<b>SummaryRenderer</b><br/>Renders summary tables:<br/>top tools, model breakdown,<br/>per-project costs, session<br/>duration distribution."]
    end

    ext_query["Query Engine"]
    ext_cli["CLI Shell"]

    ext_query -- "Aggregated<br/>metrics" --> lm
    lm --> mp
    lm --> tc
    lm --> sr
    mp -- "Metric cards" --> ext_cli
    tc -- "Chart output" --> ext_cli
    sr -- "Summary tables" --> ext_cli

    style dashboard_container fill:none,stroke:#438dd5,stroke-width:2px
    style lm fill:#85bbf0,color:#000,stroke:#5d99d0
    style mp fill:#85bbf0,color:#000,stroke:#5d99d0
    style tc fill:#85bbf0,color:#000,stroke:#5d99d0
    style sr fill:#85bbf0,color:#000,stroke:#5d99d0
    style ext_query fill:#438dd5,color:#fff,stroke:#2e6295
    style ext_cli fill:#438dd5,color:#fff,stroke:#2e6295
```

#### Dashboard Renderer Component Details

| Component | Module | Key Behaviors |
|-----------|--------|---------------|
| LayoutManager | `src/dashboard/layout-manager.ts` | Terminal size detection, panel arrangement, responsive grid layout |
| MetricPanels | `src/dashboard/metric-panels.ts` | Key metric display with threshold color coding (green >80% cache, red <50%) |
| TrendCharts | `src/dashboard/trend-charts.ts` | ASCII sparklines and bar charts for time-series data |
| SummaryRenderer | `src/dashboard/summary-renderer.ts` | Ranked tables for tools, models, projects using cli-table3 |

---

### 3.7. Configuration Manager Components

The Configuration Manager provides centralized access to settings, database paths,
and runtime state.

```mermaid
flowchart TB
    subgraph config_container ["Configuration Manager"]
        direction TB

        sp["<b>SettingsProvider</b><br/>Reads settings.json from<br/>~/.claude/. Resolves config<br/>path (supports both<br/>~/.claude/ and<br/>~/.config/claude/)."]

        dbp["<b>DatabasePathResolver</b><br/>Resolves analytics.duckdb<br/>file location. Supports<br/>local path, MotherDuck<br/>connection string, and<br/>PostgreSQL attach URI."]

        pt["<b>PricingTable</b><br/>Maintains model pricing<br/>data (input, cache write,<br/>cache read, output rates<br/>per million tokens) for<br/>all Claude models."]

        rp["<b>RetentionPolicy</b><br/>Reads logRetentionDays from<br/>settings.json (default 30).<br/>Determines archival and<br/>cleanup thresholds for<br/>Parquet export."]
    end

    ext_fs["~/.claude/settings.json"]
    ext_all["All Containers"]

    ext_fs -- "Read settings" --> sp
    sp -- "Resolved config" --> dbp
    sp -- "Resolved config" --> pt
    sp -- "Resolved config" --> rp
    dbp -- "DB connection<br/>config" --> ext_all
    pt -- "Pricing data" --> ext_all
    rp -- "Retention<br/>thresholds" --> ext_all

    style config_container fill:none,stroke:#438dd5,stroke-width:2px
    style sp fill:#85bbf0,color:#000,stroke:#5d99d0
    style dbp fill:#85bbf0,color:#000,stroke:#5d99d0
    style pt fill:#85bbf0,color:#000,stroke:#5d99d0
    style rp fill:#85bbf0,color:#000,stroke:#5d99d0
    style ext_fs fill:#999999,color:#fff,stroke:#6b6b6b
    style ext_all fill:#438dd5,color:#fff,stroke:#2e6295
```

#### Configuration Manager Component Details

| Component | Module | Key Behaviors |
|-----------|--------|---------------|
| SettingsProvider | `src/config/settings-provider.ts` | Path resolution (`~/.claude/` vs `~/.config/claude/`), JSON parsing, default values |
| DatabasePathResolver | `src/config/db-path-resolver.ts` | Local file path, `md:` MotherDuck prefix, `postgres:` attach URI, env var overrides |
| PricingTable | `src/config/pricing-table.ts` | Per-model rates (Opus/Sonnet/Haiku), cache write 1.25x multiplier, cache read 0.10x multiplier |
| RetentionPolicy | `src/config/retention-policy.ts` | Default 30-day retention, Parquet archival threshold, ZSTD compression settings |

---

## 4. Data Flow Diagram

This diagram traces data from its origin in Claude Code through the entire ccanalytics
pipeline to terminal output.

```mermaid
flowchart LR
    subgraph origin ["Data Origin"]
        cc["<b>Claude Code</b><br/>AI Coding Assistant"]
    end

    subgraph storage ["Local Storage"]
        jsonl["<b>JSONL Files</b><br/>~/.claude/projects/<br/>{path}/{session}.jsonl"]
    end

    subgraph ingestion ["Ingestion Pipeline"]
        fd["<b>File<br/>Discovery</b>"]
        jp["<b>JSONL<br/>Parser</b>"]
        sv["<b>Schema<br/>Validator</b>"]
        dedup["<b>Deduplicator</b><br/>(requestId<br/>last wins)"]
        bi["<b>Batch<br/>Inserter</b>"]
    end

    subgraph analytics_db ["Analytics Store"]
        db[("DuckDB<br/>analytics.duckdb")]
        sessions["sessions"]
        turns["conversation_turns"]
        tools["tool_calls"]
        errors["errors"]
        state["ingestion_state"]
    end

    subgraph query_layer ["Query Layer"]
        qe["<b>Query<br/>Engine</b>"]
    end

    subgraph output ["Output"]
        cli_out["<b>CLI Output</b><br/>Tables, JSON,<br/>Dashboard"]
    end

    cc -- "Writes session<br/>transcripts" --> jsonl
    jsonl --> fd
    fd -- "File paths" --> jp
    jp -- "Raw records" --> sv
    sv -- "Valid records" --> dedup
    dedup -- "Unique records" --> bi
    bi -- "MERGE INTO" --> db

    db --- sessions
    db --- turns
    db --- tools
    db --- errors
    db --- state

    bi -- "Update offsets" --> state
    state -- "Resume offsets" -.-> jp

    db -- "SQL queries" --> qe
    qe -- "Results" --> cli_out

    style origin fill:none,stroke:#999,stroke-width:1px
    style storage fill:none,stroke:#999,stroke-width:1px
    style ingestion fill:none,stroke:#438dd5,stroke-width:2px
    style analytics_db fill:none,stroke:#438dd5,stroke-width:2px
    style query_layer fill:none,stroke:#438dd5,stroke-width:2px
    style output fill:none,stroke:#438dd5,stroke-width:2px
    style cc fill:#999999,color:#fff,stroke:#6b6b6b
    style jsonl fill:#999999,color:#fff,stroke:#6b6b6b
    style fd fill:#85bbf0,color:#000,stroke:#5d99d0
    style jp fill:#85bbf0,color:#000,stroke:#5d99d0
    style sv fill:#85bbf0,color:#000,stroke:#5d99d0
    style dedup fill:#85bbf0,color:#000,stroke:#5d99d0
    style bi fill:#85bbf0,color:#000,stroke:#5d99d0
    style db fill:#438dd5,color:#fff,stroke:#2e6295
    style sessions fill:#85bbf0,color:#000,stroke:#5d99d0
    style turns fill:#85bbf0,color:#000,stroke:#5d99d0
    style tools fill:#85bbf0,color:#000,stroke:#5d99d0
    style errors fill:#85bbf0,color:#000,stroke:#5d99d0
    style state fill:#85bbf0,color:#000,stroke:#5d99d0
    style qe fill:#438dd5,color:#fff,stroke:#2e6295
    style cli_out fill:#08427b,color:#fff,stroke:#052e56
```

### Data Flow Summary

| Stage | Input | Processing | Output |
|-------|-------|-----------|--------|
| 1. Origin | Developer interaction with Claude Code | Claude Code writes session data | JSONL files in `~/.claude/projects/` |
| 2. Discovery | `~/.claude/projects/` directory tree | Glob for `*.jsonl`, decode path encoding | Ordered list of file paths |
| 3. Parsing | JSONL file bytes (from last offset) | Line-by-line parsing, field extraction | Raw typed records (user, assistant, etc.) |
| 4. Validation | Raw parsed records | Schema validation, required field checks | Valid records (malformed lines rejected) |
| 5. Deduplication | Valid records with `requestId` | Group by `requestId`, last entry wins | Unique canonical records |
| 6. Insertion | Unique records | `MERGE INTO` for idempotent upserts | Star schema tables populated |
| 7. State Update | Successful insert position | Write byte offset + line number | `ingestion_state` table updated |
| 8. Querying | Analyst SQL or pre-built templates | DuckDB analytical functions | Aggregated metric results |
| 9. Output | Query results | Format as table, JSON, or dashboard | Terminal display to developer |

---

## 5. Architecture Decision Records (ADR) Summary

| ADR | Decision | Status | Rationale | Tradeoffs |
|-----|----------|--------|-----------|-----------|
| ADR-001 | **DuckDB over SQLite** | Accepted | OLAP-optimized engine with native JSONL querying (`read_ndjson()`), window functions, `QUALIFY`, `GROUPING SETS`, columnar storage, and Parquet export. SQLite lacks analytical query features and requires manual ETL. | DuckDB binary is larger (~30MB). Single-writer constraint requires ingestion serialization. Newer ecosystem with less community tooling than SQLite. |
| ADR-002 | **Commander v12 over yargs** | Accepted | 109M weekly downloads, zero dependencies, TypeScript types included, clean subcommand pattern, auto-generated help text. yargs has a larger dependency tree and more complex API. | Commander has fewer built-in features for complex argument validation. Less middleware/plugin ecosystem than yargs. |
| ADR-003 | **Chokidar v5 for file watching** | Accepted | Battle-tested cross-platform file watching (macOS FSEvents, Linux inotify, Windows ReadDirectoryChangesW). Critical `awaitWriteFinish` option prevents reading partial JSONL writes with configurable stability threshold. | Adds ~1MB to bundle. Native filesystem bindings may require compilation on some platforms. Chokidar v4 exists but v5 is proven stable. |
| ADR-004 | **CJS for bin entry point** | Accepted | ESM bin scripts have cross-version compatibility issues across Node.js versions. CJS entry point via tsup's `.cjs` output ensures reliable `npx` execution across Node 20+. | Cannot use top-level `await` in entry point. Must use `require()` or dynamic `import()` for ESM dependencies. |
| ADR-005 | **Star schema with 5 tables** | Accepted | Denormalized star schema optimized for analytical queries. Fact tables (`conversation_turns`, `tool_calls`, `errors`) reference the `sessions` dimension table. Utility table (`ingestion_state`) tracks pipeline progress. Schema matches DuckDB's columnar strengths. | Some data duplication between `sessions` (aggregated) and `conversation_turns` (per-turn). Requires `MERGE INTO` for consistency during reprocessing. |
| ADR-006 | **requestId deduplication (last wins)** | Accepted | Claude Code streaming produces duplicate JSONL entries sharing the same `requestId`. The final entry is the authoritative record (contains complete token counts and cost). This matches the behavior validated by goccc. | Requires full-file scan on first ingestion to resolve duplicates. Memory usage scales with number of unique `requestId` values per file. |
| ADR-007 | **Byte-offset incremental ingestion** | Accepted | Track `last_byte_offset` per file in `ingestion_state` table. On re-ingestion, seek to offset and parse only new bytes. Reduces processing time from O(file_size) to O(new_data). File checksum validates integrity on reprocessing. | If a file is truncated or rewritten, checksum mismatch triggers full re-ingestion. Does not handle mid-line corruption gracefully (relies on line-by-line parsing). |
| ADR-008 | **@duckdb/node-api (Neo) binding** | Accepted | Official DuckDB Node.js binding recommended for all new projects. Promise-native API, TypeScript-first design, lossless handling of STRUCT and LIST types. Older `duckdb` and `duckdb-async` packages are deprecated and frozen at DuckDB 1.4.x. | Newer package with less community documentation. API surface may change between minor versions. |
| ADR-009 | **Parquet archival with ZSTD** | Accepted | Archive data older than retention threshold to Parquet files with ZSTD compression for 5-10x storage savings. DuckDB can query Parquet files directly alongside live data. Partitioned by month for efficient pruning. | Adds archival logic complexity. Parquet files are immutable -- corrections require rewriting partitions. Two-tier storage (DuckDB + Parquet) increases operational surface. |
| ADR-010 | **picocolors + nanospinner over chalk + ora** | Accepted | picocolors is 7KB vs chalk's 101KB, 2x faster, zero dependencies. nanospinner is 20KB with single dependency (picocolors), CJS+ESM compatible. Aligns with minimal bundle size requirement (NFR-05). | Fewer formatting features than chalk (no RGB, no hex colors). nanospinner has fewer animation options than ora. |

---

## 6. Technology Stack Overview

| Layer | Technology | Version | Role | npm Package |
|-------|-----------|---------|------|-------------|
| **Runtime** | Node.js | >= 20 | JavaScript runtime target | -- |
| **Language** | TypeScript | latest | Type-safe development language | `typescript` |
| **Database** | DuckDB | 1.4.x | Embedded OLAP analytical engine | `@duckdb/node-api` |
| **CLI Framework** | Commander | v12 | Command routing, argument parsing, help generation | `commander` |
| **Build Tool** | tsup | latest | esbuild-powered bundler, CJS output, shebang preservation | `tsup` |
| **File Watching** | Chokidar | v5 | Cross-platform filesystem event monitoring | `chokidar` |
| **Terminal Colors** | picocolors | latest | Lightweight terminal color formatting (7KB) | `picocolors` |
| **Progress Spinner** | nanospinner | latest | Terminal progress indicators (20KB) | `nanospinner` |
| **Table Rendering** | cli-table3 | latest | Unicode table rendering with column spanning | `cli-table3` |
| **Testing** | Vitest | latest | TypeScript-native test framework | `vitest` |
| **OTel Protocol** | OTLP | -- | OpenTelemetry metrics/events ingestion (optional) | `@opentelemetry/api` |

### Build Configuration

```
tsup.config.ts
  entry: src/cli.ts
  format: CJS (.cjs)
  target: node20
  banner: #!/usr/bin/env node
```

### Distribution

```
package.json
  name: claude-analytics
  bin: { "claude-analytics": "./dist/cli.cjs" }
  files: ["dist"]
```

---

## Appendix A: Star Schema Entity Relationship

```mermaid
flowchart TB
    subgraph star_schema ["Star Schema: analytics.duckdb"]
        sessions["<b>sessions</b> (Dimension)<br/>-----------<br/>PK: session_id<br/>start_time, end_time<br/>duration, model<br/>total_input_tokens<br/>total_output_tokens<br/>total_cache_write_tokens<br/>total_cache_read_tokens<br/>total_cost, num_turns<br/>num_tool_calls<br/>cwd, source_file"]

        turns["<b>conversation_turns</b> (Fact)<br/>-----------<br/>PK: turn_id<br/>FK: session_id<br/>role, timestamp<br/>input_tokens, output_tokens<br/>cache_write_tokens<br/>cache_read_tokens<br/>cost, model, stop_reason"]

        tools["<b>tool_calls</b> (Fact)<br/>-----------<br/>PK: tool_call_id<br/>FK: session_id<br/>FK: turn_id<br/>tool_name, duration_ms<br/>success, error_message<br/>parameters (JSON)"]

        errors["<b>errors</b> (Fact)<br/>-----------<br/>PK: error_id<br/>FK: session_id<br/>timestamp, error_type<br/>message, is_retryable<br/>retry_count"]

        state["<b>ingestion_state</b> (Utility)<br/>-----------<br/>PK: file_path<br/>last_byte_offset<br/>last_line_number<br/>last_ingested_at<br/>checksum"]
    end

    sessions --- turns
    sessions --- tools
    sessions --- errors
    turns --- tools

    style star_schema fill:none,stroke:#438dd5,stroke-width:2px
    style sessions fill:#438dd5,color:#fff,stroke:#2e6295
    style turns fill:#85bbf0,color:#000,stroke:#5d99d0
    style tools fill:#85bbf0,color:#000,stroke:#5d99d0
    style errors fill:#85bbf0,color:#000,stroke:#5d99d0
    style state fill:#85bbf0,color:#000,stroke:#5d99d0
```

---

## Appendix B: Scaling Architecture

```mermaid
flowchart LR
    subgraph stage1 ["Stage 1: Local"]
        local_db[("analytics.duckdb<br/>(Local File)")]
    end

    subgraph stage2 ["Stage 2: Team"]
        md[("MotherDuck<br/>md:team_analytics")]
    end

    subgraph stage3 ["Stage 3: Enterprise"]
        pg[("PostgreSQL<br/>+ pg_duckdb")]
    end

    subgraph stage4 ["Stage 4: Scale"]
        ch[("ClickHouse<br/>+ Parquet")]
    end

    local_db -- "Change connection<br/>string to md:" --> md
    md -- "Same SQL,<br/>pg_duckdb v1.0" --> pg
    pg -- "Export Parquet,<br/>partitioned" --> ch

    style stage1 fill:none,stroke:#438dd5,stroke-width:2px
    style stage2 fill:none,stroke:#438dd5,stroke-width:2px
    style stage3 fill:none,stroke:#438dd5,stroke-width:2px
    style stage4 fill:none,stroke:#438dd5,stroke-width:2px
    style local_db fill:#438dd5,color:#fff,stroke:#2e6295
    style md fill:#438dd5,color:#fff,stroke:#2e6295
    style pg fill:#438dd5,color:#fff,stroke:#2e6295
    style ch fill:#438dd5,color:#fff,stroke:#2e6295
```

| Stage | Target | Migration Effort | Same SQL | Same Schema |
|-------|--------|-----------------|----------|-------------|
| 1. Local DuckDB | Individual developer | None (default) | Yes | Yes |
| 2. MotherDuck | Team sharing | Connection string change | Yes | Yes |
| 3. PostgreSQL | Enterprise (existing PG) | pg_duckdb extension install | Yes | Yes |
| 4. ClickHouse | Large-scale OLAP | Parquet export + ingest | Mostly | Yes |
