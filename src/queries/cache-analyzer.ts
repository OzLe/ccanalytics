/**
 * @module queries/cache-analyzer
 *
 * Cache efficiency analytical queries.
 * Calculates cache hit rates, trends, and per-session/per-model breakdowns.
 *
 * Cache hit rate formula:
 *   cache_read / (cache_read + cache_write + uncached_input)
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
} from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";

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
  async getCacheHitRate(range: TimeRange): Promise<CacheMetrics> {
    const sql = `
      SELECT
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
    `;
    const result = await this.executor.query<{
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_input_tokens: number;
    }>(sql, [range.start, range.end]);

    const row = result.rows[0];
    const cacheReadTokens = Number(row?.cache_read_tokens ?? 0);
    const cacheWriteTokens = Number(row?.cache_write_tokens ?? 0);
    const totalInputTokens = Number(row?.total_input_tokens ?? 0);

    // Uncached input = total input - cache_read (cache reads are part of input)
    const uncachedInputTokens = Math.max(0, totalInputTokens - cacheReadTokens);
    const denominator = cacheReadTokens + cacheWriteTokens + uncachedInputTokens;
    const cacheHitRate = denominator > 0 ? cacheReadTokens / denominator : 0;

    // Estimate savings: cache reads are ~10x cheaper than regular input
    // Savings = cacheReadTokens * 0.9 * (avg input cost per token)
    // Approximate: $3/MTok input vs $0.30/MTok cache read = $2.70/MTok saved
    const estimatedSavingsUSD = (cacheReadTokens / 1_000_000) * 2.70;

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
  ): Promise<CacheEfficiencyTrend[]> {
    const sql = `
      SELECT date, cache_hit_rate, cache_read_tokens, cache_write_tokens
      FROM v_cache_efficiency
      WHERE date >= $1 AND date < $2
      ORDER BY date ASC
    `;
    const result = await this.executor.query<{
      date: string;
      cache_hit_rate: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>(sql, [range.start, range.end]);

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
    const sql = `
      SELECT
        s.session_id,
        COALESCE(s.cache_hit_rate, 0) AS cache_hit_rate,
        COALESCE(SUM(ct.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(ct.cache_creation_tokens), 0) AS cache_write_tokens,
        GREATEST(COALESCE(SUM(ct.input_tokens), 0) - COALESCE(SUM(ct.cache_read_tokens), 0), 0) AS uncached_input_tokens
      FROM v_session_summary s
      LEFT JOIN conversation_turns ct ON ct.session_id = s.session_id
      WHERE s.start_time >= $1 AND s.start_time < $2
      GROUP BY s.session_id, s.cache_hit_rate
      ORDER BY cache_hit_rate DESC
    `;
    const result = await this.executor.query<{
      session_id: string;
      cache_hit_rate: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      uncached_input_tokens: number;
    }>(sql, [range.start, range.end]);

    return result.rows.map((row) => {
      const cacheReadTokens = Number(row.cache_read_tokens);
      // Estimate savings similarly to getCacheHitRate
      const estimatedSavingsUSD = (cacheReadTokens / 1_000_000) * 2.70;

      return {
        sessionId: row.session_id,
        cacheHitRate: Number(row.cache_hit_rate),
        cacheReadTokens,
        cacheWriteTokens: Number(row.cache_write_tokens),
        uncachedInputTokens: Number(row.uncached_input_tokens),
        estimatedSavingsUSD,
      };
    });
  }
}
