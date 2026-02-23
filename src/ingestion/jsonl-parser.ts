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

/** Result of parsing a single JSONL file. */
export interface ParseResult {
  entries: ParsedEntry[];
  /** Number of lines that failed to parse. */
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
   * Returns null if the line cannot be parsed or has an unknown type.
   *
   * @param line - A single JSON line from a JSONL file
   * @returns Typed ParsedEntry, or null if unparseable
   */
  parseLine(line: string): ParsedEntry | null {
    if (!line || line.trim() === "") {
      return null;
    }

    let raw: RawJSONLEntry;
    try {
      raw = JSON.parse(line) as RawJSONLEntry;
    } catch {
      return null;
    }

    if (!raw.type) {
      return null;
    }

    switch (raw.type) {
      case "user":
        return { type: "user", data: raw as unknown as UserMessage };

      case "assistant":
        return {
          type: "assistant",
          data: raw as unknown as AssistantMessage,
        };

      case "file-history-snapshot":
        return {
          type: "file-history-snapshot",
          data: raw as unknown as FileHistorySnapshot,
        };

      case "queue-operation":
        return {
          type: "queue-operation",
          data: raw as unknown as QueueOperation,
        };

      default:
        // Unknown type — silently skip (forward-compatible)
        return null;
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

      const entry = this.parseLine(line);
      if (entry !== null) {
        entries.push(entry);
      } else if (line.trim() !== "") {
        // Non-empty line that failed to parse
        parseErrors++;
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
