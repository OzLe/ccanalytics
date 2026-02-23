/**
 * @module ingestion/jsonl-parser
 *
 * Streaming JSONL parser with type discrimination.
 * Parses each line of a JSONL file into a typed message object,
 * discriminating by the `type` field.
 */

import type {
  RawJSONLEntry,
  UserMessage,
  AssistantMessage,
  FileHistorySnapshot,
  QueueOperation,
} from "../types/index.js";

/** Discriminated union of all parsed JSONL entry types. */
export type ParsedEntry =
  | { type: "user"; data: UserMessage }
  | { type: "assistant"; data: AssistantMessage }
  | { type: "file-history-snapshot"; data: FileHistorySnapshot }
  | { type: "queue-operation"; data: QueueOperation };

/** Known JSONL types that we intentionally skip (no analytics value). */
const SKIPPED_TYPES = new Set(["progress", "system", "summary"]);

/** Result of parsing a single line. */
type LineResult =
  | { status: "parsed"; entry: ParsedEntry }
  | { status: "skipped" }
  | { status: "error" };

/** Result of parsing a single JSONL file. */
export interface ParseResult {
  entries: ParsedEntry[];
  /** Number of lines that failed to parse (invalid JSON). */
  parseErrors: number;
  /** Total bytes read. */
  bytesRead: number;
  /** Total lines processed (including errors). */
  linesProcessed: number;
}

/**
 * Parses JSONL session files line-by-line with type discrimination.
 */
export class JSONLParser {
  /**
   * Parse a single JSONL line into a typed entry.
   *
   * @param line - A single JSON line from a JSONL file
   * @returns Parsed entry, "skipped" for known non-analytical types, or "error" for invalid JSON
   */
  parseLine(line: string): ParsedEntry | null {
    return this.parseLineWithStatus(line).status === "parsed"
      ? (this.parseLineWithStatus(line) as { status: "parsed"; entry: ParsedEntry }).entry
      : null;
  }

  /**
   * Parse a single line with full status information.
   */
  private parseLineWithStatus(line: string): LineResult {
    if (!line || line.trim() === "") {
      return { status: "skipped" };
    }

    let raw: RawJSONLEntry;
    try {
      raw = JSON.parse(line) as RawJSONLEntry;
    } catch {
      return { status: "error" };
    }

    if (!raw.type) {
      return { status: "error" };
    }

    switch (raw.type) {
      case "user":
        return { status: "parsed", entry: { type: "user", data: raw as unknown as UserMessage } };

      case "assistant":
        return {
          status: "parsed",
          entry: { type: "assistant", data: raw as unknown as AssistantMessage },
        };

      case "file-history-snapshot":
        return {
          status: "parsed",
          entry: { type: "file-history-snapshot", data: raw as unknown as FileHistorySnapshot },
        };

      case "queue-operation":
        return {
          status: "parsed",
          entry: { type: "queue-operation", data: raw as unknown as QueueOperation },
        };

      default:
        // Known non-analytical types or unknown future types — skip silently
        return { status: "skipped" };
    }
  }

  /**
   * Parse a JSONL file from a given byte offset.
   * Uses streaming line-by-line reading for memory efficiency.
   *
   * @param filePath - Absolute path to the JSONL file
   * @param fromByteOffset - Byte offset to start reading from (default: 0)
   * @returns Parse result with typed entries, error count, and bytes read
   */
  async parseFile(
    filePath: string,
    fromByteOffset: number = 0,
  ): Promise<ParseResult> {
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");

    const entries: ParsedEntry[] = [];
    let parseErrors = 0;
    let bytesRead = 0;
    let linesProcessed = 0;

    const stream = createReadStream(filePath, {
      start: fromByteOffset,
      encoding: "utf-8",
      highWaterMark: 64 * 1024,
    });

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      linesProcessed++;
      // Track bytes: line content + 1 byte for newline
      bytesRead += Buffer.byteLength(line, "utf-8") + 1;

      const result = this.parseLineWithStatus(line);
      switch (result.status) {
        case "parsed":
          entries.push(result.entry);
          break;
        case "error":
          parseErrors++;
          break;
        // "skipped" — intentionally ignored
      }
    }

    return {
      entries,
      parseErrors,
      bytesRead,
      linesProcessed,
    };
  }
}
