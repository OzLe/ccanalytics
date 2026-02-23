# 05 -- Cross-Cutting Concerns

> Error handling, testing strategy, scaling playbook, performance tuning,
> and logging conventions that span all ccanalytics modules.
>
> Predecessor docs: `00-v0-analysis.md`, `01-c4-architecture.md`,
> `02-data-architecture.md`, `03-component-design.md`, `04-api-specs.md`

---

## Table of Contents

1. [Error Handling Strategy](#1-error-handling-strategy)
2. [Testing Strategy](#2-testing-strategy)
3. [Scaling Playbook](#3-scaling-playbook)
4. [Performance Considerations](#4-performance-considerations)
5. [Logging Strategy](#5-logging-strategy)

---

## 1. Error Handling Strategy

### 1.1 Error Taxonomy

All custom errors extend a base `CCAnalyticsError` class. The hierarchy is
organized by **domain boundary** so that callers can catch at the granularity
they need -- a single `catch (e) { if (e instanceof CCAnalyticsError) }` handles
everything, while `catch (e) { if (e instanceof IngestionError) }` narrows to
one subsystem.

```typescript
// src/errors.ts

/**
 * Base error for all ccanalytics errors.
 * Every subclass carries a machine-readable `code` string and an optional
 * `cause` for error-chain inspection.
 */
export class CCAnalyticsError extends Error {
  /** Machine-readable error code, e.g. "INGESTION_ERROR". */
  public readonly code: string;
  /** Original error that caused this one, if any. */
  public readonly cause?: Error;
  /** Process exit code to use if this error is fatal. */
  public readonly exitCode: number;

  constructor(
    message: string,
    code: string,
    exitCode: number = 1,
    cause?: Error,
  ) {
    super(message);
    this.name = "CCAnalyticsError";
    this.code = code;
    this.exitCode = exitCode;
    this.cause = cause;
  }
}

// -----------------------------------------------------------------------
// 1. IngestionError
// -----------------------------------------------------------------------

/**
 * Errors during JSONL file discovery, parsing, and data loading.
 *
 * When it occurs:
 *   - Corrupt or truncated JSONL lines that fail JSON.parse
 *   - File read failures (ENOENT mid-read, encoding issues)
 *   - Schema validation failures (missing required fields like `type`,
 *     `sessionId`, or `timestamp` on an otherwise valid JSON line)
 *
 * Recovery strategy:
 *   - Corrupt line    -> skip + log warning, continue (never abort batch)
 *   - File read fail  -> skip file, add to failedFiles summary
 *   - Schema invalid  -> skip entry, increment parseErrors counter
 *
 * User-facing message:
 *   Error: [INGESTION] Failed to parse line 42 in session-abc.jsonl
 *     Hint: Run with --verbose to see the raw line content
 *
 * Exit code: 3 (partial failure) -- the CLI reports a summary and exits 3
 * if any files failed but others succeeded, or exits 0 if all succeeded.
 */
export class IngestionError extends CCAnalyticsError {
  constructor(message: string, cause?: Error) {
    super(message, "INGESTION_ERROR", 3, cause);
    this.name = "IngestionError";
  }
}

// -----------------------------------------------------------------------
// 2. QueryError
// -----------------------------------------------------------------------

/**
 * Errors during analytical query construction or execution.
 *
 * When it occurs:
 *   - Invalid query parameters (end date before start date, unknown
 *     template name, negative limit)
 *   - DuckDB query failures (syntax errors in raw SQL, missing tables
 *     if schema is out of date, type mismatches)
 *
 * Recovery strategy:
 *   - Invalid params  -> abort query, report validation error immediately
 *   - DuckDB failure  -> abort, wrap native error with the SQL for debugging
 *   - Missing schema  -> abort, suggest running `ccanalytics ingest` first
 *
 * User-facing message:
 *   Error: [QUERY] Invalid time range: end date is before start date
 *     Hint: Use --range "7d" for the last 7 days or specify --since/--until
 *
 * Exit code: 4
 */
export class QueryError extends CCAnalyticsError {
  constructor(message: string, cause?: Error) {
    super(message, "QUERY_ERROR", 4, cause);
    this.name = "QueryError";
  }
}

export class QueryValidationError extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

export class QueryExecutionError extends QueryError {
  public readonly sql?: string;
  constructor(message: string, sql?: string, cause?: Error) {
    super(message, cause);
    this.name = "QueryExecutionError";
    this.sql = sql;
  }
}

// -----------------------------------------------------------------------
// 3. ConfigError
// -----------------------------------------------------------------------

/**
 * Errors during configuration loading, parsing, and validation.
 *
 * When it occurs:
 *   - Config file contains malformed JSON
 *   - Required fields have invalid types or values (e.g., negative batchSize)
 *   - Path resolution failures (home directory unresolvable, explicit
 *     --config path does not exist)
 *   - Claude data directory not found at any known location
 *
 * Recovery strategy:
 *   - Malformed JSON    -> abort, report file path and parse error position
 *   - Invalid values    -> abort, list all validation errors at once
 *   - Missing config    -> fall back to defaults silently (config is optional)
 *   - Missing Claude dir -> abort, suggest checking Claude Code installation
 *
 * User-facing message:
 *   Error: [CONFIG] Invalid config at ~/.ccanalytics/config.json: batchSize must be positive
 *     Hint: Remove the config file to use defaults, or fix the value
 *
 * Exit code: 5
 */
export class ConfigError extends CCAnalyticsError {
  constructor(message: string, cause?: Error) {
    super(message, "CONFIG_ERROR", 5, cause);
    this.name = "ConfigError";
  }
}

export class ConfigParseError extends ConfigError {
  public readonly filePath: string;
  constructor(filePath: string, cause?: Error) {
    super(`Failed to parse config file: ${filePath}`, cause);
    this.name = "ConfigParseError";
    this.filePath = filePath;
  }
}

export class ConfigValidationError extends ConfigError {
  public readonly errors: Array<{ path: string; message: string; value: unknown }>;
  constructor(errors: Array<{ path: string; message: string; value: unknown }>) {
    const summary = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    super(`Configuration validation failed:\n${summary}`);
    this.name = "ConfigValidationError";
    this.errors = errors;
  }
}

// -----------------------------------------------------------------------
// 4. FileSystemError
// -----------------------------------------------------------------------

/**
 * Errors from filesystem operations outside of DuckDB.
 *
 * When it occurs:
 *   - Permission denied reading JSONL files or writing the database directory
 *   - File not found when a previously-tracked file is deleted mid-ingestion
 *   - Chokidar watch failures (EMFILE, inaccessible directories)
 *   - Directory creation failures for the database path
 *
 * Recovery strategy:
 *   - Permission denied -> skip file, log warning, report at end
 *   - File not found    -> skip file, reset ingestion state for that file
 *   - Watch failure      -> log error, suggest --poll-interval or reducing scope
 *   - EMFILE            -> log error with ulimit suggestion
 *
 * User-facing message:
 *   Error: [FS] Permission denied reading ~/.claude/projects/-example/session.jsonl
 *     Hint: Check file permissions with `ls -la` on the file
 *
 * Exit code: 6
 */
export class FileSystemError extends CCAnalyticsError {
  public readonly path?: string;
  constructor(message: string, path?: string, cause?: Error) {
    super(message, "FILESYSTEM_ERROR", 6, cause);
    this.name = "FileSystemError";
    this.path = path;
  }
}

export class PermissionError extends FileSystemError {
  constructor(path: string, cause?: Error) {
    super(`Permission denied: ${path}`, path, cause);
    this.name = "PermissionError";
  }
}

export class FileNotFoundError extends FileSystemError {
  constructor(path: string, cause?: Error) {
    super(`File not found: ${path}`, path, cause);
    this.name = "FileNotFoundError";
  }
}

export class WatcherError extends FileSystemError {
  constructor(message: string, cause?: Error) {
    super(message, undefined, cause);
    this.name = "WatcherError";
  }
}

// -----------------------------------------------------------------------
// 5. DatabaseError
// -----------------------------------------------------------------------

/**
 * Errors from DuckDB connection and schema management.
 *
 * When it occurs:
 *   - Connection failures (file locked by another process, corrupt .duckdb file)
 *   - Schema migration errors (DDL failure, version conflict)
 *   - Concurrent write conflicts (single-writer constraint violated)
 *   - Disk full during write
 *
 * Recovery strategy:
 *   - Connection fail   -> retry with exponential backoff (3 attempts: 1s, 2s, 4s)
 *   - File locked       -> report PID if available, suggest closing other ccanalytics
 *   - Migration error   -> roll back migration, report version number
 *   - Write conflict    -> queue writes, single-writer enforcement
 *   - Disk full         -> abort, report available disk space
 *
 * User-facing message:
 *   Error: [DATABASE] Database is locked by another process
 *     Hint: Close other ccanalytics instances or use `lsof analytics.duckdb` to find the holder
 *
 * Exit code: 2
 */
export class DatabaseError extends CCAnalyticsError {
  constructor(message: string, cause?: Error) {
    super(message, "DATABASE_ERROR", 2, cause);
    this.name = "DatabaseError";
  }
}

export class ConnectionError extends DatabaseError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = "ConnectionError";
  }
}

export class DatabaseLockedError extends DatabaseError {
  constructor(cause?: Error) {
    super("Database is locked by another process", cause);
    this.name = "DatabaseLockedError";
  }
}

export class DatabaseCorruptError extends DatabaseError {
  public readonly dbPath: string;
  constructor(dbPath: string, cause?: Error) {
    super(`Database file appears corrupted: ${dbPath}`, cause);
    this.name = "DatabaseCorruptError";
    this.dbPath = dbPath;
  }
}

export class MigrationError extends DatabaseError {
  public readonly version: number;
  constructor(version: number, cause?: Error) {
    super(`Schema migration to version ${version} failed`, cause);
    this.name = "MigrationError";
    this.version = version;
  }
}

export class ConcurrentWriteError extends DatabaseError {
  constructor(cause?: Error) {
    super("Concurrent write detected; ccanalytics uses single-writer mode", cause);
    this.name = "ConcurrentWriteError";
  }
}
```

### 1.2 Exit Code Map

| Exit Code | Error Type | Meaning |
|-----------|-----------|---------|
| 0 | -- | Success |
| 1 | Unhandled / Commander | Generic failure, invalid subcommand, unhandled rejection |
| 2 | `DatabaseError` | Database connection, corruption, or migration failure |
| 3 | `IngestionError` | Partial or full ingestion failure |
| 4 | `QueryError` | Query validation or execution failure |
| 5 | `ConfigError` | Configuration loading or validation failure |
| 6 | `FileSystemError` | File permission, not-found, or watcher failure |

### 1.3 Error Recovery Patterns

#### Corrupt or truncated JSONL lines

Corrupt lines are **expected** in production. Claude Code writes JSONL files
incrementally, and reads may race with writes. A single bad line must never
abort an entire ingestion run.

```
Strategy: SKIP + LOG WARNING
  1. JSON.parse fails on a line
  2. Increment ParseResult.parseErrors
  3. Log at warn level: "[ingestion] Skipping corrupt line {lineNumber} in {filePath}"
  4. Continue to next line
  5. Report total parseErrors in IngestionResult summary
```

#### DuckDB connection failures

Transient failures (file temporarily locked, OS-level I/O hiccup) are
retried before giving up.

```
Strategy: RETRY WITH EXPONENTIAL BACKOFF
  Attempt 1: wait 1 second
  Attempt 2: wait 2 seconds
  Attempt 3: wait 4 seconds
  After 3 failures: throw ConnectionError with aggregated cause chain
```

```typescript
async function connectWithRetry(dbPath: string, maxAttempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await connectionManager.connect(dbPath);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        throw new ConnectionError(
          `Failed to connect after ${maxAttempts} attempts: ${dbPath}`,
          err as Error,
        );
      }
      const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      logger.warn(`[db] Connection attempt ${attempt} failed, retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
}
```

#### File system permission errors

Permission errors on individual files must not block the rest of ingestion.

```
Strategy: SKIP + LOG + REPORT SUMMARY
  1. Catch EACCES on file read
  2. Log at warn level: "[ingestion] Permission denied: {filePath}, skipping"
  3. Add to IngestionResult.failedFiles with error description
  4. Continue with remaining files
  5. At end, print summary: "Completed: 142 files processed, 3 skipped (permission denied)"
  6. Exit code 3 if any files failed, exit code 0 if all succeeded
```

#### Concurrent DuckDB access

DuckDB enforces a single-writer constraint. ccanalytics must never attempt
parallel writes.

```
Strategy: SINGLE-WRITER QUEUE
  1. The ConnectionManager owns exactly one DuckDB connection
  2. All write operations (ingestion, state updates) go through BatchInserter
  3. BatchInserter serializes writes within a single transaction
  4. If a second ccanalytics process attempts to open the same DB for writing:
     - DuckDB throws a lock error
     - Wrapped as DatabaseLockedError
     - User message: "Another ccanalytics process is using this database"
     - Hint: "Close other instances or use `lsof <dbPath>` to identify the holder"
  5. The `watch` command holds the write connection for its entire lifetime
```

#### Streaming duplicate entries

Duplicates from Claude Code's streaming output are **not errors** -- they are
expected behavior. The deduplication strategy is built into the ingestion
pipeline, not the error handling layer.

```
Strategy: DEDUP VIA requestId (normal operation, not an error)
  1. Collect all AssistantMessage entries from a file
  2. Group by requestId
  3. For each group, keep only the last entry (last-entry-wins)
  4. Report duplicatesRemoved count in IngestionResult
  5. No warning or error logged -- this is expected behavior
```

### 1.4 User-Facing Error Messages

Error messages follow a two-tier format depending on the `--verbose` flag.

**Normal mode** -- one-line message with a suggested fix:

```
Error: [INGESTION] Failed to parse 3 lines in session-abc123.jsonl
  Hint: Run with --verbose to see line numbers and raw content

Error: [DATABASE] Database is locked by another process
  Hint: Close other ccanalytics instances or check with `lsof analytics.duckdb`

Error: [CONFIG] Claude data directory not found
  Hint: Expected ~/.claude or ~/.config/claude -- is Claude Code installed?

Error: [QUERY] Table 'sessions' does not exist
  Hint: Run `ccanalytics ingest` first to create the schema and load data

Error: [FS] Permission denied reading 3 files in ~/.claude/projects/
  Hint: Check file ownership with `ls -la` or run from the correct user account
```

**Verbose mode** (`--verbose`) -- full stack trace with context:

```
Error: [INGESTION] Failed to parse line 42 in /Users/dev/.claude/projects/-repo/session.jsonl
  Raw line: {"type":"assistant","sessionId":"abc","trun
  Parse error: Unexpected end of JSON input
  Stack:
    at JSONLParser.parseLine (src/ingestion/jsonl-parser.ts:87:15)
    at JSONLParser.parseFile (src/ingestion/jsonl-parser.ts:54:22)
    at IngestionPipeline.run (src/ingestion/index.ts:31:18)
```

The formatting function:

```typescript
function formatError(error: CCAnalyticsError, verbose: boolean): string {
  const type = error.code.replace("_ERROR", "").replace("_", " ");
  let output = `Error: [${type}] ${error.message}`;

  if (error instanceof ConfigError) {
    output += "\n  Hint: Check your config file or remove it to use defaults";
  } else if (error instanceof DatabaseLockedError) {
    output += "\n  Hint: Close other ccanalytics instances or use `lsof <dbPath>`";
  } else if (error instanceof QueryError) {
    output += "\n  Hint: Use --verbose to see the full SQL query";
  }
  // ... additional hint logic per error type

  if (verbose && error.stack) {
    output += `\n  Stack:\n    ${error.stack.split("\n").slice(1).join("\n    ")}`;
  }

  if (verbose && error.cause) {
    output += `\n  Caused by: ${error.cause.message}`;
  }

  return output;
}
```

### 1.5 Global Error Handler

The CLI entry point installs a global unhandled rejection handler to ensure
no error silently crashes the process:

```typescript
// In src/cli/index.ts, registered during createProgram()

process.on("uncaughtException", (error) => {
  if (error instanceof CCAnalyticsError) {
    console.error(formatError(error, globalOptions.verbose));
    process.exit(error.exitCode);
  } else {
    console.error(`Error: [INTERNAL] ${error.message}`);
    if (globalOptions.verbose) {
      console.error(error.stack);
    }
    console.error("  Hint: This is an unexpected error. Please report it.");
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`Error: [INTERNAL] Unhandled rejection: ${error.message}`);
  if (globalOptions.verbose) {
    console.error(error.stack);
  }
  process.exit(1);
});
```

---

## 2. Testing Strategy

### 2.1 Test Categories with Vitest

ccanalytics uses **Vitest** as its test runner. Tests are organized into five
categories, each with distinct responsibilities, execution speed, and
isolation requirements.

#### Category 1: Unit Tests

Unit tests verify individual functions and classes in isolation, with all
external dependencies mocked or stubbed.

| Module Under Test | What Is Tested |
|-------------------|----------------|
| `JSONLParser` | Line parsing, type discrimination, malformed input handling |
| `CostAnalyzer` | Cost calculation logic, model pricing lookups, cross-validation |
| `CacheAnalyzer` | Cache hit rate formula, threshold interpretation |
| `OutputFormatter` | Table rendering, JSON pretty-printing, CSV escaping, cost/token formatting |
| `Deduplicator` | requestId grouping, last-entry-wins logic, empty input handling |
| `PathUtils` | Path encoding (`/Users/sam/app` to `-Users-sam-app`), decoding, session ID extraction |
| `ConfigLoader` | Precedence merging (CLI > env > file > defaults), validation |

**Execution time target**: < 5 seconds total for all unit tests.

#### Category 2: Integration Tests

Integration tests verify that multiple modules work together correctly. They
use DuckDB's in-memory mode (`:memory:`) to avoid filesystem side effects.

| Integration Scenario | Modules Involved |
|---------------------|-----------------|
| DuckDB in-memory schema creation | `SchemaManager`, `ConnectionManager` |
| End-to-end ingestion pipeline | `FileDiscovery`, `JSONLParser`, `Deduplicator`, `BatchInserter`, `IngestionTracker` |
| Query results against known fixtures | `IngestionPipeline`, `CostAnalyzer`, `CacheAnalyzer`, `SessionAnalyzer` |
| Config loading with env overrides | `ConfigLoader`, `loadConfig` |

**Execution time target**: < 15 seconds total for all integration tests.

#### Category 3: Fixture-Based Tests

Fixture-based tests use handcrafted JSONL files that cover specific data
scenarios. Each fixture is a real-world-representative JSONL file.

| Fixture File | Scenario Covered |
|-------------|-----------------|
| `minimal-session.jsonl` | Single user message + single assistant response; baseline happy path |
| `multi-turn-session.jsonl` | 5+ turns with tool calls (Read, Edit, Bash), thinking blocks, and text blocks |
| `mcp-tools-session.jsonl` | MCP tool calls following `mcp__github__search`, `mcp__github__create_pr` naming |
| `streaming-duplicates.jsonl` | 3 entries sharing the same `requestId` with incrementally more complete data |
| `corrupt-lines.jsonl` | Mix of valid lines, truncated JSON, empty lines, binary garbage, and valid lines after errors |
| `cache-heavy-session.jsonl` | Session with high `cache_read_input_tokens` (>80% cache hit rate) and `cache_creation_input_tokens` |

#### Category 4: Snapshot Tests

Snapshot tests lock down the exact CLI output format. Vitest's built-in
snapshot support (`toMatchSnapshot()`) captures the formatted string output
so that unintentional formatting changes are caught in code review.

| Snapshot Scope | What Is Captured |
|---------------|-----------------|
| Table output mode | `OutputFormatter.table()` result for a session summary |
| JSON output mode | `OutputFormatter.json()` result for cost breakdown |
| CSV output mode | `OutputFormatter.csv()` result with header row |
| Dashboard summary | `OutputFormatter.summary()` result for key metrics panel |
| Error formatting | `formatError()` output for each error type in normal and verbose mode |

#### Category 5: Edge Case Tests

Edge case tests verify behavior at the boundaries of valid input and under
unusual conditions.

| Edge Case | Expected Behavior |
|-----------|-------------------|
| Empty JSONL file (0 bytes) | Parse returns 0 entries, 0 errors; ingestion reports file as skipped |
| Huge session (10,000+ turns) | Ingestion completes without OOM; batch flushing at 1000 rows prevents memory spikes |
| Missing fields on assistant message (no `costUSD`) | Entry skipped with warning; parseErrors incremented |
| Future schema changes (unknown `type` value) | Unknown types are silently skipped; forward-compatible |
| Session with 0 tool calls | Session row has `num_tool_calls = 0`; tool_calls table has no rows for this session |
| JSONL file with only `user` messages (no assistant) | No sessions created (sessions require at least one assistant message for cost data) |
| Very long lines (>1 MB single JSON line) | Parsed normally; no line-length limit enforced |
| Unicode in file paths and content | Path encoding handles Unicode; JSONL parser handles UTF-8 |
| Concurrent `ingest` and `watch` on same DB | DatabaseLockedError thrown for second writer |

### 2.2 Test Directory Structure

```
tests/
  fixtures/
    minimal-session.jsonl
    multi-turn-session.jsonl
    mcp-tools-session.jsonl
    streaming-duplicates.jsonl
    corrupt-lines.jsonl
    cache-heavy-session.jsonl
  ingestion/
    file-discovery.test.ts
    jsonl-parser.test.ts
    deduplicator.test.ts
    batch-inserter.test.ts
  queries/
    cost-analyzer.test.ts
    cache-analyzer.test.ts
    session-analyzer.test.ts
    tool-analyzer.test.ts
  db/
    connection.test.ts
    schema.test.ts
  cli/
    output-formatter.test.ts
  integration/
    ingest-and-query.test.ts
```

### 2.3 Coverage Targets

| Metric | Minimum | Rationale |
|--------|---------|-----------|
| **Line coverage** | 80% | Ensures most code paths are exercised; allows pragmatic gaps in error-only branches |
| **Branch coverage** | 70% | Covers major conditional logic; some defensive branches are hard to trigger in tests |
| **Function coverage** | 90% | Every public API function must be tested; only internal helpers may be exempt |

Vitest coverage configuration:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 90,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/types/**/*.ts"], // Type-only files have no runtime code
    },
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
});
```

### 2.4 Sample Test Fixture Content

#### Fixture 1: `minimal-session.jsonl`

A single-turn session with one user message and one assistant response.
This is the baseline happy-path fixture for all ingestion and query tests.

```jsonl
{"type":"user","sessionId":"sess-minimal-001","timestamp":"2026-02-20T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"What is 2+2?"}]},"uuid":"uuid-user-001","parentUuid":null}
{"type":"assistant","sessionId":"sess-minimal-001","timestamp":"2026-02-20T10:00:02.500Z","costUSD":0.0042,"usage":{"input_tokens":150,"output_tokens":28,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"requestId":"req_minimal_001","parentUuid":"uuid-user-001","uuid":"uuid-asst-001","version":"1.0.35","model":"claude-sonnet-4-5","message":{"role":"assistant","content":[{"type":"text","text":"2 + 2 = 4."}],"stop_reason":"end_turn","model":"claude-sonnet-4-5"}}
```

**Expected parse results:**
- 2 entries (1 user, 1 assistant)
- 0 parse errors
- 1 session with `session_id = "sess-minimal-001"`
- `total_cost = 0.0042`
- `num_turns = 1` (one assistant response)
- `num_tool_calls = 0`
- `cache_hit_rate = 0.0` (no cache tokens)

#### Fixture 2: `streaming-duplicates.jsonl`

Three entries sharing the same `requestId`, simulating Claude Code's
streaming behavior where partial responses are written as they arrive.
Only the final entry (last-entry-wins) should be kept after deduplication.

```jsonl
{"type":"user","sessionId":"sess-stream-001","timestamp":"2026-02-20T14:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Explain caching."}]},"uuid":"uuid-user-stream","parentUuid":null}
{"type":"assistant","sessionId":"sess-stream-001","timestamp":"2026-02-20T14:00:01.000Z","costUSD":0.0010,"usage":{"input_tokens":200,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"requestId":"req_stream_dedup_001","parentUuid":"uuid-user-stream","uuid":"uuid-asst-s1","version":"1.0.35","model":"claude-sonnet-4-5","message":{"role":"assistant","content":[{"type":"text","text":"Caching is"}],"stop_reason":null,"model":"claude-sonnet-4-5"}}
{"type":"assistant","sessionId":"sess-stream-001","timestamp":"2026-02-20T14:00:02.000Z","costUSD":0.0025,"usage":{"input_tokens":200,"output_tokens":120,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"requestId":"req_stream_dedup_001","parentUuid":"uuid-user-stream","uuid":"uuid-asst-s2","version":"1.0.35","model":"claude-sonnet-4-5","message":{"role":"assistant","content":[{"type":"text","text":"Caching is a technique that stores frequently accessed data"}],"stop_reason":null,"model":"claude-sonnet-4-5"}}
{"type":"assistant","sessionId":"sess-stream-001","timestamp":"2026-02-20T14:00:03.500Z","costUSD":0.0051,"usage":{"input_tokens":200,"output_tokens":245,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"requestId":"req_stream_dedup_001","parentUuid":"uuid-user-stream","uuid":"uuid-asst-s3","version":"1.0.35","model":"claude-sonnet-4-5","message":{"role":"assistant","content":[{"type":"text","text":"Caching is a technique that stores frequently accessed data in a fast-access layer to reduce latency and computational cost. In the context of LLMs, prompt caching allows repeated prefixes to be served from cache at 10% of the normal input cost."}],"stop_reason":"end_turn","model":"claude-sonnet-4-5"}}
```

**Expected deduplication results:**
- 3 assistant entries with `requestId = "req_stream_dedup_001"` found
- 2 duplicates removed
- 1 surviving entry: the last one (`uuid-asst-s3`) with `costUSD = 0.0051`, `output_tokens = 245`, and `stop_reason = "end_turn"`
- Final session has `total_cost = 0.0051`, `num_turns = 1`

### 2.5 Test Conventions

| Convention | Rule |
|-----------|------|
| **Database isolation** | Integration tests use `:memory:` DuckDB -- no file on disk |
| **Fixture immutability** | Fixture files are read-only; tests never modify them |
| **No network** | All tests run offline; no HTTP calls, no MotherDuck connections |
| **Deterministic timestamps** | Fixtures use fixed ISO timestamps; tests never depend on `Date.now()` |
| **Cleanup** | DuckDB in-memory connections are closed in `afterEach` |
| **Naming** | Test files mirror source files: `src/ingestion/jsonl-parser.ts` -> `tests/ingestion/jsonl-parser.test.ts` |

---

## 3. Scaling Playbook

ccanalytics is designed to scale through four stages without requiring an
application rewrite. The same TypeScript codebase, the same SQL queries, and
the same star schema work at every stage. Only the `dbPath` configuration
value changes.

### 3.1 Stage 1: Local DuckDB (Default)

**Configuration:**

```json
{
  "dbPath": "~/.ccanalytics/analytics.duckdb"
}
```

**Capacity:**
- Millions of rows comfortably (DuckDB handles 100M+ rows on a laptop)
- Single developer workstation
- Typical ccanalytics deployment: ~1,000-50,000 rows after months of usage

**Characteristics:**
- Zero infrastructure: no server, no daemon, no Docker
- DuckDB runs in-process inside the Node.js CLI
- Database file is a single `analytics.duckdb` file on disk
- Ad-hoc SQL queries via `duckdb analytics.duckdb -json -c "SELECT ..."`

**Limitations:**
- **Single-writer constraint**: only one process can write at a time. The
  `watch` command holds the write connection for its lifetime. Running
  `ingest` while `watch` is active will fail with `DatabaseLockedError`.
- No sharing across machines without manual file copying
- No access control (anyone with file access can read everything)

**Privacy:**
- No concerns -- all data stays on the local filesystem
- No network calls, no telemetry, no external services
- Data is as private as the user's home directory

### 3.2 Stage 2: MotherDuck

**Configuration change:**

```json
{
  "dbPath": "md:ccanalytics"
}
```

That is the only change. MotherDuck uses the DuckDB wire protocol, so
`@duckdb/node-api` connects to it natively.

**Migration from Stage 1:**

```sql
-- Run once to copy local data to MotherDuck
ATTACH 'analytics.duckdb' AS local_db;
ATTACH 'md:ccanalytics' AS remote_db;

CREATE TABLE remote_db.sessions AS SELECT * FROM local_db.sessions;
CREATE TABLE remote_db.conversation_turns AS SELECT * FROM local_db.conversation_turns;
CREATE TABLE remote_db.tool_calls AS SELECT * FROM local_db.tool_calls;
CREATE TABLE remote_db.errors AS SELECT * FROM local_db.errors;
CREATE TABLE remote_db.ingestion_state AS SELECT * FROM local_db.ingestion_state;
CREATE TABLE remote_db.schema_migrations AS SELECT * FROM local_db.schema_migrations;

DETACH local_db;
```

**Capacity:**
- Same as local DuckDB (billions of rows) but with cloud-backed storage
- Multiple developers can read concurrently
- Hybrid execution: small queries run locally, large aggregations run on MotherDuck servers

**Characteristics:**
- Free tier available (10 GB storage, shared compute)
- Same SQL, same schema, same queries
- Web UI for ad-hoc exploration at app.motherduck.com
- Supports sharing databases with team members via MotherDuck organizations

**Limitations:**
- Requires MotherDuck account and authentication token
- Write throughput limited by network latency
- Free tier has compute quotas

**Privacy:**
- Data leaves the local machine and resides on MotherDuck's servers
- **Must strip or hash sensitive data before migration** (see Section 3.5)
- MotherDuck is SOC 2 Type II compliant

### 3.3 Stage 3: pg_duckdb

**Configuration change:**

```json
{
  "dbPath": "postgres://user:pass@host:5432/analytics?duckdb=true"
}
```

**Migration from Stage 1 or 2:**

```sql
-- On the PostgreSQL server, install pg_duckdb
CREATE EXTENSION duckdb;

-- Create tables matching the star schema (see sql/schema.sql)
CREATE TABLE sessions (
  session_id VARCHAR PRIMARY KEY,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  duration_seconds INTEGER,
  model VARCHAR,
  input_tokens BIGINT DEFAULT 0,
  output_tokens BIGINT DEFAULT 0,
  cache_creation_tokens BIGINT DEFAULT 0,
  cache_read_tokens BIGINT DEFAULT 0,
  total_cost_usd DOUBLE DEFAULT 0.0,
  num_turns INTEGER DEFAULT 0,
  num_tool_calls INTEGER DEFAULT 0,
  cwd VARCHAR,
  source_file VARCHAR,
  git_branch VARCHAR,
  claude_version VARCHAR,
  project_path VARCHAR
);

-- Repeat for conversation_turns, tool_calls, errors, ingestion_state
-- (DDL matches 02-data-architecture.md)

-- Import from DuckDB file or Parquet export
-- Option A: Direct import from local DuckDB via duckdb_fdw
SELECT duckdb.install_extension('postgres');
COPY sessions FROM '/path/to/analytics.duckdb'
  (FORMAT DUCKDB, TABLE 'sessions');

-- Option B: Import from Parquet (exported from Stage 1)
SELECT duckdb.install_extension('parquet');
INSERT INTO sessions
  SELECT * FROM read_parquet('/path/to/export/sessions/*.parquet');
```

**Capacity:**
- Limited by PostgreSQL infrastructure (typically TB-scale)
- Multi-user with full RBAC via PostgreSQL roles
- DuckDB accelerates analytical reads up to 1,500x over standard PostgreSQL

**Characteristics:**
- Integrates with existing PostgreSQL infrastructure (monitoring, backups, RBAC)
- DuckDB handles analytical reads; PostgreSQL handles transactional writes
- pg_duckdb v1.0 is production-ready
- Full PostgreSQL ecosystem (pgAdmin, Grafana, etc.)

**Limitations:**
- Requires PostgreSQL server administration
- Write path goes through PostgreSQL (slower than direct DuckDB writes)
- pg_duckdb extension must be installed and maintained

**Privacy:**
- Data resides on team-controlled PostgreSQL infrastructure
- Full RBAC: developers see only their own data, admins see aggregates
- Standard PostgreSQL audit logging available
- **Must anonymize before loading** (see Section 3.5)

### 3.4 Stage 4: ClickHouse

**When to use:** >10M rows, distributed query needs, multi-region teams,
or when sub-second query latency on massive datasets is required.

**Export from DuckDB:**

```sql
-- Export partitioned Parquet from DuckDB (Stage 1 or 2)
COPY sessions TO 'archive/sessions/'
  (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (date_trunc('month', start_time)));

COPY conversation_turns TO 'archive/turns/'
  (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (date_trunc('month', timestamp)));

COPY tool_calls TO 'archive/tool_calls/'
  (FORMAT PARQUET, COMPRESSION ZSTD);
```

**ClickHouse ingestion:**

```sql
-- Create ClickHouse tables with MergeTree engine
CREATE TABLE sessions (
  session_id String,
  start_time DateTime,
  end_time DateTime,
  duration_seconds UInt32,
  model LowCardinality(String),
  input_tokens UInt64,
  output_tokens UInt64,
  cache_creation_tokens UInt64,
  cache_read_tokens UInt64,
  total_cost_usd Float64,
  num_turns UInt32,
  num_tool_calls UInt32,
  cwd String,
  source_file String,
  git_branch String,
  claude_version String,
  project_path String
) ENGINE = MergeTree()
ORDER BY (start_time, session_id)
PARTITION BY toYYYYMM(start_time);

-- Ingest Parquet files
INSERT INTO sessions
  SELECT * FROM file('archive/sessions/**/*.parquet', Parquet);

-- Or use clickhouse-local for one-shot import
clickhouse-local --query "
  INSERT INTO FUNCTION s3('https://...', 'Parquet')
  SELECT * FROM file('archive/sessions/**/*.parquet', Parquet)
"
```

**Capacity:**
- Billions of rows, petabyte scale
- Distributed query execution across shards
- Sub-second latency on aggregation queries

**Characteristics:**
- Column-oriented storage optimized for analytical workloads
- Native Parquet and JSON ingestion
- Materialized views for pre-aggregated metrics
- DuckDB can query ClickHouse as a remote source for hybrid queries:
  ```sql
  ATTACH 'clickhouse://host:9000/analytics' AS ch;
  SELECT * FROM ch.sessions WHERE start_time > '2026-01-01';
  ```

**Limitations:**
- Requires ClickHouse infrastructure (self-hosted or ClickHouse Cloud)
- Not designed for OLTP writes (batch-oriented)
- Schema must be adapted to ClickHouse types (`LowCardinality`, `DateTime`)

**Privacy:**
- Implement column-level access control in ClickHouse
- Use ClickHouse's row-level security policies for multi-tenant data
- **Must fully anonymize before loading** (see Section 3.5)

### 3.5 Privacy at Each Stage

| Stage | Privacy Posture | Action Required |
|-------|----------------|-----------------|
| **Stage 1: Local DuckDB** | No concerns -- data never leaves the machine | None |
| **Stage 2: MotherDuck** | Data on third-party cloud | Strip/hash `cwd` paths and session content before sharing |
| **Stage 3: pg_duckdb** | Data on team infrastructure | Implement RBAC; anonymize before loading |
| **Stage 4: ClickHouse** | Data on shared analytical infrastructure | Full anonymization; row-level security |

**Data anonymization view for team export:**

At Stage 2 and beyond, create a view that strips personally identifiable
information before any data leaves the local machine:

```sql
-- Anonymization view: safe for team export
CREATE OR REPLACE VIEW v_anonymized_sessions AS
  SELECT
    session_id,
    start_time,
    end_time,
    duration_seconds,
    model,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    total_cost_usd,
    num_turns,
    num_tool_calls,
    -- Hash the working directory to preserve uniqueness without revealing paths
    md5(cwd) AS cwd_hash,
    -- Strip the full path, keep only the project directory name
    regexp_extract(source_file, '/([^/]+)/[^/]+\.jsonl$', 1) AS project_slug
  FROM sessions;

-- Export only the anonymized view
COPY (SELECT * FROM v_anonymized_sessions) TO 'team-export.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD);
```

Anonymization rules:
1. **`cwd` paths** -- hash with MD5 or replace with a project slug
2. **`source_file` paths** -- strip to project directory name only
3. **Session content** -- never export raw message text; only export token counts and costs
4. **Tool parameters** -- strip from `tool_calls.parameters` column; set to `NULL`
5. **Error messages** -- strip file paths from `errors.message`; keep only error type

---

## 4. Performance Considerations

### 4.1 Batch Insert Sizes

All ingestion writes use batched transactions. The default batch size is
**1,000 rows per transaction**.

```
Why 1,000:
  - Small enough to avoid holding the write lock for too long
  - Large enough to amortize per-transaction overhead (DuckDB WAL flush)
  - Memory footprint per batch: ~1-5 MB (depends on JSON content size)
  - Measured throughput: ~50,000 rows/second on typical hardware
```

The `BatchInserter` flushes automatically when the buffer reaches the
configured `batchSize`. At the end of a file, any remaining rows are
flushed in a final partial batch.

```typescript
// Simplified flush logic in BatchInserter
async function flush(batch: InsertionBatch): Promise<void> {
  await queryExecutor.transaction(async (tx) => {
    // MERGE INTO for sessions (idempotent upsert)
    for (const session of batch.sessions) {
      await tx.run(UPSERT_SESSION_SQL, sessionToParams(session));
    }
    // INSERT for turns, tool_calls, errors (append-only)
    if (batch.conversationTurns.length > 0) {
      await tx.run(BATCH_INSERT_TURNS_SQL, turnsToParams(batch.conversationTurns));
    }
    if (batch.toolCalls.length > 0) {
      await tx.run(BATCH_INSERT_TOOLS_SQL, toolsToParams(batch.toolCalls));
    }
    if (batch.errors.length > 0) {
      await tx.run(BATCH_INSERT_ERRORS_SQL, errorsToParams(batch.errors));
    }
  });
}
```

### 4.2 Lazy Module Loading

CLI startup time is critical for developer experience. ccanalytics uses
**lazy module loading** so that only the code needed for the requested
command is loaded.

```
Startup sequence:
  1. Commander parses argv                    (~5ms)
  2. Config loaded                            (~10ms)
  3. Logger created                           (~1ms)
  4. Command-specific modules loaded lazily:
     - `ingest` -> loads Ingestion + Database  (~50ms)
     - `query`  -> loads Query + Database      (~40ms)
     - `watch`  -> loads Watcher + Ingestion + Database (~60ms)
     - `status` -> loads Database only         (~30ms)
```

Implementation pattern:

```typescript
// In src/cli/commands/ingest.ts
export function registerIngestCommand(parent: Command): void {
  parent
    .command("ingest")
    .description("Ingest JSONL session files into DuckDB")
    .action(async (options) => {
      // Lazy import: Database and Ingestion modules loaded only when
      // the ingest command is actually invoked
      const { createConnectionManager } = await import("../../db");
      const { createIngestionPipeline } = await import("../../ingestion");
      // ... execute
    });
}
```

### 4.3 DuckDB Single-Connection Write Pattern

ccanalytics enforces a single-writer pattern at the application level.
The `ConnectionManager` creates exactly one `DuckDBConnection` and shares
it across all write operations.

```
Architecture:
  ConnectionManager (singleton)
    |
    +-- DuckDBInstance (one per process)
    |     |
    |     +-- DuckDBConnection (one per process, shared)
    |           |
    |           +-- Used by BatchInserter (writes)
    |           +-- Used by QueryExecutor (reads)
    |           +-- Used by SchemaManager (DDL)
    |           +-- Used by IngestionTracker (state updates)
```

This avoids DuckDB's write-lock contention and matches the single-process
ingestion model described in the V0 document.

### 4.4 Read-Ahead Buffering for Large JSONL

For JSONL files larger than 10 MB, the parser uses `node:readline` with a
configurable `highWaterMark` to buffer reads efficiently.

```typescript
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

async function parseFile(filePath: string, fromByteOffset: number = 0): Promise<ParseResult> {
  const stream = createReadStream(filePath, {
    start: fromByteOffset,
    encoding: "utf-8",
    highWaterMark: 64 * 1024, // 64 KB read-ahead buffer
  });

  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity, // Handle both \n and \r\n
  });

  const entries: ParsedEntry[] = [];
  let parseErrors = 0;
  let linesProcessed = 0;

  for await (const line of rl) {
    linesProcessed++;
    if (line.trim() === "") continue; // Skip empty lines

    try {
      const parsed = JSON.parse(line);
      const entry = discriminateEntry(parsed);
      if (entry) entries.push(entry);
    } catch {
      parseErrors++;
      // Skip corrupt line, continue processing
    }
  }

  return { entries, parseErrors, bytesRead: stream.bytesRead, linesProcessed };
}
```

### 4.5 Chokidar `awaitWriteFinish`

Claude Code writes to JSONL files incrementally during active sessions.
Reading a file mid-write produces truncated JSON lines. The `awaitWriteFinish`
option in Chokidar prevents this by waiting for a file's size to stabilize
before firing the change event.

```typescript
const watcher = chokidar.watch(patterns, {
  awaitWriteFinish: {
    stabilityThreshold: 2000, // Wait 2 seconds after last size change
    pollInterval: 100,        // Check size every 100ms during stability window
  },
  ignoreInitial: false,       // Process existing files on startup
  persistent: true,
});
```

The 2-second stability threshold is calibrated to Claude Code's write
pattern: assistant messages are written in bursts during streaming, with
gaps between turns that typically exceed 2 seconds.

### 4.6 DuckDB In-Memory Mode for Tests

All integration tests use DuckDB's `:memory:` mode to avoid filesystem
I/O and cleanup overhead.

```typescript
// In test setup
import { DuckDBInstance } from "@duckdb/node-api";

let instance: DuckDBInstance;
let connection: DuckDBConnection;

beforeEach(async () => {
  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
  await schemaManager.ensureSchema(connection);
});

afterEach(async () => {
  await connection.close();
  await instance.close();
});
```

Benefits:
- No file cleanup needed between tests
- No risk of test pollution from leftover state
- Faster than file-backed DuckDB (no fsync overhead)
- Parallel test execution safe (each test gets its own instance)

---

## 5. Logging Strategy

### 5.1 Output Channel Separation

ccanalytics strictly separates **data output** from **log output**:

| Channel | Purpose | Content |
|---------|---------|---------|
| **stdout** | Data output | Query results (table, JSON, CSV), export output, machine-readable data |
| **stderr** | Log output | Progress messages, warnings, errors, debug information |

This separation enables piping data output to other tools:

```bash
# Pipe JSON query results to jq
ccanalytics query --template cost-by-model --format json | jq '.[] | .totalCostUSD'

# Redirect CSV to a file while seeing progress on screen
ccanalytics query --template daily-cost --format csv > costs.csv

# Silence logs, keep only data
ccanalytics query --sql "SELECT * FROM sessions" --format json 2>/dev/null
```

### 5.2 Log Levels

| Level | When Used | Visible By Default |
|-------|-----------|-------------------|
| **error** | Unrecoverable failures, fatal errors | Yes |
| **warn** | Recoverable issues: skipped files, corrupt lines, fallback behavior | Yes |
| **info** | Progress summaries: "Ingested 142 files in 3.2s", "Watching 28 files" | Yes |
| **debug** | Detailed internals: SQL queries, per-file processing, byte offsets, config resolution | No (`--verbose` only) |

### 5.3 Structured Log Format

All log lines follow a consistent format for readability and greppability:

```
[LEVEL] [MODULE] message
```

Examples:

```
[info]  [ingestion] Discovered 142 JSONL files in ~/.claude/projects/
[info]  [ingestion] Ingested 142 files (38,291 entries) in 3.2s
[warn]  [ingestion] Skipping corrupt line 42 in session-abc123.jsonl
[warn]  [ingestion] Permission denied: /root/.claude/projects/-secret/data.jsonl, skipping
[error] [db]        Database is locked by another process
[debug] [db]        Executing: SELECT COUNT(*) FROM sessions WHERE start_time > ?
[debug] [ingestion] Processing file: ~/.claude/projects/-my-app/sess-001.jsonl (offset: 4096)
[debug] [config]    Resolved Claude dir: ~/.claude (checked ~/.config/claude -- not found)
[info]  [watcher]   Watching 28 files for changes (stability threshold: 2000ms)
[info]  [watcher]   Detected change: session-new.jsonl (+1,247 bytes)
```

### 5.4 Verbose Mode

The `--verbose` flag (or `CCANALYTICS_VERBOSE=true` environment variable)
enables `debug` level logging. This is useful for troubleshooting ingestion
issues, understanding query behavior, and diagnosing performance problems.

Additional information logged in verbose mode:

| Module | Verbose Output |
|--------|---------------|
| **Ingestion** | Per-file byte offsets, line counts, parse error details with raw line content |
| **Database** | Full SQL queries with parameter values, query execution time in ms |
| **Config** | Full resolution chain showing which source each config value came from |
| **Watcher** | Every Chokidar event (add, change, unlink) with file size and timestamp |
| **Query** | Generated SQL before execution, result row counts, DuckDB execution plan |

### 5.5 Logger Implementation

```typescript
// src/utils/logger.ts

import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: pc.gray,
  info: pc.cyan,
  warn: pc.yellow,
  error: pc.red,
};

export function createLogger(options?: {
  verbose?: boolean;
  level?: LogLevel;
  prefix?: string;
}): Logger {
  const level = options?.level ?? (options?.verbose ? "debug" : "info");
  const prefix = options?.prefix ?? "";

  function log(msgLevel: LogLevel, message: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[msgLevel] < LEVEL_ORDER[level]) return;

    const levelTag = LEVEL_COLORS[msgLevel](`[${msgLevel}]`.padEnd(8));
    const moduleTag = prefix ? pc.dim(`[${prefix}]`.padEnd(14)) : "";
    const formatted = args.length > 0
      ? `${message} ${args.map(String).join(" ")}`
      : message;

    process.stderr.write(`${levelTag}${moduleTag}${formatted}\n`);
  }

  return {
    debug: (msg, ...args) => log("debug", msg, ...args),
    info: (msg, ...args) => log("info", msg, ...args),
    warn: (msg, ...args) => log("warn", msg, ...args),
    error: (msg, ...args) => log("error", msg, ...args),
    child: (childPrefix) =>
      createLogger({
        level,
        prefix: prefix ? `${prefix}:${childPrefix}` : childPrefix,
      }),
    level,
  };
}
```

### 5.6 Logger Usage Pattern

Every module creates a child logger with its module name:

```typescript
// In src/ingestion/index.ts
const logger = parentLogger.child("ingestion");
logger.info("Discovered %d JSONL files", files.length);
logger.debug("Processing file: %s (offset: %d)", filePath, byteOffset);

// In src/db/connection-manager.ts
const logger = parentLogger.child("db");
logger.info("Connected to DuckDB at %s", dbPath);
logger.debug("Executing: %s", sql);

// In src/watcher/index.ts
const logger = parentLogger.child("watcher");
logger.info("Watching %d files for changes", watchedCount);
logger.warn("File deleted while watching: %s", filePath);
```

---

## Requirements Traceability

| Section | Requirements Addressed |
|---------|----------------------|
| Error Handling (Section 1) | NFR-08 (single-writer), NFR-12 (schema reliability), Constraint #2 (dedup), Constraint #3 (partial writes) |
| Testing (Section 2) | FR-01 (JSONL parsing), FR-02 (dedup), FR-07 (cache hit rate), FR-10 (tool patterns), NFR-03 (zero-ETL) |
| Scaling (Section 3) | NFR-01 (local-first), NFR-09 (privacy), NFR-13 (scalable without rewrite), Stages 1-4 from V0 |
| Performance (Section 4) | NFR-05 (minimal bundle), NFR-08 (single-writer), NFR-11 (cross-platform watching), Constraint #3 (awaitWriteFinish) |
| Logging (Section 5) | NFR-09 (privacy -- logs to stderr, no data leakage), FR-28 (output format support) |
