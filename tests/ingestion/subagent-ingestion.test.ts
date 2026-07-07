/**
 * @module tests/ingestion/subagent-ingestion
 *
 * F-SA (migration 6) ingestion tests:
 *   1. ClaudeCodeAdapter.buildInsertionBatch sub-agent + workflow-manifest
 *      branches — the correctness core. Asserts sub-agent transcripts produce
 *      NO sessions/conversation_turns/tool_calls rows (the cost-SSOT guarantee),
 *      parent attribution keys on the record's OWN sessionId (not the dir name),
 *      and cost is the calculateCost() sum.
 *   2. FileDiscovery recursion into <session>/subagents/** + workflows/ — the
 *      gap fix — against a real temp directory tree.
 *   3. BatchInserter sub-agent/workflow inserts against an in-memory DuckDB:
 *      composite-PK behaviour (agentId not globally unique) and the
 *      stub-vs-manifest COALESCE upsert.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ClaudeCodeAdapter } from "../../src/ingestion/adapters/claude-code.js";
import { FileDiscovery } from "../../src/ingestion/file-discovery.js";
import type { DiscoveredFile } from "../../src/ingestion/file-discovery.js";
import type {
  ParsedAssistantMessage,
  ParsedUserMessage,
} from "../../src/ingestion/adapters/types.js";
import type {
  InsertionBatch,
  SubAgentRow,
  SubAgentToolCallRow,
  WorkflowRunRow,
} from "../../src/types/index.js";
import { BatchInserter } from "../../src/ingestion/batch-inserter.js";
import { SchemaManager } from "../../src/db/schema.js";
import { calculateCost } from "../../src/utils/pricing.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function subagentFile(overrides: Partial<DiscoveredFile> = {}): DiscoveredFile {
  return {
    absolutePath: "/x/proj/sess-dir/subagents/agent-abc.jsonl",
    projectPath: "/x/proj",
    sessionId: "sess-dir",
    isSidechain: true,
    sizeBytes: 100,
    modifiedAt: new Date("2026-06-01T00:00:00Z"),
    kind: "subagent",
    agentId: "abc",
    parentSessionId: "sess-dir",
    metadata: { agentType: "general-purpose", toolUseId: "toolu_parent_1" },
    ...overrides,
  };
}

function asst(
  sessionId: string,
  model: string,
  input: number,
  output: number,
  ts: string,
  opts?: { stopReason?: string; content?: unknown[] },
): ParsedAssistantMessage {
  return {
    sessionId,
    timestamp: ts,
    uuid: `u-${ts}`,
    requestId: `r-${ts}`,
    model,
    content: opts?.content ?? [],
    stopReason: opts?.stopReason,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    metadata: { gitBranch: "main" },
  };
}

// ---------------------------------------------------------------------------
// 1. adapter branches
// ---------------------------------------------------------------------------

describe("F-SA adapter: sub-agent branch", () => {
  const adapter = new ClaudeCodeAdapter(path.resolve(process.cwd()));

  it("emits ONE sub_agents row + tool calls and NO sessions/turns/tool_calls", () => {
    const file = subagentFile();
    const msgs = [
      asst("real-sess-id", "claude-haiku-4-5", 100, 50, "2026-06-01T00:00:00Z", {
        stopReason: "end_turn",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { c: "ls" } }],
      }),
    ];
    const batch = adapter.buildInsertionBatch(file, msgs, []);

    // The cost-SSOT guarantee: nothing lands in the main tables.
    expect(batch.sessions).toHaveLength(0);
    expect(batch.conversationTurns).toHaveLength(0);
    expect(batch.toolCalls).toHaveLength(0);

    expect(batch.subAgents).toHaveLength(1);
    const sa = batch.subAgents![0];
    // parent attribution = the record's OWN sessionId, NOT the dir name.
    expect(sa.parent_session_id).toBe("real-sess-id");
    expect(sa.agent_id).toBe("abc");
    expect(sa.agent_class).toBe("regular");
    expect(sa.subagent_type).toBe("general-purpose");
    expect(sa.spawn_tool_use_id).toBe("toolu_parent_1");
    expect(sa.model).toBe("claude-haiku-4-5");
    expect(sa.num_tool_calls).toBe(1);
    expect(sa.success).toBe(true);
    expect(sa.cost_usd).toBeCloseTo(
      calculateCost("claude-haiku-4-5", 100, 50, 0, 0),
      10,
    );

    expect(batch.subAgentToolCalls).toHaveLength(1);
    const tc = batch.subAgentToolCalls![0];
    expect(tc.tool_call_id).toBe("toolu_1");
    expect(tc.parent_session_id).toBe("real-sess-id");
    expect(tc.agent_id).toBe("abc");
    expect(tc.tool_name).toBe("Bash");
  });

  it("workflow sub-agent sets workflow_run_id, agent_class, and a stub workflow_runs row", () => {
    const file = subagentFile({
      workflowRunId: "wf_123",
      metadata: { agentType: "researcher" }, // workflow meta has no toolUseId
    });
    const batch = adapter.buildInsertionBatch(
      file,
      [asst("wsess", "claude-opus-4-8", 10, 5, "2026-06-01T00:00:00Z", { stopReason: "end_turn" })],
      [],
    );
    const sa = batch.subAgents![0];
    expect(sa.agent_class).toBe("workflow");
    expect(sa.workflow_run_id).toBe("wf_123");
    expect(sa.spawn_tool_use_id).toBeNull();
    expect(sa.subagent_type).toBe("researcher");

    expect(batch.workflowRuns).toHaveLength(1);
    expect(batch.workflowRuns![0].run_id).toBe("wf_123");
    expect(batch.workflowRuns![0].source_file).toBeNull(); // it is a stub
  });

  it("workflow-manifest branch maps the manifest into a workflow_runs row", () => {
    const manifestFile: DiscoveredFile = {
      absolutePath: "/x/proj/sess-A/workflows/wf_123.json",
      projectPath: "/x/proj",
      sessionId: "sess-A",
      isSidechain: false,
      sizeBytes: 200,
      modifiedAt: new Date("2026-06-01T00:00:00Z"),
      kind: "workflow-manifest",
      parentSessionId: "sess-A",
      workflowRunId: "wf_123",
      metadata: {
        runId: "wf_123",
        taskId: "t1",
        workflowName: "demo",
        summary: "s",
        status: "completed",
        defaultModel: "claude-fable-5[1m]",
        agentCount: 9,
        totalTokens: 440437,
        totalToolCalls: 84,
        startTime: 1781193857218,
        durationMs: 866279,
        phases: [{ title: "a" }, { title: "b" }, { title: "c" }],
      },
    };
    const batch = adapter.buildInsertionBatch(manifestFile, [], []);
    expect(batch.subAgents ?? []).toHaveLength(0);
    expect(batch.workflowRuns).toHaveLength(1);
    const w = batch.workflowRuns![0];
    expect(w.run_id).toBe("wf_123");
    expect(w.workflow_name).toBe("demo");
    expect(w.status).toBe("completed");
    expect(w.num_phases).toBe(3);
    expect(w.manifest_agent_count).toBe(9);
    expect(w.duration_seconds).toBeCloseTo(866.279, 3);
    expect(w.source_file).toBe(manifestFile.absolutePath);
  });
});

// ---------------------------------------------------------------------------
// 2. discovery recursion
// ---------------------------------------------------------------------------

describe("F-SA FileDiscovery recursion", () => {
  let claudeDir: string;

  beforeAll(() => {
    claudeDir = mkdtempSync(path.join(tmpdir(), "ccanalytics-fsa-"));
    const proj = path.join(claudeDir, "projects", "-test-proj");
    const sess = path.join(proj, "sessX");
    mkdirSync(path.join(sess, "subagents", "workflows", "wf_1"), { recursive: true });
    mkdirSync(path.join(sess, "workflows"), { recursive: true });

    const line = JSON.stringify({ type: "assistant", sessionId: "sessX" }) + "\n";
    // top-level session file
    writeFileSync(path.join(proj, "sessX.jsonl"), line);
    // regular sub-agent + its meta.json sidecar
    writeFileSync(path.join(sess, "subagents", "agent-r1.jsonl"), line);
    writeFileSync(
      path.join(sess, "subagents", "agent-r1.meta.json"),
      JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_x" }),
    );
    // workflow sub-agent (one level deeper) + meta
    writeFileSync(path.join(sess, "subagents", "workflows", "wf_1", "agent-w1.jsonl"), line);
    writeFileSync(
      path.join(sess, "subagents", "workflows", "wf_1", "agent-w1.meta.json"),
      JSON.stringify({ agentType: "worker" }),
    );
    // workflow manifest
    writeFileSync(
      path.join(sess, "workflows", "wf_1.json"),
      JSON.stringify({ runId: "wf_1", workflowName: "demo", status: "completed" }),
    );
  });

  afterAll(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("discovers the session, both sub-agents, and the manifest; skips *.meta.json", async () => {
    const files = await new FileDiscovery(claudeDir).discoverFiles();

    expect(files.filter((f) => f.kind === "session")).toHaveLength(1);
    expect(files.filter((f) => f.kind === "subagent")).toHaveLength(2);
    expect(files.filter((f) => f.kind === "workflow-manifest")).toHaveLength(1);
    // No *.meta.json surfaced as a discovered file.
    expect(files.some((f) => f.absolutePath.endsWith(".meta.json"))).toBe(false);

    const reg = files.find((f) => f.kind === "subagent" && f.agentId === "r1")!;
    expect(reg.workflowRunId).toBeUndefined();
    expect((reg.metadata as Record<string, unknown>)?.agentType).toBe("general-purpose");

    const wf = files.find((f) => f.kind === "subagent" && f.agentId === "w1")!;
    expect(wf.workflowRunId).toBe("wf_1");

    const man = files.find((f) => f.kind === "workflow-manifest")!;
    expect(man.workflowRunId).toBe("wf_1");
    expect((man.metadata as Record<string, unknown>)?.workflowName).toBe("demo");
  });
});

// ---------------------------------------------------------------------------
// 3. inserter (in-memory DuckDB)
// ---------------------------------------------------------------------------

function batchWith(overrides: Partial<InsertionBatch>): InsertionBatch {
  return {
    sessions: [],
    conversationTurns: [],
    toolCalls: [],
    errors: [],
    sessionSkills: [],
    ...overrides,
  };
}

function saRow(parent: string, agentId: string, cost: number): SubAgentRow {
  return {
    parent_session_id: parent,
    agent_id: agentId,
    session_dir: parent,
    agent_class: "regular",
    subagent_type: "general-purpose",
    workflow_run_id: null,
    spawn_tool_use_id: null,
    spawn_depth: null,
    is_fork: null,
    workflow_label: null,
    workflow_phase: null,
    entrypoint: null,
    model: "claude-haiku-4-5",
    git_branch: null,
    start_time: new Date("2026-06-01T00:00:00Z"),
    end_time: null,
    duration_seconds: null,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: cost,
    num_turns: 1,
    num_tool_calls: 0,
    success: true,
    project_path: "/x/proj",
    source_file: `/x/proj/${parent}/subagents/agent-${agentId}.jsonl`,
  };
}

function stubRun(runId: string, parent: string): WorkflowRunRow {
  return {
    run_id: runId,
    parent_session_id: parent,
    task_id: null,
    workflow_name: null,
    summary: null,
    status: null,
    default_model: null,
    num_phases: null,
    manifest_agent_count: null,
    manifest_total_tokens: null,
    manifest_total_tool_calls: null,
    start_time: null,
    end_time: null,
    duration_seconds: null,
    source_file: null,
  };
}

describe("F-SA BatchInserter", () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  let inserter: BatchInserter;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
    // initialize() creates the full schema incl. migration-6 tables + views.
    await new SchemaManager().initialize(connection);
    inserter = new BatchInserter({ getConnection: () => connection });
  });

  afterAll(() => {
    connection.closeSync();
  });

  async function scalar(sql: string): Promise<number> {
    const reader = await connection.runAndReadAll(sql);
    const rows = reader.getRowObjectsJS() as Array<Record<string, unknown>>;
    return Number(Object.values(rows[0] ?? { x: 0 })[0]);
  }

  it("keeps same agent_id under different sessions as distinct rows (composite PK)", async () => {
    await inserter.insert(
      batchWith({ subAgents: [saRow("sess-A", "dup", 0.1), saRow("sess-B", "dup", 0.2)] }),
    );
    expect(await scalar("SELECT COUNT(*) AS n FROM sub_agents")).toBe(2);

    // Re-ingest of sess-A/dup collapses via composite ON CONFLICT (idempotent).
    await inserter.insert(batchWith({ subAgents: [saRow("sess-A", "dup", 0.1)] }));
    expect(await scalar("SELECT COUNT(*) AS n FROM sub_agents")).toBe(2);
  });

  it("inserts sub_agent_tool_calls", async () => {
    const tc: SubAgentToolCallRow = {
      tool_call_id: "toolu_sa_1",
      parent_session_id: "sess-A",
      agent_id: "dup",
      tool_name: "Read",
      tool_type: "builtin",
      mcp_server: null,
      success: true,
      error_message: null,
      parameters: { file: "x.ts" },
      skill_name: null,
      skill_caller_type: null,
    };
    await inserter.insert(batchWith({ subAgentToolCalls: [tc] }));
    expect(
      await scalar("SELECT COUNT(*) AS n FROM sub_agent_tool_calls WHERE tool_call_id = 'toolu_sa_1'"),
    ).toBe(1);
  });

  it("workflow_runs stub does not clobber a manifest, in either order", async () => {
    // Stub first, then manifest fills the fields in.
    await inserter.insert(batchWith({ workflowRuns: [stubRun("wf_x", "sess-A")] }));
    await inserter.insert(
      batchWith({
        workflowRuns: [
          { ...stubRun("wf_x", "sess-A"), workflow_name: "demo", status: "completed", source_file: "/m/wf_x.json" },
        ],
      }),
    );
    let row = (
      await connection.runAndReadAll(
        "SELECT workflow_name, status, source_file FROM workflow_runs WHERE run_id = 'wf_x'",
      )
    ).getRowObjectsJS()[0] as Record<string, unknown>;
    expect(row.workflow_name).toBe("demo");
    expect(row.status).toBe("completed");

    // A later stub (all-null fields) must NOT erase the manifest's values.
    await inserter.insert(batchWith({ workflowRuns: [stubRun("wf_x", "sess-A")] }));
    row = (
      await connection.runAndReadAll(
        "SELECT workflow_name, status FROM workflow_runs WHERE run_id = 'wf_x'",
      )
    ).getRowObjectsJS()[0] as Record<string, unknown>;
    expect(row.workflow_name).toBe("demo");
    expect(row.status).toBe("completed");
    expect(await scalar("SELECT COUNT(*) AS n FROM workflow_runs")).toBe(1);
  });
});
