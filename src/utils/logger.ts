/**
 * @module utils/logger
 *
 * Configurable logging utility. All log output goes to stderr so that
 * stdout remains clean for data output (JSON, CSV, tables).
 *
 * Log lines follow the format: [LEVEL] [MODULE] message
 */

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

/** Logger interface with level-based methods and child logger support. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;

  /** Create a child logger with a module-name prefix. */
  child(prefix: string): Logger;

  /** Current effective log level. */
  level: LogLevel;
}

/**
 * Create a logger instance.
 * When verbose = true, level is "debug"; otherwise "info".
 * All output goes to stderr so stdout remains clean for data output.
 *
 * @param options - Logger configuration
 * @param options.verbose - Enable debug-level logging
 * @param options.level - Explicit log level (overrides verbose)
 * @param options.prefix - Module name prefix for log lines
 * @returns Logger instance
 */
export function createLogger(options?: {
  verbose?: boolean;
  level?: LogLevel;
  prefix?: string;
}): Logger {
  const level: LogLevel =
    options?.level ?? (options?.verbose ? "debug" : "info");
  const prefix = options?.prefix ?? "";

  function log(
    msgLevel: LogLevel,
    message: string,
    ...args: unknown[]
  ): void {
    if (LEVEL_ORDER[msgLevel] < LEVEL_ORDER[level]) return;

    const levelTag = LEVEL_COLORS[msgLevel](`[${msgLevel}]`.padEnd(8));
    const moduleTag = prefix ? pc.dim(`[${prefix}]`.padEnd(14)) : "";
    const formatted =
      args.length > 0
        ? `${message} ${args.map(String).join(" ")}`
        : message;

    try {
      process.stderr.write(`${levelTag}${moduleTag}${formatted}\n`);
    } catch {
      // Silently swallow -- logging should never crash the app
    }
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
