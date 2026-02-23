/**
 * @module errors
 *
 * Centralized error type hierarchy for ccanalytics.
 * All custom errors extend CCAnalyticsError for consistent catch handling.
 * Each error carries a machine-readable code and a suggested exit code.
 */

/**
 * Base error for all ccanalytics errors.
 * Every subclass carries a machine-readable `code` string and an optional
 * `cause` for error-chain inspection.
 */
export class CCAnalyticsError extends Error {
  /** Machine-readable error code, e.g. "INGESTION_ERROR". */
  public readonly code: string;
  /** Original error that caused this one, if any. */
  public override readonly cause?: Error;
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

// ---------------------------------------------------------------------------
// Ingestion Errors
// ---------------------------------------------------------------------------

/**
 * Errors during JSONL file discovery, parsing, and data loading.
 * Recovery: skip corrupt lines/files, continue with rest, report summary.
 */
export class IngestionError extends CCAnalyticsError {
  constructor(message: string, cause?: Error) {
    super(message, "INGESTION_ERROR", 3, cause);
    this.name = "IngestionError";
  }
}

// ---------------------------------------------------------------------------
// Query Errors
// ---------------------------------------------------------------------------

/**
 * Errors during analytical query construction or execution.
 * Recovery: abort query, report validation/execution error.
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

// ---------------------------------------------------------------------------
// Config Errors
// ---------------------------------------------------------------------------

/**
 * Errors during configuration loading, parsing, and validation.
 * Recovery: abort with descriptive message, suggest fix.
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
  public readonly errors: Array<{
    path: string;
    message: string;
    value: unknown;
  }>;
  constructor(
    errors: Array<{ path: string; message: string; value: unknown }>,
  ) {
    const summary = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    super(`Configuration validation failed:\n${summary}`);
    this.name = "ConfigValidationError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// File System Errors
// ---------------------------------------------------------------------------

/**
 * Errors from filesystem operations outside of DuckDB.
 * Recovery: skip file, log warning, continue.
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

// ---------------------------------------------------------------------------
// Database Errors
// ---------------------------------------------------------------------------

/**
 * Errors from DuckDB connection and schema management.
 * Recovery: retry with exponential backoff, then abort.
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
    super(
      "Concurrent write detected; ccanalytics uses single-writer mode",
      cause,
    );
    this.name = "ConcurrentWriteError";
  }
}

/**
 * Format a CCAnalyticsError for user display.
 * In verbose mode, includes the full stack trace and cause chain.
 */
export function formatError(
  error: CCAnalyticsError,
  verbose: boolean,
): string {
  const type = error.code.replace("_ERROR", "").replace(/_/g, " ");
  let output = `Error: [${type}] ${error.message}`;

  if (error instanceof ConfigError) {
    output += "\n  Hint: Check your config file or remove it to use defaults";
  } else if (error instanceof DatabaseLockedError) {
    output +=
      "\n  Hint: Close other ccanalytics instances or use `lsof <dbPath>`";
  } else if (error instanceof QueryError) {
    output += "\n  Hint: Use --verbose to see the full SQL query";
  } else if (error instanceof IngestionError) {
    output += "\n  Hint: Run with --verbose to see detailed parse errors";
  }

  if (verbose && error.stack) {
    output += `\n  Stack:\n    ${error.stack.split("\n").slice(1).join("\n    ")}`;
  }

  if (verbose && error.cause) {
    output += `\n  Caused by: ${error.cause.message}`;
  }

  return output;
}
