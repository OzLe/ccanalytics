/**
 * @module ingestion/adapters/error-derivation
 *
 * KPI-003: derive `errors` table rows from signals the source adapters ALREADY
 * parse — no schema change, no extra parsing pass, no JSONL re-read.
 *
 * Two error signals are available from already-parsed data:
 *
 *   1. tool_result blocks carrying `is_error: true` — a tool invocation that
 *      failed. One error row per failed tool call.
 *   2. assistant `stop_reason` values that indicate a problem rather than a
 *      normal completion (e.g. `max_tokens` truncation, `refusal`). One error
 *      row per affected assistant turn.
 *
 * This is a real-but-not-exhaustive error signal: it does NOT cover API-level
 * error log entries (HTTP 429s, 5xx, overloaded_error, etc.), which require
 * deeper adapter work and are a deferred follow-up. Before this, the `errors`
 * table was structurally never populated — both adapters hardcoded `errors: []`
 * — so the SessionDetail ErrorPanel and every error KPI were permanently empty.
 *
 * Idempotency: `error_id` values are deterministic and stable, and
 * BatchInserter.insertErrors uses `ON CONFLICT(error_id) DO NOTHING`, so
 * re-ingesting the same file never produces duplicate error rows. This affects
 * FUTURE ingestion only; it does not retro-populate already-ingested rows.
 */

import type { ErrorRow, ContentBlock } from "../../types/index.js";
import type { ParsedAssistantMessage, ParsedUserMessage } from "./types.js";

/**
 * assistant `stop_reason` values that represent a problem worth surfacing as
 * an error row. Normal terminal reasons (`end_turn`, `tool_use`, `stop_sequence`)
 * are intentionally excluded. `max_tokens` is treated as retryable (the user
 * can continue / raise the limit); `refusal` is not.
 */
const PROBLEM_STOP_REASONS: Record<string, { errorType: string; isRetryable: boolean }> = {
  max_tokens: { errorType: "max_tokens_truncation", isRetryable: true },
  refusal: { errorType: "refusal", isRetryable: false },
  model_context_window_exceeded: {
    errorType: "context_window_exceeded",
    isRetryable: false,
  },
};

/** Cap stored error messages so a huge tool_result payload can't bloat the row. */
const ERROR_MESSAGE_MAX_LENGTH = 2000;

/** Flatten a tool_result block's content into a single (possibly truncated) string. */
function stringifyToolResultContent(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string | null {
  let text: string | null = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((c) => c.text ?? "").join("\n");
  }
  if (text == null || text.length === 0) return null;
  return text.length > ERROR_MESSAGE_MAX_LENGTH
    ? text.slice(0, ERROR_MESSAGE_MAX_LENGTH)
    : text;
}

/**
 * Derive `errors` rows for one file's parsed messages.
 *
 * @param assistantMessages - parsed assistant messages for the file
 * @param userMessages - parsed user messages for the file (carry tool_result blocks)
 * @returns ErrorRow[] ready for BatchInserter (deduped on stable error_id)
 */
export function deriveErrorRows(
  assistantMessages: ParsedAssistantMessage[],
  userMessages: ParsedUserMessage[],
): ErrorRow[] {
  const errors: ErrorRow[] = [];
  // Stable error_ids guard against duplicates within a single batch too.
  const seen = new Set<string>();

  // --- Signal 1: failed tool_result blocks --------------------------------
  // tool_result blocks live in user messages; tie each failure back to the
  // assistant turn that issued the matching tool_use (so the error timestamp
  // and session line up with the tool call). Fall back to the user message's
  // own timestamp/session if the tool_use can't be located.
  const toolUseTurn = new Map<
    string,
    { sessionId: string; timestamp: string }
  >();
  for (const msg of assistantMessages) {
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "tool_use") {
        toolUseTurn.set(block.id, {
          sessionId: msg.sessionId,
          timestamp: msg.timestamp,
        });
      }
    }
  }

  for (const msg of userMessages) {
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "tool_result" && block.is_error === true) {
        const origin = toolUseTurn.get(block.tool_use_id);
        const sessionId = origin?.sessionId ?? msg.sessionId;
        const timestamp = origin?.timestamp ?? msg.timestamp;
        const errorId = `${block.tool_use_id}-toolerr`;
        if (seen.has(errorId)) continue;
        seen.add(errorId);
        errors.push({
          error_id: errorId,
          session_id: sessionId,
          timestamp: new Date(timestamp),
          error_type: "tool_error",
          message:
            stringifyToolResultContent(block.content) ?? "Tool call returned an error.",
          // Tool errors are commonly transient (a failed Bash command, a flaky
          // network call); mark them retryable so retry-rate metrics are usable.
          is_retryable: true,
          retry_count: 0,
        });
      }
    }
  }

  // --- Signal 2: problematic assistant stop_reason values -----------------
  for (let idx = 0; idx < assistantMessages.length; idx++) {
    const msg = assistantMessages[idx];
    const reason = msg.stopReason;
    if (!reason) continue;
    const mapped = PROBLEM_STOP_REASONS[reason];
    if (!mapped) continue;
    const turnId = msg.uuid ?? `${msg.sessionId}-assistant-${idx}`;
    const errorId = `${turnId}-stop`;
    if (seen.has(errorId)) continue;
    seen.add(errorId);
    errors.push({
      error_id: errorId,
      session_id: msg.sessionId,
      timestamp: new Date(msg.timestamp),
      error_type: mapped.errorType,
      message: `Assistant turn ended with stop_reason="${reason}".`,
      is_retryable: mapped.isRetryable,
      retry_count: 0,
    });
  }

  return errors;
}
