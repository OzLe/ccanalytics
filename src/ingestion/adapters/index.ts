/**
 * @module ingestion/adapters
 *
 * Adapter registry and factory for multi-source ingestion.
 * Exports all adapter types and provides a factory to create
 * adapters based on configuration.
 */

export type {
  SourceType,
  ISourceAdapter,
  AdapterParseResult,
  AdapterDeduplicationResult,
  AdapterDiscoveryResult,
  ParsedUserMessage,
  ParsedAssistantMessage,
  NormalizedTokenUsage,
} from "./types.js";

export { ClaudeCodeAdapter } from "./claude-code.js";
export { ClaudeDesktopAdapter } from "./claude-desktop.js";

import type { SourceType, ISourceAdapter } from "./types.js";
import type { CCAnalyticsConfig } from "../../types/index.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { ClaudeDesktopAdapter } from "./claude-desktop.js";

/**
 * Create adapter instances based on configuration and optional source filter.
 *
 * @param config - Application config (provides claudeDir, desktopDataDir)
 * @param sourceFilter - Restrict to specific source types. Default: config.sources or all.
 * @returns Array of configured adapter instances
 */
export function createAdapters(
  config: CCAnalyticsConfig,
  sourceFilter?: SourceType | SourceType[],
): ISourceAdapter[] {
  const requested: SourceType[] = sourceFilter
    ? (Array.isArray(sourceFilter) ? sourceFilter : [sourceFilter])
    : (config.sources ?? ["claude-code", "claude-desktop"]);

  const adapters: ISourceAdapter[] = [];

  for (const source of requested) {
    switch (source) {
      case "claude-code":
        adapters.push(new ClaudeCodeAdapter(config.claudeDir));
        break;
      case "claude-desktop":
        adapters.push(new ClaudeDesktopAdapter(config.desktopDataDir ?? "~/Library/Application Support/Claude"));
        break;
    }
  }

  return adapters;
}
