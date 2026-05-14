/**
 * @module queries/cache-analyzer
 *
 * Cache efficiency analytical queries.
 * Calculates cache hit rates, trends, and per-session/per-model breakdowns.
 *
 * Cache hit rate formula (KPI-001 — canonical, matches the SQL views):
 *   cache_read / (cache_read + cache_creation + input_tokens)
 *
 * In the Anthropic API, cache_read_input_tokens and cache_creation_input_tokens
 * are SEPARATE fields from input_tokens (input_tokens does NOT include cache
 * reads). The adapters store them as separate quantities, so input_tokens is
 * already the uncached-input figure — do NOT subtract cache_read from it.
 *
 * Interpretation:
 *   > 80% = "effective"
 *   50-80% = "moderate"
 *   < 50% = "ineffective"
 */

import type {
  CacheMetrics,
  CacheEfficiencyTrend,
  TimeRange,
  TimeBucket,
  QueryFilters,
} from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildTurnFilters } from "./filter-builder.js";
import { getPricing } from "../utils/pricing.js";

/** Cache metrics for a single session. */
export interface SessionCacheMetrics {
  sessionId: string;
  cacheHitRate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  estimatedSavingsUSD: number;
}

/** Cache metrics for a single model. */
export interface ModelCacheMetrics {
  model: string;
  cacheHitRate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
}

/**
 * Analyzes cache efficiency data from the v_cache_efficiency view.
 */
export class CacheAnalyzer {
  constructor(private executor: QueryExecutor) {}

  /**
   * Get overall cache metrics for a time range.
   *
   * @param range - Time range to analyze
   * @returns Aggregate cache metrics with interpretation
   */
  async getCacheHitRate(range: TimeRange, filters?: QueryFilters): Promise<CacheMetrics> {
    const f = buildTurnFilters(filters, 3);
    // Group by model to compute model-aware cache savings
    const sql = `
      SELECT
        model,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY model
    `;
    const result = await this.executor.query<{
      model: string;
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_input_tokens: number;
    }>(sql, [range.start, range.end, ...f.params]);

    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalInputTokens = 0;
    let estimatedSavingsUSD = 0;

    for (const row of result.rows) {
      const crTok = Number(row.cache_read_tokens);
      const cwTok = Number(row.cache_write_tokens);
      const inTok = Number(row.total_input_tokens);

      cacheReadTokens += crTok;
      cacheWriteTokens += cwTok;
      totalInputTokens += inTok;

      // Savings per model = (inputPerM - cacheReadPerM) per MTok of cache reads
      const p = getPricing(row.model);
      const savingsPerMTok = p.inputPerM - p.cacheReadPerM;
      estimatedSavingsUSD += (crTok / 1_000_000) * savingsPerMTok;
    }

    // KPI-001: input_tokens is already the uncached-input figure (cache reads
    // are a SEPARATE field in the Anthropic API, not a subset of input_tokens).
    // Canonical denominator = cache_read + cache_creation + input_tokens,
    // matching v_cache_efficiency / v_session_summary and getCacheTrend.
    const uncachedInputTokens = totalInputTokens;
    const denominator = cacheReadTokens + cacheWriteTokens + uncachedInputTokens;
    const cacheHitRate = denominator > 0 ? cacheReadTokens / denominator : 0;

    let interpretation: "effective" | "moderate" | "ineffective";
    if (cacheHitRate > 0.8) {
      interpretation = "effective";
    } else if (cacheHitRate >= 0.5) {
      interpretation = "moderate";
    } else {
      interpretation = "ineffective";
    }

    return {
      cacheHitRate,
      cacheReadTokens,
      cacheWriteTokens,
      uncachedInputTokens,
      estimatedSavingsUSD,
      interpretation,
    };
  }

  /**
   * Get cache efficiency trending over time.
   * Reads from the v_cache_efficiency view.
   *
   * @param range - Time range to query
   * @param bucket - Time bucket granularity
   * @returns Array of cache efficiency data points
   */
  async getCacheTrend(
    range: TimeRange,
    _bucket?: TimeBucket,
    filters?: QueryFilters,
  ): Promise<CacheEfficiencyTrend[]> {
    const f = buildTurnFilters(filters, 3);
    // Query conversation_turns directly (instead of the view) to support filters
    const sql = `
      SELECT
        CAST(timestamp AS DATE) AS date,
        CASE
          WHEN (SUM(cache_read_tokens) + SUM(cache_creation_tokens) + SUM(input_tokens)) > 0
          THEN SUM(cache_read_tokens)::DOUBLE /
               (SUM(cache_read_tokens) + SUM(cache_creation_tokens) + SUM(input_tokens))::DOUBLE
          ELSE 0.0
        END AS cache_hit_rate,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_creation_tokens) AS cache_write_tokens
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY CAST(timestamp AS DATE)
      ORDER BY date ASC
    `;
    const result = await this.executor.query<{
      date: string;
      cache_hit_rate: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>(sql, [range.start, range.end, ...f.params]);

    return result.rows.map((row) => ({
      timestamp: new Date(row.date),
      cacheHitRate: Number(row.cache_hit_rate),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
    }));
  }

  /**
   * Get cache metrics broken down by session.
   *
   * @param range - Time range to query
   * @returns Per-session cache metrics
   */
  async getCacheBySession(range: TimeRange): Promise<SessionCacheMetrics[]> {
    // Group by session and model to compute model-aware savings
    const sql = `
      SELECT
        s.session_id,
        COALESCE(s.cache_hit_rate, 0) AS cache_hit_rate,
        ct.model,
        COALESCE(SUM(ct.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(ct.cache_creation_tokens), 0) AS cache_write_tokens,
        -- KPI-001: input_tokens is already the uncached-input figure; do not
        -- subtract cache_read (they are separate Anthropic API fields).
        COALESCE(SUM(ct.input_tokens), 0) AS uncached_input_tokens
      FROM v_session_summary s
      LEFT JOIN conversation_turns ct ON ct.session_id = s.session_id
      WHERE s.start_time >= $1 AND s.start_time < $2
      GROUP BY s.session_id, s.cache_hit_rate, ct.model
      ORDER BY cache_hit_rate DESC
    `;
    const result = await this.executor.query<{
      session_id: string;
      cache_hit_rate: number;
      model: string;
      cache_read_tokens: number;
      cache_write_tokens: number;
      uncached_input_tokens: number;
    }>(sql, [range.start, range.end]);

    // Aggregate per-model rows into per-session metrics
    const sessionMap = new Map<string, SessionCacheMetrics>();

    for (const row of result.rows) {
      const sid = row.session_id;
      let entry = sessionMap.get(sid);
      if (!entry) {
        entry = {
          sessionId: sid,
          cacheHitRate: Number(row.cache_hit_rate),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          uncachedInputTokens: 0,
          estimatedSavingsUSD: 0,
        };
        sessionMap.set(sid, entry);
      }

      const crTok = Number(row.cache_read_tokens);
      entry.cacheReadTokens += crTok;
      entry.cacheWriteTokens += Number(row.cache_write_tokens);
      entry.uncachedInputTokens += Number(row.uncached_input_tokens);

      // Model-aware savings: (inputPerM - cacheReadPerM) per MTok
      const p = getPricing(row.model);
      const savingsPerMTok = p.inputPerM - p.cacheReadPerM;
      entry.estimatedSavingsUSD += (crTok / 1_000_000) * savingsPerMTok;
    }

    const results = Array.from(sessionMap.values());
    results.sort((a, b) => b.cacheHitRate - a.cacheHitRate);
    return results;
  }
}
