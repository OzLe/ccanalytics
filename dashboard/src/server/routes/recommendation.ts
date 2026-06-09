/**
 * @module server/routes/recommendation
 *
 * Subscription-recommendation API endpoint — read-only `GET /api/recommendation`.
 *
 * Answers one advisory question from local Claude Code usage: should the user
 * DOWNGRADE (under-utilizing the tier), UPGRADE (frequently at/near the
 * ESTIMATED limits), or STAY — with an explicit confidence level and an honest
 * estimate caveat.
 *
 * This route is a THIN presentation layer over the shared core. ALL decision
 * logic lives in the pure modules (src/recommendation/windows.ts +
 * src/recommendation/engine.ts) wrapped by {@link RecommendationAnalyzer} — the
 * exact same analyzer the CLI `recommend` command drives. The route only:
 *   1. parses the period / model / project filters (like every other route),
 *   2. reads the current tier + recommendation config (autoCalibrate + sparse
 *      ceiling overrides) through the SHARED resolver exported by settings.ts
 *      (no duplicated config-reading logic — §4.3), and
 *   3. runs the analyzer against the same DuckDB `query()` helper cost.ts uses.
 *
 * IMPORTANT — read-only and cost-neutral. settings.ts remains the ONLY write
 * path; this route never writes. Per-model rates stay in src/utils/pricing.ts
 * and tier prices stay in src/config/subscription.ts; this route reads neither.
 * Every figure returned is an ESTIMATE — the payload carries
 * RECOMMENDATION_ESTIMATE_CAVEAT as `data.caveat`, surfaced on every UI.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import { parseFilters, envelope } from "../helpers/parseFilters.js";
import {
  getRecommendationConfig,
  getSubscriptionConfig,
} from "./settings.js";
import { RecommendationAnalyzer } from "../../../../src/queries/recommendation-analyzer.js";
import type { QueryFilters } from "../../../../src/types/analytics.js";

const router = Router();

/** Period values the recommendation surfaces support (mirrors parsePeriod). */
const VALID_PERIODS = new Set(["today", "7d", "30d", "90d", "all"]);

/**
 * Adapt the dashboard's singleton `query()` helper to the minimal
 * `QueryExecutor` surface {@link RecommendationAnalyzer} consumes (it only ever
 * calls `executor.query<T>(sql, params)`). Reusing the helper means the route
 * shares the same read-only DuckDB connection, view-init, and index-rebuild
 * pre-flight as cost.ts — and, crucially, the SAME window-reconstruction code
 * as the analyzer, so nothing is duplicated server-side.
 */
const executorAdapter = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return query<T>(sql, params);
  },
};

/**
 * GET /api/recommendation
 *
 * Query params:
 *   ?period=today|7d|30d|90d|all   (default: 30d — the recommendation default)
 *   &model=X&project=Y             (optional, same filter semantics as cost.ts)
 * Header:
 *   X-User-Timezone                (parsed for parity; the analyzer's
 *                                   active-day count is a UTC data-volume proxy
 *                                   per §2.6, so it is not bound into SQL here)
 *
 * Returns the full structured {@link RecommendationAnalysis} (window stats,
 * per-model weekly split, default + calibrated ceilings, ceilingSource, the
 * recommendation verdict, and the estimate caveat) wrapped in the standard
 * envelope. Read-only.
 */
router.get("/", async (req, res, next) => {
  try {
    // Reuse the shared filter parsing, but default to 30d (the recommendation
    // window) rather than parseFilters' 7d default, and reject an unknown
    // period explicitly so it can't silently fall back. Default in place on the
    // mutable query object so parseFilters keeps full access to req (it reads
    // the X-User-Timezone header via req.header(), which a shallow spread of
    // req would strip off the Express prototype).
    const rawPeriod = (req.query.period as string | undefined) ?? "30d";
    if (!VALID_PERIODS.has(rawPeriod)) {
      return res.status(400).json({
        error: "Bad request",
        message: `Invalid period: ${rawPeriod}. Valid values: today, 7d, 30d, 90d, all.`,
      });
    }
    if (req.query.period === undefined) {
      req.query.period = rawPeriod;
    }
    const filters = parseFilters(req);

    // Current tier + recommendation behaviour come from the SHARED settings
    // resolver (the only config-reading logic), so the route can never drift
    // from what GET/PUT /api/settings persist.
    const [subscription, recommendation] = await Promise.all([
      getSubscriptionConfig(),
      getRecommendationConfig(),
    ]);

    // Map the dashboard's ParsedFilters onto the core QueryFilters the analyzer
    // expects (model/project; userTimezone passed through for parity).
    const queryFilters: QueryFilters = {
      model: filters.model,
      project: filters.project,
      userTimezone: filters.userTimezone,
    };

    const analyzer = new RecommendationAnalyzer(executorAdapter);
    const analysis = await analyzer.analyze(
      subscription.tier,
      filters.range,
      queryFilters,
      {
        autoCalibrate: recommendation.autoCalibrate,
        ceilingOverrides: recommendation.ceilings,
      },
    );

    res.json(envelope(analysis, filters.period));
  } catch (err) {
    next(err);
  }
});

export default router;
