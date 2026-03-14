/**
 * @module ingestion/adapters/types
 *
 * Shared interface and types for source adapters.
 * Each adapter (Claude Code CLI, Claude Desktop, etc.) implements
 * ISourceAdapter to plug into the generic IngestionPipeline.
 */

import type { InsertionBatch } from "../batch-inserter.js";
import type { DiscoveredFile } from "../file-discovery.js";

/** Discriminator for data source origin. */
export type SourceType = "claude-code" | "claude-desktop";

/** Result of adapter file discovery. */
export interface AdapterDiscoveryResult {
  files: DiscoveredFile[];
}

/** Result of parsing a single file through an adapter. */
export interface AdapterParseResult {
  /** Parsed user messages in a source-agnostic shape. */
  userMessages: ParsedUserMessage[];
  /** Parsed assistant messages in a source-agnostic shape. */
  assistantMessages: ParsedAssistantMessage[];
  /** Number of lines that failed to parse. */
  parseErrors: number;
  /** Total bytes consumed from the file. */
  bytesRead: number;
  /** Total lines processed (including errors and skipped). */
  linesProcessed: number;
}

/** Result of adapter deduplication. */
export interface AdapterDeduplicationResult {
  /** Unique assistant messages after dedup. */
  unique: ParsedAssistantMessage[];
  /** Number of duplicates removed. */
  duplicatesRemoved: number;
}

/** Token usage shape shared across all sources. */
export interface NormalizedTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Common shape for a parsed user message. */
export interface ParsedUserMessage {
  sessionId: string;
  timestamp: string;
  uuid?: string;
  parentUuid?: string;
  content: unknown[];
}

/** Common shape for a parsed assistant message. */
export interface ParsedAssistantMessage {
  sessionId: string;
  timestamp: string;
  uuid?: string;
  parentUuid?: string;
  requestId?: string;
  model?: string;
  content: unknown[];
  stopReason?: string;
  usage: NormalizedTokenUsage;
  costUSD?: number;
  metadata: {
    cwd?: string;
    version?: string;
    gitBranch?: string;
  };
}

/**
 * Adapter interface that every data source must implement.
 *
 * The IngestionPipeline iterates over adapters and calls these methods
 * in order: discoverFiles -> parseFile -> deduplicate -> buildInsertionBatch.
 */
export interface ISourceAdapter {
  /** Human-readable name for logging (e.g. "Claude Code CLI"). */
  readonly name: string;
  /** Source type discriminator written to the DB. */
  readonly sourceType: SourceType;
  /** Version of the upstream app this adapter was tested against. */
  readonly testedUpstreamVersion: string;

  /**
   * Discover files that this adapter can ingest.
   * @param options.since - Only return files modified after this ISO date
   */
  discoverFiles(options?: { since?: string }): Promise<DiscoveredFile[]>;

  /**
   * Parse a single discovered file starting at a byte offset.
   * Returns normalized user + assistant messages.
   */
  parseFile(
    file: DiscoveredFile,
    fromByteOffset?: number,
  ): Promise<AdapterParseResult>;

  /**
   * Deduplicate assistant messages (e.g. requestId last-wins for Claude Code,
   * no-op for Desktop).
   */
  deduplicate(
    messages: ParsedAssistantMessage[],
  ): AdapterDeduplicationResult;

  /**
   * Build an InsertionBatch from parsed messages for a single file.
   * Sets source_type on SessionRow.
   */
  buildInsertionBatch(
    file: DiscoveredFile,
    assistantMessages: ParsedAssistantMessage[],
    userMessages: ParsedUserMessage[],
  ): InsertionBatch;
}
