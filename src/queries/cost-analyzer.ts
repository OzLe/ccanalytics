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
} from "../types/index.js";
import type { QueryExecutor } from "../db/executor.js";

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
   * Reads from the v_daily_cost view.
   *
   * @param range - Time range to query
   * @returns Array of daily cost rows
   */
  async getDailyCosts(range: TimeRange): Promise<DailyCost[]> {
    const sql = `
      SELECT date, model, total_cost, input_tokens, output_tokens,
             cache_read_tokens, turn_count, session_count
      FROM v_daily_cost
      WHERE date >= $1 AND date < $2
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
    }>(sql, [range.start, range.end]);

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
   * @returns Cost breakdown per model
   */
  async getCostByModel(range: TimeRange): Promise<ModelCostBreakdown[]> {
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
    }>(sql, [range.start, range.end]);

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
   * @returns Cost breakdown per project
   */
  async getCostByProject(range: TimeRange): Promise<ProjectCostBreakdown[]> {
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
    }>(sql, [range.start, range.end]);

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
   * Get total cost breakdown (input, output, cache_write, cache_read).
   *
   * @param range - Time range to query
   * @returns Aggregate cost breakdown
   */
  async getTotalCost(range: TimeRange): Promise<CostBreakdown> {
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
    `;
    const result = await this.executor.query<{
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_write_tokens: number;
      total_cache_read_tokens: number;
    }>(sql, [range.start, range.end]);

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
