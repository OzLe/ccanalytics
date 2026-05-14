/**
 * @module server/routes/settings
 *
 * Settings API endpoints — GET and PUT /api/settings.
 *
 * This is the FIRST write path in the dashboard server: every other route is
 * read-only against DuckDB. It owns a minimal read/merge/write of
 * ~/.ccanalytics/config.json and is deliberately conservative:
 *
 *   - It does NOT import the CLI loader (src/config/loader.ts) — that module
 *     only reads. This route reads, merges, and writes the JSON file directly.
 *   - It only ever writes the `subscription` key. A shallow
 *     `{ ...existing, subscription }` merge is sufficient and safest for v1, so
 *     dbPath / ingestion / watcher / database / etc. are never clobbered.
 *   - ENOENT on the config file is normal (the user may not have one yet) — GET
 *     returns the DEFAULT_CONFIG fallback, and PUT creates the file.
 *
 * Tier prices come from the shared single source of truth in
 * src/config/subscription.ts so the server never duplicates them.
 */

import { Router } from "express";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { envelope } from "../helpers/parseFilters.js";
import {
  DEFAULT_MONTHLY_USD,
  isSubscriptionTier,
} from "../../../../src/config/subscription.js";
import type {
  SubscriptionConfig,
  SubscriptionTier,
} from "../../../../src/types/config.js";

const router = Router();

/**
 * Canonical config file location. Matches loader.ts candidate #3 and the
 * CLAUDE.md-documented canonical path.
 */
const CONFIG_DIR = path.join(os.homedir(), ".ccanalytics");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

/**
 * Fallback subscription block when the config file is absent or has no
 * `subscription` key — the same default as DEFAULT_CONFIG in the CLI.
 */
const DEFAULT_SUBSCRIPTION: SubscriptionConfig = {
  tier: "max-20x",
  monthlyUSD: 200,
};

/**
 * Read and parse ~/.ccanalytics/config.json.
 *
 * Returns `{}` if the file is missing (ENOENT) or unparseable — a fresh install
 * is normal and must never 500. Re-throws any other fs error.
 */
async function readConfigFile(): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Unparseable config — treat as empty rather than failing the request.
    return {};
  }
}

/**
 * Resolve the `subscription` block out of a parsed config object, falling back
 * to DEFAULT_SUBSCRIPTION when absent or malformed.
 */
function resolveSubscription(
  config: Record<string, unknown>,
): SubscriptionConfig {
  const raw = config.subscription;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SUBSCRIPTION };
  }
  const candidate = raw as Partial<SubscriptionConfig>;
  const tier: SubscriptionTier = isSubscriptionTier(candidate.tier)
    ? candidate.tier
    : DEFAULT_SUBSCRIPTION.tier;
  const monthlyUSD =
    typeof candidate.monthlyUSD === "number" &&
    Number.isFinite(candidate.monthlyUSD)
      ? candidate.monthlyUSD
      : DEFAULT_MONTHLY_USD[tier];
  return { tier, monthlyUSD };
}

/**
 * GET /api/settings
 *
 * Returns the resolved `subscription` block from ~/.ccanalytics/config.json,
 * or the DEFAULT_CONFIG fallback (max-20x / $200) when the file is missing.
 * Always 200 on a fresh install; 500 only on an unexpected fs error.
 */
router.get("/", async (_req, res, next) => {
  try {
    const config = await readConfigFile();
    const subscription = resolveSubscription(config);
    res.json(envelope({ subscription }, "all"));
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/settings
 *
 * Body: { subscription: { tier: SubscriptionTier, monthlyUSD?: number } }
 *
 * Validates `tier` against the four known ids (400 on unknown). `monthlyUSD` is
 * derived from the canonical tier->price map when omitted or non-finite, so the
 * UI only needs to send `tier`. Then mkdir -p, read the existing config (or {}),
 * shallow-merge ONLY the `subscription` key, and write it back pretty-printed.
 */
router.put("/", async (req, res, next) => {
  try {
    const body = req.body as
      | { subscription?: { tier?: unknown; monthlyUSD?: unknown } }
      | undefined;
    const incoming = body?.subscription;

    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({
        error: "Bad request",
        message: "Body must include a `subscription` object.",
      });
    }
    if (!isSubscriptionTier(incoming.tier)) {
      return res.status(400).json({
        error: "Bad request",
        message:
          "`subscription.tier` must be one of: none, pro, max-5x, max-20x.",
      });
    }

    const tier: SubscriptionTier = incoming.tier;
    const monthlyUSD =
      typeof incoming.monthlyUSD === "number" &&
      Number.isFinite(incoming.monthlyUSD)
        ? incoming.monthlyUSD
        : DEFAULT_MONTHLY_USD[tier];

    const subscription: SubscriptionConfig = { tier, monthlyUSD };

    // (1) ensure ~/.ccanalytics/ exists, (2) read existing config (or {}),
    // (3) shallow-merge ONLY the subscription key, (4) write back.
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    const existing = await readConfigFile();
    const merged = { ...existing, subscription };
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify(merged, null, 2) + "\n",
      "utf-8",
    );

    res.json(envelope({ subscription }, "all"));
  } catch (err) {
    next(err);
  }
});

export default router;
