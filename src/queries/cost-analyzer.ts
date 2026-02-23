/**
 * @module queries/cost-analyzer
 *
 * Cost-focused analytical queries.
 * Provides daily cost breakdown, cost by model, cost by project,
 * cost trending, and cross-validation against raw JSONL data.
 */

import type {
  DailyCost,
  CostBreakdown,
  ModelCostBreakdown,
  CostTrend,
  TimeRange,
  TimeBucket,
  QueryFilters,
} from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";
import { buildTurnFilters, buildSessionFilters } from "./filter-builder.js";

/** Cost breakdown for a specific project. */
export interface ProjectCostBreakdown {
  projectPath: string;
  totalCostUSD: number;
  sessionCount: number;
  tokenBreakdown: CostBreakdown;
}

/** Cost summary for an individual session. */
export interface SessionCostSummary {
  sessionId: string;
  startTime: Date;
  totalCostUSD: number;
  model: string;
  numTurns: number;
}

/**
 * Analyzes cost data from the v_daily_cost view and sessions table.
 */
export class CostAnalyzer {
  constructor(private executor: QueryExecutor) {}

  /**
   * Get daily cost aggregation broken down by model.
   * Queries conversation_turns directly to support filters.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @returns Array of daily cost rows
   */
  async getDailyCosts(range: TimeRange, filters?: QueryFilters): Promise<DailyCost[]> {
    const f = buildTurnFilters(filters, 3);
    const sql = `
      SELECT
        CAST(timestamp AS DATE) AS date,
        model,
        SUM(cost_usd) AS total_cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        COUNT(*) AS turn_count,
        COUNT(DISTINCT session_id) AS session_count
      FROM conversation_turns
      WHERE role = 'assistant'
        AND cost_usd > 0
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY CAST(timestamp AS DATE), model
      ORDER BY date DESC, total_cost DESC
    `;
    const result = await this.executor.query<{
      date: string;
      model: string;
      total_cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      turn_count: number;
      session_count: number;
    }>(sql, [range.start, range.end, ...f.params]);

    return result.rows.map((row) => ({
      date: String(row.date),
      model: row.model,
      totalCost: Number(row.total_cost),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      turnCount: Number(row.turn_count),
      sessionCount: Number(row.session_count),
    }));
  }

  /**
   * Get cost broken down by model across a time range.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @returns Cost breakdown per model
   */
  async getCostByModel(range: TimeRange, filters?: QueryFilters): Promise<ModelCostBreakdown[]> {
    const f = buildTurnFilters(filters, 3);
    const sql = `
      SELECT
        ct.model,
        COUNT(DISTINCT ct.session_id) AS session_count,
        COALESCE(SUM(ct.cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(ct.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(ct.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(ct.cache_creation_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(ct.cache_read_tokens), 0) AS total_cache_read_tokens
      FROM conversation_turns ct
      WHERE ct.role = 'assistant'
        AND ct.timestamp >= $1 AND ct.timestamp < $2
        ${f.clauses.map((c) => c.replace(/\bmodel\b/, "ct.model").replace(/\bsession_id\b/, "ct.session_id")).join("\n        ")}
      GROUP BY ct.model
      ORDER BY total_cost_usd DESC
    `;
    const result = await this.executor.query<{
      model: string;
      session_count: number;
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_write_tokens: number;
      total_cache_read_tokens: number;
    }>(sql, [range.start, range.end, ...f.params]);

    return result.rows.map((row) => {
      const totalCostUSD = Number(row.total_cost_usd);
      const totalInputTokens = Number(row.total_input_tokens);
      const totalOutputTokens = Number(row.total_output_tokens);
      const totalCacheWriteTokens = Number(row.total_cache_write_tokens);
      const totalCacheReadTokens = Number(row.total_cache_read_tokens);
      const totalTokens = totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens;

      return {
        model: row.model,
        sessionCount: Number(row.session_count),
        totalCostUSD,
        inputCostUSD: totalTokens > 0 ? totalCostUSD * (totalInputTokens / totalTokens) : 0,
        outputCostUSD: totalTokens > 0 ? totalCostUSD * (totalOutputTokens / totalTokens) : 0,
        cacheWriteCostUSD: totalTokens > 0 ? totalCostUSD * (totalCacheWriteTokens / totalTokens) : 0,
        cacheReadCostUSD: totalTokens > 0 ? totalCostUSD * (totalCacheReadTokens / totalTokens) : 0,
        totalInputTokens,
        totalOutputTokens,
        totalCacheWriteTokens,
        totalCacheReadTokens,
      };
    });
  }

  /**
   * Get cost broken down by project.
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @returns Cost breakdown per project
   */
  async getCostByProject(range: TimeRange, filters?: QueryFilters): Promise<ProjectCostBreakdown[]> {
    const f = buildSessionFilters(filters, 3);
    const sql = `
      SELECT
        COALESCE(s.project_path, 'unknown') AS project_path,
        COALESCE(SUM(s.total_cost_usd), 0) AS total_cost_usd,
        COUNT(*) AS session_count,
        COALESCE(SUM(s.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(s.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(s.cache_creation_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(s.cache_read_tokens), 0) AS total_cache_read_tokens
      FROM sessions s
      WHERE s.start_time >= $1 AND s.start_time < $2
        ${f.clauses.join("\n        ")}
      GROUP BY s.project_path
      ORDER BY total_cost_usd DESC
    `;
    const result = await this.executor.query<{
      project_path: string;
      total_cost_usd: number;
      session_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_write_tokens: number;
      total_cache_read_tokens: number;
    }>(sql, [range.start, range.end, ...f.params]);

    return result.rows.map((row) => {
      const totalCostUSD = Number(row.total_cost_usd);
      const totalInputTokens = Number(row.total_input_tokens);
      const totalOutputTokens = Number(row.total_output_tokens);
      const totalCacheWriteTokens = Number(row.total_cache_write_tokens);
      const totalCacheReadTokens = Number(row.total_cache_read_tokens);
      const totalTokens = totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens;

      return {
        projectPath: row.project_path,
        totalCostUSD,
        sessionCount: Number(row.session_count),
        tokenBreakdown: {
          totalCostUSD,
          inputCostUSD: totalTokens > 0 ? totalCostUSD * (totalInputTokens / totalTokens) : 0,
          outputCostUSD: totalTokens > 0 ? totalCostUSD * (totalOutputTokens / totalTokens) : 0,
          cacheWriteCostUSD: totalTokens > 0 ? totalCostUSD * (totalCacheWriteTokens / totalTokens) : 0,
          cacheReadCostUSD: totalTokens > 0 ? totalCostUSD * (totalCacheReadTokens / totalTokens) : 0,
          totalInputTokens,
          totalOutputTokens,
          totalCacheWriteTokens,
          totalCacheReadTokens,
        },
      };
    });
  }

  /**
   * Get cost trending over time, bucketed by the given time granularity.
   *
   * @param range - Time range to query
   * @param bucket - Aggregation granularity (hour, day, week, month)
   * @param filters - Optional model/project filters
   * @returns Array of cost trend points
   */
  async getCostTrend(range: TimeRange, bucket: TimeBucket, filters?: QueryFilters): Promise<CostTrend[]> {
    const validBuckets: Record<TimeBucket, string> = {
      hour: "hour",
      day: "day",
      week: "week",
      month: "month",
    };
    const duckBucket = validBuckets[bucket];
    if (!duckBucket) {
      throw new Error(`Invalid time bucket: ${bucket}`);
    }

    const f = buildTurnFilters(filters, 3);
    const sql = `
      SELECT
        DATE_TRUNC('${duckBucket}', timestamp) AS ts,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY ts
      ORDER BY ts ASC
    `;
    const result = await this.executor.query<{
      ts: string;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
    }>(sql, [range.start, range.end, ...f.params]);

    return result.rows.map((row) => ({
      timestamp: new Date(row.ts),
      costUSD: Number(row.cost_usd),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    }));
  }

  /**
   * Get total cost breakdown (input, output, cache_write, cache_read).
   *
   * @param range - Time range to query
   * @param filters - Optional model/project filters
   * @returns Aggregate cost breakdown
   */
  async getTotalCost(range: TimeRange, filters?: QueryFilters): Promise<CostBreakdown> {
    const f = buildTurnFilters(filters, 3);
    const sql = `
      SELECT
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens
      FROM conversation_turns
      WHERE role = 'assistant'
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
    `;
    const result = await this.executor.query<{
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_write_tokens: number;
      total_cache_read_tokens: number;
    }>(sql, [range.start, range.end, ...f.params]);

    const row = result.rows[0];
    if (!row) {
      return {
        totalCostUSD: 0,
        inputCostUSD: 0,
        outputCostUSD: 0,
        cacheWriteCostUSD: 0,
        cacheReadCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheWriteTokens: 0,
        totalCacheReadTokens: 0,
      };
    }

    const totalCostUSD = Number(row.total_cost_usd);
    const totalInputTokens = Number(row.total_input_tokens);
    const totalOutputTokens = Number(row.total_output_tokens);
    const totalCacheWriteTokens = Number(row.total_cache_write_tokens);
    const totalCacheReadTokens = Number(row.total_cache_read_tokens);
    const totalTokens = totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens;

    return {
      totalCostUSD,
      inputCostUSD: totalTokens > 0 ? totalCostUSD * (totalInputTokens / totalTokens) : 0,
      outputCostUSD: totalTokens > 0 ? totalCostUSD * (totalOutputTokens / totalTokens) : 0,
      cacheWriteCostUSD: totalTokens > 0 ? totalCostUSD * (totalCacheWriteTokens / totalTokens) : 0,
      cacheReadCostUSD: totalTokens > 0 ? totalCostUSD * (totalCacheReadTokens / totalTokens) : 0,
      totalInputTokens,
      totalOutputTokens,
      totalCacheWriteTokens,
      totalCacheReadTokens,
    };
  }
}
