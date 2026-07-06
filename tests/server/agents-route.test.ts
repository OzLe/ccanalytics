/**
 * @module tests/server/agents-route
 *
 * Integration tests for /api/agents/* (F-SA). Mounts the agents router on a
 * real express app against a temp DuckDB seeded with sessions +
 * conversation_turns + sub_agents + workflow_runs + the v_session_orchestration
 * view, then asserts each endpoint's shape and key values.
 *
 * Fixture: session sess-A ($1.00 main cost) that spawned 3 sub-agents —
 * 2 workflow agents (type general-purpose, run wf_1) at $0.25 + $0.35 and one
 * regular agent (type Explore) at $0.10. Orchestration total = $0.70.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express, { type Express } from "express";

interface Handle {
  baseUrl: string;
  close: () => Promise<void>;
}

async function bootRouter(): Promise<Handle> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccanalytics-agents-"));
  const dbPath = path.join(tmpDir, "test.duckdb");
  process.env.DB_PATH = dbPath;
  process.env.CCANALYTICS_CONFIG_PATH = path.join(tmpDir, "config.json");

  const { default: agentsRouter } = await import(
    "../../dashboard/src/server/routes/agents.js"
  );
  const dbHelper = await import("../../dashboard/src/server/helpers/db.js");

  await dbHelper.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id VARCHAR PRIMARY KEY,
      project_name VARCHAR,
      project_path VARCHAR,
      model VARCHAR,
      source_type VARCHAR,
      start_time TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS conversation_turns (
      turn_id VARCHAR PRIMARY KEY,
      session_id VARCHAR,
      role VARCHAR,
      timestamp TIMESTAMP,
      cost_usd DOUBLE
    );
    CREATE TABLE IF NOT EXISTS sub_agents (
      parent_session_id VARCHAR,
      agent_id VARCHAR,
      session_dir VARCHAR,
      agent_class VARCHAR,
      subagent_type VARCHAR,
      workflow_run_id VARCHAR,
      spawn_tool_use_id VARCHAR,
      spawn_depth INTEGER,
      model VARCHAR,
      start_time TIMESTAMP,
      end_time TIMESTAMP,
      input_tokens BIGINT,
      output_tokens BIGINT,
      cache_creation_tokens BIGINT,
      cache_read_tokens BIGINT,
      cost_usd DOUBLE,
      num_turns INTEGER,
      num_tool_calls INTEGER,
      success BOOLEAN,
      project_path VARCHAR,
      PRIMARY KEY (parent_session_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id VARCHAR PRIMARY KEY,
      parent_session_id VARCHAR,
      workflow_name VARCHAR,
      status VARCHAR,
      num_phases INTEGER,
      duration_seconds INTEGER,
      start_time TIMESTAMP
    );
  `);

  await dbHelper.query(`
    INSERT INTO sessions (session_id, project_name, project_path, model, source_type, start_time)
    VALUES ('sess-A', 'proj-A', '/x/proj-A', 'claude-opus-4-8', 'claude-code', '2026-07-01 09:00:00');
    INSERT INTO conversation_turns (turn_id, session_id, role, timestamp, cost_usd)
    VALUES ('t1', 'sess-A', 'assistant', '2026-07-01 09:00:00', 1.0);
    INSERT INTO sub_agents
      (parent_session_id, agent_id, agent_class, subagent_type, workflow_run_id,
       spawn_tool_use_id, spawn_depth, model, start_time, end_time,
       input_tokens, output_tokens, cost_usd, num_turns, num_tool_calls, success, project_path)
    VALUES
      ('sess-A','a1','workflow','general-purpose','wf_1', NULL, 1, 'claude-haiku-4-5',
       '2026-07-01 09:01:00','2026-07-01 09:03:00', 100, 50, 0.25, 4, 6, TRUE, '/x/proj-A'),
      ('sess-A','a2','workflow','general-purpose','wf_1', NULL, 1, 'claude-opus-4-8',
       '2026-07-01 09:02:00','2026-07-01 09:05:00', 200, 80, 0.35, 6, 8, TRUE, '/x/proj-A'),
      ('sess-A','a3','regular','Explore', NULL, 'toolu_x', NULL, 'claude-haiku-4-5',
       '2026-07-01 09:01:30','2026-07-01 09:02:00', 50, 20, 0.10, 2, 3, NULL, '/x/proj-A');
    INSERT INTO workflow_runs (run_id, parent_session_id, workflow_name, status, num_phases, duration_seconds, start_time)
    VALUES ('wf_1', 'sess-A', 'demo', 'completed', 2, 300, '2026-07-01 09:01:00');
  `);

  // v_session_orchestration is only created by initViews when the underlying
  // tables already exist; on a fresh temp DB they don't, so create it here.
  await dbHelper.query(`
    CREATE OR REPLACE VIEW v_session_orchestration AS
    WITH main AS (
      SELECT session_id, SUM(cost_usd) AS main_cost_usd FROM conversation_turns GROUP BY session_id
    ),
    sub AS (
      SELECT parent_session_id AS session_id, COUNT(*) AS sub_agents_spawned,
             SUM(cost_usd) AS orchestration_cost_usd, SUM(num_tool_calls) AS subagent_tool_calls,
             SUM(input_tokens + output_tokens) AS subagent_tokens
      FROM sub_agents GROUP BY parent_session_id
    ),
    wf AS (
      SELECT parent_session_id AS session_id, COUNT(*) AS workflow_runs
      FROM workflow_runs GROUP BY parent_session_id
    )
    SELECT s.session_id, s.project_name,
      COALESCE(sub.sub_agents_spawned, 0) AS sub_agents_spawned,
      COALESCE(wf.workflow_runs, 0) AS workflow_runs,
      COALESCE(m.main_cost_usd, 0.0) AS main_cost_usd,
      COALESCE(sub.orchestration_cost_usd, 0.0) AS orchestration_cost_usd,
      COALESCE(m.main_cost_usd, 0.0) + COALESCE(sub.orchestration_cost_usd, 0.0) AS blended_cost_usd,
      CASE WHEN COALESCE(m.main_cost_usd,0)+COALESCE(sub.orchestration_cost_usd,0) > 0
           THEN ROUND(COALESCE(sub.orchestration_cost_usd,0)::DOUBLE /
                (COALESCE(m.main_cost_usd,0)+COALESCE(sub.orchestration_cost_usd,0))::DOUBLE, 4)
           ELSE 0.0 END AS orchestration_cost_share
    FROM sessions s
    LEFT JOIN main m ON m.session_id = s.session_id
    LEFT JOIN sub ON sub.session_id = s.session_id
    LEFT JOIN wf ON wf.session_id = s.session_id
    WHERE COALESCE(sub.sub_agents_spawned,0) > 0 OR COALESCE(wf.workflow_runs,0) > 0
    ORDER BY orchestration_cost_usd DESC;
  `);

  const app: Express = express();
  app.use(express.json());
  app.use("/api/agents", agentsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dbHelper.closeDb();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("agents route (F-SA)", () => {
  let h: Handle;
  let prevDbPath: string | undefined;
  let prevConfigPath: string | undefined;

  beforeAll(async () => {
    prevDbPath = process.env.DB_PATH;
    prevConfigPath = process.env.CCANALYTICS_CONFIG_PATH;
    h = await bootRouter();
  });

  afterAll(async () => {
    await h.close();
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    if (prevConfigPath === undefined) delete process.env.CCANALYTICS_CONFIG_PATH;
    else process.env.CCANALYTICS_CONFIG_PATH = prevConfigPath;
  });

  it("/summary — KPI bundle with blended cost", async () => {
    const body = (await (
      await fetch(`${h.baseUrl}/api/agents/summary?period=all`)
    ).json()) as { data: Record<string, number | string | null> };
    const d = body.data;
    expect(d.totalSubAgents).toBe(3);
    expect(d.workflowRuns).toBe(1);
    expect(d.orchestratingSessions).toBe(1);
    expect(Number(d.orchestrationCostUSD)).toBeCloseTo(0.7, 6);
    expect(d.maxSpawnDepth).toBe(1);
    expect(d.maxFanOut).toBe(3);
    expect(Number(d.avgFanOut)).toBeCloseTo(3, 6);
    expect(d.topSubagentType).toBe("general-purpose");
    expect(Number(d.totalToolCalls)).toBe(17);
    // Blended = main (1.0) + orchestration (0.7); share = 0.7/1.7.
    expect(Number(d.blendedCostUSD)).toBeCloseTo(1.7, 6);
    expect(Number(d.orchestrationCostPct)).toBeCloseTo(0.7 / 1.7, 4);
  });

  it("/by-type — one row per subagent_type, cost-ordered", async () => {
    const body = (await (
      await fetch(`${h.baseUrl}/api/agents/by-type?period=all`)
    ).json()) as {
      data: Array<{
        subagentType: string;
        agentRuns: number;
        pct: number;
        totalCostUSD: number;
        totalTokens: number;
        totalToolCalls: number;
        successRate: number | null;
      }>;
    };
    expect(body.data).toHaveLength(2);
    const gp = body.data.find((r) => r.subagentType === "general-purpose")!;
    const ex = body.data.find((r) => r.subagentType === "Explore")!;
    expect(body.data[0]!.subagentType).toBe("general-purpose"); // cost-ordered
    expect(gp.agentRuns).toBe(2);
    expect(gp.totalCostUSD).toBeCloseTo(0.6, 6);
    expect(gp.totalTokens).toBe(430); // (100+50)+(200+80)
    expect(gp.totalToolCalls).toBe(14);
    expect(gp.successRate).toBeCloseTo(1, 6);
    expect(gp.pct).toBeCloseTo(2 / 3, 4);
    expect(ex.agentRuns).toBe(1);
    expect(ex.successRate).toBeNull(); // its only agent has NULL success
  });

  it("/workflows — authoritative agent count + fan-out per phase", async () => {
    const body = (await (
      await fetch(`${h.baseUrl}/api/agents/workflows?period=all`)
    ).json()) as {
      data: Array<{
        runId: string;
        workflowName: string | null;
        agentsObserved: number;
        numPhases: number | null;
        fanOutPerPhase: number | null;
        totalCostUSD: number;
        status: string | null;
      }>;
    };
    expect(body.data).toHaveLength(1);
    const w = body.data[0]!;
    expect(w.runId).toBe("wf_1");
    expect(w.workflowName).toBe("demo");
    expect(w.agentsObserved).toBe(2);
    expect(w.numPhases).toBe(2);
    expect(w.fanOutPerPhase).toBeCloseTo(1, 6);
    expect(w.totalCostUSD).toBeCloseTo(0.6, 6);
    expect(w.status).toBe("completed");
  });

  it("/tree — session root with a workflow node (2 children) + a regular agent", async () => {
    const body = (await (
      await fetch(`${h.baseUrl}/api/agents/tree?sessionId=sess-A`)
    ).json()) as {
      data: {
        id: string;
        kind: string;
        label: string;
        children: Array<{ id: string; kind: string; children: unknown[] }>;
      };
    };
    expect(body.data.kind).toBe("session");
    expect(body.data.label).toBe("proj-A");
    // Two top-level children: the workflow run node + the regular agent.
    expect(body.data.children).toHaveLength(2);
    const wf = body.data.children.find((c) => c.kind === "workflow")!;
    expect(wf.id).toBe("wf_1");
    expect(wf.children).toHaveLength(2); // a1 + a2
    expect(body.data.children.some((c) => c.kind === "agent")).toBe(true);
  });

  it("/tree — 400 without sessionId", async () => {
    const res = await fetch(`${h.baseUrl}/api/agents/tree`);
    expect(res.status).toBe(400);
  });

  it("/timeline — one lane per timestamped sub-agent", async () => {
    const body = (await (
      await fetch(`${h.baseUrl}/api/agents/timeline?sessionId=sess-A`)
    ).json()) as {
      data: {
        windowStart: string;
        windowEnd: string;
        lanes: Array<{ agentId: string; start: string; end: string }>;
      };
    };
    expect(body.data.lanes).toHaveLength(3);
    expect(new Date(body.data.windowStart).getTime()).toBeLessThanOrEqual(
      new Date(body.data.windowEnd).getTime(),
    );
    for (const lane of body.data.lanes) {
      expect(new Date(lane.start).getTime()).toBeLessThanOrEqual(
        new Date(lane.end).getTime(),
      );
    }
  });

  it("/cost-attribution — main vs orchestration split per session", async () => {
    const body = (await (
      await fetch(`${h.baseUrl}/api/agents/cost-attribution?period=all`)
    ).json()) as {
      data: Array<{
        sessionId: string;
        projectName: string | null;
        mainCostUSD: number;
        orchestrationCostUSD: number;
        orchestrationCostPct: number;
        subAgentsSpawned: number;
      }>;
    };
    expect(body.data).toHaveLength(1);
    const r = body.data[0]!;
    expect(r.sessionId).toBe("sess-A");
    expect(r.projectName).toBe("proj-A");
    expect(r.mainCostUSD).toBeCloseTo(1.0, 6);
    expect(r.orchestrationCostUSD).toBeCloseTo(0.7, 6);
    expect(r.orchestrationCostPct).toBeCloseTo(0.4118, 3);
    expect(r.subAgentsSpawned).toBe(3);
  });

  it("model filter narrows sub_agents to the matching model", async () => {
    // Only a2 is opus-4-8 ($0.35). haiku agents (a1, a3) are excluded.
    const body = (await (
      await fetch(`${h.baseUrl}/api/agents/summary?period=all&model=opus-4-8`)
    ).json()) as { data: { totalSubAgents: number; orchestrationCostUSD: number } };
    expect(body.data.totalSubAgents).toBe(1);
    expect(Number(body.data.orchestrationCostUSD)).toBeCloseTo(0.35, 6);
  });
});
