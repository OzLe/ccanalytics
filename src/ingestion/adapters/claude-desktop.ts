/**
 * @module ingestion/adapters/claude-desktop
 *
 * Source adapter for Claude Desktop app audit.jsonl files.
 * Reads from ~/Library/Application Support/Claude/local-agent-mode-sessions/
 *
 * Desktop audit.jsonl structure:
 *   - type: "user" / "assistant" / "result:success" / "system:*" / "tool_use_summary"
 *   - session_id: string
 *   - _audit_timestamp: ISO string
 *   - uuid: string
 *   - message.id (requestId), message.model, message.usage.*, message.content[]
 *   - message.stop_reason
 *
 * Skipped types: system:init, system:permission_*, system:compact_boundary,
 *   system:status, tool_use_summary
 *
 * Companion metadata: <session-dir>/<session-id>.json with title, cwd, model
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ISourceAdapter,
  AdapterParseResult,
  AdapterDeduplicationResult,
  ParsedUserMessage,
  ParsedAssistantMessage,
  NormalizedTokenUsage,
} from "./types.js";
import type {
  SessionRow,
  ConversationTurnRow,
  ToolCallRow,
  ContentBlock,
} from "../../types/index.js";
import type { InsertionBatch } from "../batch-inserter.js";
import type { DiscoveredFile } from "../file-discovery.js";
import { calculateCost } from "../../utils/pricing.js";
import { expandHome } from "../../utils/paths.js";

/** Maximum length of content_text stored per turn. */
const CONTENT_TEXT_MAX_LENGTH = 10000;

/**
 * Extract concatenated text from content blocks.
 * Only TextBlock.text values are included; ToolUseBlock, ToolResultBlock, and ThinkingBlock are skipped.
 * Returns null if no text content is found, otherwise truncates to CONTENT_TEXT_MAX_LENGTH.
 */
function extractContentText(contentBlocks: string | ContentBlock[]): string | null {
  if (typeof contentBlocks === 'string') {
    if (contentBlocks.length === 0) return null;
    return contentBlocks.length > CONTENT_TEXT_MAX_LENGTH
      ? contentBlocks.slice(0, CONTENT_TEXT_MAX_LENGTH)
      : contentBlocks;
  }
  if (!Array.isArray(contentBlocks)) return null;
  const texts: string[] = [];
  for (const block of contentBlocks) {
    if (block.type === "text") {
      texts.push(block.text);
    }
  }
  if (texts.length === 0) return null;
  const joined = texts.join("\n");
  return joined.length > CONTENT_TEXT_MAX_LENGTH
    ? joined.slice(0, CONTENT_TEXT_MAX_LENGTH)
    : joined;
}

/** Types in audit.jsonl that should be skipped entirely. */
const SKIPPED_TYPES = new Set([
  "system:init",
  "system:permission_request",
  "system:permission_response",
  "system:compact_boundary",
  "system:status",
  "tool_use_summary",
]);

/** Parsed result:success data cached per session for batch building. */
interface ResultSuccessData {
  totalCostUsd?: number;
  durationMs?: number;
  modelUsage?: Record<string, unknown>;
}

/**
 * Adapter for Claude Desktop app audit.jsonl files.
 * Reads from ~/Library/Application Support/Claude/local-agent-mode-sessions/
 */
export class ClaudeDesktopAdapter implements ISourceAdapter {
  readonly name = "Claude Desktop";
  readonly sourceType = "claude-desktop" as const;

  private desktopDataDir: string;

  constructor(desktopDataDir: string) {
    this.desktopDataDir = expandHome(desktopDataDir);
  }

  async discoverFiles(options?: { since?: string }): Promise<DiscoveredFile[]> {
    const sessionsDir = path.join(this.desktopDataDir, "local-agent-mode-sessions");
    const sinceDate = options?.since ? new Date(options.since) : null;
    const results: DiscoveredFile[] = [];

    // Recursively find all audit.jsonl files under the sessions directory.
    // The Desktop directory structure can be nested arbitrarily:
    //   local-agent-mode-sessions/<orgId>/<projectId>/<sessionId>/audit.jsonl
    await this.walkForAuditFiles(sessionsDir, sinceDate, results);

    // Sort by modification time descending (newest first)
    results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    return results;
  }

  /**
   * Recursively walk directories looking for audit.jsonl files.
   * When found, the parent directory is treated as the session directory.
   */
  private async walkForAuditFiles(
    dir: string,
    sinceDate: Date | null,
    results: DiscoveredFile[],
  ): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if this directory contains an audit.jsonl
    const hasAudit = entries.some((e) => !e.isDirectory() && e.name === "audit.jsonl");

    if (hasAudit) {
      const auditPath = path.join(dir, "audit.jsonl");
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(auditPath);
      } catch {
        return;
      }

      if (sinceDate && stat.mtime < sinceDate) {
        return;
      }

      const sessionDirName = path.basename(dir);
      const metadata = await this.loadSessionMetadata(dir, sessionDirName);

      results.push({
        absolutePath: auditPath,
        projectPath: (metadata?.cwd as string) ?? sessionDirName,
        sessionId: sessionDirName,
        isSidechain: false,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime,
        sourceType: this.sourceType,
        metadata: metadata ?? undefined,
      });
      return; // Don't recurse further into a session directory
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.walkForAuditFiles(path.join(dir, entry.name), sinceDate, results);
      }
    }
  }

  async parseFile(
    file: DiscoveredFile,
    fromByteOffset: number = 0,
  ): Promise<AdapterParseResult> {
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");

    const userMessages: ParsedUserMessage[] = [];
    const assistantMessages: ParsedAssistantMessage[] = [];
    let parseErrors = 0;
    let bytesRead = 0;
    let linesProcessed = 0;

    const stream = createReadStream(file.absolutePath, {
      start: fromByteOffset,
      encoding: "utf-8",
      highWaterMark: 64 * 1024,
    });

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    // Cache result:success data per session for later use in buildInsertionBatch
    const resultData: ResultSuccessData = {};

    for await (const line of rl) {
      linesProcessed++;
      bytesRead += Buffer.byteLength(line, "utf-8") + 1;

      if (!line || line.trim() === "") continue;

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parseErrors++;
        continue;
      }

      const type = raw.type as string | undefined;
      if (!type) {
        parseErrors++;
        continue;
      }

      // Skip known non-analytical types
      if (SKIPPED_TYPES.has(type) || type.startsWith("system:permission_")) {
        continue;
      }

      const sessionId = (raw.session_id as string) ?? file.sessionId;
      const timestamp = (raw._audit_timestamp as string) ?? (raw.timestamp as string) ?? new Date().toISOString();
      const uuid = raw.uuid as string | undefined;

      if (type === "user") {
        const message = raw.message as Record<string, unknown> | undefined;
        userMessages.push({
          sessionId,
          timestamp,
          uuid,
          parentUuid: raw.parentUuid as string | undefined,
          content: (message?.content as unknown[]) ?? [],
        });
      } else if (type === "assistant") {
        const message = raw.message as Record<string, unknown> | undefined;
        const msgUsage = message?.usage as Record<string, number> | undefined;
        const topUsage = raw.usage as Record<string, number> | undefined;
        const u = msgUsage ?? topUsage;

        const usage: NormalizedTokenUsage = {
          input_tokens: u?.input_tokens ?? 0,
          output_tokens: u?.output_tokens ?? 0,
          cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
        };

        const model = (raw.model as string) ?? (message?.model as string) ?? undefined;

        assistantMessages.push({
          sessionId,
          timestamp,
          uuid,
          parentUuid: raw.parentUuid as string | undefined,
          requestId: (message?.id as string) ?? (raw.requestId as string) ?? undefined,
          model,
          content: (message?.content as unknown[]) ?? [],
          stopReason: (message?.stop_reason as string) ?? undefined,
          usage,
          costUSD: raw.costUSD as number | undefined,
          metadata: {
            cwd: (file.metadata?.cwd as string) ?? undefined,
            version: (raw.version as string) ?? undefined,
            gitBranch: (raw.gitBranch as string) ?? undefined,
          },
        });
      } else if (type === "result:success") {
        // Cache authoritative server-side cost data
        if (typeof raw.total_cost_usd === "number") {
          resultData.totalCostUsd = raw.total_cost_usd;
        }
        if (typeof raw.duration_ms === "number") {
          resultData.durationMs = raw.duration_ms;
        }
        if (raw.modelUsage) {
          resultData.modelUsage = raw.modelUsage as Record<string, unknown>;
        }
      }
      // All other types (progress, etc.) are silently skipped
    }

    // Stash result:success data on the file metadata for buildInsertionBatch
    if (file.metadata) {
      file.metadata._resultSuccess = resultData;
    }

    return {
      userMessages,
      assistantMessages,
      parseErrors,
      bytesRead,
      linesProcessed,
    };
  }

  deduplicate(
    messages: ParsedAssistantMessage[],
  ): AdapterDeduplicationResult {
    // Desktop doesn't produce streaming duplicates — no-op dedup
    return {
      unique: messages,
      duplicatesRemoved: 0,
    };
  }

  buildInsertionBatch(
    file: DiscoveredFile,
    assistantMessages: ParsedAssistantMessage[],
    userMessages: ParsedUserMessage[],
  ): InsertionBatch {
    const turns: ConversationTurnRow[] = [];
    const toolCalls: ToolCallRow[] = [];

    // Build user turn rows
    for (let idx = 0; idx < userMessages.length; idx++) {
      const msg = userMessages[idx];
      const turnId = msg.uuid ?? `${msg.sessionId}-user-${idx}`;
      const userContentBlocks = msg.content as ContentBlock[];

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
        content_text: extractContentText(userContentBlocks),
      });
    }

    // Build a map of tool_use_id → result from user messages' tool_result blocks
    const toolResultMap = new Map<string, { isError: boolean; content: string | null }>();
    for (const msg of userMessages) {
      const blocks = msg.content as ContentBlock[];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const content = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: { text?: string }) => c.text ?? "").join("\n")
              : null;
          toolResultMap.set(block.tool_use_id, {
            isError: block.is_error === true,
            content,
          });
        }
      }
    }

    // Build assistant turn rows and tool call rows
    for (let idx = 0; idx < assistantMessages.length; idx++) {
      const msg = assistantMessages[idx];
      const turnId = msg.uuid ?? `${msg.sessionId}-assistant-${idx}`;
      const contentBlocks = msg.content as ContentBlock[];

      const hasToolUse = contentBlocks.some((b) => b.type === "tool_use");
      const hasThinking = contentBlocks.some((b) => b.type === "thinking");

      const usage = msg.usage;
      const model = msg.model ?? null;
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
        stop_reason: msg.stopReason ?? null,
        request_id: msg.requestId ?? null,
        parent_uuid: msg.parentUuid ?? null,
        has_tool_use: hasToolUse,
        has_thinking: hasThinking,
        content_text: extractContentText(contentBlocks),
      });

      for (const block of contentBlocks) {
        if (block.type === "tool_use") {
          const toolName = block.name;
          let toolType = "builtin";
          let mcpServer: string | null = null;

          if (toolName.startsWith("mcp__")) {
            toolType = "mcp";
            const parts = toolName.split("__");
            if (parts.length >= 3) {
              mcpServer = parts[1];
            }
          }

          // Look up tool_result in subsequent user messages to determine success
          const result = toolResultMap.get(block.id);
          const success = result != null ? !result.isError : null;
          const errorMessage = result?.isError ? result.content : null;

          toolCalls.push({
            tool_call_id: block.id,
            session_id: msg.sessionId,
            turn_id: turnId,
            tool_name: toolName,
            tool_type: toolType,
            mcp_server: mcpServer,
            duration_ms: null,
            success,
            error_message: errorMessage,
            parameters: block.input ?? null,
          });
        }
      }
    }

    // Build session rows
    const sessions: SessionRow[] = [];
    const sessionMap = new Map<string, ParsedAssistantMessage[]>();

    for (const msg of assistantMessages) {
      const existing = sessionMap.get(msg.sessionId);
      if (existing) {
        existing.push(msg);
      } else {
        sessionMap.set(msg.sessionId, [msg]);
      }
    }

    for (const msg of userMessages) {
      if (!sessionMap.has(msg.sessionId)) {
        sessionMap.set(msg.sessionId, []);
      }
    }

    // Get cached result:success data if available
    const resultSuccess = (file.metadata?._resultSuccess ?? {}) as ResultSuccessData;

    for (const [sessionId, msgs] of sessionMap) {
      const allTimestamps: Date[] = [];
      for (const m of msgs) {
        allTimestamps.push(new Date(m.timestamp));
      }
      for (const u of userMessages) {
        if (u.sessionId === sessionId) {
          allTimestamps.push(new Date(u.timestamp));
        }
      }

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

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let totalCost = 0;
      let numToolCalls = 0;

      for (const m of msgs) {
        const u = m.usage;
        const mdl = m.model ?? null;
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

        const content = m.content as ContentBlock[];
        for (const block of content) {
          if (block.type === "tool_use") {
            numToolCalls++;
          }
        }
      }

      // Use authoritative server-side cost when available from result:success
      if (resultSuccess.totalCostUsd != null) {
        totalCost = resultSuccess.totalCostUsd;
      }

      const first = msgs.length > 0 ? msgs[0] : null;
      const sessionUserTurns = userMessages.filter(
        (u) => u.sessionId === sessionId,
      ).length;
      const numTurns = msgs.length + sessionUserTurns;

      sessions.push({
        session_id: sessionId,
        start_time: startTime,
        end_time: endTime,
        duration_seconds: durationSeconds,
        model: first?.model ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_read_tokens: cacheReadTokens,
        total_cost_usd: totalCost,
        num_turns: numTurns,
        num_tool_calls: numToolCalls,
        cwd: first?.metadata.cwd ?? null,
        source_file: file.absolutePath,
        git_branch: first?.metadata.gitBranch ?? null,
        claude_version: first?.metadata.version ?? null,
        project_path: (file.metadata?.cwd as string) ?? file.projectPath,
        source_type: this.sourceType,
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
   * Try to load companion session metadata JSON.
   * Looks for <session-id>.json in the session directory.
   */
  private async loadSessionMetadata(
    sessionDir: string,
    sessionId: string,
  ): Promise<Record<string, unknown> | null> {
    const metadataPath = path.join(sessionDir, `${sessionId}.json`);
    try {
      const raw = await fs.readFile(metadataPath, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
