# 04 -- API and Interface Specifications

> Complete CLI command reference, query type details, configuration schema,
> exit codes, environment variables, and output format specifications for ccanalytics.
>
> Predecessor docs: `00-v0-analysis.md`, `01-c4-architecture.md`,
> `02-data-architecture.md`, `03-component-design.md`

---

## Table of Contents

1. [CLI Command Reference](#1-cli-command-reference)
2. [Query Type Details](#2-query-type-details)
3. [Configuration Schema](#3-configuration-schema)
4. [Exit Codes](#4-exit-codes)
5. [Environment Variables](#5-environment-variables)
6. [Example CLI Sessions](#6-example-cli-sessions)
7. [Output Formats](#7-output-formats)

---

## 1. CLI Command Reference

ccanalytics exposes six subcommands. Every subcommand inherits the global
options listed below.

### Global Options

| Flag | Type | Default | Env Var | Description |
|------|------|---------|---------|-------------|
| `--db <path>` | `string` | `~/.ccanalytics/analytics.duckdb` | `CCANALYTICS_DB_PATH` | Path to the DuckDB database file. Created automatically if it does not exist. |
| `--claude-dir <path>` | `string` | Auto-detect (`~/.claude` or `~/.config/claude`) | `CCANALYTICS_CLAUDE_DIR` | Path to the Claude Code data directory. Auto-detection checks `~/.claude` first, then `~/.config/claude` (v1.0.30+). |
| `--format <fmt>` | `string` | `table` | `CCANALYTICS_FORMAT` | Output format. One of `table`, `json`, or `csv`. |
| `--verbose` | `boolean` | `false` | `CCANALYTICS_LOG_LEVEL=debug` | Enable verbose logging. Prints SQL queries, file-level processing details, and full stack traces to stderr. |
| `--help` | `boolean` | -- | -- | Show help for the command. |
| `--version` | `boolean` | -- | -- | Print the ccanalytics version and exit. |

Configuration precedence: **CLI flag > environment variable > config file > built-in default**.

---

### `ccanalytics ingest [options]`

Parse JSONL session transcripts from the Claude data directory and load them
into the DuckDB analytical store. Supports incremental ingestion via byte-offset
tracking per file, so only new data is processed on subsequent runs.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--claude-dir <path>` | `string` | Auto-detect | Override the Claude data directory for this run. Merged with the global `--claude-dir` option. |
| `--db <path>` | `string` | `~/.ccanalytics/analytics.duckdb` | Override the database path for this run. |
| `--incremental` | `boolean` | `true` | Only ingest new bytes appended since the last run. Uses the `ingestion_state` table to track byte offsets per file. This is the default behavior. |
| `--full` | `boolean` | `false` | Force a full re-ingestion, ignoring all previously tracked byte offsets. Equivalent to resetting the `ingestion_state` table before running. Mutually exclusive with `--incremental`. |
| `--project <name>` | `string` | (all projects) | Restrict ingestion to a specific project directory. Matches against the decoded project path (e.g., `my-app` matches `-Users-sam-Projects-my-app`). Supports glob patterns. |
| `--batch-size <n>` | `number` | `1000` | Maximum number of rows per INSERT batch. Lower values reduce memory usage; higher values improve throughput. |
| `--verbose` | `boolean` | `false` | Print per-file progress, parse error details, and DuckDB SQL statements to stderr. |

**Behavior:**

1. Discover all `.jsonl` files under `<claude-dir>/projects/`.
2. For each file, check `ingestion_state` for the last byte offset.
3. Read only new bytes from that offset onward.
4. Parse JSONL lines into typed records (user, assistant, file-history-snapshot, queue-operation).
5. Deduplicate assistant messages by `requestId` (last entry wins).
6. Extract session, turn, tool call, and error records.
7. Batch-insert into the star schema using `MERGE INTO` for idempotent session upserts.
8. Update `ingestion_state` with the new byte offset and checksum.

**Example:**

```bash
# Incremental ingestion (default)
ccanalytics ingest

# Full re-ingestion with verbose output
ccanalytics ingest --full --verbose

# Ingest only a specific project
ccanalytics ingest --project "my-app"

# Custom batch size for low-memory environments
ccanalytics ingest --batch-size 250
```

---

### `ccanalytics query <type> [options]`

Run pre-built analytical queries against the DuckDB store. The `<type>`
argument selects the query family. Each type returns a different set of
columns and supports its own sort fields.

**Available types:** `cost`, `sessions`, `tools`, `cache`, `activity`

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--period <range>` | `string` | `7d` | Time range filter. Accepted values: `today`, `7d`, `30d`, `90d`, `all`. Interpreted as "the last N days ending now" for relative values. |
| `--model <name>` | `string` | (all models) | Filter results to a specific model (e.g., `claude-sonnet-4-5-20250514`). Supports partial matching: `sonnet` matches any model containing "sonnet". |
| `--project <name>` | `string` | (all projects) | Filter results to a specific project. Matches against the decoded project path. Supports glob patterns. |
| `--format <fmt>` | `string` | `table` | Output format. One of `table`, `json`, `csv`. Overrides the global `--format` setting. |
| `--sort <field>` | `string` | (type-dependent) | Sort field. Valid values depend on the query type. See Section 2 for available sort fields per type. |
| `--limit <n>` | `number` | `25` | Maximum number of rows to return. Use `0` for unlimited. |
| `--desc` | `boolean` | `true` | Sort in descending order. Use `--no-desc` for ascending. |

**Example:**

```bash
# Cost breakdown for the last 7 days (default)
ccanalytics query cost

# Today's sessions sorted by duration
ccanalytics query sessions --period today --sort duration --no-desc

# Tool usage for the last 30 days, output as JSON
ccanalytics query tools --period 30d --format json

# Cache efficiency across all time
ccanalytics query cache --period all --limit 50

# Activity heatmap for the last 7 days
ccanalytics query activity --period 7d
```

---

### `ccanalytics watch [options]`

Start a long-running file watcher that monitors the Claude data directory
for new or modified JSONL files. When changes are detected, incremental
ingestion is triggered automatically. Uses Chokidar v5 with
`awaitWriteFinish` to safely handle partial writes.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--claude-dir <path>` | `string` | Auto-detect | Override the Claude data directory to watch. |
| `--db <path>` | `string` | `~/.ccanalytics/analytics.duckdb` | Override the database path. |
| `--interval <ms>` | `number` | `2000` | Polling interval in milliseconds when native filesystem events are unavailable. Also sets the `awaitWriteFinish` stability threshold. |
| `--verbose` | `boolean` | `false` | Print every detected file change event and ingestion result to stderr. |

**Behavior:**

1. Initialize Chokidar watcher on `<claude-dir>/projects/**/*.jsonl`.
2. Set `awaitWriteFinish` with `stabilityThreshold` equal to `--interval` value.
3. On file add/change events, debounce for 500ms, then batch-process changed files.
4. For each changed file, run incremental ingestion (read from last byte offset).
5. Print a summary line to stderr on each ingestion cycle.
6. Continue watching until `SIGINT` or `SIGTERM` is received.
7. On shutdown, flush any pending changes before exiting cleanly.

**Example:**

```bash
# Start watching with default settings
ccanalytics watch

# Watch with faster polling interval
ccanalytics watch --interval 1000

# Watch a non-default Claude directory
ccanalytics watch --claude-dir ~/.config/claude
```

**Output (stderr):**

```
[watch] Watching ~/.claude/projects/**/*.jsonl (42 files)
[watch] 14:32:01 - 2 files changed, 18 entries ingested (12ms)
[watch] 14:35:44 - 1 file changed, 7 entries ingested (4ms)
^C
[watch] Shutting down... flushed 0 pending changes
```

---

### `ccanalytics dashboard [options]`

Launch an interactive terminal dashboard showing key analytics metrics.
The dashboard refreshes periodically and displays cost trends, cache
efficiency, tool usage, and session activity in a compact terminal UI.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--refresh <seconds>` | `number` | `30` | Auto-refresh interval in seconds. Set to `0` to disable auto-refresh (manual refresh with `r` key). |
| `--compact` | `boolean` | `false` | Use a compact single-column layout suitable for narrow terminals (under 80 columns). |
| `--period <range>` | `string` | `7d` | Default time range for all dashboard panels. Accepts the same values as `query --period`. |

**Dashboard Panels:**

```
+---------------------------+---------------------------+
| Cost Summary (7d)         | Cache Efficiency (7d)     |
|                           |                           |
| Total:        $42.18      | Hit Rate:       82.4%     |
| Today:         $6.30      | Savings:       $31.06     |
| Avg/day:       $6.03      | Read Tokens:    1.2M      |
| Top model:  Sonnet 4.5    | Write Tokens:   142K      |
+---------------------------+---------------------------+
| Top Tools (7d)            | Activity (7d)             |
|                           |                           |
| Bash          1,247  42%  | Sessions:        38       |
| Read          1,102  37%  | Turns:        1,847       |
| Edit            389  13%  | Avg turns/sess:   49      |
| Grep            156   5%  | Avg duration:    34m      |
| Write            89   3%  | Peak hour:      14:00     |
+---------------------------+---------------------------+
| Cost Trend (7d)                                       |
|                                                       |
| $8 |    *                                             |
| $6 | *  * *  *  * *                                   |
| $4 |              *                                   |
| $2 |                                                  |
|    +--+--+--+--+--+--+--                              |
|    Mon Tue Wed Thu Fri Sat Sun                         |
+-------------------------------------------------------+
```

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `r` | Force refresh |
| `q` / `Ctrl+C` | Quit |
| `1`-`4` | Switch time period: `1`=today, `2`=7d, `3`=30d, `4`=all |
| `c` | Toggle compact mode |

**Example:**

```bash
# Default dashboard with 30-second refresh
ccanalytics dashboard

# Compact mode with 10-second refresh, showing today's data
ccanalytics dashboard --compact --refresh 10 --period today
```

---

### `ccanalytics status`

Display the current state of the ccanalytics database and ingestion
pipeline. Useful for verifying that the system is set up correctly and
data is being ingested.

This command takes no subcommand-specific flags beyond the global options.

| Field | Description |
|-------|-------------|
| DB Path | Absolute path to the DuckDB database file |
| DB Size | Size of the database file on disk |
| DuckDB Version | Version of the DuckDB engine in use |
| Schema Version | Current schema migration version |
| Table Row Counts | Number of rows in each of the 5 star schema tables |
| Last Ingestion | Timestamp of the most recent ingestion run |
| Watched Files | Number of files tracked in the `ingestion_state` table |
| Claude Dir | Resolved path to the Claude data directory |
| Config File | Path to the active config file (or "none") |

**Example output:**

```
ccanalytics status

  Database
    Path:             ~/.ccanalytics/analytics.duckdb
    Size:             14.2 MB
    DuckDB Version:   1.4.2
    Schema Version:   3

  Tables
    sessions:           847 rows
    conversation_turns: 41,203 rows
    tool_calls:         28,519 rows
    errors:                142 rows
    ingestion_state:       394 files

  Ingestion
    Last Run:           2026-02-23 14:32:01
    Claude Dir:         ~/.claude
    Projects Found:     12

  Config
    File:               ~/.ccanalytics/config.json
    Log Level:          info
    Default Format:     table
```

---

### `ccanalytics export [options]`

Export data from the DuckDB analytical store to portable file formats.
Supports Parquet (with ZSTD compression), CSV, and JSON. Useful for
archival, sharing with team members, or loading into external tools.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--format <fmt>` | `string` | `parquet` | Export format. One of `parquet`, `csv`, `json`. |
| `--output <path>` | `string` | `./ccanalytics-export/` | Output directory or file path. If a directory, individual files are created per table. If a file path (with extension), all data is exported to a single file. |
| `--compress` | `boolean` | `true` | Enable ZSTD compression for Parquet output. Achieves 5-10x storage savings. Ignored for CSV and JSON formats. |
| `--period <range>` | `string` | `all` | Export only data within this time range. Accepts the same values as `query --period`. |
| `--table <name>` | `string` | (all tables) | Export only a specific table. One of `sessions`, `conversation_turns`, `tool_calls`, `errors`. Can be specified multiple times: `--table sessions --table tool_calls`. |

**Behavior:**

1. Validate the output path and create parent directories if needed.
2. For each selected table, execute `COPY ... TO ...` with the chosen format.
3. For Parquet output with `--compress`, use `(FORMAT PARQUET, CODEC 'ZSTD')`.
4. For CSV output, include a header row. Values containing delimiters are escaped per RFC 4180.
5. For JSON output, emit one JSON object per line (NDJSON).
6. Print a summary of exported files, row counts, and total file size.

**Example:**

```bash
# Export everything as compressed Parquet (default)
ccanalytics export

# Export last 30 days of sessions as CSV
ccanalytics export --format csv --period 30d --table sessions

# Export to a specific directory as JSON
ccanalytics export --format json --output ~/analytics-backup/

# Export specific tables without compression
ccanalytics export --table sessions --table tool_calls --no-compress
```

**Output:**

```
Exported 4 tables to ./ccanalytics-export/
  sessions.parquet              847 rows     142 KB
  conversation_turns.parquet  41,203 rows   3.8 MB
  tool_calls.parquet          28,519 rows   2.1 MB
  errors.parquet                 142 rows    12 KB
Total: 6.1 MB (compressed with ZSTD)
```

---

## 2. Query Type Details

### 2.1 `cost` -- Cost Breakdown

Shows cost aggregated by day and model, with token breakdown.

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `date` | `date` | Calendar date |
| `model` | `string` | Model name (e.g., `claude-sonnet-4-5-20250514`) |
| `sessions` | `integer` | Number of sessions |
| `input_tokens` | `integer` | Total uncached input tokens |
| `output_tokens` | `integer` | Total output tokens (includes thinking tokens) |
| `cache_read` | `integer` | Total cache read tokens |
| `cache_write` | `integer` | Total cache write tokens |
| `cost` | `decimal` | Total cost in USD |

**Available sort fields:** `date`, `model`, `sessions`, `input_tokens`, `output_tokens`, `cache_read`, `cache_write`, `cost`

**Default sort:** `date` (descending -- most recent first)

**Example output:**

```
ccanalytics query cost --period 7d

 Date       | Model              | Sessions | Input     | Output   | Cache Read | Cache Write | Cost
------------+--------------------+----------+-----------+----------+------------+-------------+---------
 2026-02-23 | claude-sonnet-4-5  |        5 |   182,401 |   47,892 |    921,445 |      41,203 |   $6.30
 2026-02-22 | claude-sonnet-4-5  |        7 |   241,882 |   63,104 |  1,104,229 |      58,441 |   $8.14
 2026-02-22 | claude-haiku-4-5   |        2 |    12,403 |    8,291 |     44,102 |       5,220 |   $0.48
 2026-02-21 | claude-sonnet-4-5  |        4 |   158,990 |   39,448 |    784,221 |      32,109 |   $5.18
 2026-02-20 | claude-sonnet-4-5  |        6 |   203,441 |   51,220 |    988,102 |      44,891 |   $6.92
 2026-02-19 | claude-sonnet-4-5  |        3 |   112,889 |   28,104 |    542,009 |      24,410 |   $3.72
 2026-02-18 | claude-sonnet-4-5  |        5 |   178,220 |   44,891 |    891,334 |      39,882 |   $5.94
 2026-02-17 | claude-sonnet-4-5  |        6 |   199,003 |   52,104 |    942,118 |      42,770 |   $6.58
            |                    |          |           |          |            |     TOTAL   |  $43.26

 8 rows (7d period)
```

---

### 2.2 `sessions` -- Session Summaries

Shows individual sessions with duration, turn count, cost, and cache efficiency.

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `session_id` | `string` | Session UUID (truncated to 8 chars in table format) |
| `start` | `datetime` | Session start timestamp |
| `duration` | `string` | Session duration (human-readable, e.g., `34m 12s`) |
| `model` | `string` | Primary model used |
| `turns` | `integer` | Number of conversation turns |
| `tool_calls` | `integer` | Number of tool calls made |
| `tokens` | `integer` | Total tokens (input + output + cache) |
| `cache_hit` | `percent` | Cache hit rate as a percentage |
| `cost` | `decimal` | Total session cost in USD |

**Available sort fields:** `start`, `duration`, `model`, `turns`, `tool_calls`, `tokens`, `cache_hit`, `cost`

**Default sort:** `start` (descending -- most recent first)

**Example output:**

```
ccanalytics query sessions --period today

 Session  | Start            | Duration | Model             | Turns | Tools | Tokens    | Cache | Cost
----------+------------------+----------+-------------------+-------+-------+-----------+-------+-------
 31f3f224 | 2026-02-23 14:02 |   42m 8s | claude-sonnet-4-5 |    67 |   104 | 1,284,330 | 84.2% | $2.18
 a9c1e882 | 2026-02-23 11:30 |   18m 4s | claude-sonnet-4-5 |    23 |    38 |   412,891 | 79.1% | $1.04
 f7d2a441 | 2026-02-23 09:15 |  1h 4m   | claude-sonnet-4-5 |    89 |   142 | 2,104,220 | 86.7% | $3.08

 3 rows (today period)
```

---

### 2.3 `tools` -- Tool Usage Patterns

Shows tool call frequency, success rates, and associated token cost.

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `tool` | `string` | Tool name. MCP tools shown as `mcp__<server>__<tool>`. |
| `calls` | `integer` | Total number of invocations |
| `success_rate` | `percent` | Percentage of calls that succeeded |
| `avg_duration` | `string` | Average execution duration (human-readable) |
| `total_tokens` | `integer` | Estimated tokens associated with this tool's calls |
| `cost` | `decimal` | Estimated cost attributed to this tool |
| `pct` | `percent` | Percentage of all tool calls |

**Available sort fields:** `tool`, `calls`, `success_rate`, `avg_duration`, `total_tokens`, `cost`, `pct`

**Default sort:** `calls` (descending -- most used first)

**Example output:**

```
ccanalytics query tools --period 7d

 Tool                         | Calls | Success | Avg Dur  | Tokens    | Cost   | Pct
------------------------------+-------+---------+----------+-----------+--------+------
 Bash                         | 1,247 |  94.3%  |    1.2s  |   841,220 | $12.40 | 42.1%
 Read                         | 1,102 |  99.8%  |   82ms   |   402,118 |  $4.82 | 37.2%
 Edit                         |   389 |  97.4%  |  210ms   |   284,009 |  $3.41 | 13.1%
 Grep                         |   156 |  99.4%  |   44ms   |    98,441 |  $1.18 |  5.3%
 Write                        |    89 |  98.9%  |  120ms   |    52,110 |  $0.63 |  3.0%
 mcp__github__create_pr       |    12 | 100.0%  |    3.4s  |    28,940 |  $0.35 |  0.4%

 6 rows (7d period)
```

---

### 2.4 `cache` -- Cache Efficiency

Shows cache hit rate metrics, estimated savings, and efficiency trends.

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `date` | `date` | Calendar date |
| `hit_rate` | `percent` | Cache hit rate: `cache_read / (cache_read + cache_write + uncached_input)` |
| `read_tokens` | `integer` | Tokens served from cache |
| `write_tokens` | `integer` | Tokens written to cache |
| `uncached_tokens` | `integer` | Tokens that missed the cache |
| `savings` | `decimal` | Estimated cost savings from cache hits (USD) |
| `status` | `string` | Interpretation: `effective` (>80%), `moderate` (50-80%), `ineffective` (<50%) |

**Available sort fields:** `date`, `hit_rate`, `read_tokens`, `write_tokens`, `uncached_tokens`, `savings`

**Default sort:** `date` (descending -- most recent first)

**Example output:**

```
ccanalytics query cache --period 7d

 Date       | Hit Rate | Read Tokens | Write Tokens | Uncached  | Savings | Status
------------+----------+-------------+--------------+-----------+---------+------------
 2026-02-23 |   84.2%  |     921,445 |       41,203 |   110,882 |  $4.72  | effective
 2026-02-22 |   82.9%  |   1,148,331 |       63,661 |   172,443 |  $5.88  | effective
 2026-02-21 |   81.1%  |     784,221 |       32,109 |   142,201 |  $4.01  | effective
 2026-02-20 |   83.7%  |     988,102 |       44,891 |   148,330 |  $5.06  | effective
 2026-02-19 |   79.4%  |     542,009 |       24,410 |   116,002 |  $2.78  | moderate
 2026-02-18 |   81.8%  |     891,334 |       39,882 |   152,440 |  $4.56  | effective
 2026-02-17 |   80.2%  |     942,118 |       42,770 |   188,991 |  $4.82  | effective

 7 rows (7d period)
 Overall cache hit rate: 82.0% (effective)
 Total estimated savings: $31.83
```

---

### 2.5 `activity` -- Usage Activity

Shows session and interaction activity aggregated by day, including
hour-of-day distribution.

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `date` | `date` | Calendar date |
| `sessions` | `integer` | Number of sessions started |
| `turns` | `integer` | Total conversation turns |
| `tool_calls` | `integer` | Total tool calls |
| `active_hours` | `decimal` | Estimated active hours (sum of session durations) |
| `peak_hour` | `string` | Most active hour of the day (e.g., `14:00`) |
| `models_used` | `string` | Comma-separated list of models used that day |

**Available sort fields:** `date`, `sessions`, `turns`, `tool_calls`, `active_hours`

**Default sort:** `date` (descending -- most recent first)

**Example output:**

```
ccanalytics query activity --period 7d

 Date       | Sessions | Turns | Tool Calls | Active Hrs | Peak Hour | Models
------------+----------+-------+------------+------------+-----------+-------------------
 2026-02-23 |        5 |   179 |        284 |       1.7h |     14:00 | claude-sonnet-4-5
 2026-02-22 |        9 |   312 |        481 |       3.2h |     10:00 | sonnet-4-5, haiku-4-5
 2026-02-21 |        4 |   142 |        198 |       1.4h |     15:00 | claude-sonnet-4-5
 2026-02-20 |        6 |   224 |        344 |       2.1h |     11:00 | claude-sonnet-4-5
 2026-02-19 |        3 |    98 |        148 |       0.9h |     09:00 | claude-sonnet-4-5
 2026-02-18 |        5 |   189 |        291 |       1.8h |     14:00 | claude-sonnet-4-5
 2026-02-17 |        6 |   203 |        318 |       2.0h |     13:00 | claude-sonnet-4-5

 7 rows (7d period)
 Weekly total: 38 sessions, 1,347 turns, 2,064 tool calls
```

---

## 3. Configuration Schema

ccanalytics is configured via a JSON file. The loader searches for configuration
in this order:

1. Explicit `--config <path>` CLI flag
2. `.ccanalyticsrc.json` in the current working directory
3. `~/.ccanalytics/config.json`
4. `~/.config/ccanalytics/config.json`

All fields are optional. Missing fields use built-in defaults.

### Full Schema: `ccanalytics.config.json`

```jsonc
{
  // --- Top-level settings ---

  // Path to the Claude Code data directory.
  // Type: string
  // Default: auto-detect (~/.claude or ~/.config/claude)
  "claudeDir": "~/.claude",

  // Path to the DuckDB database file. Created if it does not exist.
  // Type: string
  // Default: "~/.ccanalytics/analytics.duckdb"
  "dbPath": "~/.ccanalytics/analytics.duckdb",

  // Logging verbosity. Controls what is printed to stderr.
  //   "debug" - SQL queries, per-file details, full stack traces
  //   "info"  - Progress summaries and warnings
  //   "warn"  - Warnings and errors only
  //   "error" - Errors only
  // Type: string (enum: "debug" | "info" | "warn" | "error")
  // Default: "info"
  "logLevel": "info",

  // Default time period for query and dashboard commands when --period is
  // not specified. Accepted values: "today", "7d", "30d", "90d", "all".
  // Type: string
  // Default: "7d"
  "defaultPeriod": "7d",

  // Default output format when --format is not specified.
  // Type: string (enum: "table" | "json" | "csv")
  // Default: "table"
  "defaultFormat": "table",

  // --- Ingestion settings ---
  "ingestion": {
    // Maximum number of rows per INSERT batch during ingestion.
    // Lower values reduce peak memory usage; higher values improve throughput.
    // Type: integer (min: 50, max: 10000)
    // Default: 1000
    "batchSize": 1000,

    // Whether to deduplicate assistant messages by requestId during ingestion.
    // When true, only the last entry per requestId is kept (handles streaming
    // duplicates). Disabling this is not recommended.
    // Type: boolean
    // Default: true
    "deduplication": true,

    // Number of days after which ingested data is eligible for archival to
    // Parquet. Set to 0 to disable automatic archival. Archival moves older
    // data out of the live DuckDB tables into compressed Parquet files,
    // achieving 5-10x storage savings.
    // Type: integer (min: 0)
    // Default: 90
    "archivalDays": 90
  },

  // --- Watch mode settings ---
  "watch": {
    // Whether watch mode is available. Set to false to disable the `watch`
    // command entirely (useful in CI environments).
    // Type: boolean
    // Default: true
    "enabled": true,

    // Polling interval in milliseconds for file system monitoring. Used as
    // the fallback when native FS events are unavailable, and as the
    // Chokidar polling interval.
    // Type: integer (min: 500, max: 30000)
    // Default: 2000
    "interval": 2000,

    // Whether to use Chokidar's awaitWriteFinish option. Prevents reading
    // partial writes by waiting until the file size stabilizes.
    // Type: boolean
    // Default: true
    "awaitWriteFinish": true,

    // Time in milliseconds that a file's size must remain constant before
    // it is considered fully written. Only applies when awaitWriteFinish
    // is true.
    // Type: integer (min: 500, max: 10000)
    // Default: 2000
    "stabilityThreshold": 2000
  },

  // --- Model pricing (per million tokens) ---
  "pricing": {
    // Custom or override pricing for models. Keys are model name patterns
    // (matched against the model string in JSONL). Values specify per-million-
    // token costs. These prices are used for cross-validation against the
    // JSONL costUSD field and for independent cost computation in the cache
    // savings calculation.
    "models": {
      "claude-opus-4-5": {
        // Cost per million uncached input tokens (USD)
        // Type: number
        "input": 5.00,
        // Cost per million cache write tokens (USD). Typically 1.25x input.
        // Type: number
        "cacheWrite": 6.25,
        // Cost per million cache read tokens (USD). Typically 0.10x input.
        // Type: number
        "cacheRead": 0.50,
        // Cost per million output tokens (USD). Includes thinking tokens.
        // Type: number
        "output": 25.00
      },
      "claude-sonnet-4-5": {
        "input": 3.00,
        "cacheWrite": 3.75,
        "cacheRead": 0.30,
        "output": 15.00
      },
      "claude-haiku-4-5": {
        "input": 1.00,
        "cacheWrite": 1.25,
        "cacheRead": 0.10,
        "output": 5.00
      }
    }
  }
}
```

### Configuration Field Summary

| Path | Type | Default | Description |
|------|------|---------|-------------|
| `claudeDir` | `string` | Auto-detect | Claude Code data directory |
| `dbPath` | `string` | `~/.ccanalytics/analytics.duckdb` | DuckDB database file path |
| `logLevel` | `string` | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |
| `defaultPeriod` | `string` | `7d` | Default time period for queries |
| `defaultFormat` | `string` | `table` | Default output format |
| `ingestion.batchSize` | `integer` | `1000` | Rows per INSERT batch |
| `ingestion.deduplication` | `boolean` | `true` | Deduplicate by requestId |
| `ingestion.archivalDays` | `integer` | `90` | Days before Parquet archival |
| `watch.enabled` | `boolean` | `true` | Enable watch command |
| `watch.interval` | `integer` | `2000` | Polling interval (ms) |
| `watch.awaitWriteFinish` | `boolean` | `true` | Wait for stable file size |
| `watch.stabilityThreshold` | `integer` | `2000` | Stability wait time (ms) |
| `pricing.models.<name>.input` | `number` | (built-in) | Input token price per 1M |
| `pricing.models.<name>.cacheWrite` | `number` | (built-in) | Cache write price per 1M |
| `pricing.models.<name>.cacheRead` | `number` | (built-in) | Cache read price per 1M |
| `pricing.models.<name>.output` | `number` | (built-in) | Output token price per 1M |

---

## 4. Exit Codes

ccanalytics uses conventional exit codes to communicate success or failure
to the calling process. These are stable and suitable for use in scripts
and CI pipelines.

| Code | Error Type | Meaning |
|------|-----------|---------|
| `0` | -- | Success. The command completed successfully. |
| `1` | General / Commander | Generic failure, invalid subcommand, unhandled rejection. |
| `2` | `DatabaseError` | DuckDB connection failed, the database file is locked or corrupted, or a schema migration failed. |
| `3` | `IngestionError` | Partial or full ingestion failure (corrupt files, permission errors during parse). |
| `4` | `QueryError` | Query validation or execution failure (invalid parameters, DuckDB query error). |
| `5` | `ConfigError` | Configuration loading or validation failure. Includes missing Claude data directory when auto-detection fails. |
| `6` | `FileSystemError` | File permission denied, file not found, or watcher failure. |

**Usage in scripts:**

```bash
ccanalytics ingest
case $? in
  0) echo "Ingestion successful" ;;
  2) echo "Database issue -- is another process using it?" ;;
  3) echo "Some files failed to ingest" ;;
  4) echo "Query failed" ;;
  5) echo "Check your config file" ;;
  6) echo "File permission or watcher error" ;;
  *) echo "Unexpected error" ;;
esac
```

---

## 5. Environment Variables

All environment variables are prefixed with `CCANALYTICS_` to avoid
collisions. Environment variables have higher precedence than the config
file but lower precedence than CLI flags.

| Variable | Type | Default | Corresponding CLI Flag | Description |
|----------|------|---------|------------------------|-------------|
| `CCANALYTICS_DB_PATH` | `string` | `~/.ccanalytics/analytics.duckdb` | `--db` | Path to the DuckDB database file. |
| `CCANALYTICS_CLAUDE_DIR` | `string` | Auto-detect | `--claude-dir` | Path to the Claude Code data directory. |
| `CCANALYTICS_LOG_LEVEL` | `string` | `info` | `--verbose` (sets `debug`) | Log level: `debug`, `info`, `warn`, `error`. Setting `--verbose` on the CLI is equivalent to `CCANALYTICS_LOG_LEVEL=debug`. |
| `CCANALYTICS_FORMAT` | `string` | `table` | `--format` | Default output format: `table`, `json`, `csv`. |

**Precedence chain (highest to lowest):**

```
CLI flag  >  Environment variable  >  Config file  >  Built-in default
```

**Example:**

```bash
# Set defaults via environment
export CCANALYTICS_DB_PATH=~/my-analytics.duckdb
export CCANALYTICS_FORMAT=json
export CCANALYTICS_LOG_LEVEL=debug

# These defaults apply to all commands
ccanalytics query cost
# Output is JSON, verbose logging is on, using custom DB path

# CLI flags still override environment variables
ccanalytics query cost --format table
# Output is table format despite CCANALYTICS_FORMAT=json
```

---

## 6. Example CLI Sessions

### 6.1 First-Time Setup and Ingestion

A new user running ccanalytics for the first time against an existing
Claude Code installation.

```bash
$ npx ccanalytics ingest
[ingest] Database not found, creating ~/.ccanalytics/analytics.duckdb
[ingest] Schema initialized (version 3, 5 tables, 7 indexes, 2 views)
[ingest] Discovering JSONL files in ~/.claude/projects/...
[ingest] Found 394 files across 12 projects
[ingest] Processing files...
  [========================================] 394/394 files (100%)
[ingest] Done in 4.2s
  Files processed:    394
  Entries ingested:   68,204
  Duplicates removed: 1,847
  Parse errors:       0
  Sessions created:   847
  Tool calls:         28,519

$ ccanalytics status
  Database
    Path:             ~/.ccanalytics/analytics.duckdb
    Size:             14.2 MB
    DuckDB Version:   1.4.2
    Schema Version:   3

  Tables
    sessions:           847 rows
    conversation_turns: 41,203 rows
    tool_calls:         28,519 rows
    errors:                142 rows
    ingestion_state:       394 files

  Ingestion
    Last Run:           2026-02-23 14:32:01
    Claude Dir:         ~/.claude
    Projects Found:     12

  Config
    File:               none (using defaults)
    Log Level:          info
    Default Format:     table
```

### 6.2 Checking Daily Costs

Reviewing cost trends over the past week to stay within budget.

```bash
$ ccanalytics query cost --period 7d

 Date       | Model              | Sessions | Input     | Output   | Cache Read | Cache Write | Cost
------------+--------------------+----------+-----------+----------+------------+-------------+---------
 2026-02-23 | claude-sonnet-4-5  |        5 |   182,401 |   47,892 |    921,445 |      41,203 |   $6.30
 2026-02-22 | claude-sonnet-4-5  |        7 |   241,882 |   63,104 |  1,104,229 |      58,441 |   $8.14
 2026-02-22 | claude-haiku-4-5   |        2 |    12,403 |    8,291 |     44,102 |       5,220 |   $0.48
 2026-02-21 | claude-sonnet-4-5  |        4 |   158,990 |   39,448 |    784,221 |      32,109 |   $5.18
 2026-02-20 | claude-sonnet-4-5  |        6 |   203,441 |   51,220 |    988,102 |      44,891 |   $6.92
 2026-02-19 | claude-sonnet-4-5  |        3 |   112,889 |   28,104 |    542,009 |      24,410 |   $3.72
 2026-02-18 | claude-sonnet-4-5  |        5 |   178,220 |   44,891 |    891,334 |      39,882 |   $5.94
 2026-02-17 | claude-sonnet-4-5  |        6 |   199,003 |   52,104 |    942,118 |      42,770 |   $6.58
            |                    |          |           |          |            |     TOTAL   |  $43.26

 8 rows (7d period)

# Drill into a specific expensive day
$ ccanalytics query sessions --period today --sort cost

 Session  | Start            | Duration | Model             | Turns | Tools | Tokens    | Cache | Cost
----------+------------------+----------+-------------------+-------+-------+-----------+-------+-------
 31f3f224 | 2026-02-23 14:02 |   42m 8s | claude-sonnet-4-5 |    67 |   104 | 1,284,330 | 84.2% | $2.18
 a9c1e882 | 2026-02-23 11:30 |   18m 4s | claude-sonnet-4-5 |    23 |    38 |   412,891 | 79.1% | $1.04
 f7d2a441 | 2026-02-23 09:15 |  1h 4m   | claude-sonnet-4-5 |    89 |   142 | 2,104,220 | 86.7% | $3.08

 3 rows (today period)
```

### 6.3 Analyzing Cache Efficiency

Investigating whether prompt caching is working effectively.

```bash
$ ccanalytics query cache --period 30d --limit 10

 Date       | Hit Rate | Read Tokens | Write Tokens | Uncached  | Savings | Status
------------+----------+-------------+--------------+-----------+---------+------------
 2026-02-23 |   84.2%  |     921,445 |       41,203 |   110,882 |  $4.72  | effective
 2026-02-22 |   82.9%  |   1,148,331 |       63,661 |   172,443 |  $5.88  | effective
 2026-02-21 |   81.1%  |     784,221 |       32,109 |   142,201 |  $4.01  | effective
 2026-02-20 |   83.7%  |     988,102 |       44,891 |   148,330 |  $5.06  | effective
 2026-02-19 |   79.4%  |     542,009 |       24,410 |   116,002 |  $2.78  | moderate
 2026-02-18 |   81.8%  |     891,334 |       39,882 |   152,440 |  $4.56  | effective
 2026-02-17 |   80.2%  |     942,118 |       42,770 |   188,991 |  $4.82  | effective
 2026-02-16 |   77.3%  |     701,882 |       31,443 |   172,992 |  $3.59  | moderate
 2026-02-15 |   83.1%  |     884,220 |       38,109 |   140,331 |  $4.53  | effective
 2026-02-14 |   81.9%  |     812,440 |       36,220 |   142,009 |  $4.16  | effective

 10 rows (30d period)
 Overall cache hit rate: 81.4% (effective)
 Total estimated savings: $128.41

# The Feb 19 dip stands out -- investigate by checking sessions that day
$ ccanalytics query sessions --period today --sort cache_hit --no-desc \
    2>/dev/null | head -5
```

### 6.4 Watching for Live Changes

Running ccanalytics in watch mode alongside active Claude Code sessions.

```bash
$ ccanalytics watch --verbose

[watch] Watching ~/.claude/projects/**/*.jsonl
[watch] Initial scan: 394 files found
[watch] awaitWriteFinish enabled (stability: 2000ms)
[watch] Listening for changes... (Ctrl+C to stop)
[watch] 14:32:01 | ADD    | .../-Users-oz-Development-myapp/a1b2c3d4.jsonl (new session)
[watch] 14:32:01 | CHANGE | .../-Users-oz-Development-myapp/a1b2c3d4.jsonl
[watch]   -> Parsed 3 entries (1 assistant, 1 user, 1 tool_use), 4,281 bytes
[watch]   -> Ingested in 8ms
[watch] 14:32:18 | CHANGE | .../-Users-oz-Development-myapp/a1b2c3d4.jsonl
[watch]   -> Parsed 2 entries (1 assistant, 1 user), 3,104 bytes
[watch]   -> Ingested in 4ms
[watch] 14:35:44 | CHANGE | .../-Users-oz-Development-myapp/a1b2c3d4.jsonl
[watch]   -> Parsed 5 entries (2 assistant, 2 user, 1 tool_use), 12,440 bytes
[watch]   -> Ingested in 11ms
^C
[watch] Shutting down...
[watch] Flushed 0 pending changes
[watch] Watched for 3m 43s, processed 10 entries from 1 file
```

### 6.5 Exporting Data to Parquet

Archiving a month of analytics data for long-term storage or team sharing.

```bash
$ ccanalytics export --format parquet --period 30d --output ~/analytics-archive/

Exported 4 tables to /Users/sam/analytics-archive/
  sessions.parquet              124 rows      22 KB
  conversation_turns.parquet  6,103 rows     580 KB
  tool_calls.parquet          4,218 rows     412 KB
  errors.parquet                 18 rows       2 KB
Total: 1.0 MB (compressed with ZSTD)

# Verify with DuckDB CLI
$ duckdb -c "SELECT count(*) FROM read_parquet('~/analytics-archive/sessions.parquet')"
┌──────────────┐
│ count_star() │
│    int64     │
├──────────────┤
│          124 │
└──────────────┘

# Export just tool data as CSV for spreadsheet analysis
$ ccanalytics export --format csv --table tool_calls --output ~/tools.csv

Exported 1 table to /Users/sam/tools.csv
  tool_calls.csv   28,519 rows   4.2 MB
```

### 6.6 Querying Tool Usage Patterns

Understanding which tools consume the most resources and which MCP
integrations are most active.

```bash
$ ccanalytics query tools --period 30d --sort cost --limit 15

 Tool                              | Calls | Success | Avg Dur  | Tokens    | Cost   | Pct
-----------------------------------+-------+---------+----------+-----------+--------+------
 Bash                              | 4,812 |  93.8%  |    1.4s  | 3,241,008 | $48.62 | 38.4%
 Read                              | 4,221 |  99.9%  |   78ms   | 1,544,220 | $18.53 | 33.7%
 Edit                              | 1,502 |  97.1%  |  220ms   | 1,082,441 | $12.99 | 12.0%
 Grep                              |   618 |  99.5%  |   52ms   |   384,109 |  $4.61 |  4.9%
 Write                             |   412 |  98.8%  |  140ms   |   248,002 |  $2.98 |  3.3%
 Glob                              |   384 |  99.7%  |   38ms   |   201,334 |  $2.42 |  3.1%
 mcp__github__create_pr            |    42 | 100.0%  |    3.2s  |   112,009 |  $1.34 |  0.3%
 mcp__github__list_issues          |    38 |  97.4%  |    2.8s  |    98,441 |  $1.18 |  0.3%
 mcp__google-sheets__get_sheet_data|    24 | 100.0%  |    1.1s  |    64,220 |  $0.77 |  0.2%
 WebFetch                          |    22 |  90.9%  |    4.1s  |    58,110 |  $0.70 |  0.2%

 10 rows (30d period)

# Check which MCP servers are using the most resources
$ ccanalytics query tools --period 30d --format json | \
    jq '[.[] | select(.tool | startswith("mcp__"))] |
        group_by(.tool | split("__")[1]) |
        map({server: .[0].tool | split("__")[1], total_calls: map(.calls) | add})'
[
  { "server": "github", "total_calls": 80 },
  { "server": "google-sheets", "total_calls": 24 }
]
```

---

## 7. Output Formats

All `query` and `export` commands support three output formats. The format
is selected via the `--format` flag or the `CCANALYTICS_FORMAT` environment
variable.

### 7.1 Table Format (`--format table`)

The default format. Renders a Unicode-bordered table to stdout with
aligned columns, thousands separators for numbers, and color-coded
values when the terminal supports it.

```
ccanalytics query cost --period today --format table

 Date       | Model              | Sessions | Input     | Output   | Cache Read | Cache Write | Cost
------------+--------------------+----------+-----------+----------+------------+-------------+---------
 2026-02-23 | claude-sonnet-4-5  |        5 |   182,401 |   47,892 |    921,445 |      41,203 |   $6.30
 2026-02-23 | claude-haiku-4-5   |        1 |     4,102 |    2,891 |     18,440 |       2,110 |   $0.14
            |                    |          |           |          |            |     TOTAL   |   $6.44

 2 rows (today period)
```

**Characteristics:**

- Columns are auto-sized to fit content, up to terminal width.
- Numbers use thousands separators (e.g., `1,234,567`).
- Currency values are prefixed with `$` and show 2 decimal places.
- Percentages show 1 decimal place with `%` suffix.
- Durations are human-readable (e.g., `42m 8s`, `1h 4m`).
- Summary/total rows appear at the bottom when applicable.
- Color coding (when supported): green for effective cache rates, yellow for moderate, red for ineffective.

### 7.2 JSON Format (`--format json`)

Machine-readable JSON output. Emits a JSON array of objects to stdout.
Suitable for piping into `jq`, loading into other tools, or programmatic
consumption.

```
ccanalytics query cost --period today --format json
```

```json
{
  "query": "cost",
  "period": "today",
  "generated_at": "2026-02-23T14:45:00.000Z",
  "rows": [
    {
      "date": "2026-02-23",
      "model": "claude-sonnet-4-5-20250514",
      "sessions": 5,
      "input_tokens": 182401,
      "output_tokens": 47892,
      "cache_read_tokens": 921445,
      "cache_write_tokens": 41203,
      "cost_usd": 6.30
    },
    {
      "date": "2026-02-23",
      "model": "claude-haiku-4-5-20250514",
      "sessions": 1,
      "input_tokens": 4102,
      "output_tokens": 2891,
      "cache_read_tokens": 18440,
      "cache_write_tokens": 2110,
      "cost_usd": 0.14
    }
  ],
  "summary": {
    "total_rows": 2,
    "total_cost_usd": 6.44
  }
}
```

**Characteristics:**

- Root object contains `query`, `period`, `generated_at`, `rows`, and `summary` fields.
- `rows` is always an array, even if empty.
- Numbers are unformatted (no thousands separators, no currency symbols).
- Dates are ISO 8601 strings.
- Token counts are raw integers.
- Costs are floating-point numbers in USD.
- No trailing newline issues -- valid JSON document.
- Pretty-printed with 2-space indentation by default. Use `| jq -c` for compact output.

### 7.3 CSV Format (`--format csv`)

Comma-separated values with a header row. Suitable for import into
spreadsheets, databases, or data analysis tools.

```
ccanalytics query cost --period today --format csv
```

```csv
date,model,sessions,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd
2026-02-23,claude-sonnet-4-5-20250514,5,182401,47892,921445,41203,6.30
2026-02-23,claude-haiku-4-5-20250514,1,4102,2891,18440,2110,0.14
```

**Characteristics:**

- First row is always a header row with column names.
- Values containing commas, quotes, or newlines are escaped per RFC 4180 (double-quoted with internal quotes doubled).
- Numbers are unformatted (no thousands separators, no currency symbols).
- Dates are in `YYYY-MM-DD` format.
- No summary/total rows -- raw data only.
- UTF-8 encoded.
- Line endings are `\n` (Unix-style).
- No BOM (byte order mark).

### Format Comparison

| Aspect | `table` | `json` | `csv` |
|--------|---------|--------|-------|
| Human readable | Yes | Moderate | Moderate |
| Machine parseable | No | Yes | Yes |
| Streaming friendly | No | Yes (NDJSON variant) | Yes |
| Includes summary | Yes | Yes (in `summary` field) | No |
| Number formatting | Thousands separators, `$`, `%` | Raw values | Raw values |
| Color support | Yes (when TTY) | No | No |
| Suitable for piping | No | Yes (`jq`) | Yes (`cut`, `awk`) |

---

## Appendix: Quick Reference Card

```
ccanalytics ingest [--full] [--project <name>] [--batch-size <n>]
ccanalytics query <cost|sessions|tools|cache|activity> [--period <range>] [--sort <field>] [--limit <n>]
ccanalytics watch [--interval <ms>]
ccanalytics dashboard [--refresh <s>] [--compact]
ccanalytics status
ccanalytics export [--format <parquet|csv|json>] [--output <path>] [--table <name>] [--period <range>]

Env vars:  CCANALYTICS_DB_PATH  CCANALYTICS_CLAUDE_DIR  CCANALYTICS_LOG_LEVEL  CCANALYTICS_FORMAT
Exit codes: 0=success  1=error  2=database  3=ingestion  4=query  5=config  6=filesystem
Config:    .ccanalyticsrc.json | ~/.ccanalytics/config.json | ~/.config/ccanalytics/config.json
```
