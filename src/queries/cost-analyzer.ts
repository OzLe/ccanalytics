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
import { getPricing } from "../utils/pricing.js";
import { resolveTimezone, wrapTimestampForTz } from "../utils/timezone.js";
import { costRowPredicateSql } from "../utils/sqlPredicates.js";

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
    // ACT-001: bind $3 = userTimezone; the local-date CAST projects through it
    // so a turn at 22:30Z lands in the user's local "tomorrow" not UTC's "today".
    const userTimezone = resolveTimezone(filters?.userTimezone);
    const f = buildTurnFilters(filters, 4);
    const localDate = `CAST(${wrapTimestampForTz("timestamp", "$3")} AS DATE)`;
    const sql = `
      SELECT
        ${localDate} AS date,
        model,
        SUM(cost_usd) AS total_cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        COUNT(*) AS turn_count,
        COUNT(DISTINCT session_id) AS session_count
      FROM conversation_turns
      WHERE ${costRowPredicateSql("")}
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY ${localDate}, model
      ORDER BY date DESC, total_cost DESC
    `;
    const result = await this.executor.query<{
      date: string;
      model: string;
      total_cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      turn_count: number;
      session_count: number;
    }>(sql, [range.start, range.end, userTimezone, ...f.params]);

    return result.rows.map((row) => ({
      date: String(row.date),
      model: row.model,
      totalCost: Number(row.total_cost),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheCreationTokens: Number(row.cache_creation_tokens),
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
    // COST-003: total_cost_usd is the SUM of the stored cost_usd column — the
    // single canonical basis. Per-category costs are still rate-derived (the
    // stored column is one combined total); after the COST-002 backfill the
    // per-category sum reconciles with the stored total.
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
      WHERE ${costRowPredicateSql("ct")}
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
      const totalInputTokens = Number(row.total_input_tokens);
      const totalOutputTokens = Number(row.total_output_tokens);
      const totalCacheWriteTokens = Number(row.total_cache_write_tokens);
      const totalCacheReadTokens = Number(row.total_cache_read_tokens);

      // Compute per-category costs using actual model rates
      const p = getPricing(row.model);
      const inputCostUSD = (totalInputTokens * p.inputPerM) / 1_000_000;
      const outputCostUSD = (totalOutputTokens * p.outputPerM) / 1_000_000;
      const cacheWriteCostUSD = (totalCacheWriteTokens * p.cacheCreationPerM) / 1_000_000;
      const cacheReadCostUSD = (totalCacheReadTokens * p.cacheReadPerM) / 1_000_000;
      // Canonical total: stored cost_usd column (COST-003).
      const totalCostUSD = Number(row.total_cost_usd);

      return {
        model: row.model,
        sessionCount: Number(row.session_count),
        totalCostUSD,
        inputCostUSD,
        outputCostUSD,
        cacheWriteCostUSD,
        cacheReadCostUSD,
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
    // Query tokens grouped by project and model so we can apply correct
    // per-model rates for the per-category breakdown. cost_usd (stored) is
    // also summed per group — it is the canonical total (COST-003).
    const sql = `
      SELECT
        COALESCE(s.project_path, 'unknown') AS project_path,
        ct.model,
        COUNT(DISTINCT s.session_id) AS session_count,
        COALESCE(SUM(ct.cost_usd), 0) AS stored_cost_usd,
        COALESCE(SUM(ct.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(ct.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(ct.cache_creation_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(ct.cache_read_tokens), 0) AS total_cache_read_tokens
      FROM sessions s
      JOIN conversation_turns ct ON ct.session_id = s.session_id AND ${costRowPredicateSql("ct")}
      WHERE s.start_time >= $1 AND s.start_time < $2
        ${f.clauses.join("\n        ")}
      GROUP BY s.project_path, ct.model
      ORDER BY project_path
    `;
    const result = await this.executor.query<{
      project_path: string;
      model: string;
      session_count: number;
      stored_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_write_tokens: number;
      total_cache_read_tokens: number;
    }>(sql, [range.start, range.end, ...f.params]);

    // Aggregate per-model rows into per-project breakdowns
    const projectMap = new Map<string, {
      sessionIds: Set<string>;
      sessionCount: number;
      storedCostUSD: number;
      inputCostUSD: number;
      outputCostUSD: number;
      cacheWriteCostUSD: number;
      cacheReadCostUSD: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheWriteTokens: number;
      totalCacheReadTokens: number;
    }>();

    for (const row of result.rows) {
      const pp = row.project_path;
      let agg = projectMap.get(pp);
      if (!agg) {
        agg = {
          sessionIds: new Set(),
          sessionCount: 0,
          storedCostUSD: 0,
          inputCostUSD: 0,
          outputCostUSD: 0,
          cacheWriteCostUSD: 0,
          cacheReadCostUSD: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheWriteTokens: 0,
          totalCacheReadTokens: 0,
        };
        projectMap.set(pp, agg);
      }

      const inTok = Number(row.total_input_tokens);
      const outTok = Number(row.total_output_tokens);
      const cwTok = Number(row.total_cache_write_tokens);
      const crTok = Number(row.total_cache_read_tokens);

      const p = getPricing(row.model);
      agg.storedCostUSD += Number(row.stored_cost_usd);
      agg.inputCostUSD += (inTok * p.inputPerM) / 1_000_000;
      agg.outputCostUSD += (outTok * p.outputPerM) / 1_000_000;
      agg.cacheWriteCostUSD += (cwTok * p.cacheCreationPerM) / 1_000_000;
      agg.cacheReadCostUSD += (crTok * p.cacheReadPerM) / 1_000_000;
      agg.totalInputTokens += inTok;
      agg.totalOutputTokens += outTok;
      agg.totalCacheWriteTokens += cwTok;
      agg.totalCacheReadTokens += crTok;
      // session_count from SQL is already per group; accumulate max across model rows
      agg.sessionCount += Number(row.session_count);
    }

    // Deduplicate session counts: re-query distinct sessions per project
    // The sessionCount from grouped rows may double-count sessions using multiple models.
    // Use a simpler sub-query for accurate count.
    const sessionCountSql = `
      SELECT
        COALESCE(s.project_path, 'unknown') AS project_path,
        COUNT(*) AS session_count
      FROM sessions s
      WHERE s.start_time >= $1 AND s.start_time < $2
        ${f.clauses.join("\n        ")}
      GROUP BY s.project_path
    `;
    const sessionCountResult = await this.executor.query<{
      project_path: string;
      session_count: number;
    }>(sessionCountSql, [range.start, range.end, ...f.params]);

    const sessionCountMap = new Map<string, number>();
    for (const row of sessionCountResult.rows) {
      sessionCountMap.set(row.project_path, Number(row.session_count));
    }

    const projects: ProjectCostBreakdown[] = [];
    for (const [projectPath, agg] of projectMap) {
      // Canonical total: SUM of the stored cost_usd column (COST-003).
      const totalCostUSD = agg.storedCostUSD;
      projects.push({
        projectPath,
        totalCostUSD,
        sessionCount: sessionCountMap.get(projectPath) ?? 0,
        tokenBreakdown: {
          totalCostUSD,
          inputCostUSD: agg.inputCostUSD,
          outputCostUSD: agg.outputCostUSD,
          cacheWriteCostUSD: agg.cacheWriteCostUSD,
          cacheReadCostUSD: agg.cacheReadCostUSD,
          totalInputTokens: agg.totalInputTokens,
          totalOutputTokens: agg.totalOutputTokens,
          totalCacheWriteTokens: agg.totalCacheWriteTokens,
          totalCacheReadTokens: agg.totalCacheReadTokens,
        },
      });
    }

    // Sort by cost descending
    projects.sort((a, b) => b.totalCostUSD - a.totalCostUSD);

    return projects;
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

    // ACT-001: bucket boundaries follow the user's local clock so a 22:30Z
    // turn rolls into the user's "today" bucket, not UTC's "today".
    const userTimezone = resolveTimezone(filters?.userTimezone);
    const f = buildTurnFilters(filters, 4);
    const localTs = wrapTimestampForTz("timestamp", "$3");
    const sql = `
      SELECT
        DATE_TRUNC('${duckBucket}', ${localTs}) AS ts,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
      FROM conversation_turns
      WHERE ${costRowPredicateSql("")}
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
      cache_creation_tokens: number;
      cache_read_tokens: number;
    }>(sql, [range.start, range.end, userTimezone, ...f.params]);

    return result.rows.map((row) => ({
      timestamp: new Date(row.ts),
      costUSD: Number(row.cost_usd),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheCreationTokens: Number(row.cache_creation_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
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
    // Group by model so we can apply correct per-model rates for the
    // per-category breakdown. cost_usd (stored) is summed too — it is the
    // canonical total (COST-003), identical to the daily/trend paths.
    const sql = `
      SELECT
        model,
        COALESCE(SUM(cost_usd), 0) AS stored_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_write_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens
      FROM conversation_turns
      WHERE ${costRowPredicateSql("")}
        AND timestamp >= $1 AND timestamp < $2
        ${f.clauses.join("\n        ")}
      GROUP BY model
    `;
    const result = await this.executor.query<{
      model: string;
      stored_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_write_tokens: number;
      total_cache_read_tokens: number;
    }>(sql, [range.start, range.end, ...f.params]);

    if (result.rows.length === 0) {
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

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalCacheReadTokens = 0;
    let inputCostUSD = 0;
    let outputCostUSD = 0;
    let cacheWriteCostUSD = 0;
    let cacheReadCostUSD = 0;
    let storedCostUSD = 0;

    for (const row of result.rows) {
      const inTok = Number(row.total_input_tokens);
      const outTok = Number(row.total_output_tokens);
      const cwTok = Number(row.total_cache_write_tokens);
      const crTok = Number(row.total_cache_read_tokens);

      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      totalCacheWriteTokens += cwTok;
      totalCacheReadTokens += crTok;
      storedCostUSD += Number(row.stored_cost_usd);

      const p = getPricing(row.model);
      inputCostUSD += (inTok * p.inputPerM) / 1_000_000;
      outputCostUSD += (outTok * p.outputPerM) / 1_000_000;
      cacheWriteCostUSD += (cwTok * p.cacheCreationPerM) / 1_000_000;
      cacheReadCostUSD += (crTok * p.cacheReadPerM) / 1_000_000;
    }

    return {
      // Canonical total: SUM of the stored cost_usd column (COST-003).
      totalCostUSD: storedCostUSD,
      inputCostUSD,
      outputCostUSD,
      cacheWriteCostUSD,
      cacheReadCostUSD,
      totalInputTokens,
      totalOutputTokens,
      totalCacheWriteTokens,
      totalCacheReadTokens,
    };
  }
}
