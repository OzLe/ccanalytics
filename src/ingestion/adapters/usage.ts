/**
 * @module ingestion/adapters/usage
 *
 * Token usage as the transcripts record it (`message.usage`), and its cost.
 * Shared by the Claude Code and Claude Desktop adapters.
 *
 * `usage.cache_creation` splits the cache writes into 5-minute and 1-hour
 * writes, which cost 1.25x and 2x input. Older transcripts lack it; see
 * {@link UnrecordedCacheTtl} for how those writes are priced.
 */

import { calculateCost, type UnrecordedCacheTtl } from "../../utils/pricing.js";
import type { NormalizedTokenUsage } from "./types.js";

/** `message.usage` as it appears in the transcripts. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Normalize a transcript's usage; the 1-hour share is null when unrecorded. */
export function normalizeUsage(u: RawUsage | undefined): NormalizedTokenUsage {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    cache_creation_1h_input_tokens: u?.cache_creation
      ? (u.cache_creation.ephemeral_1h_input_tokens ?? 0)
      : null,
  };
}

/** The 1-hour cache writes of `u`, or all/none of them when unrecorded. */
export function oneHourCacheWrites(
  u: NormalizedTokenUsage,
  unrecordedAs: UnrecordedCacheTtl,
): number {
  return (
    u.cache_creation_1h_input_tokens ??
    (unrecordedAs === "1h" ? u.cache_creation_input_tokens : 0)
  );
}

/** Cost of one assistant message's usage. */
export function usageCost(
  model: string | null | undefined,
  u: NormalizedTokenUsage,
  unrecordedAs: UnrecordedCacheTtl,
): number {
  return calculateCost(
    model,
    u.input_tokens,
    u.output_tokens,
    u.cache_creation_input_tokens,
    u.cache_read_input_tokens,
    oneHourCacheWrites(u, unrecordedAs),
  );
}
