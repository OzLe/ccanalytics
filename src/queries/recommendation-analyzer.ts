/**
 * @module queries/recommendation-analyzer
 *
 * Subscription-recommendation analyzer (§2, §3.3, §5 glue). Runs ONE read-only
 * source query over `conversation_turns` (the §2.1 query), reconstructs rolling
 * 5-hour and weekly usage windows in TypeScript (greedy session-start
 * anchoring), applies opt-in auto-calibration of the ESTIMATED tier ceilings,
 * and produces the structured recommendation via the pure `recommend()` engine.
 *
 * Constructor pattern is identical to {@link CostAnalyzer} / SessionAnalyzer
 * (the concrete CLI {@link QueryExecutor} satisfies the {@link QueryRunner}
 * read surface it accepts). Typing against {@link QueryRunner} rather than the
 * concrete class lets the dashboard server hand in its own read-only `query()`
 * helper without duplicating any of this analyzer's logic. All decision math
 * lives in the pure modules src/recommendation/windows.ts and
 * src/recommendation/engine.ts so it is unit testable without a DB.
 *
 * Usage is metered by API-equivalent cost (`cost_usd`) per rolling window — the
 * unit Anthropic's limits scale with (see src/config/limits.ts). The analyzer
 * sums the stored conversation_turns.cost_usd per window; it never recomputes
 * cost.
 *
 * IMPORTANT: read-only and cost-neutral. Per-model rates stay in
 * src/utils/pricing.ts; tier prices stay in src/config/subscription.ts; this
 * analyzer reads neither — it only READS the stored cost_usd column and
 * reconstructs windows. Every figure it returns is an ESTIMATE (see
 * RECOMMENDATION_ESTIMATE_CAVEAT).
 */

import type { TimeRange, QueryFilters } from "../types/index.js";
import type { SubscriptionTier } from "../types/config.js";
import type { QueryRunner } from "../db/executor.js";
import { buildTurnFilters } from "./filter-builder.js";
import { costRowPredicateSql } from "../utils/sqlPredicates.js";
import {
  resolveCeilings,
  calibrateCeilings,
  RECOMMENDATION_ESTIMATE_CAVEAT,
  type TierLimitCeilings,
  type TierLimitOverrides,
  type CeilingSource,
  type CalibratedFlags,
} from "../config/limits.js";
import {
  reconstructWindows,
  summarizeWindows,
  countActiveDays,
  computeRecencyDays,
  FIVE_HOUR_MS,
  WEEK_MS,
  type TurnRow,
  type WindowStats,
} from "../recommendation/windows.js";
import { recommend, type Recommendation } from "../recommendation/engine.js";

/** Model class used for the per-model weekly split (§2.5). */
export type ModelClass = "all" | "sonnet" | "opus" | "fable";

/** Weekly stats per model class (§2.5). */
export type PerModelWeekly = Record<ModelClass, WindowStats>;

/** The default + calibrated ceilings and per-dimension provenance (§3.3). */
export interface CeilingReport {
  default: TierLimitCeilings;
  calibrated: TierLimitCeilings;
  calibratedFlags: CalibratedFlags;
}

/** The full structured analysis returned by {@link RecommendationAnalyzer}. */
export interface RecommendationAnalysis {
  /** The tier the recommendation was computed against. */
  tier: SubscriptionTier;
  /** 5-hour window stats against the active (calibrated) ceilings. */
  windowStats5h: WindowStats;
  /** All-models weekly window stats against the active ceilings. */
  weeklyStats: WindowStats;
  /** Weekly stats split by model class (all / sonnet / opus / fable). */
  perModelWeekly: PerModelWeekly;
  /** Default + calibrated ceilings + per-dimension calibrated flags. */
  ceilings: CeilingReport;
  /** "calibrated" if auto-calibration raised any ceiling, else "default". */
  ceilingSource: CeilingSource;
  /** The recommendation verdict + confidence + $ delta + copy. */
  recommendation: Recommendation;
  /** Distinct active UTC days in the period (confidence input). */
  activeDays: number;
  /** Whole days since the most recent activity (confidence input). */
  recencyDays: number;
  /** Total cost-bearing assistant turns scanned (transparency). */
  totalTurns: number;
  /** Total API-equivalent cost (USD) scanned across all turns (transparency). */
  totalCostUSD: number;
  /** The estimate caveat shown on every surface. */
  caveat: string;
}

/** Options controlling ceiling resolution + auto-calibration. */
export interface RecommendationOptions {
  /** Opt-in auto-calibration of ceilings to observed peaks. Default: true. */
  autoCalibrate?: boolean;
  /** Sparse per-tier ceiling overrides (from config.recommendation.ceilings). */
  ceilingOverrides?: TierLimitOverrides;
  /** Injectable "now" (epoch ms) for deterministic recency in tests. */
  nowMs?: number;
}

/** One row of the §2.1 source query (epoch-ms timestamp + cost + model class). */
interface SourceRow {
  ts_ms: bigint | number | null;
  cost_usd: number | null;
  model_class: string;
}

/**
 * Analyzes usage intensity to recommend up/down/stay on the subscription tier.
 */
export class RecommendationAnalyzer {
  constructor(private executor: QueryRunner) {}

  /**
   * Compute the full recommendation analysis for a time range.
   *
   * @param tier - The user's current subscription tier.
   * @param range - Time range to analyze (inclusive start, exclusive end).
   * @param filters - Optional model/project filters (timezone is not used —
   *   active-day counting is a UTC data-volume proxy, §2.6).
   * @param options - Ceiling overrides + auto-calibrate toggle + injectable now.
   * @returns The structured {@link RecommendationAnalysis}.
   */
  async analyze(
    tier: SubscriptionTier,
    range: TimeRange,
    filters?: QueryFilters,
    options?: RecommendationOptions,
  ): Promise<RecommendationAnalysis> {
    const autoCalibrate = options?.autoCalibrate ?? true;
    const nowMs = options?.nowMs ?? Date.now();

    // §2.1 single source query. Filters start at $3 (range start/end are $1/$2);
    // costRowPredicateSql() is a literal (zero binds) so $-indices are unchanged.
    // buildTurnFilters emits bare `model` / `session_id`; rewrite to ct.* exactly
    // as CostAnalyzer.getCostByModel / the dashboard /by-model route do.
    const f = buildTurnFilters(filters, 3);
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bmodel\b/, "ct.model").replace(/\bsession_id\b/, "ct.session_id"),
    );
    const sql = `
      SELECT
        epoch_ms(ct.timestamp) AS ts_ms,
        ct.cost_usd AS cost_usd,
        CASE
          WHEN LOWER(COALESCE(ct.model, '')) LIKE '%fable%'
            OR LOWER(COALESCE(ct.model, '')) LIKE '%mythos%' THEN 'fable'
          WHEN LOWER(COALESCE(ct.model, '')) LIKE '%opus%'   THEN 'opus'
          WHEN LOWER(COALESCE(ct.model, '')) LIKE '%sonnet%' THEN 'sonnet'
          ELSE 'other'
        END AS model_class
      FROM conversation_turns ct
      WHERE ${costRowPredicateSql("ct")}
        AND ct.timestamp >= $1 AND ct.timestamp < $2
        ${filterClauses.join("\n        ")}
      ORDER BY ct.timestamp ASC
    `;
    const result = await this.executor.query<SourceRow>(sql, [range.start, range.end, ...f.params]);

    // Project rows to the pure TurnRow shape (epoch ms + API-equivalent cost).
    // DuckDB BIGINT columns surface as JS bigint, so coerce with Number().
    const allRows: TurnRow[] = [];
    const sonnetRows: TurnRow[] = [];
    const opusRows: TurnRow[] = [];
    const fableRows: TurnRow[] = [];
    for (const r of result.rows) {
      if (r.ts_ms === null || r.ts_ms === undefined) continue;
      const row: TurnRow = {
        timestamp: Number(r.ts_ms),
        costUsd: Number(r.cost_usd ?? 0),
      };
      allRows.push(row);
      if (r.model_class === "sonnet") sonnetRows.push(row);
      else if (r.model_class === "opus") opusRows.push(row);
      else if (r.model_class === "fable") fableRows.push(row);
    }

    // Resolve the override-merged DEFAULT ceilings for the tier, then (per §3.3)
    // run a FIRST pass against those defaults to read observed peaks, calibrate,
    // and RE-summarize against the calibrated ceilings so users who exceed the
    // published estimate are not pinned at a meaningless >100%.
    const defaultCeilings = resolveCeilings(tier, options?.ceilingOverrides);

    const windows5h = reconstructWindows(allRows, FIVE_HOUR_MS);
    const weeklyWindowsAll = reconstructWindows(allRows, WEEK_MS);

    // First-pass summary against defaults → observed raw peak costs for calibration.
    const fivePeaksDefault = summarizeWindows(windows5h, defaultCeilings.fiveHourCostUSD);
    const weeklyPeaksDefault = summarizeWindows(weeklyWindowsAll, defaultCeilings.weeklyCostUSD);

    const calibration = autoCalibrate
      ? calibrateCeilings(defaultCeilings, {
          fiveHourCostUSD: fivePeaksDefault.peakCostUSD,
          weeklyCostUSD: weeklyPeaksDefault.peakCostUSD,
        })
      : {
          default: { ...defaultCeilings },
          calibrated: { ...defaultCeilings },
          calibratedFlags: {
            fiveHourCostUSD: false,
            weeklyCostUSD: false,
          },
          ceilingSource: "default" as CeilingSource,
        };

    const active = calibration.calibrated;

    // Final summaries against the active (calibrated) cost ceilings.
    const windowStats5h = summarizeWindows(windows5h, active.fiveHourCostUSD);
    const weeklyStats = summarizeWindows(weeklyWindowsAll, active.weeklyCostUSD);

    // §2.5 per-model weekly split (all / sonnet / opus / fable) — re-run the
    // weekly reconstruction per class against the SAME (active) weekly cost
    // ceiling (a documented approximation, since exact per-class ceilings are
    // not published).
    const perModelWeekly: PerModelWeekly = {
      all: weeklyStats,
      sonnet: summarizeWindows(reconstructWindows(sonnetRows, WEEK_MS), active.weeklyCostUSD),
      opus: summarizeWindows(reconstructWindows(opusRows, WEEK_MS), active.weeklyCostUSD),
      fable: summarizeWindows(reconstructWindows(fableRows, WEEK_MS), active.weeklyCostUSD),
    };

    const activeDays = countActiveDays(allRows);
    const recencyDays = computeRecencyDays(allRows, nowMs);
    const totalCostUSD = allRows.reduce((sum, r) => sum + r.costUsd, 0);

    // Observed-activity span (first→last turn, in days) for the engine's
    // monthly run-rate extrapolation. Clamped to ≥1 day so a single burst
    // cannot divide by ~0; zero when there is no data at all.
    const firstTs = allRows.length > 0 ? (allRows[0] as TurnRow).timestamp : 0;
    const lastTs =
      allRows.length > 0 ? (allRows[allRows.length - 1] as TurnRow).timestamp : 0;
    const activitySpanDays =
      allRows.length > 0 ? Math.max((lastTs - firstTs) / (24 * 60 * 60 * 1000), 1) : 0;

    // VERDICT uses the DEFAULT (absolute) ceilings, NOT the calibrated ones.
    // Auto-calibration raises a ceiling to the user's own observed peak purely
    // so the DISPLAYED fill% is not pinned at a meaningless >100% (§3.3). If
    // the decision read calibrated stats, the upgrade triggers would measure
    // usage against the user's OWN peak instead of the tier limit. The v2
    // engine therefore receives the RAW windows and re-derives every per-tier
    // signal from each tier's default (override-resolved) ceilings itself —
    // calibration stays display-only by construction.
    const recommendation = recommend({
      tier,
      windows5h,
      windowsWeekly: weeklyWindowsAll,
      totalCostUSD,
      activitySpanDays,
      volume: {
        activeDays,
        activeWindows: windows5h.length,
        recencyDays,
      },
      ceilingOverrides: options?.ceilingOverrides,
    });

    return {
      tier,
      windowStats5h,
      weeklyStats,
      perModelWeekly,
      ceilings: {
        default: calibration.default,
        calibrated: calibration.calibrated,
        calibratedFlags: calibration.calibratedFlags,
      },
      ceilingSource: calibration.ceilingSource,
      recommendation,
      activeDays,
      recencyDays,
      totalTurns: allRows.length,
      totalCostUSD,
      caveat: RECOMMENDATION_ESTIMATE_CAVEAT,
    };
  }
}
