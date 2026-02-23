# 06 -- Bootstrap Manifest

> Complete list of all files created during the ccanalytics project bootstrap.
> Each file includes its path, category, and a brief description.
>
> Generated: 2026-02-23

---

## Summary

| Category | File Count |
|----------|-----------|
| Config Files | 5 |
| Source — Types | 4 |
| Source — Errors | 1 |
| Source — Utils | 3 |
| Source — Config | 3 |
| Source — Database | 4 |
| Source — Ingestion | 6 |
| Source — Queries | 6 |
| Source — Watcher | 3 |
| Source — CLI | 7 |
| SQL | 2 |
| Test Fixtures | 3 |
| Test Files | 2 |
| Documentation | 1 |
| **Total** | **50** |

---

## Config Files (5)

| # | Path | Description |
|---|------|-------------|
| 1 | `package.json` | npm package manifest: name, version, bin entry, dependencies, scripts |
| 2 | `tsconfig.json` | TypeScript compiler config: ES2022 target, NodeNext modules, strict mode |
| 3 | `tsup.config.ts` | tsup bundler config: CJS output, node20 target, shebang banner |
| 4 | `vitest.config.ts` | Vitest test runner config: coverage thresholds, test directory |
| 5 | `.gitignore` | Git ignore rules: node_modules, dist, DuckDB files, .DS_Store |

## Source — Types Module (4)

| # | Path | Description |
|---|------|-------------|
| 6 | `src/types/index.ts` | Barrel export for all shared types |
| 7 | `src/types/jsonl.ts` | JSONL message types: UserMessage, AssistantMessage, ContentBlock, TokenUsage, etc. |
| 8 | `src/types/analytics.ts` | Analytics result types: SessionSummary, CostBreakdown, CacheMetrics, TimeSeriesPoint, DB row types, etc. |
| 9 | `src/types/config.ts` | Configuration types: CCAnalyticsConfig, IngestionConfig, WatcherConfig, DatabaseConfig, GlobalOptions |

## Source — Errors Module (1)

| # | Path | Description |
|---|------|-------------|
| 10 | `src/errors.ts` | Error class hierarchy: CCAnalyticsError, IngestionError, QueryError, DatabaseError, ConfigError, etc. |

## Source — Utils Module (3)

| # | Path | Description |
|---|------|-------------|
| 11 | `src/utils/format.ts` | OutputFormatter class: formatTable, formatJson, formatCsv, formatCost, formatTokens, formatPercent, formatDuration |
| 12 | `src/utils/logger.ts` | Logger factory with debug/info/warn/error levels, stderr output, child loggers, picocolors |
| 13 | `src/utils/paths.ts` | Path utilities: findClaudeDir, encodeProjectPath, decodeProjectPath, getProjectsDir, expandHome, extractSessionId, ensureDir |

## Source — Config Module (3)

| # | Path | Description |
|---|------|-------------|
| 14 | `src/config/index.ts` | Barrel export: loadConfig, DEFAULT_CONFIG |
| 15 | `src/config/defaults.ts` | DEFAULT_CONFIG object with all built-in default values |
| 16 | `src/config/loader.ts` | loadConfig function: multi-source merging (CLI > env > file > defaults), config file discovery |

## Source — Database Module (4)

| # | Path | Description |
|---|------|-------------|
| 17 | `src/db/index.ts` | Barrel export: ConnectionManager, SchemaManager, QueryExecutor |
| 18 | `src/db/connection.ts` | ConnectionManager class: open, close, getConnection, getInstance, isOpen |
| 19 | `src/db/schema.ts` | SchemaManager class: initialize (DDL), migrate, getVersion |
| 20 | `src/db/executor.ts` | QueryExecutor class: run (DDL/DML), query (SELECT), scalar |

## Source — Ingestion Module (6)

| # | Path | Description |
|---|------|-------------|
| 21 | `src/ingestion/index.ts` | Barrel export + IngestionPipeline class: orchestrates discovery, parsing, dedup, insertion |
| 22 | `src/ingestion/file-discovery.ts` | FileDiscovery class: discoverFiles with glob matching, stat metadata, project path decoding |
| 23 | `src/ingestion/jsonl-parser.ts` | JSONLParser class: parseLine (type discrimination), parseFile (streaming), ParsedEntry union type |
| 24 | `src/ingestion/deduplicator.ts` | Deduplicator class: deduplicate by requestId (last-entry-wins), DeduplicationResult |
| 25 | `src/ingestion/batch-inserter.ts` | BatchInserter class: insertSessions, insertTurns, insertToolCalls with transaction support |
| 26 | `src/ingestion/ingestion-tracker.ts` | IngestionTracker class: getState, updateState, getAllStates, resetState, resetAll |

## Source — Query Module (6)

| # | Path | Description |
|---|------|-------------|
| 27 | `src/queries/index.ts` | Barrel export: all five analyzer classes |
| 28 | `src/queries/session-analyzer.ts` | SessionAnalyzer class: getSessions, getSessionDetail, getSessionStats |
| 29 | `src/queries/cost-analyzer.ts` | CostAnalyzer class: getDailyCosts, getCostByModel, getCostByProject, getTotalCost |
| 30 | `src/queries/cache-analyzer.ts` | CacheAnalyzer class: getCacheHitRate, getCacheTrend, getCacheBySession |
| 31 | `src/queries/tool-analyzer.ts` | ToolAnalyzer class: getToolUsage, getToolSuccessRates, getMCPServerUsage, getToolChains |
| 32 | `src/queries/time-series.ts` | TimeSeriesAnalyzer class: getHourlyActivity, getDailyActivity, getWeeklyTrend |

## Source — Watcher Module (3)

| # | Path | Description |
|---|------|-------------|
| 33 | `src/watcher/index.ts` | Barrel export + Watcher class: start, stop, getStatus, onEvent |
| 34 | `src/watcher/chokidar-manager.ts` | ChokidarManager class: start, stop, onFileChange with awaitWriteFinish config |
| 35 | `src/watcher/change-processor.ts` | ChangeProcessor class: enqueue, flush, onBatch with debounce logic |

## Source — CLI Module (7)

| # | Path | Description |
|---|------|-------------|
| 36 | `src/cli.ts` | Main entry point: Commander program with global options, registers all subcommands, error handlers |
| 37 | `src/commands/ingest.ts` | `ingest` command: --incremental, --full, --project, --batch-size flags |
| 38 | `src/commands/query.ts` | `query <type>` command: cost/sessions/tools/cache/activity, --period, --model, --sort, --limit |
| 39 | `src/commands/watch.ts` | `watch` command: --interval flag, SIGINT/SIGTERM graceful shutdown |
| 40 | `src/commands/dashboard.ts` | `dashboard` command: --refresh, --compact, --period flags |
| 41 | `src/commands/status.ts` | `status` command: DB stats, table row counts, ingestion status |
| 42 | `src/commands/export.ts` | `export` command: --format (parquet/csv/json), --output, --compress, --table |

## SQL Files (2)

| # | Path | Description |
|---|------|-------------|
| 43 | `sql/schema.sql` | Complete DDL: 5 tables, 14 indexes, schema_migrations tracking |
| 44 | `sql/views.sql` | 5 analytical views: v_daily_cost, v_session_summary, v_tool_usage, v_cache_efficiency, v_hourly_activity |

## Test Fixtures (3)

| # | Path | Description |
|---|------|-------------|
| 45 | `tests/fixtures/minimal-session.jsonl` | 2 lines: one user message + one assistant response with costUSD and usage |
| 46 | `tests/fixtures/streaming-duplicates.jsonl` | 4 lines: 1 user + 3 assistant messages sharing same requestId (test dedup: last wins) |
| 47 | `tests/fixtures/multi-turn-session.jsonl` | 9 lines: 4 user/assistant pairs with tool_use blocks (Read, Edit, Bash), thinking blocks |

## Test Files (2)

| # | Path | Description |
|---|------|-------------|
| 48 | `tests/ingestion/jsonl-parser.test.ts` | Vitest unit tests: parse user/assistant messages, handle corrupt lines, parse tool_use blocks |
| 49 | `tests/queries/cost-analyzer.test.ts` | Vitest integration tests: daily costs, cost by model, total cost (DuckDB :memory: mode) |

## Documentation (1)

| # | Path | Description |
|---|------|-------------|
| 50 | `docs/architecture/06-bootstrap-manifest.md` | This file: complete manifest of all bootstrapped files |

---

## Directory Structure

```
ccanalytics/
  .gitignore
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  docs/
    architecture/
      06-bootstrap-manifest.md
  sql/
    schema.sql
    views.sql
  src/
    cli.ts
    errors.ts
    commands/
      dashboard.ts
      export.ts
      ingest.ts
      query.ts
      status.ts
      watch.ts
    config/
      defaults.ts
      index.ts
      loader.ts
    db/
      connection.ts
      executor.ts
      index.ts
      schema.ts
    ingestion/
      batch-inserter.ts
      deduplicator.ts
      file-discovery.ts
      index.ts
      ingestion-tracker.ts
      jsonl-parser.ts
    queries/
      cache-analyzer.ts
      cost-analyzer.ts
      index.ts
      session-analyzer.ts
      time-series.ts
      tool-analyzer.ts
    types/
      analytics.ts
      config.ts
      index.ts
      jsonl.ts
    utils/
      format.ts
      logger.ts
      paths.ts
    watcher/
      change-processor.ts
      chokidar-manager.ts
      index.ts
  tests/
    fixtures/
      minimal-session.jsonl
      multi-turn-session.jsonl
      streaming-duplicates.jsonl
    ingestion/
      jsonl-parser.test.ts
    queries/
      cost-analyzer.test.ts
```
