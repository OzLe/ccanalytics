/**
 * @module ingestion
 *
 * Barrel export and pipeline orchestrator for the ingestion module.
 * Coordinates file discovery, parsing, deduplication, and batch insertion.
 */

export { FileDiscovery } from "./file-discovery.js";
export { JSONLParser } from "./jsonl-parser.js";
export { Deduplicator } from "./deduplicator.js";
export { BatchInserter } from "./batch-inserter.js";
export { IngestionTracker } from "./ingestion-tracker.js";

import type {
  IngestionResult,
  IngestionProgress,
  CCAnalyticsConfig,
  SessionRow,
  ConversationTurnRow,
  ToolCallRow,
  AssistantMessage,
  UserMessage,
  ContentBlock,
  TokenUsage,
} from "../types/index.js";
import type { InsertionBatch } from "./batch-inserter.js";
import type { ConnectionManager } from "../db/connection.js";
import type { DiscoveredFile } from "./file-discovery.js";
import { FileDiscovery } from "./file-discovery.js";
import { JSONLParser } from "./jsonl-parser.js";
import { Deduplicator } from "./deduplicator.js";
import { BatchInserter } from "./batch-inserter.js";
import { IngestionTracker } from "./ingestion-tracker.js";
import { calculateCost } from "../utils/pricing.js";

/**
 * Extract token usage from an assistant message.
 * Checks message.usage first (actual JSONL location), then falls back to top-level usage.
 */
function getUsage(msg: AssistantMessage): TokenUsage {
  const u = msg.message?.usage ?? msg.usage;
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
  };
}

/**
 * Get the model identifier from an assistant message.
 */
function getModel(msg: AssistantMessage): string | null {
  return msg.model ?? msg.message?.model ?? null;
}

/**
 * Orchestrates the full ingestion pipeline:
 * 1. Discover JSONL files
 * 2. Parse each file from last byte offset
 * 3. Deduplicate assistant messages by requestId
 * 4. Batch-insert into DuckDB
 * 5. Update ingestion state
 */
export class IngestionPipeline {
  private discovery: FileDiscovery;
  private parser: JSONLParser;
  private deduplicator: Deduplicator;
  private inserter: BatchInserter;
  private tracker: IngestionTracker;
  private progressCallbacks: Array<(progress: IngestionProgress) => void> = [];

  constructor(
    private config: CCAnalyticsConfig,
    private db: ConnectionManager,
  ) {
    this.discovery = new FileDiscovery(config.claudeDir);
    this.parser = new JSONLParser();
    this.deduplicator = new Deduplicator();
    this.inserter = new BatchInserter(db);
    this.tracker = new IngestionTracker(db);
  }

  /**
   * Run a full or incremental ingestion pass.
   *
   * @param options - Ingestion options
   * @param options.force - Force full re-ingestion, ignoring byte-offset state
   * @param options.limit - Maximum number of files to process
   * @param options.since - Only process files modified after this ISO date
   * @returns Summary of the ingestion run
   */
  async run(options?: {
    force?: boolean;
    limit?: number;
    since?: string;
  }): Promise<IngestionResult> {
    const startTime = Date.now();

    // 1. Discover JSONL files
    let files = await this.discovery.discoverFiles({ since: options?.since });

    // 2. Apply limit if provided
    if (options?.limit != null && options.limit > 0) {
      files = files.slice(0, options.limit);
    }

    // 3. If force, clear all tracked byte offsets
    if (options?.force) {
      await this.tracker.resetAll();
    }

    // 4. Initialize result counters
    const result: IngestionResult = {
      filesDiscovered: files.length,
      filesProcessed: 0,
      filesSkipped: 0,
      filesFailed: 0,
      failedFiles: [],
      entriesIngested: 0,
      duplicatesRemoved: 0,
      parseErrors: 0,
      durationMs: 0,
    };

    // 5. Process each discovered file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Emit discovery progress
      this.emitProgress({
        phase: "discovery",
        filesTotal: files.length,
        filesProcessed: i,
        entriesTotal: 0,
        entriesProcessed: 0,
        bytesTotal: files.reduce((sum, f) => sum + f.sizeBytes, 0),
        bytesProcessed: 0,
        currentFile: file.absolutePath,
      });

      try {
        // Get last ingestion state for this file
        const state = await this.tracker.getState(file.absolutePath);

        // Determine byte offset to resume from
        const byteOffset = options?.force ? 0 : (state?.last_byte_offset ?? 0);

        // Skip if no new data to process
        if (byteOffset >= file.sizeBytes) {
          result.filesSkipped++;
          continue;
        }

        // Parse the file from the byte offset
        const parseResult = await this.parser.parseFile(file.absolutePath, byteOffset);

        // Emit parsing progress
        this.emitProgress({
          phase: "parsing",
          filesTotal: files.length,
          filesProcessed: i,
          entriesTotal: parseResult.entries.length,
          entriesProcessed: 0,
          bytesTotal: file.sizeBytes,
          bytesProcessed: parseResult.bytesRead,
          currentFile: file.absolutePath,
        });

        // Track parse errors
        result.parseErrors += parseResult.parseErrors;

        // Separate assistant messages and user messages from parsed entries
        const assistantMessages: AssistantMessage[] = [];
        const userMessages: UserMessage[] = [];
        for (const entry of parseResult.entries) {
          if (entry.type === "assistant") {
            assistantMessages.push(entry.data);
          } else if (entry.type === "user") {
            userMessages.push(entry.data);
          }
        }

        // Deduplicate assistant messages by requestId (last wins)
        const dedupResult = this.deduplicator.deduplicate(assistantMessages);
        result.duplicatesRemoved += dedupResult.duplicatesRemoved;

        const uniqueAssistantMessages = dedupResult.unique;

        // Build InsertionBatch from parsed data
        const batch = this.buildInsertionBatch(
          file,
          uniqueAssistantMessages,
          userMessages,
        );

        // Insert batch into database
        await this.inserter.insert(batch);

        // Update tracker state with new byte offset
        await this.tracker.updateState(
          file.absolutePath,
          byteOffset + parseResult.bytesRead,
          (state?.last_line_number ?? 0) + parseResult.linesProcessed,
        );

        // Update counters
        result.filesProcessed++;
        result.entriesIngested +=
          batch.conversationTurns.length + batch.toolCalls.length;
      } catch (err) {
        result.filesFailed++;
        result.failedFiles.push({
          path: file.absolutePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Build an InsertionBatch from parsed assistant and user messages for a single file.
   */
  private buildInsertionBatch(
    file: DiscoveredFile,
    assistantMessages: AssistantMessage[],
    userMessages: UserMessage[],
  ): InsertionBatch {
    const turns: ConversationTurnRow[] = [];
    const toolCalls: ToolCallRow[] = [];

    // Build conversation turn rows from user messages
    for (let idx = 0; idx < userMessages.length; idx++) {
      const msg = userMessages[idx];
      const turnId = msg.uuid ?? `${msg.sessionId}-user-${idx}`;

      turns.push({
        turn_id: turnId,
        session_id: msg.sessionId,
        role: "user",
        timestamp: new Date(msg.timestamp),
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: 0,
        model: null,
        stop_reason: null,
        request_id: null,
        parent_uuid: msg.parentUuid ?? null,
        has_tool_use: false,
        has_thinking: false,
      });
    }

    // Build conversation turn rows and tool call rows from assistant messages
    for (let idx = 0; idx < assistantMessages.length; idx++) {
      const msg = assistantMessages[idx];
      const turnId = msg.uuid ?? `${msg.sessionId}-assistant-${idx}`;
      const contentBlocks: ContentBlock[] = msg.message?.content ?? [];

      const hasToolUse = contentBlocks.some((b) => b.type === "tool_use");
      const hasThinking = contentBlocks.some((b) => b.type === "thinking");

      const usage = getUsage(msg);
      const model = getModel(msg);
      const costUsd = calculateCost(
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
      );

      turns.push({
        turn_id: turnId,
        session_id: msg.sessionId,
        role: "assistant",
        timestamp: new Date(msg.timestamp),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        cost_usd: costUsd,
        model,
        stop_reason: msg.message?.stop_reason ?? null,
        request_id: msg.requestId ?? null,
        parent_uuid: msg.parentUuid ?? null,
        has_tool_use: hasToolUse,
        has_thinking: hasThinking,
      });

      // Extract tool calls from content blocks
      for (const block of contentBlocks) {
        if (block.type === "tool_use") {
          const toolName = block.name;
          let toolType = "builtin";
          let mcpServer: string | null = null;

          if (toolName.startsWith("mcp__")) {
            toolType = "mcp";
            // Pattern: mcp__<server>__<tool>
            const parts = toolName.split("__");
            if (parts.length >= 3) {
              mcpServer = parts[1];
            }
          }

          toolCalls.push({
            tool_call_id: block.id,
            session_id: msg.sessionId,
            turn_id: turnId,
            tool_name: toolName,
            tool_type: toolType,
            mcp_server: mcpServer,
            duration_ms: null,
            success: null,
            error_message: null,
            parameters: block.input ?? null,
          });
        }
      }
    }

    // Build session row by aggregating across all assistant messages for this file
    const sessions: SessionRow[] = [];
    const sessionMap = new Map<string, AssistantMessage[]>();

    for (const msg of assistantMessages) {
      const existing = sessionMap.get(msg.sessionId);
      if (existing) {
        existing.push(msg);
      } else {
        sessionMap.set(msg.sessionId, [msg]);
      }
    }

    // Also account for user messages in sessions that have no assistant messages
    for (const msg of userMessages) {
      if (!sessionMap.has(msg.sessionId)) {
        sessionMap.set(msg.sessionId, []);
      }
    }

    for (const [sessionId, msgs] of sessionMap) {
      // Collect timestamps from all messages in this session
      const allTimestamps: Date[] = [];
      for (const m of msgs) {
        allTimestamps.push(new Date(m.timestamp));
      }
      for (const u of userMessages) {
        if (u.sessionId === sessionId) {
          allTimestamps.push(new Date(u.timestamp));
        }
      }

      // Sort timestamps
      allTimestamps.sort((a, b) => a.getTime() - b.getTime());

      const startTime = allTimestamps.length > 0
        ? allTimestamps[0]
        : new Date();
      const endTime = allTimestamps.length > 1
        ? allTimestamps[allTimestamps.length - 1]
        : null;
      const durationSeconds = endTime
        ? (endTime.getTime() - startTime.getTime()) / 1000
        : null;

      // Aggregate token usage and cost
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let totalCost = 0;
      let numToolCalls = 0;

      for (const m of msgs) {
        const u = getUsage(m);
        const mdl = getModel(m);
        inputTokens += u.input_tokens;
        outputTokens += u.output_tokens;
        cacheCreationTokens += u.cache_creation_input_tokens;
        cacheReadTokens += u.cache_read_input_tokens;
        totalCost += calculateCost(
          mdl,
          u.input_tokens,
          u.output_tokens,
          u.cache_creation_input_tokens,
          u.cache_read_input_tokens,
        );

        // Count tool_use blocks in this message
        const content: ContentBlock[] = m.message?.content ?? [];
        for (const block of content) {
          if (block.type === "tool_use") {
            numToolCalls++;
          }
        }
      }

      // Get metadata from the first assistant message if available
      const first = msgs.length > 0 ? msgs[0] : null;

      // Count turns for this session (user + assistant)
      const sessionUserTurns = userMessages.filter(
        (u) => u.sessionId === sessionId,
      ).length;
      const numTurns = msgs.length + sessionUserTurns;

      sessions.push({
        session_id: sessionId,
        start_time: startTime,
        end_time: endTime,
        duration_seconds: durationSeconds,
        model: first ? getModel(first) : null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_read_tokens: cacheReadTokens,
        total_cost_usd: totalCost,
        num_turns: numTurns,
        num_tool_calls: numToolCalls,
        cwd: first?.cwd ?? null,
        source_file: file.absolutePath,
        git_branch: first?.gitBranch ?? null,
        claude_version: first?.version ?? null,
        project_path: file.projectPath,
      });
    }

    return {
      sessions,
      conversationTurns: turns,
      toolCalls,
      errors: [],
    };
  }

  /**
   * Subscribe to progress events during ingestion.
   * Useful for CLI progress display (spinners, progress bars).
   *
   * @param callback - Called with progress updates during ingestion
   */
  onProgress(callback: (progress: IngestionProgress) => void): void {
    this.progressCallbacks.push(callback);
  }

  /**
   * Emit a progress event to all registered callbacks.
   */
  private emitProgress(progress: IngestionProgress): void {
    for (const cb of this.progressCallbacks) {
      cb(progress);
    }
  }
}
