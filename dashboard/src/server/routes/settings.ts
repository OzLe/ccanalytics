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
import {
  CEILING_DIMENSIONS,
  type TierLimitCeilings,
  type TierLimitOverrides,
} from "../../../../src/config/limits.js";
import type {
  DisplayConfig,
  RecommendationConfig,
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
 * Fallback recommendation block when the config file is absent or has no
 * `recommendation` key. Mirrors DEFAULT_CONFIG.recommendation in the CLI:
 * auto-calibration defaults ON, and `ceilings` is left sparse/absent so the
 * DEFAULT_TIER_LIMITS in src/config/limits.ts are the effective default. All
 * ceiling values are ESTIMATES (see RECOMMENDATION_ESTIMATE_CAVEAT).
 */
const DEFAULT_RECOMMENDATION: RecommendationConfig = {
  autoCalibrate: true,
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
 * Sanitize a raw `recommendation.ceilings` value into a sparse
 * {@link TierLimitOverrides}. Defensive (this guards the only write path):
 *
 *   - Only known {@link SubscriptionTier} keys survive (drops e.g. "team").
 *   - Within each tier, only the two numeric {@link TierLimitCeilings} cost
 *     dimensions (`fiveHourCostUSD` / `weeklyCostUSD`, API-equivalent USD per
 *     rolling window) survive, and only when finite and non-negative — NaN,
 *     Infinity, negatives and non-numbers are dropped.
 *   - A tier whose every dimension was dropped is omitted entirely, so the
 *     persisted shape stays sparse (any omitted tier/dimension falls back to
 *     DEFAULT_TIER_LIMITS at read time via resolveCeilings()).
 *
 * Returns `undefined` when nothing valid remains, so the caller can omit the
 * key rather than persist an empty object.
 */
function sanitizeCeilings(raw: unknown): TierLimitOverrides | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: TierLimitOverrides = {};
  let anyTier = false;
  for (const [tierKey, tierVal] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSubscriptionTier(tierKey)) continue;
    if (!tierVal || typeof tierVal !== "object" || Array.isArray(tierVal)) continue;
    const dims = tierVal as Record<string, unknown>;
    const sanitized: Partial<TierLimitCeilings> = {};
    let anyDim = false;
    for (const dim of CEILING_DIMENSIONS) {
      const v = dims[dim];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        sanitized[dim] = v;
        anyDim = true;
      }
    }
    if (anyDim) {
      out[tierKey] = sanitized;
      anyTier = true;
    }
  }
  return anyTier ? out : undefined;
}

/**
 * Resolve the `recommendation` block out of a parsed config object, falling
 * back to DEFAULT_RECOMMENDATION (`autoCalibrate: true`, no ceiling overrides)
 * when absent or malformed. `autoCalibrate` is coerced to a strict boolean and
 * `ceilings` is passed through {@link sanitizeCeilings} so only known tiers and
 * finite/non-negative numeric dimensions survive — the same defensive
 * normalization the PUT gate applies, so GET never surfaces stored garbage.
 *
 * This is the shared resolver the read-only /api/recommendation route consumes
 * to obtain `autoCalibrate` + merged ceiling overrides without duplicating the
 * config-reading logic (§4.3).
 */
function resolveRecommendation(
  config: Record<string, unknown>,
): RecommendationConfig {
  const raw = config.recommendation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_RECOMMENDATION };
  }
  const candidate = raw as Partial<RecommendationConfig>;
  const autoCalibrate =
    typeof candidate.autoCalibrate === "boolean"
      ? candidate.autoCalibrate
      : DEFAULT_RECOMMENDATION.autoCalibrate;
  const ceilings = sanitizeCeilings(candidate.ceilings);
  return ceilings ? { autoCalibrate, ceilings } : { autoCalibrate };
}

/**
 * Read the resolved `recommendation` block straight from disk. Exposed so the
 * read-only /api/recommendation route can share this route's config-reading +
 * normalization logic instead of re-implementing it. settings.ts stays the
 * ONLY write path; this is a pure read.
 */
export async function getRecommendationConfig(): Promise<RecommendationConfig> {
  const config = await readConfigFile();
  return resolveRecommendation(config);
}

/**
 * Read the resolved `subscription` block straight from disk. Companion to
 * {@link getRecommendationConfig} so the recommendation route can learn the
 * current tier through the same shared resolver. Pure read.
 */
export async function getSubscriptionConfig(): Promise<SubscriptionConfig> {
  const config = await readConfigFile();
  return resolveSubscription(config);
}

/**
 * GET /api/settings
 *
 * Returns the resolved `subscription`, `display`, and `recommendation` blocks
 * from ~/.ccanalytics/config.json, or the DEFAULT_CONFIG fallback (max-20x /
 * $200, userTimezone='UTC', autoCalibrate=true) when the file is missing.
 * Always 200 on a fresh install; 500 only on an unexpected fs error.
 */
router.get("/", async (_req, res, next) => {
  try {
    const config = await readConfigFile();
    const subscription = resolveSubscription(config);
    const display = resolveDisplay(config);
    const recommendation = resolveRecommendation(config);
    res.json(envelope({ subscription, display, recommendation }, "all"));
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
 *     display?: { userTimezone?: string },
 *     recommendation?: {
 *       autoCalibrate?: boolean,
 *       ceilings?: { [tier]: { fiveHourCostUSD?: number, weeklyCostUSD?: number } }
 *     }
 *   }
 *
 * Validates each provided key independently; rejects with 400 if any is
 * malformed or contains an invalid IANA timezone. `monthlyUSD` is derived
 * server-side from the canonical tier->price map when omitted, an empty
 * `userTimezone` is normalised to 'UTC', and `recommendation` is sanitized
 * server-side (boolean-coerced `autoCalibrate`; finite/non-negative ceiling
 * dimensions on known tiers only — anything else dropped). Then mkdir -p, read
 * the existing config (or {}), shallow-merge ONLY the provided keys, and write
 * it back pretty-printed. Untouched keys (subscription/display/recommendation
 * not in the body, plus unknown keys like dbPath) are preserved from disk.
 */
router.put("/", async (req, res, next) => {
  try {
    const body = req.body as
      | {
          subscription?: { tier?: unknown; monthlyUSD?: unknown };
          display?: { userTimezone?: unknown };
          recommendation?: { autoCalibrate?: unknown; ceilings?: unknown };
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
    const incomingRecommendation = body.recommendation;
    if (
      incomingSub === undefined &&
      incomingDisplay === undefined &&
      incomingRecommendation === undefined
    ) {
      return res.status(400).json({
        error: "Bad request",
        message:
          "Body must include at least one of `subscription`, `display`, or `recommendation`.",
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

    // --- Recommendation (preserve existing if not in body) ---
    // Mirrors the subscription/display gates: reject a non-object payload with
    // 400, then sanitize numeric ceilings + boolean autoCalibrate server-side.
    let nextRecommendation: RecommendationConfig | undefined;
    if (incomingRecommendation !== undefined) {
      if (
        !incomingRecommendation ||
        typeof incomingRecommendation !== "object" ||
        Array.isArray(incomingRecommendation)
      ) {
        return res.status(400).json({
          error: "Bad request",
          message: "`recommendation` must be an object.",
        });
      }
      const rawAuto = incomingRecommendation.autoCalibrate;
      if (rawAuto !== undefined && typeof rawAuto !== "boolean") {
        return res.status(400).json({
          error: "Bad request",
          message: "`recommendation.autoCalibrate` must be a boolean.",
        });
      }
      const rawCeilings = incomingRecommendation.ceilings;
      if (
        rawCeilings !== undefined &&
        (rawCeilings === null ||
          typeof rawCeilings !== "object" ||
          Array.isArray(rawCeilings))
      ) {
        return res.status(400).json({
          error: "Bad request",
          message:
            "`recommendation.ceilings` must be an object keyed by subscription tier.",
        });
      }
      // autoCalibrate defaults to the current default (true) when omitted; the
      // ceilings are sanitized to a sparse, finite/non-negative override set.
      const autoCalibrate =
        typeof rawAuto === "boolean"
          ? rawAuto
          : DEFAULT_RECOMMENDATION.autoCalibrate;
      const ceilings = sanitizeCeilings(rawCeilings);
      nextRecommendation = ceilings
        ? { autoCalibrate, ceilings }
        : { autoCalibrate };
    }

    // (1) ensure ~/.ccanalytics/ exists, (2) read existing config (or {}),
    // (3) shallow-merge ONLY the provided keys, (4) write back.
    const { dir, file } = resolveConfigPath();
    await fs.mkdir(dir, { recursive: true });
    const existing = await readConfigFile();
    const merged: Record<string, unknown> = { ...existing };
    if (nextSubscription) merged.subscription = nextSubscription;
    if (nextDisplay) merged.display = nextDisplay;
    if (nextRecommendation) merged.recommendation = nextRecommendation;
    await fs.writeFile(
      file,
      JSON.stringify(merged, null, 2) + "\n",
      "utf-8",
    );

    // Always return the fully-resolved view (post-merge) so the client gets all
    // three blocks back, regardless of which one(s) were sent.
    const finalSubscription =
      nextSubscription ?? resolveSubscription(existing);
    const finalDisplay = nextDisplay ?? resolveDisplay(existing);
    const finalRecommendation =
      nextRecommendation ?? resolveRecommendation(existing);
    res.json(
      envelope(
        {
          subscription: finalSubscription,
          display: finalDisplay,
          recommendation: finalRecommendation,
        },
        "all",
      ),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
