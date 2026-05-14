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
  /**
   * P-03: loaded-skill records parsed from `skill_listing` attachments in
   * this file. Optional — most callers ignore it, and a file with no
   * `skill_listing` record (e.g. incremental ingest past the file head, or a
   * source that does not emit it) simply leaves it `undefined`/empty. A
   * single file may carry 0..N `skill_listing` records.
   */
  loadedSkills?: ParsedLoadedSkillRecord[];
}

/**
 * P-03: a single `skill_listing` attachment, normalized for the batch
 * inserter. One record per `skill_listing` JSONL line; `skills` holds every
 * skill parsed out of that record's `content`.
 */
export interface ParsedLoadedSkillRecord {
  /** Session the attachment belongs to. */
  sessionId: string;
  /** The attachment record's own `uuid`, or null when absent. Part of the PK. */
  recordUuid: string | null;
  /** The attachment record's `timestamp` (ISO string). */
  timestamp: string;
  /** Upstream-reported skill count (the integrity-check denominator). */
  skillCount: number;
  /** TRUE for the session-start injection, FALSE for a mid-session re-listing. */
  isInitial: boolean;
  /** Every skill parsed from the attachment's `content`. */
  skills: Array<{ name: string; description: string }>;
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
   *
   * P-03/P-05: also emits `sessionSkills` rows derived from any
   * `skill_listing` attachments parsed in this file. When `loadedSkills` is
   * passed it is flattened (one `SessionSkillRow` per parsed skill, keyed per
   * D4); when omitted the batch's `sessionSkills` is simply `[]`.
   */
  buildInsertionBatch(
    file: DiscoveredFile,
    assistantMessages: ParsedAssistantMessage[],
    userMessages: ParsedUserMessage[],
    loadedSkills?: ParsedLoadedSkillRecord[],
  ): InsertionBatch;
}
