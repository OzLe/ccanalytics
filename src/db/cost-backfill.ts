/**
 * @module db/cost-backfill
 *
 * The UPDATE statements `npm run backfill:costs` (scripts/backfill-costs.ts)
 * runs after a rate change (COST-002). Each recomputes a stored cost column
 * from its token columns × the rates in utils/pricing — the arithmetic
 * `calculateCost()` applies at ingest — so re-running is idempotent. They only
 * touch cost columns; row counts cannot change.
 */

import { buildRateCaseSql } from "../utils/pricing.js";

/**
 * Cost of one row from its token columns. `conversation_turns` and
 * `sub_agents` share the column names.
 */
function costFromTokensSql(): string {
  return [
    `input_tokens          * (${buildRateCaseSql("inputPerM")})         / 1000000.0`,
    `output_tokens         * (${buildRateCaseSql("outputPerM")})        / 1000000.0`,
    `cache_creation_tokens * (${buildRateCaseSql("cacheCreationPerM")}) / 1000000.0`,
    `cache_read_tokens     * (${buildRateCaseSql("cacheReadPerM")})     / 1000000.0`,
  ].join("\n    + ");
}

/** Recompute every turn's `cost_usd` from its tokens and model. */
export function turnCostUpdateSql(): string {
  return `UPDATE conversation_turns\nSET cost_usd =\n      ${costFromTokensSql()}`;
}

/**
 * Recompute every session's `total_cost_usd` as the sum of its turns' costs;
 * sessions without turns get 0 (this also resolves COST-004, the session
 * aggregate drifting from its child rows).
 */
export function sessionCostUpdateSql(): string {
  return `UPDATE sessions AS s
SET total_cost_usd = COALESCE(
  (SELECT SUM(ct.cost_usd) FROM conversation_turns ct
   WHERE ct.session_id = s.session_id),
  0.0
)`;
}

/**
 * Recompute `cost_usd` for the sub-agents of models whose rates changed.
 *
 * Ingest sums `calculateCost()` per turn with each turn's model, but the table
 * keeps only token totals and the agent's dominant model, so a recompute is
 * exact only for an agent that ran on one model. Most do (all 355 sub-agent
 * transcripts on disk on 2026-09-28), but a few older agents mixed models, and
 * for those the stored per-turn cost is the better number. A rate change moves
 * the cost of every agent of that model, while mixing moves a few; so only
 * models where most agents' stored cost disagrees with the current rates are
 * recomputed. A second run changes nothing.
 */
export function subAgentCostUpdateSql(): string {
  const cost = costFromTokensSql();
  return `UPDATE sub_agents
SET cost_usd =
      ${cost}
WHERE COALESCE(model, '') IN (
  SELECT COALESCE(model, '') FROM sub_agents
  GROUP BY COALESCE(model, '')
  HAVING AVG(CASE WHEN ABS(cost_usd - (
      ${cost}
    )) > 0.000001 THEN 1.0 ELSE 0.0 END) > 0.5
)`;
}
