/**
 * @module db/unpriced-models
 *
 * Models in the database that have no pricing entry and are therefore costed
 * at the Sonnet fallback rates. Ingest warns about them, but only in a log
 * file, where the warnings for Opus 5 and Opus 5.5 went unseen for weeks; the
 * dashboard (via /api/health) and `npm run check:pricing` show this list.
 */

import { unpricedModels } from "../utils/pricing.js";

/** A model without a pricing entry and how much it was used. */
export interface UnpricedModel {
  model: string;
  /** Assistant turns in `conversation_turns`. */
  turns: number;
  /** Rows in `sub_agents` whose model it is. */
  subAgents: number;
}

/** Assistant turns and sub-agents per model. */
export const MODEL_USAGE_SQL = `
  SELECT model, SUM(turns)::BIGINT AS turns, SUM(sub_agents)::BIGINT AS sub_agents
  FROM (
    SELECT model, COUNT(*) AS turns, 0 AS sub_agents
    FROM conversation_turns
    WHERE role = 'assistant' AND model IS NOT NULL
    GROUP BY model
    UNION ALL
    SELECT model, 0 AS turns, COUNT(*) AS sub_agents
    FROM sub_agents
    WHERE model IS NOT NULL
    GROUP BY model
  )
  GROUP BY model
  ORDER BY turns DESC, sub_agents DESC`;

/** Keep the {@link MODEL_USAGE_SQL} rows whose model has no pricing entry. */
export function findUnpricedModels(
  rows: ReadonlyArray<Record<string, unknown>>,
): UnpricedModel[] {
  const unknown = new Set(unpricedModels(rows.map((r) => String(r.model))));
  return rows
    .filter((r) => unknown.has(String(r.model)))
    .map((r) => ({
      model: String(r.model),
      turns: Number(r.turns),
      subAgents: Number(r.sub_agents),
    }));
}
