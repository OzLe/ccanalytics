# ccanalytics

Local-first analytics for Claude Code sessions — cost tracking, cache efficiency, tool usage patterns, and session insights powered by DuckDB.

## Quickstart

ccanalytics is not yet published to npm — build it from source:

```bash
git clone https://github.com/OzLe/ccanalytics.git
cd ccanalytics
npm install
npm run build

# Optionally link the `ccanalytics` command onto your PATH
npm link
```

Requires **Node.js 20+**. Without `npm link`, invoke the CLI directly as
`node dist/cli.cjs <command>` in place of `ccanalytics <command>` below.

```bash
# 1. Ingest your Claude Code session data
ccanalytics ingest

# 2. Check what was loaded
ccanalytics status

# 3. Query your analytics
ccanalytics query cost --period 7d
ccanalytics query sessions --period 30d
ccanalytics query tools
ccanalytics query cache

# 4. Launch the interactive dashboard
ccanalytics dashboard

# 5. Watch for new sessions in real-time
ccanalytics watch
```

Data is read from `~/.claude/projects/` and stored in a local DuckDB database at `~/.ccanalytics/analytics.duckdb`.

## Commands

### `ingest` — Load session data

Parses JSONL files from `~/.claude/projects/` into the analytics database. Incremental by default — only new data is processed on subsequent runs.

```bash
ccanalytics ingest                # Incremental (default)
ccanalytics ingest --full         # Force full re-ingestion
ccanalytics ingest --project foo  # Restrict to a specific project
```

### `query <type>` — Run analytics

Five built-in query types:

| Type | Description |
|------|-------------|
| `cost` | Daily cost breakdown by model |
| `sessions` | Session list with duration, cost, cache efficiency |
| `tools` | Tool usage frequency and success rates |
| `cache` | Cache hit rates and estimated savings |
| `activity` | Hourly usage distribution |

```bash
ccanalytics query cost --period 30d --model claude-sonnet-4
ccanalytics query sessions --sort total_cost_usd --limit 10
ccanalytics query tools --format json
```

**Common options:** `--period` (today, 7d, 30d, 90d, all), `--model`, `--project`, `--format` (table, json, csv), `--sort`, `--limit`

### `dashboard` — Interactive terminal UI

Live-updating dashboard with cost summary, cache efficiency, session stats, and top tools.

```bash
ccanalytics dashboard                    # Default 30s refresh
ccanalytics dashboard --refresh 10       # 10s refresh
ccanalytics dashboard --compact          # Single-column layout
ccanalytics dashboard --period 30d       # Default time range
```

**Keyboard shortcuts:** `r` refresh, `q` quit, `1-4` change period, `c` toggle compact

### `watch` — Real-time monitoring

Monitors `~/.claude/projects/**/*.jsonl` for changes and triggers incremental ingestion automatically.

```bash
ccanalytics watch
ccanalytics watch --interval 5000   # 5s polling interval
```

### `web` — Browser dashboard

A richer React dashboard with interactive charts. It has its own dependencies,
so install them once before first use:

```bash
cd dashboard && npm install && cd ..
```

```bash
ccanalytics web              # API on :3001, UI on :5173
ccanalytics web --dev        # Vite dev server with hot reload
ccanalytics web --api-only   # Start only the API server
```

`npm run build:dashboard` produces an optimized production build that `web`
serves automatically when present.

### Run at login (macOS)

`ccanalytics web` launches the web dashboard (API on `:3001`, UI on `:5173`).
To start it automatically when you log in, install the LaunchAgent:

```bash
./scripts/install-launchagent.sh              # install + start now
./scripts/install-launchagent.sh --status     # check whether it's loaded
./scripts/install-launchagent.sh --uninstall  # unload + remove
```

The agent runs `ccanalytics web --no-open` and keeps it alive; logs go to
`~/.ccanalytics/logs/`. It pins the current `node` path, so re-run the script
after switching node versions (e.g. via nvm).

### `export` — Export data

Export analytics to Parquet, CSV, or JSON for use in other tools.

```bash
ccanalytics export                          # Parquet with ZSTD compression
ccanalytics export --format csv             # CSV export
ccanalytics export --table sessions --table tool_calls  # Specific tables
ccanalytics export --period 30d             # Time-filtered export
```

### `status` — Pipeline health

Shows database size, table row counts, last ingestion time, and config.

```bash
ccanalytics status
```

### Global options

```
--db <path>         DuckDB database path (default: ~/.ccanalytics/analytics.duckdb)
--claude-dir <path> Claude data directory (default: ~/.claude)
--format <fmt>      Output format: table, json, csv
--verbose           Enable verbose logging
```

## Architecture

```
~/.claude/projects/**/*.jsonl
            |
     File Discovery
            |
      JSONL Parser ──── Streaming, line-by-line with error recovery
            |
      Deduplicator ──── Last requestId wins (handles streaming duplicates)
            |
     Batch Inserter ─── 1000 rows/batch into DuckDB
            |
     DuckDB Star Schema (5 tables)
            |
     Analytical Views (5 pre-built)
            |
     Query Analyzers ── Cost, Session, Tool, Cache, TimeSeries
            |
     Output Formatter ─ Table, JSON, CSV
```

### Star schema

**Fact table:**
- `sessions` — per-session aggregates (tokens, cost, duration, turns, tool calls)

**Dimension tables:**
- `conversation_turns` — per-turn token usage, cost, model, stop reason
- `tool_calls` — tool name, type (builtin/MCP), server, duration, success/failure
- `errors` — error type, message, retryability

**Operational:**
- `ingestion_state` — byte-offset tracking for incremental ingestion

### Analytical views

| View | Purpose |
|------|---------|
| `v_daily_cost` | Daily cost aggregation by model |
| `v_session_summary` | Sessions with computed cache hit rate |
| `v_tool_usage` | Tool frequency, success rates, per-session averages |
| `v_cache_efficiency` | Daily cache metrics and estimated savings |
| `v_hourly_activity` | Activity distribution by hour of day |

### Key metrics

**Cache hit rate** — the single most impactful metric for cost optimization:
```
cache_hit_rate = cache_read_tokens / (cache_read + cache_write + uncached_input)
```
- \> 80%: effective caching (each hit saves 90% of input cost)
- < 50%: wasted spend — investigate prompt structure

**Context window utilization:**
```
utilization = total_input_tokens / max_context_window
```
- \> 60%: risk of degraded quality; consider `/compact`

### Data flow

ccanalytics reads from Claude Code's JSONL session logs. Each assistant message contains pre-calculated `costUSD` and full token breakdowns (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). ccanalytics aggregates and visualizes — it does not recalculate costs.

Ingestion is incremental by default: byte offsets are tracked per file so only new data is parsed on subsequent runs. The deduplicator handles streaming duplicates (multiple JSONL entries with the same `requestId`) by keeping the last entry.

### Scaling path

| Stage | Backend | Use case |
|-------|---------|----------|
| 1 | Local DuckDB file | Single developer (current) |
| 2 | MotherDuck | Team sharing, hybrid execution |
| 3 | PostgreSQL + pg_duckdb | RBAC, transactions, 1500x faster analytics |
| 4 | ClickHouse | Distributed, partitioned Parquet |

## Tech stack

| Component | Library |
|-----------|---------|
| Database | DuckDB (`@duckdb/node-api`) |
| CLI | Commander v12 |
| File watching | Chokidar v5 |
| Terminal output | picocolors, nanospinner, cli-table3 |
| Build | tsup (esbuild) |
| Tests | Vitest |

## Development

```bash
git clone https://github.com/OzLe/ccanalytics.git
cd ccanalytics
npm install
npm run build        # Build with tsup
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # Type-check
```

## Versioning

The version string in the dashboard sidebar and Settings page is **never
hard-coded**. It comes from compile-time globals injected by
`dashboard/vite.config.ts` via Vite's `define`:

- `__APP_VERSION__` — short semver (e.g. `0.1.6`)
- `__APP_FULL_VERSION__` — semver + commit count + short hash
  (e.g. `0.1.6+35.7aff4df`)

Source-of-truth chain:

1. `src/version.ts` (gitignored, auto-generated by
   `scripts/update-version.sh`)
2. Root `package.json` `version` field — fallback for fresh checkouts
3. Literal `"unknown"` — last-resort guard

`dashboard/package.json`'s `dev` and `build` scripts both prepend
`bash ../scripts/update-version.sh`, so the version file is always
fresh before Vite reads it.

To bump the patch version:

```bash
bash scripts/bump-patch.sh   # updates both package.json files
                             # and regenerates src/version.ts
```

After a code change that ships to users, **rebuild the dashboard and
restart the LaunchAgent** (if running) so the served bundle picks up
the new version:

```bash
cd dashboard && npm run build
launchctl unload ~/Library/LaunchAgents/com.ccanalytics.web.plist
launchctl load ~/Library/LaunchAgents/com.ccanalytics.web.plist
```

**Never type a version string into dashboard React.** Always use the
injected globals (declared in `dashboard/src/vite-env.d.ts`). The two
existing callsites are `dashboard/src/components/layout/Sidebar.tsx`
and `dashboard/src/pages/SettingsPage.tsx`.

## License

MIT
