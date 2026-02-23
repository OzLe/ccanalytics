/**
 * @module ingestion/deduplicator
 *
 * Request-ID based deduplication for assistant messages.
 * Claude Code's streaming mode produces multiple JSONL entries with the same
 * requestId. The last entry (by file position) is authoritative.
 *
 * Rule: Last entry per requestId wins.
 */

import type { AssistantMessage } from "../types/index.js";

/** Result of a deduplication pass. */
export interface DeduplicationResult {
  /** Deduplicated assistant messages (last entry per requestId wins). */
  unique: AssistantMessage[];
  /** Number of duplicate entries removed. */
  duplicatesRemoved: number;
}

/**
 * Deduplicates assistant messages by requestId.
 * Later entries overwrite earlier ones for the same requestId (last wins).
 * Entries without a requestId are always kept.
 */
export class Deduplicator {
  /**
   * Deduplicate assistant messages by requestId.
   * Last entry wins — the final entry for a given requestId is authoritative
   * because it contains the complete token counts and final cost.
   *
   * @param messages - Array of assistant messages, in file order
   * @returns Deduplicated messages and count of duplicates removed
   */
  deduplicate(messages: AssistantMessage[]): DeduplicationResult {
    const lastByRequestId = new Map<string, AssistantMessage>();
    const noRequestId: AssistantMessage[] = [];

    for (const message of messages) {
      if (message.requestId) {
        // Later entries overwrite earlier ones (last wins)
        lastByRequestId.set(message.requestId, message);
      } else {
        // Entries without requestId are always kept
        noRequestId.push(message);
      }
    }

    const unique = [...lastByRequestId.values(), ...noRequestId];
    const duplicatesRemoved = messages.length - unique.length;

    return { unique, duplicatesRemoved };
  }
}
