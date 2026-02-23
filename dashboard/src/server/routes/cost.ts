/**
 * @module server/routes/cost
 *
 * Cost analysis API endpoints.
 * Mirrors CostAnalyzer queries with raw SQL against DuckDB.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import {
  parseFilters,
  buildTurnFilterClauses,
  buildSessionFilterClauses,
  envelope,
} from "../helpers/parseFilters.js";

const router = Router();

/**
 * GET /api/cost/total
 *
 * Get total cost breakdown (input, output, cache_write, cache_read).
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/total", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);

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

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return res.json(
        envelope(
          {
            totalCostUSD: 0,
            inputCostUSD: 0,
            outputCostUSD: 0,
            cacheWriteCostUSD: 0,
            cacheReadCostUSD: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheWriteTokens: 0,
            totalCacheReadTokens: 0,
          },
          filters.period,
        ),
      );
    }

    const totalCostUSD = Number(row.total_cost_usd);
    const totalInputTokens = Number(row.total_input_tokens);
    const totalOutputTokens = Number(row.total_output_tokens);
    const totalCacheWriteTokens = Number(row.total_cache_write_tokens);
    const totalCacheReadTokens = Number(row.total_cache_read_tokens);
    const totalTokens =
      totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens;

    res.json(
      envelope(
        {
          totalCostUSD,
          inputCostUSD: totalTokens > 0 ? totalCostUSD * (totalInputTokens / totalTokens) : 0,
          outputCostUSD: totalTokens > 0 ? totalCostUSD * (totalOutputTokens / totalTokens) : 0,
          cacheWriteCostUSD:
            totalTokens > 0 ? totalCostUSD * (totalCacheWriteTokens / totalTokens) : 0,
          cacheReadCostUSD:
            totalTokens > 0 ? totalCostUSD * (totalCacheReadTokens / totalTokens) : 0,
          totalInputTokens,
          totalOutputTokens,
          totalCacheWriteTokens,
          totalCacheReadTokens,
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cost/daily
 *
 * Get daily cost aggregation broken down by model.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/daily", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);

    const sql = `
      SELECT
        CAST(CAST(timestamp AS DATE) AS VARCHAR) AS date,
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
      GROUP BY CAST(CAST(timestamp AS DATE) AS VARCHAR), model
      ORDER BY date ASC, total_cost DESC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      date: String(row.date),
      model: row.model,
      totalCost: Number(row.total_cost),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      turnCount: Number(row.turn_count),
      sessionCount: Number(row.session_count),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cost/by-model
 *
 * Get cost broken down by model.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/by-model", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildTurnFilterClauses(filters, 3);
    const filterClauses = f.clauses.map((c) =>
      c.replace(/\bmodel\b/, "ct.model").replace(/\bsession_id\b/, "ct.session_id"),
    );

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
        AND ct.model IS NOT NULL AND ct.model NOT LIKE '<%>'
        AND ct.timestamp >= $1 AND ct.timestamp < $2
        ${filterClauses.join("\n        ")}
      GROUP BY ct.model
      ORDER BY total_cost_usd DESC
    `;

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => {
      const totalCostUSD = Number(row.total_cost_usd);
      const totalInputTokens = Number(row.total_input_tokens);
      const totalOutputTokens = Number(row.total_output_tokens);
      const totalCacheWriteTokens = Number(row.total_cache_write_tokens);
      const totalCacheReadTokens = Number(row.total_cache_read_tokens);
      const totalTokens =
        totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens;

      return {
        model: row.model,
        sessionCount: Number(row.session_count),
        totalCostUSD,
        inputCostUSD: totalTokens > 0 ? totalCostUSD * (totalInputTokens / totalTokens) : 0,
        outputCostUSD: totalTokens > 0 ? totalCostUSD * (totalOutputTokens / totalTokens) : 0,
        cacheWriteCostUSD:
          totalTokens > 0 ? totalCostUSD * (totalCacheWriteTokens / totalTokens) : 0,
        cacheReadCostUSD:
          totalTokens > 0 ? totalCostUSD * (totalCacheReadTokens / totalTokens) : 0,
        totalInputTokens,
        totalOutputTokens,
        totalCacheWriteTokens,
        totalCacheReadTokens,
      };
    });

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cost/by-project
 *
 * Get cost broken down by project.
 * Query params: ?period=7d&model=X&project=Y
 */
router.get("/by-project", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const f = buildSessionFilterClauses(filters, 3);

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

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => {
      const totalCostUSD = Number(row.total_cost_usd);
      const totalInputTokens = Number(row.total_input_tokens);
      const totalOutputTokens = Number(row.total_output_tokens);
      const totalCacheWriteTokens = Number(row.total_cache_write_tokens);
      const totalCacheReadTokens = Number(row.total_cache_read_tokens);
      const totalTokens =
        totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens;

      return {
        projectPath: row.project_path,
        totalCostUSD,
        sessionCount: Number(row.session_count),
        tokenBreakdown: {
          totalCostUSD,
          inputCostUSD: totalTokens > 0 ? totalCostUSD * (totalInputTokens / totalTokens) : 0,
          outputCostUSD: totalTokens > 0 ? totalCostUSD * (totalOutputTokens / totalTokens) : 0,
          cacheWriteCostUSD:
            totalTokens > 0 ? totalCostUSD * (totalCacheWriteTokens / totalTokens) : 0,
          cacheReadCostUSD:
            totalTokens > 0 ? totalCostUSD * (totalCacheReadTokens / totalTokens) : 0,
          totalInputTokens,
          totalOutputTokens,
          totalCacheWriteTokens,
          totalCacheReadTokens,
        },
      };
    });

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cost/trend
 *
 * Get cost trending over time, bucketed by day (default) or specified bucket.
 * Query params: ?period=7d&bucket=day&model=X&project=Y
 */
router.get("/trend", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const bucket = (req.query.bucket as string) || "day";
    const validBuckets: Record<string, string> = {
      hour: "hour",
      day: "day",
      week: "week",
      month: "month",
    };
    const duckBucket = validBuckets[bucket];
    if (!duckBucket) {
      return res.status(400).json({
        error: `Invalid time bucket: ${bucket}. Valid values: hour, day, week, month`,
      });
    }

    const f = buildTurnFilterClauses(filters, 3);

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

    const result = await query(sql, [
      filters.range.start,
      filters.range.end,
      ...f.params,
    ]);

    const rows = result.rows.map((row: Record<string, unknown>) => ({
      timestamp: new Date(row.ts as string).toISOString(),
      costUSD: Number(row.cost_usd),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    }));

    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

export default router;
