/**
 * @module tests/ingestion/batch-inserter-text
 *
 * Regression tests for the 2026-09-28 ingestion failure
 * (docs/ingestion-failure-nul-byte-2026-09-28.md). A sub-agent tool result
 * holding raw gzip bytes put NUL characters (U+0000) into `error_message`.
 * BatchInserter inlined every string as a SQL literal, DuckDB read the
 * statement text only up to the first NUL, and the whole file failed with
 * "unterminated quoted string" on every run.
 *
 *   1. Every insert round-trips hostile text exactly through a real in-memory
 *      DuckDB — once with NULs (bound as parameters) and once without
 *      (inlined as quoted literals) — including the ON CONFLICT DO UPDATE and
 *      COALESCE upsert paths.
 *   2. Only text containing a NUL is bound; every other statement runs as
 *      plain SQL, the faster path (docs/ingestion-performance-2026-09-28.md).
 *   3. Non-string values are stored exactly as before: timestamps, JSON
 *      parameters, booleans and numbers.
 *   4. End to end: a sub-agent transcript whose failed tool_result carries
 *      `\u0000` ingests with no failed files.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import type {
  SessionRow,
  ConversationTurnRow,
  ToolCallRow,
  ErrorRow,
  SessionSkillRow,
  SubAgentRow,
  SubAgentToolCallRow,
  WorkflowRunRow,
} from "../../src/types/index.js";
import { BatchInserter, type InsertionBatch } from "../../src/ingestion/batch-inserter.js";
import { IngestionPipeline } from "../../src/ingestion/index.js";
import { ClaudeCodeAdapter } from "../../src/ingestion/adapters/claude-code.js";
import { SchemaManager } from "../../src/db/schema.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Text that broke an inline literal (the NULs) or could break one (quotes,
 * backslashes, control characters, `$1` / `?` placeholder look-alikes).
 */
const HOSTILE =
  "Exit code 1\n\u001f\u008b\b\u0000\u0000\u0000 it's a \\ \"quote\" '' $1 ? :name\t\r\n🚀 ספט׳ \u0000end";

/** The same text without its NULs: it takes the inline-literal path. */
const HOSTILE_NO_NUL = HOSTILE.replaceAll("\u0000", "");

const T0 = new Date("2026-09-27T07:21:55.737Z");

function batchWith(overrides: Partial<InsertionBatch>): InsertionBatch {
  return {
    sessions: [],
    conversationTurns: [],
    toolCalls: [],
    errors: [],
    sessionSkills: [],
    subAgents: [],
    subAgentToolCalls: [],
    workflowRuns: [],
    ...overrides,
  };
}

function sessionRow(id: string, text: string): SessionRow {
  return {
    session_id: id,
    start_time: T0,
    end_time: null,
    duration_seconds: null,
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_cost_usd: 0.1234567,
    num_turns: 1,
    num_tool_calls: 0,
    cwd: text,
    source_file: "/x/proj/s.jsonl",
    git_branch: text,
    claude_version: "",
    project_path: "/x/proj",
    project_name: text,
    source_type: "claude-code",
  };
}

function turnRow(id: string, text: string): ConversationTurnRow {
  return {
    turn_id: id,
    session_id: "txt-sess",
    role: "assistant",
    timestamp: T0,
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0.25,
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    request_id: `req-${id}`, // request_id is UNIQUE
    parent_uuid: null,
    has_tool_use: true,
    has_thinking: false,
    content_text: text,
  };
}

function toolCallRow(id: string, error: string | null): ToolCallRow {
  return {
    tool_call_id: id,
    session_id: "txt-sess",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_type: "builtin",
    mcp_server: null,
    duration_ms: 42,
    success: error === null,
    error_message: error,
    parameters: { command: HOSTILE },
    skill_name: null,
    skill_caller_type: null,
  };
}

function subAgentRow(agentId: string, text: string): SubAgentRow {
  return {
    parent_session_id: "txt-sess",
    agent_id: agentId,
    session_dir: "txt-sess",
    agent_class: "regular",
    subagent_type: "general-purpose",
    workflow_run_id: null,
    spawn_tool_use_id: "toolu_parent",
    spawn_depth: 1,
    is_fork: false,
    workflow_label: text,
    workflow_phase: null,
    entrypoint: null,
    model: "claude-sonnet-5",
    git_branch: text,
    start_time: T0,
    end_time: null,
    duration_seconds: null,
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0.5,
    num_turns: 1,
    num_tool_calls: 1,
    success: false,
    project_path: "/x/proj",
    source_file: `/x/proj/txt-sess/subagents/agent-${agentId}.jsonl`,
  };
}

function workflowRunRow(runId: string, overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    run_id: runId,
    parent_session_id: "txt-sess",
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shared in-memory database
// ---------------------------------------------------------------------------

let instance: DuckDBInstance;
let connection: DuckDBConnection;
let inserter: BatchInserter;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
  await new SchemaManager().initialize(connection);
  inserter = new BatchInserter({ getConnection: () => connection });
});

afterAll(() => {
  connection.closeSync();
});

async function row(sql: string): Promise<Record<string, unknown>> {
  const rows = (await connection.runAndReadAll(sql)).getRowObjectsJS() as Array<
    Record<string, unknown>
  >;
  expect(rows).toHaveLength(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// 1. hostile text round-trips through every insert, bound and inlined
// ---------------------------------------------------------------------------

describe.each([
  ["with NULs, bound", HOSTILE, "b"],
  ["without NULs, inlined", HOSTILE_NO_NUL, "i"],
])("BatchInserter text round-trip, %s", (_label, text, tag) => {
  it("sessions: text columns, including on the ON CONFLICT DO UPDATE path", async () => {
    await inserter.insert(batchWith({ sessions: [sessionRow(`txt-s1-${tag}`, "first")] }));
    await inserter.insert(batchWith({ sessions: [sessionRow(`txt-s1-${tag}`, text)] }));
    const r = await row(
      `SELECT cwd, git_branch, project_name, claude_version FROM sessions WHERE session_id = 'txt-s1-${tag}'`,
    );
    expect(r.cwd).toBe(text);
    expect(r.git_branch).toBe(text);
    expect(r.project_name).toBe(text);
    expect(r.claude_version).toBe("");
  });

  it("conversation_turns: content_text", async () => {
    await inserter.insert(batchWith({ conversationTurns: [turnRow(`txt-t1-${tag}`, text)] }));
    const r = await row(
      `SELECT content_text FROM conversation_turns WHERE turn_id = 'txt-t1-${tag}'`,
    );
    expect(r.content_text).toBe(text);
  });

  it("tool_calls: error_message, including on the ON CONFLICT DO UPDATE path", async () => {
    await inserter.insert(batchWith({ toolCalls: [toolCallRow(`txt-tc1-${tag}`, "first")] }));
    await inserter.insert(batchWith({ toolCalls: [toolCallRow(`txt-tc1-${tag}`, text)] }));
    const r = await row(
      `SELECT error_message FROM tool_calls WHERE tool_call_id = 'txt-tc1-${tag}'`,
    );
    expect(r.error_message).toBe(text);
  });

  it("errors: message", async () => {
    const e: ErrorRow = {
      error_id: `txt-e1-${tag}`,
      session_id: "txt-sess",
      timestamp: T0,
      error_type: "tool_error",
      message: text,
      is_retryable: false,
      retry_count: 0,
    };
    await inserter.insert(batchWith({ errors: [e] }));
    const r = await row(`SELECT message FROM errors WHERE error_id = 'txt-e1-${tag}'`);
    expect(r.message).toBe(text);
  });

  it("session_skills: skill_description", async () => {
    const ss: SessionSkillRow = {
      session_skill_id: `txt-ss1-${tag}`,
      session_id: "txt-sess",
      record_uuid: null,
      skill_name: "demo",
      skill_description: text,
      skill_count: 1,
      is_initial: true,
      captured_at: T0,
      source: "claude-code",
    };
    await inserter.insert(batchWith({ sessionSkills: [ss] }));
    const r = await row(
      `SELECT skill_description FROM session_skills WHERE session_skill_id = 'txt-ss1-${tag}'`,
    );
    expect(r.skill_description).toBe(text);
  });

  it("sub_agents: text columns, including on the ON CONFLICT DO UPDATE path", async () => {
    await inserter.insert(batchWith({ subAgents: [subAgentRow(`txt-a1-${tag}`, text)] }));
    let r = await row(
      `SELECT workflow_label, git_branch FROM sub_agents WHERE agent_id = 'txt-a1-${tag}'`,
    );
    expect(r.workflow_label).toBe(text);
    expect(r.git_branch).toBe(text);

    // git_branch is in the DO UPDATE SET list (workflow_label is insert-only).
    await inserter.insert(
      batchWith({ subAgents: [{ ...subAgentRow(`txt-a1-${tag}`, text), git_branch: `${text} v2` }] }),
    );
    r = await row(`SELECT git_branch FROM sub_agents WHERE agent_id = 'txt-a1-${tag}'`);
    expect(r.git_branch).toBe(`${text} v2`);
  });

  it("sub_agent_tool_calls: error_message (the statement that failed in production)", async () => {
    const tc: SubAgentToolCallRow = {
      tool_call_id: `txt-satc1-${tag}`,
      parent_session_id: "txt-sess",
      agent_id: `txt-a1-${tag}`,
      tool_name: "Bash",
      tool_type: "builtin",
      mcp_server: null,
      success: false,
      error_message: text,
      parameters: { command: "head -c 600 cw-units.json" },
      skill_name: null,
      skill_caller_type: null,
    };
    await inserter.insert(batchWith({ subAgentToolCalls: [tc] }));
    const r = await row(
      `SELECT success, error_message FROM sub_agent_tool_calls WHERE tool_call_id = 'txt-satc1-${tag}'`,
    );
    expect(r.success).toBe(false);
    expect(r.error_message).toBe(text);
  });

  it("workflow_runs: summary through the COALESCE upsert, in both orders", async () => {
    await inserter.insert(
      batchWith({
        workflowRuns: [workflowRunRow(`txt-wf1-${tag}`, { summary: text, start_time: T0 })],
      }),
    );
    // A later stub (all-null fields) must not erase the manifest's values.
    await inserter.insert(batchWith({ workflowRuns: [workflowRunRow(`txt-wf1-${tag}`)] }));
    const r = await row(
      `SELECT summary, epoch_ms(start_time) AS start_ms FROM workflow_runs WHERE run_id = 'txt-wf1-${tag}'`,
    );
    expect(r.summary).toBe(text);
    expect(Number(r.start_ms)).toBe(T0.getTime());
  });
});

// ---------------------------------------------------------------------------
// 2. only text containing a NUL is bound
// ---------------------------------------------------------------------------

describe("BatchInserter statement path", () => {
  it("runs NUL-free rows as plain SQL and binds only NUL-bearing text", async () => {
    // Record the values passed with each INSERT on a pass-through connection.
    const bound: Array<unknown[] | undefined> = [];
    const spy = new Proxy(connection, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "run") {
          return (sql: string, values?: unknown[]) => {
            if (sql.startsWith("INSERT")) bound.push(values);
            return (value as (...args: unknown[]) => unknown).call(target, sql, values);
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    const spied = new BatchInserter({ getConnection: () => spy });

    await spied.insert(batchWith({ toolCalls: [toolCallRow("txt-path1", "it's plain")] }));
    await spied.insert(batchWith({ toolCalls: [toolCallRow("txt-path2", "has a \u0000 NUL")] }));

    expect(bound).toHaveLength(2);
    expect(bound[0]).toBeUndefined();
    // error_message appears twice: in VALUES and in DO UPDATE SET.
    expect(bound[1]).toEqual(["has a \u0000 NUL", "has a \u0000 NUL"]);
  });
});

// ---------------------------------------------------------------------------
// 3. non-string values are stored as before
// ---------------------------------------------------------------------------

describe("BatchInserter non-string values", () => {
  it("keeps timestamps, numbers and booleans", async () => {
    await inserter.insert(batchWith({ sessions: [sessionRow("txt-s2", "plain")] }));
    const s = await row(
      "SELECT epoch_ms(start_time) AS start_ms, end_time, total_cost_usd, input_tokens FROM sessions WHERE session_id = 'txt-s2'",
    );
    expect(Number(s.start_ms)).toBe(T0.getTime());
    expect(s.end_time).toBeNull();
    expect(s.total_cost_usd).toBe(0.1234567);
    expect(Number(s.input_tokens)).toBe(100);

    await inserter.insert(batchWith({ conversationTurns: [turnRow("txt-t2", "plain")] }));
    const t = await row(
      "SELECT epoch_ms(timestamp) AS ts_ms, cost_usd, has_tool_use, has_thinking FROM conversation_turns WHERE turn_id = 'txt-t2'",
    );
    expect(Number(t.ts_ms)).toBe(T0.getTime());
    expect(t.cost_usd).toBe(0.25);
    expect(t.has_tool_use).toBe(true);
    expect(t.has_thinking).toBe(false);
  });

  it("keeps JSON parameters queryable", async () => {
    await inserter.insert(batchWith({ toolCalls: [toolCallRow("txt-tc2", null)] }));
    const r = await row(
      "SELECT json_valid(parameters) AS ok, parameters->>'command' AS command, success, duration_ms FROM tool_calls WHERE tool_call_id = 'txt-tc2'",
    );
    expect(r.ok).toBe(true);
    expect(r.command).toBe(HOSTILE);
    expect(r.success).toBe(true);
    expect(Number(r.duration_ms)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 4. end to end: the production failure
// ---------------------------------------------------------------------------

describe("ingestion of a sub-agent transcript with NUL bytes in a tool result", () => {
  let claudeDir: string;
  // What `head -c 600` printed for a gzip-compressed download.
  const toolOutput =
    "Exit code 1\n-rw-r--r--  1 u  wheel  239067 27 ספט׳ 10:21 cw-units.json\n" +
    "\u001f\u008b\b\u0000\u0000\u0000\u0000\u0000\u0000\u0003binary";

  beforeAll(() => {
    claudeDir = mkdtempSync(path.join(tmpdir(), "ccanalytics-nul-"));
    const agentsDir = path.join(claudeDir, "projects", "-x-proj", "sessNUL", "subagents");
    mkdirSync(agentsDir, { recursive: true });
    const records = [
      {
        type: "assistant",
        sessionId: "sessNUL",
        isSidechain: true,
        timestamp: "2026-09-27T07:21:50.000Z",
        uuid: "u-a1",
        requestId: "req-a1",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_nul_1",
              name: "Bash",
              input: { command: "head -c 600 cw-units.json" },
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: "user",
        sessionId: "sessNUL",
        isSidechain: true,
        timestamp: "2026-09-27T07:21:55.737Z",
        uuid: "u-u1",
        parentUuid: "u-a1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_nul_1", is_error: true, content: toolOutput },
          ],
        },
      },
    ];
    // JSON.stringify writes each NUL as the escape \u0000, as Claude Code does.
    writeFileSync(
      path.join(agentsDir, "agent-nul1.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  });

  afterAll(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  it("reports no failed files and stores the tool output intact", async () => {
    const pipeline = new IngestionPipeline([new ClaudeCodeAdapter(claudeDir)], {
      getConnection: () => connection,
    });
    const result = await pipeline.run();

    expect(result.failedFiles).toEqual([]);
    expect(result.filesFailed).toBe(0);
    expect(result.filesProcessed).toBe(1);

    const r = await row(
      "SELECT success, error_message FROM sub_agent_tool_calls WHERE tool_call_id = 'toolu_nul_1'",
    );
    expect(r.success).toBe(false);
    expect(r.error_message).toBe(toolOutput);
    const agent = await row(
      "SELECT num_tool_calls FROM sub_agents WHERE parent_session_id = 'sessNUL' AND agent_id = 'nul1'",
    );
    expect(Number(agent.num_tool_calls)).toBe(1);
  });
});
