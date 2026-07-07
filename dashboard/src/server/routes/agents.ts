/**
 * @module server/routes/agents
 *
 * F-SA: Sub-Agent & Dynamic-Workflow analytics endpoints. Reads the migration-6
 * tables (sub_agents / sub_agent_tool_calls / workflow_runs) and the
 * v_session_orchestration view.
 *
 * sub_agents carries its OWN start_time / model / project_path, so the
 * period/model/project filters apply directly to it — no conversation_turns
 * join is needed (unlike the tool routes). Sub-agent cost lives only in
 * sub_agents.cost_usd, so nothing here touches the main cost SSOT.
 */

import { Router } from "express";
import { query } from "../helpers/db.js";
import { parseFilters, envelope, type ParsedFilters } from "../helpers/parseFilters.js";

const router = Router();

/**
 * WHERE fragments for the `sub_agents` table (its own model / project_path
 * columns). `$1`/`$2` are always the start_time window; extra binds start at
 * `startIndex`.
 */
function subAgentClauses(
  filters: ParsedFilters,
  startIndex: number,
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;
  if (filters.model) {
    clauses.push(`AND model LIKE '%' || $${i} || '%'`);
    params.push(filters.model);
    i++;
  }
  if (filters.project) {
    clauses.push(`AND project_path LIKE '%' || $${i} || '%'`);
    params.push(filters.project);
    i++;
  }
  return { clauses, params };
}

/** DuckDB TIMESTAMP → ISO string (or null). */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * GET /api/agents/summary — KPI cards. All figures respect period/model/project.
 * `blendedCostUSD` = orchestration + the main cost of the orchestrating
 * sessions; it is the ONLY place main + sub cost are added.
 */
router.get("/summary", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const { clauses, params } = subAgentClauses(filters, 3);
    const c = clauses.join("\n        ");
    const sql = `
      WITH sa AS (
        SELECT * FROM sub_agents
        WHERE start_time >= $1 AND start_time < $2
        ${c}
      ),
      per_session AS (
        SELECT parent_session_id, COUNT(*) AS n FROM sa GROUP BY parent_session_id
      ),
      top_type AS (
        SELECT COALESCE(subagent_type, '(unknown)') AS t, COUNT(*) AS n
        FROM sa GROUP BY COALESCE(subagent_type, '(unknown)')
        ORDER BY n DESC, t ASC LIMIT 1
      )
      SELECT
        (SELECT COUNT(*) FROM sa) AS total_sub_agents,
        (SELECT COUNT(DISTINCT parent_session_id) FROM sa) AS orchestrating_sessions,
        (SELECT COUNT(DISTINCT workflow_run_id) FROM sa WHERE workflow_run_id IS NOT NULL) AS workflow_runs,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM sa) AS orchestration_cost_usd,
        (SELECT COALESCE(SUM(num_tool_calls), 0) FROM sa) AS total_tool_calls,
        (SELECT COALESCE(MAX(spawn_depth), 0) FROM sa) AS max_spawn_depth,
        (SELECT COALESCE(MAX(n), 0) FROM per_session) AS max_fan_out,
        (SELECT t FROM top_type) AS top_subagent_type,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM conversation_turns
           WHERE session_id IN (SELECT parent_session_id FROM per_session)) AS main_cost_usd
    `;
    const result = await query(sql, [filters.range.start, filters.range.end, ...params]);
    const r = (result.rows[0] ?? {}) as Record<string, unknown>;

    const totalSubAgents = Number(r.total_sub_agents ?? 0);
    const orchestratingSessions = Number(r.orchestrating_sessions ?? 0);
    const orchestrationCostUSD = Number(r.orchestration_cost_usd ?? 0);
    const mainCostUSD = Number(r.main_cost_usd ?? 0);
    const blendedCostUSD = orchestrationCostUSD + mainCostUSD;

    res.json(
      envelope(
        {
          totalSubAgents,
          workflowRuns: Number(r.workflow_runs ?? 0),
          orchestratingSessions,
          avgFanOut: orchestratingSessions > 0 ? totalSubAgents / orchestratingSessions : 0,
          maxFanOut: Number(r.max_fan_out ?? 0),
          maxSpawnDepth: Number(r.max_spawn_depth ?? 0),
          topSubagentType: (r.top_subagent_type as string | null) ?? null,
          totalToolCalls: Number(r.total_tool_calls ?? 0),
          orchestrationCostUSD,
          blendedCostUSD,
          orchestrationCostPct: blendedCostUSD > 0 ? orchestrationCostUSD / blendedCostUSD : 0,
        },
        filters.period,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agents/by-type — per subagent_type rollup (inline v_subagent_usage,
 * period/model/project-filtered).
 */
router.get("/by-type", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const { clauses, params } = subAgentClauses(filters, 3);
    const sql = `
      WITH sa AS (
        SELECT * FROM sub_agents
        WHERE start_time >= $1 AND start_time < $2
        ${clauses.join("\n        ")}
      )
      SELECT
        COALESCE(subagent_type, '(unknown)') AS subagent_type,
        COUNT(*) AS agent_runs,
        SUM(cost_usd) AS total_cost_usd,
        SUM(input_tokens + output_tokens) AS total_tokens,
        SUM(num_tool_calls) AS total_tool_calls,
        AVG(num_turns) AS avg_turns,
        CASE
          WHEN COUNT(*) FILTER (WHERE success IS NOT NULL) > 0
          THEN COUNT(*) FILTER (WHERE success = TRUE)::DOUBLE /
               COUNT(*) FILTER (WHERE success IS NOT NULL)::DOUBLE
          ELSE NULL
        END AS success_rate
      FROM sa
      GROUP BY COALESCE(subagent_type, '(unknown)')
      ORDER BY total_cost_usd DESC
    `;
    const result = await query(sql, [filters.range.start, filters.range.end, ...params]);
    const total = result.rows.reduce(
      (s, row) => s + Number((row as Record<string, unknown>).agent_runs),
      0,
    );
    const rows = result.rows.map((row: Record<string, unknown>) => {
      const agentRuns = Number(row.agent_runs);
      return {
        subagentType: row.subagent_type as string,
        agentRuns,
        pct: total > 0 ? agentRuns / total : 0,
        totalCostUSD: Number(row.total_cost_usd),
        totalTokens: Number(row.total_tokens),
        totalToolCalls: Number(row.total_tool_calls),
        avgTurns: row.avg_turns != null ? Number(row.avg_turns) : 0,
        successRate: row.success_rate != null ? Number(row.success_rate) : null,
      };
    });
    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agents/workflows — one row per dynamic-workflow RUN with agents in
 * the period. `agentsObserved` = COUNT(sub_agents) is authoritative over the
 * manifest's agent count.
 */
router.get("/workflows", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const { clauses, params } = subAgentClauses(filters, 3);
    const sql = `
      WITH sa AS (
        SELECT * FROM sub_agents
        WHERE start_time >= $1 AND start_time < $2
          AND workflow_run_id IS NOT NULL
        ${clauses.join("\n        ")}
      ),
      agg AS (
        SELECT
          workflow_run_id,
          COUNT(*) AS agents_observed,
          SUM(cost_usd) AS total_cost_usd,
          SUM(num_tool_calls) AS total_tool_calls
        FROM sa GROUP BY workflow_run_id
      )
      SELECT
        w.run_id, w.parent_session_id, w.workflow_name, w.status, w.num_phases,
        w.duration_seconds, w.start_time,
        a.agents_observed, a.total_cost_usd, a.total_tool_calls,
        CASE WHEN COALESCE(w.num_phases, 0) > 0
             THEN a.agents_observed::DOUBLE / w.num_phases::DOUBLE
             ELSE NULL END AS fan_out_per_phase
      FROM agg a
      JOIN workflow_runs w ON w.run_id = a.workflow_run_id
      ORDER BY a.total_cost_usd DESC
      LIMIT 100
    `;
    const result = await query(sql, [filters.range.start, filters.range.end, ...params]);
    const rows = result.rows.map((row: Record<string, unknown>) => ({
      runId: row.run_id as string,
      parentSessionId: (row.parent_session_id as string | null) ?? null,
      workflowName: (row.workflow_name as string | null) ?? null,
      status: (row.status as string | null) ?? null,
      numPhases: row.num_phases != null ? Number(row.num_phases) : null,
      agentsObserved: Number(row.agents_observed),
      fanOutPerPhase: row.fan_out_per_phase != null ? Number(row.fan_out_per_phase) : null,
      totalCostUSD: Number(row.total_cost_usd),
      totalToolCalls: Number(row.total_tool_calls),
      durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
      startTime: toIso(row.start_time),
    }));
    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agents/tree?sessionId= — the orchestration tree for one session:
 * session root → workflow-run nodes (children = their workflow agents) +
 * regular agents as direct children. Not period-filtered (a drill-in).
 */
router.get("/tree", async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId query param is required" });
    }
    const [agents, wfs, sess] = await Promise.all([
      query(
        `SELECT agent_id, subagent_type, workflow_run_id, cost_usd
         FROM sub_agents WHERE parent_session_id = $1 ORDER BY start_time NULLS LAST`,
        [sessionId],
      ),
      query(
        `SELECT run_id, workflow_name FROM workflow_runs
         WHERE run_id IN (SELECT DISTINCT workflow_run_id FROM sub_agents
                          WHERE parent_session_id = $1 AND workflow_run_id IS NOT NULL)`,
        [sessionId],
      ),
      query(`SELECT project_name FROM sessions WHERE session_id = $1`, [sessionId]),
    ]);

    interface TreeNode {
      id: string;
      label: string;
      kind: "session" | "workflow" | "agent";
      subagentType?: string;
      costUSD?: number;
      children: TreeNode[];
    }

    const wfNodes = new Map<string, TreeNode>();
    for (const w of wfs.rows as Array<Record<string, unknown>>) {
      const runId = w.run_id as string;
      wfNodes.set(runId, {
        id: runId,
        label: (w.workflow_name as string | null) ?? runId,
        kind: "workflow",
        costUSD: 0,
        children: [],
      });
    }

    const regular: TreeNode[] = [];
    for (const a of agents.rows as Array<Record<string, unknown>>) {
      const agentId = a.agent_id as string;
      const subagentType = (a.subagent_type as string | null) ?? undefined;
      const cost = Number(a.cost_usd ?? 0);
      const node: TreeNode = {
        id: agentId,
        label: subagentType ?? agentId.slice(0, 10),
        kind: "agent",
        subagentType,
        costUSD: cost,
        children: [],
      };
      const wfId = a.workflow_run_id as string | null;
      const wf = wfId ? wfNodes.get(wfId) : undefined;
      if (wf) {
        wf.children.push(node);
        wf.costUSD = (wf.costUSD ?? 0) + cost;
      } else {
        regular.push(node);
      }
    }

    const sessRow = sess.rows[0] as Record<string, unknown> | undefined;
    const root: TreeNode = {
      id: sessionId,
      label: (sessRow?.project_name as string | null) ?? sessionId.slice(0, 10),
      kind: "session",
      children: [...wfNodes.values(), ...regular],
    };
    res.json(envelope(root, "all"));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agents/timeline?sessionId= — one lane per sub-agent
 * (start_time..end_time) for the parallel-agent Gantt. Overlaps = concurrency.
 */
router.get("/timeline", async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId query param is required" });
    }
    const result = await query(
      `SELECT agent_id, subagent_type, start_time, end_time, num_turns, num_tool_calls, cost_usd
       FROM sub_agents
       WHERE parent_session_id = $1 AND start_time IS NOT NULL
       ORDER BY start_time`,
      [sessionId],
    );
    const lanes = result.rows.map((row: Record<string, unknown>) => {
      const start = toIso(row.start_time) ?? new Date(0).toISOString();
      return {
        agentId: row.agent_id as string,
        subagentType: (row.subagent_type as string | null) ?? null,
        start,
        end: toIso(row.end_time) ?? start,
        turns: Number(row.num_turns ?? 0),
        toolCalls: Number(row.num_tool_calls ?? 0),
        costUSD: Number(row.cost_usd ?? 0),
      };
    });
    let windowStart = lanes.length ? lanes[0]!.start : new Date().toISOString();
    let windowEnd = windowStart;
    for (const l of lanes) {
      if (l.start < windowStart) windowStart = l.start;
      if (l.end > windowEnd) windowEnd = l.end;
    }
    res.json(envelope({ windowStart, windowEnd, lanes }, "all"));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agents/cost-attribution — per orchestrating session, the main vs
 * orchestration cost split (from v_session_orchestration).
 */
router.get("/cost-attribution", async (req, res, next) => {
  try {
    const filters = parseFilters(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 25, 1), 200);
    const sql = `
      SELECT session_id, project_name, main_cost_usd, orchestration_cost_usd,
             orchestration_cost_share, sub_agents_spawned
      FROM v_session_orchestration
      ORDER BY orchestration_cost_usd DESC
      LIMIT $1
    `;
    const result = await query(sql, [limit]);
    const rows = result.rows.map((row: Record<string, unknown>) => ({
      sessionId: row.session_id as string,
      projectName: (row.project_name as string | null) ?? null,
      mainCostUSD: Number(row.main_cost_usd),
      orchestrationCostUSD: Number(row.orchestration_cost_usd),
      orchestrationCostPct: Number(row.orchestration_cost_share),
      subAgentsSpawned: Number(row.sub_agents_spawned),
    }));
    res.json(envelope(rows, filters.period));
  } catch (err) {
    next(err);
  }
});

export default router;
