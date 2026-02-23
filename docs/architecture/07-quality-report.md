# 07 -- Architecture Quality Report

> Validation of the ccanalytics architecture elaboration for completeness,
> consistency, and traceability against all V0 requirements.
>
> Validation date: 2026-02-23
> Validator role: Principal Architect / QA Lead

---

## 1. V0 Coverage Assessment

**Score: 95 / 100**

Every major topic from the V0 plan (`docs/ccanalytics-V0.md`) has been extracted,
elaborated, and traced through the architecture documents. The assessment below
checks each required item.

| # | V0 Topic | Covered | Document(s) | Notes |
|---|----------|---------|-------------|-------|
| 1 | JSONL file parsing data surface | YES | 00 (Section 5.1), 02 (Section 5), 03 (Module 2) | Fully elaborated with byte-offset parsing, type discrimination, and file discovery |
| 2 | OTel export data surface | YES | 00 (Section 5.2, 12), 01 (Container: OTel Receiver) | All 8 metrics and 4 event types documented. OTel Receiver is an optional container in C4 |
| 3 | Hooks system data surface | YES | 00 (Section 5.3, 13), 01 (Container: Hooks Processor), 03 (Module not implemented) | All 14 events listed. Hooks Processor has C4 component diagram. Note: no dedicated hooks module in bootstrap -- hooks are mentioned conceptually but not fully scaffolded |
| 4 | Star schema (5 tables) | YES | 00 (Section 7), 02 (Section 1), SQL `schema.sql` | Complete DDL for all 5 tables + schema_migrations. Tables match across all docs |
| 5 | All 9 technology decisions | YES | 00 (Section 4), 01 (Section 5 ADRs, Section 6) | 10 ADRs documented (exceeds 9). All V0 tech choices present: DuckDB, Commander, Chokidar, tsup, picocolors, nanospinner, cli-table3, @duckdb/node-api, Vitest |
| 6 | Cache hit rate metric with formula | YES | 00 (Section 8.1), 02 (View v_cache_efficiency, v_session_summary) | Formula: `cache_read / (cache_read + cache_write + uncached_input)`. Implemented in 2 SQL views. Thresholds (>80% effective, <50% wasted) documented |
| 7 | Context window utilization metric | PARTIAL | 00 (Section 8.2) | Formula documented in analysis. No dedicated SQL view or query module method implements it. The data source (statusLine API's `context_window` field) is not ingested into the star schema |
| 8 | I/O token ratio metric | YES | 00 (Section 8.3), 03 (SessionAnalyzer, CostAnalyzer) | Formula: `total_input_tokens / total_output_tokens`. Available via session summary queries |
| 9 | Tool call patterns | YES | 00 (Section 8.4), 02 (View v_tool_usage), 03 (ToolAnalyzer) | Call frequency, chains, success/failure rates, MCP server aggregation, per-tool cost all specified |
| 10 | Cost calculation formula | YES | 00 (Section 10.2), 03 (CostAnalyzer with crossValidateCosts) | Formula documented. Cross-validation against JSONL `costUSD` explicitly designed |
| 11 | Model pricing table | YES | 00 (Section 10.1), 04 (Section 3 pricing config) | Opus 4.5, Sonnet 4.5, Haiku 4.5 with input/cache_write/cache_read/output rates. Configurable via `pricing.models` in config |
| 12 | 4 scaling stages | YES | 00 (Section 11), 01 (Appendix B), 05 (Section 3) | All 4 stages: Local DuckDB, MotherDuck, pg_duckdb, ClickHouse. Migration SQL provided for each |
| 13 | 14 hook events documented | YES | 00 (Section 13.1) | All 14 listed: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Stop, SubagentStop, SubagentStart, Notification, PreCompact, TeammateIdle, TaskCompleted |
| 14 | 8 OTel metrics documented | YES | 00 (Section 12.2) | All 8: session.count, token.usage, cost.usage, lines_of_code.count, pull_request.count, commit.count, code_edit_tool.decision, active_time.total |
| 15 | requestId deduplication | YES | 00 (Section 6.4), 02 (Section 6), 03 (Deduplicator module) | "Last entry wins" rule. Two-phase dedup: in-memory + DB-level ON CONFLICT. MERGE INTO for bulk reprocessing |
| 16 | Incremental ingestion (byte-offset) | YES | 00 (Section 7.5), 02 (Section 5), 03 (IngestionTracker) | `ingestion_state` table tracks `last_byte_offset`, `last_line_number`, `file_checksum`. Full algorithm documented |
| 17 | Chokidar awaitWriteFinish | YES | 02 (Section 5.4), 03 (ChokidarManager), 05 (Section 4.5) | 2-second stability threshold. Chokidar config code provided. Cross-platform event handling |
| 18 | Parquet archival | YES | 02 (Section 10), 04 (export command) | ZSTD compression, date-month partitioning, COPY ... TO ... syntax, cleanup SQL, union query for archived+live data |

**Deductions (-5 points):**

- **Context window utilization (-3):** The metric formula is documented in the analysis (00) but lacks a concrete implementation path. The `context_window` data from the statusLine API is not ingested into any table. No SQL view computes it. The `max_context_window` per model is not stored anywhere in the schema.
- **Hooks module scaffold (-2):** The C4 architecture (01) defines a Hooks Processor container with 3 components (HookReceiver, EventFilter, IngestionTrigger), but the bootstrap manifest (06) does not include a `src/hooks/` directory. The component design (03) omits a dedicated hooks module. The hooks processor lives only in the C4 diagrams.

---

## 2. Architecture Consistency

**Score: 88 / 100**

### C4 containers vs. component design modules

| C4 Container (01) | Component Design Module (03) | Match |
|---|---|---|
| CLI Shell | Module 1 -- CLI (`src/cli/`) | YES -- but C4 shows `src/cli/commands.ts` while bootstrap has `src/commands/*.ts` |
| JSONL Ingestion Engine | Module 2 -- Ingestion (`src/ingestion/`) | YES |
| DuckDB Analytics Engine | Module 5 -- Database (`src/db/`) + Module 3 -- Query (`src/queries/`) | YES -- C4 combines them; component design splits correctly |
| File Watcher | Module 4 -- Watcher (`src/watcher/`) | YES |
| Hooks Processor | (not in component design) | MISMATCH -- C4 defines it but 03 omits it |
| OTel Receiver | (not in component design) | OK -- explicitly marked as optional in C4 |
| Dashboard Renderer | (folded into CLI/Query) | OK -- dashboard is a CLI command using Query module |
| Configuration Manager | Module 6 -- Config (`src/config/`) | YES |

### Data schema columns vs. JSONL type definitions

| Schema Column (02/SQL) | TypeScript Type (types/jsonl.ts) | Match |
|---|---|---|
| `session_id` (VARCHAR) | `sessionId: string` | YES |
| `timestamp` (TIMESTAMP) | `timestamp: string` (ISO 8601) | YES |
| `cost_usd` (DOUBLE) | `costUSD: number` | YES |
| `input_tokens` (BIGINT) | `usage.input_tokens: number` | YES |
| `output_tokens` (BIGINT) | `usage.output_tokens: number` | YES |
| `cache_creation_tokens` (BIGINT) | `usage.cache_creation_input_tokens: number` | YES |
| `cache_read_tokens` (BIGINT) | `usage.cache_read_input_tokens: number` | YES |
| `request_id` (VARCHAR) | `requestId: string` | YES |
| `tool_name` (VARCHAR) | `ToolUseBlock.name: string` | YES |
| `parameters` (JSON) | `ToolUseBlock.input: Record<string, unknown>` | YES |

### Database row types (types/analytics.ts) vs. DDL schema (sql/schema.sql)

| Issue | Detail |
|---|---|
| Column naming mismatch | `SessionRow.duration_ms` (analytics.ts) vs. `duration_seconds` (schema.sql) -- inconsistent unit. The DDL stores INTEGER seconds; the TypeScript type says `_ms`. |
| Column naming mismatch | `SessionRow.total_cost` (analytics.ts) vs. `total_cost_usd` (schema.sql) |
| Column naming mismatch | `SessionRow.total_input_tokens` (analytics.ts) vs. `input_tokens` (schema.sql) |
| Column naming mismatch | `SessionRow.total_output_tokens` (analytics.ts) vs. `output_tokens` (schema.sql) |
| Column naming mismatch | `SessionRow.total_cache_write_tokens` (analytics.ts) vs. `cache_creation_tokens` (schema.sql) |
| Column naming mismatch | `SessionRow.total_cache_read_tokens` (analytics.ts) vs. `cache_read_tokens` (schema.sql) |
| Missing columns | `SessionRow` lacks `git_branch`, `claude_version`, `project_path` which are in the DDL |
| Column naming mismatch | `ConversationTurnRow.cache_write_tokens` (analytics.ts) vs. `cache_creation_tokens` (schema.sql) |
| Column naming mismatch | `ConversationTurnRow.cost` (analytics.ts) vs. `cost_usd` (schema.sql) |
| Missing columns | `ConversationTurnRow` lacks `parent_uuid`, `has_tool_use`, `has_thinking` which are in the DDL |
| Missing columns | `ToolCallRow` lacks `tool_type`, `mcp_server` which are in the DDL |
| Missing columns | `IngestionState` lacks `file_size_bytes` which is in the DDL |

### CLI commands vs. query module methods

| CLI Command (04) | Query Module (03) | Match |
|---|---|---|
| `query cost` | `CostAnalyzer.getCostTrend()` | YES |
| `query sessions` | `SessionAnalyzer.listSessions()` | YES |
| `query tools` | `ToolAnalyzer.getToolUsage()` | YES |
| `query cache` | `CacheAnalyzer.getCacheEfficiencyTrend()` | YES |
| `query activity` | `TimeSeriesAnalyzer.getActivityHeatmap()` | YES |

### CLI commands: 04 specifies 6 commands, V0 mentions 4

The V0 document lists `ingest`, `query`, `watch`, `dashboard`. The architecture adds `status` and `export`. This is a valid elaboration, not a mismatch.

**Deductions (-12 points):**

- **Database row type mismatches (-8):** Multiple column name discrepancies between `types/analytics.ts` (SessionRow, ConversationTurnRow, ToolCallRow, IngestionState) and the actual DDL in `sql/schema.sql`. The DDL in doc 02 and the SQL file are consistent with each other, but the TypeScript types diverge. This will cause runtime mapping bugs.
- **Hooks Processor gap (-2):** C4 defines a Hooks Processor container; component design does not implement it.
- **CLI path discrepancy (-2):** C4 shows `src/cli/commands.ts` as a single file; the actual bootstrap has `src/commands/` as a separate directory outside `src/cli/`. The component design (03) shows `src/cli/commands/` but the manifest (06) and actual files show `src/commands/`.

---

## 3. Data Design Quality

**Score: 93 / 100**

### Valid DuckDB DDL

The `sql/schema.sql` file contains syntactically correct DuckDB DDL:
- `CREATE TABLE IF NOT EXISTS` for all 5 core tables + `schema_migrations`
- Proper PRIMARY KEY, FOREIGN KEY (REFERENCES), UNIQUE, DEFAULT constraints
- Correct DuckDB types: VARCHAR, BIGINT, DOUBLE, TIMESTAMP, INTEGER, BOOLEAN, JSON
- `CREATE INDEX IF NOT EXISTS` for 14 indexes
- Version tracking via `schema_migrations` table with `ON CONFLICT DO NOTHING`

The `sql/views.sql` file contains 5 valid `CREATE OR REPLACE VIEW` statements that reference correct table and column names from the schema.

### Indexes cover common query patterns

| Query Pattern | Index Coverage | Adequate |
|---|---|---|
| Time-range session queries | `idx_sessions_start_time` | YES |
| Project-scoped queries | `idx_sessions_project_path`, `idx_sessions_project_time` | YES |
| Session drill-down (turns) | `idx_turns_session_id`, `idx_turns_session_time` | YES |
| Deduplication lookup | `idx_turns_request_id` | YES |
| Tool frequency analysis | `idx_tools_tool_name` | YES |
| Error timeline | `idx_errors_session_time`, `idx_errors_type` | YES |
| MCP server aggregation | No index on `tool_calls.mcp_server` | MINOR GAP |

### Views implement correct formulas

| View | Formula Correctness | Verified |
|---|---|---|
| `v_daily_cost` | Groups by date and model; sums cost, tokens; counts sessions | CORRECT |
| `v_session_summary` | Cache hit rate: `cache_read / (cache_read + cache_creation + input)` with zero-division guard | CORRECT -- matches V0 formula |
| `v_tool_usage` | Success rate with FILTER(WHERE success IS NOT NULL) denominator; avg per session | CORRECT |
| `v_cache_efficiency` | Same cache hit rate formula at daily granularity; includes estimated_tokens_saved | CORRECT |
| `v_hourly_activity` | EXTRACT(HOUR) grouping; includes avg cost and total tokens | CORRECT |

### Incremental ingestion design

The design in `02-data-architecture.md` (Section 5) is thorough:
- Complete algorithm with pseudocode
- Truncation detection via `file_size < last_byte_offset`
- Checksum verification for file rotation
- SQL for ingestion state upsert
- Chokidar configuration with TypeScript code
- Batch insert with prepared statements and transaction management
- Performance characteristics documented (50K rows/sec)

**Deductions (-7 points):**

- **Missing `mcp_server` index (-1):** The `v_tool_usage` view groups by `mcp_server` but there is no index on this column.
- **No I/O ratio view (-2):** The V0 document identifies I/O token ratio as a key metric, but no SQL view computes it. The `v_session_summary` view has the raw tokens but does not compute the ratio.
- **No context window view (-2):** No view or schema support for context window utilization tracking.
- **Parquet archival uses string interpolation (-2):** The archival SQL in doc 02 uses `${retention_days}` which is not valid DuckDB SQL. It needs parameterization or the retention value must be a literal.

---

## 4. API Design Quality

**Score: 92 / 100**

### Command documentation completeness

| Command | Flags Documented | Examples | Behavior Described | Output Shown |
|---|---|---|---|---|
| `ingest` | YES (7 flags) | YES (4 examples) | YES (8-step behavior) | Implicit via status |
| `query <type>` | YES (7 flags) | YES (5 examples) | YES (5 query types) | YES (table format for each) |
| `watch` | YES (4 flags) | YES (3 examples) | YES (7-step behavior) | YES (stderr log format) |
| `dashboard` | YES (3 flags) | YES (2 examples) | YES (panel layout shown) | YES (ASCII dashboard mock) |
| `status` | YES (global only) | YES (1 example) | YES (field descriptions) | YES (full output mock) |
| `export` | YES (5 flags) | YES (4 examples) | YES (6-step behavior) | YES (file list with sizes) |

### Output formats documented

All three formats (table, JSON, CSV) are fully specified in Section 7 of doc 04:
- Table: Unicode borders, color coding, number formatting, summary rows
- JSON: Root object with `query`, `period`, `generated_at`, `rows`, `summary`
- CSV: RFC 4180 compliant, header row, no BOM, Unix line endings

### Configuration schema

Doc 04 Section 3 provides a complete JSONC configuration file with:
- All fields typed and defaulted
- Comments explaining each field
- Min/max constraints documented
- Pricing table with per-model rates
- Summary table with 17 configuration fields

### Exit codes

5 exit codes (0-4) are defined in doc 04 Section 4. Doc 05 extends this to 6 codes (0-6) in the error hierarchy. There is a **minor inconsistency**: doc 04 defines code 4 as "No Data" while doc 05 defines code 4 as "QueryError". Both documents define code 2 as "Config Error" (doc 04) vs "DatabaseError" (doc 05).

**Deductions (-8 points):**

- **Exit code inconsistency (-3):** Doc 04 (API spec) and doc 05 (cross-cutting) define different exit code mappings. Doc 04 has 5 codes (0-4); doc 05 has 7 codes (0-6). The mapping of codes 2-4 conflicts between the two documents.
- **Missing `--sql` flag in query command (-2):** The component design (03) mentions `QueryOptions.sql` for raw SQL execution, but the API spec (04) does not document a `--sql` flag on the `query` command. This means ad-hoc SQL is designed but not exposed.
- **No `--config` flag documented (-1):** The config loader (03) supports explicit `--config <path>`, but this flag is not in the global options table of doc 04.
- **Chokidar version discrepancy (-2):** V0 and doc 01 specify Chokidar **v5**; `package.json` specifies `"chokidar": "^4"`. This is a meaningful discrepancy since Chokidar v4 and v5 have API differences.

---

## 5. Implementation Readiness

**Score: 90 / 100**

### Package.json dependencies

| Required (from V0) | In package.json | Correct |
|---|---|---|
| `@duckdb/node-api` v1.4 | `"@duckdb/node-api": "^1.4"` | YES |
| `commander` v12 | `"commander": "^12"` | YES |
| `chokidar` v5 | `"chokidar": "^4"` | WRONG VERSION -- should be `^5` per V0 |
| `picocolors` | `"picocolors": "^1"` | YES |
| `nanospinner` | `"nanospinner": "^1"` | YES |
| `cli-table3` | `"cli-table3": "^0.6"` | YES |
| `tsup` (dev) | `"tsup": "^8"` | YES |
| `vitest` (dev) | `"vitest": "^3"` | YES |
| `typescript` (dev) | `"typescript": "^5.7"` | YES |

Additional `package.json` checks:
- `"bin": { "ccanalytics": "./dist/cli.cjs" }` -- correct CJS entry per V0 (NFR-07)
- `"engines": { "node": ">=20" }` -- matches V0 target (NFR-06)
- `"files": ["dist", "sql"]` -- includes SQL files for distribution
- `"scripts.build": "tsup"` -- correct
- `"scripts.prepublishOnly": "npm run build"` -- correct
- Missing: `"scripts.start"` is absent, which is fine for a CLI tool

### Skeleton files structure

All 37 source TypeScript files from the bootstrap manifest exist on disk:
- `src/types/` -- 4 files (index, jsonl, analytics, config)
- `src/errors.ts` -- 1 file
- `src/utils/` -- 3 files (format, logger, paths)
- `src/config/` -- 3 files (index, defaults, loader)
- `src/db/` -- 4 files (index, connection, schema, executor)
- `src/ingestion/` -- 6 files (index, file-discovery, jsonl-parser, deduplicator, batch-inserter, ingestion-tracker)
- `src/queries/` -- 6 files (index, session-analyzer, cost-analyzer, cache-analyzer, tool-analyzer, time-series)
- `src/watcher/` -- 3 files (index, chokidar-manager, change-processor)
- `src/commands/` -- 6 files (ingest, query, watch, dashboard, status, export)
- `src/cli.ts` -- 1 file (entry point)

The `src/cli.ts` file has correct imports:
- `commander` for CLI framework
- Config, Logger, Error classes imported
- All 6 command registrations
- Global error handlers installed
- Clean entry point pattern

### SQL files

Both SQL files are present and appear runnable:
- `sql/schema.sql` (116 lines) -- 6 tables, 14 indexes, 1 migration record
- `sql/views.sql` (138 lines) -- 5 analytical views

### Test fixtures

3 JSONL test fixtures exist and are valid:
- `tests/fixtures/minimal-session.jsonl` -- baseline happy path
- `tests/fixtures/streaming-duplicates.jsonl` -- deduplication testing
- `tests/fixtures/multi-turn-session.jsonl` -- multi-turn with tool calls

The cross-cutting doc (05) specifies 6 fixtures, but only 3 are bootstrapped:
- MISSING: `mcp-tools-session.jsonl`
- MISSING: `corrupt-lines.jsonl`
- MISSING: `cache-heavy-session.jsonl`

### Test files

2 test files exist:
- `tests/ingestion/jsonl-parser.test.ts`
- `tests/queries/cost-analyzer.test.ts`

The testing strategy (05) specifies a broader test suite including tests for deduplicator, batch-inserter, cache-analyzer, session-analyzer, tool-analyzer, output-formatter, connection, and schema. Only 2 of the planned test files are bootstrapped.

### Directory structure

All directories specified in the bootstrap manifest exist:
- `src/types/`, `src/utils/`, `src/config/`, `src/db/`, `src/ingestion/`, `src/queries/`, `src/watcher/`, `src/commands/`
- `sql/`, `tests/fixtures/`, `tests/ingestion/`, `tests/queries/`
- `docs/architecture/`

**Deductions (-10 points):**

- **Chokidar version (-3):** `package.json` specifies `^4` but V0 and all architecture docs specify v5.
- **Missing test fixtures (-3):** 3 of 6 specified fixtures are missing (mcp-tools, corrupt-lines, cache-heavy).
- **Missing test files (-2):** Only 2 of ~10 specified test files are bootstrapped. The testing strategy is well-defined but the scaffolding is incomplete.
- **Database row type mismatches (-2):** As noted in Section 2, the TypeScript row types in `types/analytics.ts` do not match the DDL column names. These skeleton files will not work correctly without correction.

---

## 6. Overall Score

| Category | Weight | Score | Weighted |
|----------|--------|-------|----------|
| V0 Coverage | 30% | 95 | 28.5 |
| Architecture Consistency | 20% | 88 | 17.6 |
| Data Design | 20% | 93 | 18.6 |
| API Design | 15% | 92 | 13.8 |
| Implementation Readiness | 15% | 90 | 13.5 |
| **Overall** | **100%** | | **92.0** |

---

## 7. Gaps and Missing Elements

### High Priority

1. **Context window utilization has no implementation path.** The V0 document identifies this as a key metric with a specific formula (`total_input_tokens / max_context_window`), but no table stores `max_context_window` per model, no view computes it, and the statusLine API's `context_window` data is not ingested. The schema needs a `model_config` lookup table or the `context_window` field needs to be added to `conversation_turns`.

2. **Database row type mismatches between TypeScript and DDL.** The `SessionRow`, `ConversationTurnRow`, `ToolCallRow`, and `IngestionState` types in `src/types/analytics.ts` use different column names than the DDL in `sql/schema.sql`. For example, `duration_ms` vs `duration_seconds`, `total_cost` vs `total_cost_usd`, `cache_write_tokens` vs `cache_creation_tokens`. These must be reconciled before implementation.

3. **Exit code inconsistency between docs 04 and 05.** The API spec (04) defines exit code 2 as "Config Error" and 4 as "No Data". The cross-cutting doc (05) defines code 2 as "DatabaseError", 4 as "QueryError", and adds codes 5 (ConfigError) and 6 (FileSystemError). One authoritative mapping is needed.

4. **Chokidar version mismatch.** All architecture documents specify Chokidar v5, but `package.json` pins `"chokidar": "^4"`. Chokidar v4 has a different API surface. The V0 document specifically calls out v5 for its `awaitWriteFinish` feature.

### Medium Priority

5. **Hooks Processor not scaffolded.** The C4 architecture defines a Hooks Processor container with HookReceiver, EventFilter, and IngestionTrigger components. However, the component design (03) omits a hooks module, and the bootstrap manifest (06) includes no `src/hooks/` directory. This is an intentional V0 scope reduction but should be explicitly documented as deferred.

6. **Missing 3 test fixtures.** The testing strategy (05) specifies 6 fixtures but only 3 are bootstrapped: `mcp-tools-session.jsonl`, `corrupt-lines.jsonl`, and `cache-heavy-session.jsonl` are missing.

7. **CLI command directory discrepancy.** The C4 architecture (01) and component design (03) describe commands under `src/cli/commands/`, but the bootstrap manifest (06) and actual files place them at `src/commands/` (outside `src/cli/`). The `src/cli.ts` imports from `./commands/` which matches the actual layout, but the architecture docs should be updated.

8. **No `--sql` flag for ad-hoc queries.** The component design (03, `QueryOptions.sql`) allows raw SQL, but the API spec (04) does not expose this as a CLI flag. Raw SQL access is a valuable feature for advanced users.

### Low Priority

9. **No `mcp_server` index.** The `v_tool_usage` view groups by `mcp_server`, but there is no index on `tool_calls.mcp_server`.

10. **I/O token ratio not in a view.** The metric is well-defined but has no SQL view, requiring users to compute it from raw columns.

11. **Parquet archival SQL uses string interpolation.** The `${retention_days}` pattern in doc 02 is not valid DuckDB SQL and needs to be parameterized in the TypeScript layer.

12. **No `--config` flag in global options.** The config loader supports explicit config path but the API spec does not document it as a global flag.

---

## 8. Recommendations

### For V0 Completion

1. **Reconcile TypeScript row types with DDL.** Update `src/types/analytics.ts` so that `SessionRow`, `ConversationTurnRow`, `ToolCallRow`, and `IngestionState` column names exactly match the `sql/schema.sql` DDL. Use the DDL as the source of truth.

2. **Fix Chokidar version in `package.json`.** Change `"chokidar": "^4"` to `"chokidar": "^5"` to match the V0 specification and all architecture documents.

3. **Unify exit codes.** Choose one exit code mapping and update both doc 04 and doc 05 to match. The doc 05 (cross-cutting) mapping is more granular and should be the canonical source.

4. **Add context window utilization support.** Either (a) add a `max_context_window` column to `conversation_turns` populated from model config, or (b) add a `model_config` reference table with context window sizes per model, and create a `v_context_utilization` view.

5. **Create missing test fixtures.** Bootstrap `mcp-tools-session.jsonl`, `corrupt-lines.jsonl`, and `cache-heavy-session.jsonl` per the specifications in doc 05 Section 2.4.

### For Post-V0 Iterations

6. **Scaffold the Hooks Processor module.** Create `src/hooks/` with `hook-receiver.ts`, `event-filter.ts`, and `ingestion-trigger.ts` to match the C4 component diagram.

7. **Add `--sql` flag to the query command.** Expose raw SQL execution for power users, with appropriate warnings about SQL injection (since the input comes from the CLI user themselves, this is acceptable).

8. **Add a `--config` global flag.** Document it alongside other global options in the API spec.

9. **Consider adding a `model_config` table.** This would store per-model metadata (context window size, pricing) and support the context window utilization metric, cost cross-validation, and future model additions without code changes.

10. **Normalize command directory path in docs.** Update C4 architecture (01) and component design (03) to reflect the actual `src/commands/` location rather than `src/cli/commands/`.

---

## 9. Deliverables Summary Table

| Document | Path | Lines | Key Contents |
|----------|------|-------|--------------|
| V0 Plan | `docs/ccanalytics-V0.md` | 208 | Original requirements: 3 data surfaces, star schema, 9 tech decisions, 4 CLI commands, model pricing, 4 scaling stages, analytics metrics |
| V0 Analysis | `docs/architecture/00-v0-analysis.md` | 760 | 32 functional requirements, 13 non-functional requirements, complete data surface specs, JSONL schema, star schema design, 14 hooks, 8 OTel metrics, traceability matrix |
| C4 Architecture | `docs/architecture/01-c4-architecture.md` | 770 | Context (Level 1), Container (Level 2), 7 Component (Level 3) diagrams in Mermaid, 10 ADRs, technology stack table, data flow diagram, scaling architecture |
| Data Architecture | `docs/architecture/02-data-architecture.md` | 1,755 | Complete DuckDB DDL for 5 tables, 14 indexes, 5 analytical views with SQL, data type mappings (3 tables), ingestion pipeline algorithm, deduplication strategy with code, Chokidar config, batch insert code, MERGE INTO patterns, Parquet archival SQL, ER diagram |
| Component Design | `docs/architecture/03-component-design.md` | 2,279 | 8 module specifications (CLI, Ingestion, Query, Watcher, Database, Config, Types, Utils), module dependency graph, initialization order, public interfaces with TypeScript, error handling per module, configuration per module, requirements traceability |
| API Specs | `docs/architecture/04-api-specs.md` | 1,123 | 6 CLI commands with flags/examples/output, 5 query types with columns/sort/examples, full configuration schema in JSONC, 5 exit codes, 4 environment variables, 6 example CLI sessions, 3 output format specs |
| Cross-Cutting | `docs/architecture/05-cross-cutting.md` | 1,375 | Error taxonomy with 12 error classes, 6 exit codes, recovery patterns with code, testing strategy (5 categories, 6 fixtures, coverage targets), 4-stage scaling playbook with migration SQL, performance considerations (5 topics), logging strategy with implementation |
| Bootstrap Manifest | `docs/architecture/06-bootstrap-manifest.md` | 224 | Inventory of 50 files across 14 categories, directory tree, file descriptions |
| **Total** | | **8,494** | |

### Bootstrapped Artifact Counts

| Category | Count |
|---|---|
| Architecture documents | 8 (including V0 source) |
| TypeScript source files | 37 |
| SQL files | 2 |
| Config files | 5 (package.json, tsconfig.json, tsup.config.ts, vitest.config.ts, .gitignore) |
| Test fixtures (JSONL) | 3 |
| Test files | 2 |
| **Total files** | **57** |

---

## Appendix: Spot-Check Results

### package.json

- EXISTS: Yes
- Correct `bin` entry pointing to `./dist/cli.cjs`: Yes
- All 6 runtime dependencies present: Yes (but chokidar version is `^4` instead of `^5`)
- All 4 dev dependencies present: Yes
- Engine constraint `>=20`: Yes
- Build scripts: Yes (`build`, `dev`, `test`, `lint`, `prepublishOnly`)

### src/cli.ts

- EXISTS: Yes (101 lines)
- Imports Commander: Yes
- Registers all 6 subcommands: Yes
- Global error handlers (uncaughtException, unhandledRejection): Yes
- Calls `program.parseAsync()`: Yes
- Proper entry point pattern: Yes

### src/types/jsonl.ts

- EXISTS: Yes (130 lines)
- Defines all 4 message types (UserMessage, AssistantMessage, FileHistorySnapshot, QueueOperation): Yes
- Defines TokenUsage with all 4 fields: Yes
- Defines ContentBlock union (TextBlock, ToolUseBlock, ThinkingBlock, ToolResultBlock): Yes
- Defines RawJSONLEntry for pre-discrimination: Yes
- BaseMessage interface for shared fields: Yes

### sql/schema.sql

- EXISTS: Yes (116 lines)
- 5 core tables + schema_migrations: Yes (6 total)
- 14 indexes: Yes
- CREATE TABLE IF NOT EXISTS: Yes
- CREATE INDEX IF NOT EXISTS: Yes
- Foreign key references: Yes (conversation_turns -> sessions, tool_calls -> sessions + conversation_turns, errors -> sessions)
- UNIQUE constraint on request_id: Yes
- Initial migration record: Yes

### sql/views.sql

- EXISTS: Yes (138 lines)
- 5 views: Yes (v_daily_cost, v_session_summary, v_tool_usage, v_cache_efficiency, v_hourly_activity)
- Cache hit rate formula correct: Yes
- Zero-division guards: Yes (CASE WHEN ... > 0)
- Correct column references: Yes (all reference schema.sql columns)
