/**
 * @module config/loader
 *
 * Configuration loading with multi-source merging.
 * Precedence: CLI flags > environment variables > config file > defaults.
 *
 * Config file locations searched (in order):
 *   1. Explicit --config path
 *   2. .ccanalyticsrc.json in current directory
 *   3. ~/.ccanalytics/config.json
 *   4. ~/.config/ccanalytics/config.json
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { CCAnalyticsConfig } from "../types/index.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { DEFAULT_MONTHLY_USD, isSubscriptionTier } from "./subscription.js";

/** Sources of configuration overrides. */
export interface ConfigSources {
  /** Overrides from CLI flags (highest precedence). */
  cliOverrides?: Partial<CCAnalyticsConfig>;
  /** Explicit path to config file. Skips discovery if provided. */
  configPath?: string;
}

/**
 * Load configuration by merging all sources.
 * Precedence: CLI flags > env vars > config file > defaults.
 *
 * @param sources - Optional configuration sources
 * @returns Fully resolved configuration object
 */
export async function loadConfig(
  sources?: ConfigSources,
): Promise<CCAnalyticsConfig> {
  // 1. Start with defaults
  let config: CCAnalyticsConfig = structuredClone(
    DEFAULT_CONFIG,
  ) as CCAnalyticsConfig;

  // 2. Merge config file (if found)
  const fileConfig = await loadConfigFile(sources?.configPath);
  if (fileConfig) {
    config = mergeDeep(config as unknown as Record<string, unknown>, fileConfig as Record<string, unknown>) as unknown as CCAnalyticsConfig;
  }

  // 3. Merge environment variables
  const envConfig = loadEnvConfig();
  config = mergeDeep(config as unknown as Record<string, unknown>, envConfig as Record<string, unknown>) as unknown as CCAnalyticsConfig;

  // 4. Merge CLI overrides (highest precedence)
  if (sources?.cliOverrides) {
    config = mergeDeep(config as unknown as Record<string, unknown>, sources.cliOverrides as Record<string, unknown>) as unknown as CCAnalyticsConfig;
  }

  // 5. Light validation/normalization for fields a config file could corrupt.
  normalizeSubscription(config);

  return config;
}

/**
 * Clamp the merged `subscription` block to a sane shape.
 *
 * A hand-edited config.json could carry an unknown `tier` or a non-numeric
 * `monthlyUSD`. mergeDeep merges the nested object structurally but does not
 * validate its values, so this coerces:
 *   - an unknown/missing `tier` back to the default tier, and
 *   - a non-finite `monthlyUSD` to the canonical price for the (clamped) tier.
 */
function normalizeSubscription(config: CCAnalyticsConfig): void {
  const sub = config.subscription ?? { ...DEFAULT_CONFIG.subscription };

  if (!isSubscriptionTier(sub.tier)) {
    sub.tier = DEFAULT_CONFIG.subscription.tier;
  }
  if (typeof sub.monthlyUSD !== "number" || !Number.isFinite(sub.monthlyUSD)) {
    sub.monthlyUSD = DEFAULT_MONTHLY_USD[sub.tier];
  }

  config.subscription = sub;
}

/**
 * Load and parse a config file from the filesystem.
 * Searches standard locations if no explicit path is provided.
 *
 * @param explicitPath - Explicit config file path
 * @returns Parsed config object, or null if no config file found
 */
async function loadConfigFile(
  explicitPath?: string,
): Promise<Partial<CCAnalyticsConfig> | null> {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        path.join(process.cwd(), ".ccanalyticsrc.json"),
        path.join(os.homedir(), ".ccanalytics", "config.json"),
        path.join(os.homedir(), ".config", "ccanalytics", "config.json"),
      ];

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      return JSON.parse(content) as Partial<CCAnalyticsConfig>;
    } catch {
      // File not found or invalid JSON — try next candidate
      continue;
    }
  }

  return null;
}

/**
 * Load configuration from CCANALYTICS_* environment variables.
 *
 * @returns Partial config from environment variables
 */
function loadEnvConfig(): Partial<CCAnalyticsConfig> {
  const env: Partial<CCAnalyticsConfig> = {};

  if (process.env.CCANALYTICS_DB_PATH) {
    env.dbPath = process.env.CCANALYTICS_DB_PATH;
  }

  if (process.env.CCANALYTICS_CLAUDE_DIR) {
    env.claudeDir = process.env.CCANALYTICS_CLAUDE_DIR;
  }

  if (process.env.CCANALYTICS_FORMAT) {
    const format = process.env.CCANALYTICS_FORMAT;
    if (format === "table" || format === "json" || format === "csv") {
      env.format = format;
    }
  }

  if (
    process.env.CCANALYTICS_VERBOSE === "true" ||
    process.env.CCANALYTICS_LOG_LEVEL === "debug"
  ) {
    env.verbose = true;
  }

  return env;
}

/**
 * Deep merge two objects. Source values override target values.
 * Arrays are replaced, not concatenated.
 */
function mergeDeep(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = mergeDeep(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result;
}
