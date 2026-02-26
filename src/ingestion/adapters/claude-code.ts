/**
 * @module ingestion/adapters/claude-code
 *
 * Source adapter for Claude Code CLI session files.
 * Wraps existing FileDiscovery, JSONLParser, and Deduplicator classes
 * and implements the ISourceAdapter interface.
 */

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
import { FileDiscovery } from "../file-discovery.js";
import { JSONLParser } from "../jsonl-parser.js";
import { Deduplicator } from "../deduplicator.js";
import { calculateCost } from "../../utils/pricing.js";

/**
 * Adapter for Claude Code CLI JSONL session files.
 * Reads from ~/.claude/projects/<encoded-path>/<session-id>.jsonl
 */
export class ClaudeCodeAdapter implements ISourceAdapter {
  readonly name = "Claude Code CLI";
  readonly sourceType = "claude-code" as const;

  private discovery: FileDiscovery;
  private parser: JSONLParser;
  private deduplicator: Deduplicator;

  constructor(claudeDir: string) {
    this.discovery = new FileDiscovery(claudeDir);
    this.parser = new JSONLParser();
    this.deduplicator = new Deduplicator();
  }

  async discoverFiles(options?: { since?: string }): Promise<DiscoveredFile[]> {
    const files = await this.discovery.discoverFiles({ since: options?.since });
    return files.map((f) => ({ ...f, sourceType: this.sourceType }));
  }

  async parseFile(
    file: DiscoveredFile,
    fromByteOffset: number = 0,
  ): Promise<AdapterParseResult> {
    const result = await this.parser.parseFile(file.absolutePath, fromByteOffset);

    const userMessages: ParsedUserMessage[] = [];
    const assistantMessages: ParsedAssistantMessage[] = [];

    for (const entry of result.entries) {
      if (entry.type === "user") {
        const msg = entry.data;
        userMessages.push({
          sessionId: msg.sessionId,
          timestamp: msg.timestamp,
          uuid: msg.uuid,
          parentUuid: msg.parentUuid,
          content: msg.message?.content ?? [],
        });
      } else if (entry.type === "assistant") {
        const msg = entry.data;
        const usage = getUsage(msg);
        assistantMessages.push({
          sessionId: msg.sessionId,
          timestamp: msg.timestamp,
          uuid: msg.uuid,
          parentUuid: msg.parentUuid,
          requestId: msg.requestId,
          model: msg.model ?? msg.message?.model ?? null ?? undefined,
          content: msg.message?.content ?? [],
          stopReason: msg.message?.stop_reason,
          usage,
          metadata: {
            cwd: msg.cwd,
            version: msg.version,
            gitBranch: msg.gitBranch,
          },
        });
      }
    }

    return {
      userMessages,
      assistantMessages,
      parseErrors: result.parseErrors,
      bytesRead: result.bytesRead,
      linesProcessed: result.linesProcessed,
    };
  }

  deduplicate(
    messages: ParsedAssistantMessage[],
  ): AdapterDeduplicationResult {
    // Reuse the same requestId last-wins strategy via the existing Deduplicator.
    // We need to convert to/from AssistantMessage shape for the Deduplicator,
    // but since it only looks at requestId, we can do a simpler in-place dedup.
    const lastByRequestId = new Map<string, ParsedAssistantMessage>();
    const noRequestId: ParsedAssistantMessage[] = [];

    for (const msg of messages) {
      if (msg.requestId) {
        lastByRequestId.set(msg.requestId, msg);
      } else {
        noRequestId.push(msg);
      }
    }

    const unique = [...lastByRequestId.values(), ...noRequestId];
    return {
      unique,
      duplicatesRemoved: messages.length - unique.length,
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

      // Extract tool calls from content blocks
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

    // Build session rows by aggregating across all messages for this file
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

    // Account for user messages in sessions that have no assistant messages
    for (const msg of userMessages) {
      if (!sessionMap.has(msg.sessionId)) {
        sessionMap.set(msg.sessionId, []);
      }
    }

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
        project_path: file.projectPath,
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
}

/** Maximum length of content_text stored per turn. */
const CONTENT_TEXT_MAX_LENGTH = 10000;

/**
 * Extract concatenated text from content blocks.
 * For both user and assistant messages, only TextBlock.text values are included.
 * ToolUseBlock, ToolResultBlock, and ThinkingBlock are skipped.
 * Returns null if no text content is found, otherwise truncates to CONTENT_TEXT_MAX_LENGTH.
 */
function extractContentText(contentBlocks: string | ContentBlock[]): string | null {
  // Handle plain string content (common for user messages in Claude Code JSONL)
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

/**
 * Extract normalized token usage from an AssistantMessage.
 * Checks message.usage first, falls back to top-level usage.
 */
function getUsage(msg: {
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
}): NormalizedTokenUsage {
  const u = msg.message?.usage ?? msg.usage;
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
  };
}
