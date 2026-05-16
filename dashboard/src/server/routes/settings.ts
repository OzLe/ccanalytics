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
 *   - It writes only known top-level keys (`subscription`, `display`). A
 *     shallow merge `{ ...existing, subscription, display }` is sufficient and
 *     safest, so dbPath / ingestion / watcher / database / etc. are never
 *     clobbered.
 *   - ENOENT on the config file is normal (the user may not have one yet) — GET
 *     returns the DEFAULT_CONFIG fallback, and PUT creates the file.
 *
 * Tier prices come from the shared single source of truth in
 * src/config/subscription.ts so the server never duplicates them. Timezone
 * validation lives in src/utils/timezone.ts (ACT-001 / SEM2-293) so the CLI
 * and the dashboard route both go through the same IANA gate.
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
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
} from "../../../../src/utils/timezone.js";
import type {
  DisplayConfig,
  SubscriptionConfig,
  SubscriptionTier,
} from "../../../../src/types/config.js";

const router = Router();

/**
 * Canonical config file location. Matches loader.ts candidate #3 and the
 * CLAUDE.md-documented canonical path. Tests override via
 * `CCANALYTICS_CONFIG_PATH=/tmp/x.json` so they never clobber the live user
 * config (the LaunchAgent reads it too). Resolved per-call rather than at
 * module-load so the env var can be set/unset after import.
 */
function resolveConfigPath(): { dir: string; file: string } {
  const override = process.env.CCANALYTICS_CONFIG_PATH;
  if (override && override.length > 0) {
    return { dir: path.dirname(override), file: override };
  }
  const dir = path.join(os.homedir(), ".ccanalytics");
  return { dir, file: path.join(dir, "config.json") };
}

/**
 * Fallback subscription block when the config file is absent or has no
 * `subscription` key — the same default as DEFAULT_CONFIG in the CLI.
 */
const DEFAULT_SUBSCRIPTION: SubscriptionConfig = {
  tier: "max-20x",
  monthlyUSD: 200,
};

/**
 * Fallback display block when the config file is absent or has no `display`
 * key. UTC is the safest neutral default — every stored timestamp is already
 * UTC wall-clock, so falling back to UTC means hour/date math degrades to the
 * pre-ACT-001 behaviour rather than throwing.
 */
const DEFAULT_DISPLAY: Required<DisplayConfig> = {
  userTimezone: DEFAULT_TIMEZONE,
};

/**
 * Read and parse ~/.ccanalytics/config.json.
 *
 * Returns `{}` if the file is missing (ENOENT) or unparseable — a fresh install
 * is normal and must never 500. Re-throws any other fs error.
 */
async function readConfigFile(): Promise<Record<string, unknown>> {
  const { file } = resolveConfigPath();
  let content: string;
  try {
    content = await fs.readFile(file, "utf-8");
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
 * Resolve the `display` block out of a parsed config object, falling back to
 * DEFAULT_DISPLAY (`userTimezone = 'UTC'`) when absent, malformed, or holding
 * an invalid IANA id. Invalid input is silently corrected to UTC — the route
 * never 500s on a malformed `display.userTimezone` because that would brick
 * the whole settings surface; the PUT path is the gate that rejects
 * user-typed garbage with 400.
 */
function resolveDisplay(
  config: Record<string, unknown>,
): Required<DisplayConfig> {
  const raw = config.display;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_DISPLAY };
  }
  const candidate = raw as Partial<DisplayConfig>;
  const userTimezone = isValidTimezone(candidate.userTimezone)
    ? candidate.userTimezone
    : DEFAULT_DISPLAY.userTimezone;
  return { userTimezone };
}

/**
 * GET /api/settings
 *
 * Returns the resolved `subscription` and `display` blocks from
 * ~/.ccanalytics/config.json, or the DEFAULT_CONFIG fallback (max-20x / $200,
 * userTimezone='UTC') when the file is missing. Always 200 on a fresh install;
 * 500 only on an unexpected fs error.
 */
router.get("/", async (_req, res, next) => {
  try {
    const config = await readConfigFile();
    const subscription = resolveSubscription(config);
    const display = resolveDisplay(config);
    res.json(envelope({ subscription, display }, "all"));
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/settings
 *
 * Body (all keys optional, but at least one must be present):
 *   {
 *     subscription?: { tier: SubscriptionTier, monthlyUSD?: number },
 *     display?: { userTimezone?: string }
 *   }
 *
 * Validates each provided key independently; rejects with 400 if any is
 * malformed or contains an invalid IANA timezone. `monthlyUSD` is derived
 * server-side from the canonical tier->price map when omitted, and an empty
 * `userTimezone` is normalised to 'UTC'. Then mkdir -p, read the existing
 * config (or {}), shallow-merge the provided keys, and write it back
 * pretty-printed. Untouched keys (subscription when only display is sent, and
 * vice versa) are preserved from disk.
 */
router.put("/", async (req, res, next) => {
  try {
    const body = req.body as
      | {
          subscription?: { tier?: unknown; monthlyUSD?: unknown };
          display?: { userTimezone?: unknown };
        }
      | undefined;

    if (!body || typeof body !== "object") {
      return res.status(400).json({
        error: "Bad request",
        message: "Body must be a JSON object.",
      });
    }

    const incomingSub = body.subscription;
    const incomingDisplay = body.display;
    if (incomingSub === undefined && incomingDisplay === undefined) {
      return res.status(400).json({
        error: "Bad request",
        message:
          "Body must include at least one of `subscription` or `display`.",
      });
    }

    // --- Subscription (preserve existing if not in body) ---
    let nextSubscription: SubscriptionConfig | undefined;
    if (incomingSub !== undefined) {
      if (!incomingSub || typeof incomingSub !== "object") {
        return res.status(400).json({
          error: "Bad request",
          message: "`subscription` must be an object.",
        });
      }
      if (!isSubscriptionTier(incomingSub.tier)) {
        return res.status(400).json({
          error: "Bad request",
          message:
            "`subscription.tier` must be one of: none, pro, max-5x, max-20x.",
        });
      }
      const tier: SubscriptionTier = incomingSub.tier;
      const monthlyUSD =
        typeof incomingSub.monthlyUSD === "number" &&
        Number.isFinite(incomingSub.monthlyUSD)
          ? incomingSub.monthlyUSD
          : DEFAULT_MONTHLY_USD[tier];
      nextSubscription = { tier, monthlyUSD };
    }

    // --- Display / timezone (preserve existing if not in body) ---
    let nextDisplay: Required<DisplayConfig> | undefined;
    if (incomingDisplay !== undefined) {
      if (!incomingDisplay || typeof incomingDisplay !== "object") {
        return res.status(400).json({
          error: "Bad request",
          message: "`display` must be an object.",
        });
      }
      const rawTz = incomingDisplay.userTimezone;
      // Empty string explicitly means "reset to UTC".
      if (typeof rawTz === "string" && rawTz.length === 0) {
        nextDisplay = { userTimezone: DEFAULT_TIMEZONE };
      } else if (!isValidTimezone(rawTz)) {
        return res.status(400).json({
          error: "Bad request",
          message:
            "`display.userTimezone` must be a valid IANA timezone identifier (e.g. 'UTC', 'Asia/Jerusalem', 'America/New_York').",
        });
      } else {
        nextDisplay = { userTimezone: rawTz };
      }
    }

    // (1) ensure ~/.ccanalytics/ exists, (2) read existing config (or {}),
    // (3) shallow-merge ONLY the provided keys, (4) write back.
    const { dir, file } = resolveConfigPath();
    await fs.mkdir(dir, { recursive: true });
    const existing = await readConfigFile();
    const merged: Record<string, unknown> = { ...existing };
    if (nextSubscription) merged.subscription = nextSubscription;
    if (nextDisplay) merged.display = nextDisplay;
    await fs.writeFile(
      file,
      JSON.stringify(merged, null, 2) + "\n",
      "utf-8",
    );

    // Always return the fully-resolved view (post-merge) so the client gets
    // both blocks back, regardless of which one(s) were sent.
    const finalSubscription =
      nextSubscription ?? resolveSubscription(existing);
    const finalDisplay = nextDisplay ?? resolveDisplay(existing);
    res.json(
      envelope(
        { subscription: finalSubscription, display: finalDisplay },
        "all",
      ),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
