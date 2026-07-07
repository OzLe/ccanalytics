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
  ParsedLoadedSkillRecord,
  NormalizedTokenUsage,
} from "./types.js";
import type {
  SessionRow,
  ConversationTurnRow,
  ToolCallRow,
  SessionSkillRow,
  SubAgentRow,
  SubAgentToolCallRow,
  WorkflowRunRow,
  ContentBlock,
  ToolUseBlock,
  SkillListingAttachment,
} from "../../types/index.js";
import type { InsertionBatch } from "../batch-inserter.js";
import type { DiscoveredFile } from "../file-discovery.js";
import { FileDiscovery } from "../file-discovery.js";
import { JSONLParser } from "../jsonl-parser.js";
import { Deduplicator } from "../deduplicator.js";
import { calculateCost } from "../../utils/pricing.js";
import { deriveErrorRows } from "./error-derivation.js";
import { buildSessionSkillRows } from "./skill-rows.js";
import { parseSkillListing } from "../skill-listing-parser.js";

/**
 * Adapter for Claude Code CLI JSONL session files.
 * Reads from ~/.claude/projects/<encoded-path>/<session-id>.jsonl
 *
 * Tested with Claude Code 2.1.76.
 */
export class ClaudeCodeAdapter implements ISourceAdapter {
  readonly name = "Claude Code CLI";
  readonly sourceType = "claude-code" as const;
  readonly testedUpstreamVersion = "2.1.76";

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
    // F-SA: workflow-manifest files are a single JSON object, not JSONL — the
    // parsed manifest already rides on file.metadata (read at discovery). Skip
    // the line parser and advance the byte offset to EOF so it is only
    // reprocessed when the manifest's size changes (running -> completed).
    if (file.kind === "workflow-manifest") {
      return {
        userMessages: [],
        assistantMessages: [],
        parseErrors: 0,
        bytesRead: file.sizeBytes - fromByteOffset,
        linesProcessed: 0,
        loadedSkills: [],
      };
    }

    // F-SA: sub-agent transcripts store an AGGREGATE row, so a grown file must
    // be re-aggregated from the TOP (not just its delta) or the stored totals
    // would be overwritten with only the newest turns. Parse the whole file and
    // advance the offset to EOF.
    const parseFromTop = file.kind === "subagent";
    const result = await this.parser.parseFile(
      file.absolutePath,
      parseFromTop ? 0 : fromByteOffset,
    );

    const userMessages: ParsedUserMessage[] = [];
    const assistantMessages: ParsedAssistantMessage[] = [];
    const loadedSkills: ParsedLoadedSkillRecord[] = [];

    for (const entry of result.entries) {
      if (entry.type === "user") {
        const msg = entry.data;
        userMessages.push({
          sessionId: msg.sessionId,
          timestamp: msg.timestamp,
          uuid: msg.uuid,
          parentUuid: msg.parentUuid,
          // User content may be a plain string or a content-block array;
          // downstream extractContentText() handles both, so preserve the raw
          // value and cast to satisfy the unknown[] field type.
          content: (msg.message?.content ?? []) as unknown as unknown[],
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
          model: msg.model ?? msg.message?.model ?? undefined,
          content: msg.message?.content ?? [],
          stopReason: msg.message?.stop_reason,
          usage,
          metadata: {
            cwd: msg.cwd,
            version: msg.version,
            gitBranch: msg.gitBranch,
          },
        });
      } else if (entry.type === "attachment") {
        // P-05: only `skill_listing` attachments carry loaded-skill data;
        // every other (permissive D13) attachment.type is ignored here.
        const rec = parseSkillListingRecord(entry.data);
        if (rec) {
          loadedSkills.push(rec);
        }
      }
    }

    return {
      userMessages,
      assistantMessages,
      parseErrors: result.parseErrors,
      // For a re-aggregated sub-agent file, land the offset exactly at EOF.
      bytesRead: parseFromTop ? file.sizeBytes - fromByteOffset : result.bytesRead,
      linesProcessed: result.linesProcessed,
      loadedSkills,
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
    loadedSkills?: ParsedLoadedSkillRecord[],
  ): InsertionBatch {
    // F-SA: sub-agent transcripts and workflow manifests do NOT flow into
    // sessions / conversation_turns / tool_calls — that would clobber the
    // parent session's ON CONFLICT upsert and inflate the cost SSOT. They
    // populate the dedicated migration-6 tables instead.
    if (file.kind === "workflow-manifest") {
      return emptyBatch({ workflowRuns: buildWorkflowRunRows(file) });
    }
    if (file.kind === "subagent") {
      return buildSubAgentBatch(file, assistantMessages, userMessages);
    }

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

          // P-05: capture invoked-skill name + caller type for `Skill` tool
          // calls only — NULL for every other tool. `caller` is a sibling of
          // `input` on the tool_use block (typed via ToolUseBlock.caller).
          const skillBlock = block as ToolUseBlock;
          const isSkill = toolName === "Skill";
          const skillName = isSkill
            ? ((skillBlock.input?.skill as string) ?? null)
            : null;
          const skillCallerType = isSkill
            ? (skillBlock.caller?.type ?? null)
            : null;

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
            skill_name: skillName,
            skill_caller_type: skillCallerType,
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
        project_name: file.projectPath.split("/").pop() ?? file.projectPath,
        source_type: this.sourceType,
      });
    }

    // KPI-003: derive errors table rows from already-parsed signals
    // (tool_result is_error blocks + problematic assistant stop_reason values).
    // Previously hardcoded `errors: []`, leaving the errors table empty.
    const errors = deriveErrorRows(assistantMessages, userMessages);

    // P-05: flatten any skill_listing attachments into session_skills rows.
    const sessionSkills: SessionSkillRow[] = buildSessionSkillRows(loadedSkills);

    return {
      sessions,
      conversationTurns: turns,
      toolCalls,
      errors,
      sessionSkills,
    };
  }
}

/**
 * P-05: turn a parsed `attachment` JSONL record into a
 * {@link ParsedLoadedSkillRecord} when it carries a `skill_listing` payload.
 *
 * Returns `null` for any other attachment subtype (D13 — permissive). On a
 * `parsed.length !== attachment.skillCount` mismatch it logs a warning and
 * still returns the record (trusting `attachment.skillCount` for the stored
 * count) rather than failing the batch (R: skillCount-vs-parsed drift).
 */
function parseSkillListingRecord(
  record: import("../../types/index.js").AttachmentRecord,
): ParsedLoadedSkillRecord | null {
  const att = record.attachment;
  if (!att || att.type !== "skill_listing") {
    return null;
  }
  const listing = att as SkillListingAttachment;
  const skills = parseSkillListing(listing.content ?? "");

  if (
    typeof listing.skillCount === "number" &&
    skills.length !== listing.skillCount
  ) {
    console.warn(
      `[claude-code] skill_listing skillCount mismatch in session ` +
        `${record.sessionId}: parsed ${skills.length}, attachment.skillCount ` +
        `${listing.skillCount} — storing parsed rows, trusting skillCount ` +
        `for the count.`,
    );
  }

  return {
    sessionId: record.sessionId,
    recordUuid: record.uuid ?? null,
    timestamp: record.timestamp,
    skillCount: listing.skillCount,
    isInitial: listing.isInitial,
    skills,
  };
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

// ---------------------------------------------------------------------------
// F-SA: sub-agent + workflow-manifest batch builders
// ---------------------------------------------------------------------------

/** A full InsertionBatch with all-empty arrays, merged with the given rows. */
function emptyBatch(overrides: Partial<InsertionBatch>): InsertionBatch {
  return {
    sessions: [],
    conversationTurns: [],
    toolCalls: [],
    errors: [],
    sessionSkills: [],
    subAgents: [],
    subAgentToolCalls: [],
    workflowRuns: [],
    ...overrides,
  };
}

/**
 * F-SA: build the aggregate `sub_agents` row (+ its `sub_agent_tool_calls`, +
 * a `workflow_runs` stub for workflow agents) from a sub-agent transcript.
 *
 * Cost is summed per-turn via the SAME `calculateCost()` SSOT as the main path;
 * it is exact even for a mixed-model agent because it sums before aggregation.
 * Parent attribution keys on the record's OWN `sessionId` (reliable), never the
 * containing dir name.
 */
function buildSubAgentBatch(
  file: DiscoveredFile,
  assistantMessages: ParsedAssistantMessage[],
  userMessages: ParsedUserMessage[],
): InsertionBatch {
  const parentSessionId =
    assistantMessages[0]?.sessionId ??
    userMessages[0]?.sessionId ??
    file.parentSessionId ??
    file.sessionId;
  const agentId = file.agentId ?? file.sessionId;
  const workflowRunId = file.workflowRunId ?? null;
  const agentClass = workflowRunId ? "workflow" : "regular";
  const meta = (file.metadata ?? {}) as Record<string, unknown>;

  // tool_use_id -> result, from this transcript's own tool_result blocks.
  const toolResultMap = new Map<
    string,
    { isError: boolean; content: string | null }
  >();
  for (const msg of userMessages) {
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "tool_result") {
        const content =
          typeof block.content === "string"
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

  const subAgentToolCalls: SubAgentToolCallRow[] = [];
  const modelCounts = new Map<string, number>();
  const timestamps: Date[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let costUsd = 0;
  let gitBranch: string | null = null;
  let lastStopReason: string | null = null;

  for (const u of userMessages) timestamps.push(new Date(u.timestamp));

  for (const msg of assistantMessages) {
    const usage = msg.usage;
    const model = msg.model ?? null;
    inputTokens += usage.input_tokens;
    outputTokens += usage.output_tokens;
    cacheCreation += usage.cache_creation_input_tokens;
    cacheRead += usage.cache_read_input_tokens;
    costUsd += calculateCost(
      model,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
    );
    timestamps.push(new Date(msg.timestamp));
    if (model) modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    if (!gitBranch && msg.metadata.gitBranch) gitBranch = msg.metadata.gitBranch;
    if (msg.stopReason) lastStopReason = msg.stopReason;

    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== "tool_use") continue;
      const toolName = block.name;
      let toolType = "builtin";
      let mcpServer: string | null = null;
      if (toolName.startsWith("mcp__")) {
        toolType = "mcp";
        const parts = toolName.split("__");
        if (parts.length >= 3) mcpServer = parts[1];
      }
      const result = toolResultMap.get(block.id);
      const skillBlock = block as ToolUseBlock;
      const isSkill = toolName === "Skill";
      subAgentToolCalls.push({
        tool_call_id: block.id,
        parent_session_id: parentSessionId,
        agent_id: agentId,
        tool_name: toolName,
        tool_type: toolType,
        mcp_server: mcpServer,
        success: result != null ? !result.isError : null,
        error_message: result?.isError ? result.content : null,
        parameters: block.input ?? null,
        skill_name: isSkill ? ((skillBlock.input?.skill as string) ?? null) : null,
        skill_caller_type: isSkill ? (skillBlock.caller?.type ?? null) : null,
      });
    }
  }

  timestamps.sort((a, b) => a.getTime() - b.getTime());
  const startTime = timestamps.length > 0 ? timestamps[0] : null;
  const endTime = timestamps.length > 1 ? timestamps[timestamps.length - 1] : null;
  const durationSeconds =
    startTime && endTime ? (endTime.getTime() - startTime.getTime()) / 1000 : null;

  // Dominant model by turn count.
  let model: string | null = null;
  let bestCount = -1;
  for (const [m, n] of modelCounts) {
    if (n > bestCount) {
      bestCount = n;
      model = m;
    }
  }

  const success =
    lastStopReason == null
      ? null
      : lastStopReason === "end_turn"
        ? true
        : lastStopReason === "max_tokens"
          ? false
          : null;

  const subAgent: SubAgentRow = {
    parent_session_id: parentSessionId,
    agent_id: agentId,
    session_dir: file.parentSessionId ?? null,
    agent_class: agentClass,
    subagent_type:
      (meta.agentType as string) ??
      (agentClass === "workflow" ? "workflow-subagent" : null),
    workflow_run_id: workflowRunId,
    spawn_tool_use_id: (meta.toolUseId as string) ?? null,
    spawn_depth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : null,
    is_fork: typeof meta.isFork === "boolean" ? meta.isFork : null,
    workflow_label: null,
    workflow_phase: null,
    entrypoint: null,
    model,
    git_branch: gitBranch,
    start_time: startTime,
    end_time: endTime,
    duration_seconds: durationSeconds,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    cost_usd: costUsd,
    num_turns: assistantMessages.length + userMessages.length,
    num_tool_calls: subAgentToolCalls.length,
    success,
    project_path: file.projectPath,
    source_file: file.absolutePath,
  };

  const workflowRuns: WorkflowRunRow[] = workflowRunId
    ? [stubWorkflowRun(workflowRunId, parentSessionId)]
    : [];

  return emptyBatch({ subAgents: [subAgent], subAgentToolCalls, workflowRuns });
}

/** F-SA: build the `workflow_runs` row from a parsed `wf_*.json` manifest. */
function buildWorkflowRunRows(file: DiscoveredFile): WorkflowRunRow[] {
  const m = (file.metadata ?? {}) as Record<string, unknown>;
  const runId = (m.runId as string) ?? file.workflowRunId ?? null;
  if (!runId) return [];
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const startMs = typeof m.startTime === "number" ? m.startTime : null;
  const durMs = typeof m.durationMs === "number" ? m.durationMs : null;
  return [
    {
      run_id: runId,
      parent_session_id: file.parentSessionId ?? null,
      task_id: (m.taskId as string) ?? null,
      workflow_name: (m.workflowName as string) ?? null,
      summary: (m.summary as string) ?? null,
      status: (m.status as string) ?? null,
      default_model: (m.defaultModel as string) ?? null,
      num_phases: Array.isArray(m.phases) ? m.phases.length : null,
      manifest_agent_count: num(m.agentCount),
      manifest_total_tokens: num(m.totalTokens),
      manifest_total_tool_calls: num(m.totalToolCalls),
      start_time: startMs != null ? new Date(startMs) : null,
      end_time: startMs != null && durMs != null ? new Date(startMs + durMs) : null,
      duration_seconds: durMs != null ? durMs / 1000 : null,
      source_file: file.absolutePath,
    },
  ];
}

/**
 * F-SA: a minimal `workflow_runs` row for a run dir that has no manifest yet.
 * The inserter upserts with COALESCE so this never clobbers a real manifest.
 */
function stubWorkflowRun(
  runId: string,
  parentSessionId: string,
): WorkflowRunRow {
  return {
    run_id: runId,
    parent_session_id: parentSessionId,
    task_id: null,
    workflow_name: null,
    summary: null,
    status: null,
    default_model: null,
    num_phases: null,
    manifest_agent_count: null,
    manifest_total_tokens: null,
    manifest_total_tool_calls: null,
    start_time: null,
    end_time: null,
    duration_seconds: null,
    source_file: null,
  };
}
