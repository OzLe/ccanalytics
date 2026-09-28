/**
 * @module ingestion/batch-inserter
 *
 * Batch INSERT operations for the DuckDB star schema.
 * Inserts sessions, conversation turns, tool calls, and errors
 * in transactional batches for atomicity and performance.
 */

import type {
  SessionRow,
  ConversationTurnRow,
  ToolCallRow,
  ErrorRow,
  SessionSkillRow,
  SubAgentRow,
  SubAgentToolCallRow,
  WorkflowRunRow,
} from "../types/index.js";
import type { ConnectionLike } from "../db/connection.js";

/** Default batch size for INSERT operations. */
const DEFAULT_BATCH_SIZE = 1000;

/** Batch of rows ready for insertion across all tables. */
export interface InsertionBatch {
  sessions: SessionRow[];
  conversationTurns: ConversationTurnRow[];
  toolCalls: ToolCallRow[];
  errors: ErrorRow[];
  /**
   * P-07: loaded-skill rows derived from `skill_listing` attachments. Always
   * present (defaults to `[]` when a file carries no `skill_listing` record).
   */
  sessionSkills: SessionSkillRow[];
  /** F-SA: sub-agent aggregate rows (migration 6). Optional; defaults to []. */
  subAgents?: SubAgentRow[];
  /** F-SA: sub-agent tool-call rows (migration 6). Optional; defaults to []. */
  subAgentToolCalls?: SubAgentToolCallRow[];
  /** F-SA: workflow-run rows — manifest or stub (migration 6). Optional. */
  workflowRuns?: WorkflowRunRow[];
}

/** Result of a batch insertion operation. */
export interface InsertionResult {
  sessionsUpserted: number;
  turnsInserted: number;
  toolCallsInserted: number;
  errorsInserted: number;
  sessionSkillsInserted: number;
  subAgentsUpserted: number;
  subAgentToolCallsInserted: number;
  workflowRunsUpserted: number;
  durationMs: number;
}

/**
 * Renders the values of ONE statement as SQL literals, binding only text that
 * contains a NUL.
 *
 * DuckDB reads SQL text only up to the first NUL, so an inlined tool output
 * holding U+0000 cut the statement short and failed the whole file
 * (docs/ingestion-failure-nul-byte-2026-09-28.md). Such text becomes a `$n`
 * placeholder passed to `run(sql, values)`. Everything else is inlined: a
 * quoted DuckDB string has no escape other than the doubled quote, and
 * binding every value put every statement on DuckDB's slower prepare path
 * (+0.5 ms per statement; docs/ingestion-performance-2026-09-28.md).
 */
class SqlParams {
  /** Bound values, in `$1..$n` order. */
  readonly values: string[] = [];

  /** Values for `run(sql, values)`; undefined when nothing was bound. */
  get bound(): string[] | undefined {
    return this.values.length > 0 ? this.values : undefined;
  }

  /** Return `v` as an inline literal, or bind it and return its placeholder. */
  sql(v: unknown): string {
    if (v === null || v === undefined) {
      return "NULL";
    }
    if (typeof v === "boolean") {
      return v ? "TRUE" : "FALSE";
    }
    if (typeof v === "number") {
      return String(v);
    }
    const text =
      v instanceof Date ? v.toISOString()
      : typeof v === "object" ? JSON.stringify(v)
      : String(v);
    if (!text.includes("\u0000")) {
      return `'${text.replace(/'/g, "''")}'`;
    }
    this.values.push(text);
    return `$${this.values.length}`;
  }
}

/**
 * Batch-inserts parsed records into the DuckDB star schema.
 * Uses transactions for atomicity; values are rendered by {@link SqlParams}.
 */
export class BatchInserter {
  private batchSize: number = DEFAULT_BATCH_SIZE;

  constructor(private db: ConnectionLike) {}

  /**
   * Get the raw DuckDB connection for direct SQL execution.
   */
  private get conn(): any {
    return this.db.getConnection() as any;
  }

  /**
   * Insert sessions using INSERT ... ON CONFLICT for idempotent upserts.
   *
   * @param sessions - Session rows to upsert
   * @throws IngestionError on DuckDB write failure
   */
  async insertSessions(sessions: SessionRow[]): Promise<number> {
    let count = 0;
    for (const s of sessions) {
      const p = new SqlParams();
      const sql = `INSERT INTO sessions (
        session_id, start_time, end_time, duration_seconds, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        total_cost_usd, num_turns, num_tool_calls, cwd, source_file,
        git_branch, claude_version, project_path, project_name, source_type
      ) VALUES (
        ${p.sql(s.session_id)}, ${p.sql(s.start_time)}, ${p.sql(s.end_time)}, ${p.sql(s.duration_seconds)}, ${p.sql(s.model)},
        ${p.sql(s.input_tokens)}, ${p.sql(s.output_tokens)}, ${p.sql(s.cache_creation_tokens)}, ${p.sql(s.cache_read_tokens)},
        ${p.sql(s.total_cost_usd)}, ${p.sql(s.num_turns)}, ${p.sql(s.num_tool_calls)}, ${p.sql(s.cwd)}, ${p.sql(s.source_file)},
        ${p.sql(s.git_branch)}, ${p.sql(s.claude_version)}, ${p.sql(s.project_path)}, ${p.sql(s.project_name)}, ${p.sql(s.source_type)}
      ) ON CONFLICT(session_id) DO UPDATE SET
        start_time = ${p.sql(s.start_time)},
        end_time = ${p.sql(s.end_time)},
        duration_seconds = ${p.sql(s.duration_seconds)},
        model = ${p.sql(s.model)},
        input_tokens = ${p.sql(s.input_tokens)},
        output_tokens = ${p.sql(s.output_tokens)},
        cache_creation_tokens = ${p.sql(s.cache_creation_tokens)},
        cache_read_tokens = ${p.sql(s.cache_read_tokens)},
        total_cost_usd = ${p.sql(s.total_cost_usd)},
        num_turns = ${p.sql(s.num_turns)},
        num_tool_calls = ${p.sql(s.num_tool_calls)},
        cwd = ${p.sql(s.cwd)},
        source_file = ${p.sql(s.source_file)},
        git_branch = ${p.sql(s.git_branch)},
        claude_version = ${p.sql(s.claude_version)},
        project_path = ${p.sql(s.project_path)},
        project_name = ${p.sql(s.project_name)},
        source_type = ${p.sql(s.source_type)}`;
      await this.conn.run(sql, p.bound);
      count++;
    }
    return count;
  }

  /**
   * Insert conversation turns with ON CONFLICT handling for turn_id dedup.
   *
   * @param turns - Conversation turn rows to insert
   * @throws IngestionError on DuckDB write failure
   */
  async insertTurns(turns: ConversationTurnRow[]): Promise<number> {
    let count = 0;
    for (const t of turns) {
      const p = new SqlParams();
      const sql = `INSERT INTO conversation_turns (
        turn_id, session_id, role, timestamp, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, cost_usd, model,
        stop_reason, request_id, parent_uuid, has_tool_use, has_thinking,
        content_text
      ) VALUES (
        ${p.sql(t.turn_id)}, ${p.sql(t.session_id)}, ${p.sql(t.role)}, ${p.sql(t.timestamp)},
        ${p.sql(t.input_tokens)}, ${p.sql(t.output_tokens)}, ${p.sql(t.cache_creation_tokens)},
        ${p.sql(t.cache_read_tokens)}, ${p.sql(t.cost_usd)}, ${p.sql(t.model)},
        ${p.sql(t.stop_reason)}, ${p.sql(t.request_id)}, ${p.sql(t.parent_uuid)},
        ${p.sql(t.has_tool_use)}, ${p.sql(t.has_thinking)},
        ${p.sql(t.content_text)}
      ) ON CONFLICT DO NOTHING`;
      await this.conn.run(sql, p.bound);
      count++;
    }
    return count;
  }

  /**
   * Insert tool call records extracted from assistant messages.
   *
   * @param toolCalls - Tool call rows to insert
   * @throws IngestionError on DuckDB write failure
   */
  async insertToolCalls(toolCalls: ToolCallRow[]): Promise<number> {
    let count = 0;
    for (const tc of toolCalls) {
      // P-07: skill_name/skill_caller_type are populated only for Skill rows
      // (NULL otherwise) and are included in the ON CONFLICT DO UPDATE SET so
      // a Skill row first ingested before migration 5 gets its columns
      // backfilled on re-ingest. COALESCE keeps any already-set value when a
      // later re-ingest happens to pass NULL.
      const p = new SqlParams();
      const sql = `INSERT INTO tool_calls (
        tool_call_id, session_id, turn_id, tool_name, tool_type,
        mcp_server, duration_ms, success, error_message, parameters,
        skill_name, skill_caller_type
      ) VALUES (
        ${p.sql(tc.tool_call_id)}, ${p.sql(tc.session_id)}, ${p.sql(tc.turn_id)},
        ${p.sql(tc.tool_name)}, ${p.sql(tc.tool_type)}, ${p.sql(tc.mcp_server)},
        ${p.sql(tc.duration_ms)}, ${p.sql(tc.success)}, ${p.sql(tc.error_message)},
        ${p.sql(tc.parameters)},
        ${p.sql(tc.skill_name)}, ${p.sql(tc.skill_caller_type)}
      ) ON CONFLICT(tool_call_id) DO UPDATE SET
        success = ${p.sql(tc.success)},
        error_message = ${p.sql(tc.error_message)},
        duration_ms = COALESCE(${p.sql(tc.duration_ms)}, tool_calls.duration_ms),
        skill_name = COALESCE(${p.sql(tc.skill_name)}, tool_calls.skill_name),
        skill_caller_type = COALESCE(${p.sql(tc.skill_caller_type)}, tool_calls.skill_caller_type)`;
      await this.conn.run(sql, p.bound);
      count++;
    }
    return count;
  }

  /**
   * P-07: insert loaded-skill rows from `skill_listing` attachments.
   * `ON CONFLICT(session_skill_id) DO NOTHING` makes re-ingest idempotent —
   * the PK is deterministic (D4), so a re-listing already stored is a no-op
   * while a genuinely new (mid-session) re-listing lands as additional rows.
   *
   * @param sessionSkills - Session-skill rows to insert
   * @throws IngestionError on DuckDB write failure
   */
  private async insertSessionSkills(
    sessionSkills: SessionSkillRow[],
  ): Promise<number> {
    let count = 0;
    for (const ss of sessionSkills) {
      const p = new SqlParams();
      const sql = `INSERT INTO session_skills (
        session_skill_id, session_id, record_uuid, skill_name,
        skill_description, skill_count, is_initial, captured_at, source
      ) VALUES (
        ${p.sql(ss.session_skill_id)}, ${p.sql(ss.session_id)}, ${p.sql(ss.record_uuid)},
        ${p.sql(ss.skill_name)}, ${p.sql(ss.skill_description)}, ${p.sql(ss.skill_count)},
        ${p.sql(ss.is_initial)}, ${p.sql(ss.captured_at)}, ${p.sql(ss.source)}
      ) ON CONFLICT(session_skill_id) DO NOTHING`;
      await this.conn.run(sql, p.bound);
      count++;
    }
    return count;
  }

  /**
   * F-SA: upsert `sub_agents` aggregate rows. Composite-PK conflict target
   * `(parent_session_id, agent_id)` — agentId is NOT globally unique. Sub-agent
   * files are re-aggregated from the top on every change, so DO UPDATE
   * overwrites token/cost columns with the COMPLETE aggregate (never
   * accumulates). Nullable meta columns use COALESCE so a later re-ingest that
   * lost the sidecar does not erase them.
   */
  private async insertSubAgents(rows: SubAgentRow[]): Promise<number> {
    let count = 0;
    for (const s of rows) {
      const p = new SqlParams();
      const sql = `INSERT INTO sub_agents (
        parent_session_id, agent_id, session_dir, agent_class, subagent_type,
        workflow_run_id, spawn_tool_use_id, spawn_depth, is_fork, workflow_label,
        workflow_phase, entrypoint, model, git_branch, start_time, end_time,
        duration_seconds, input_tokens, output_tokens, cache_creation_tokens,
        cache_read_tokens, cost_usd, num_turns, num_tool_calls, success,
        project_path, source_file
      ) VALUES (
        ${p.sql(s.parent_session_id)}, ${p.sql(s.agent_id)}, ${p.sql(s.session_dir)},
        ${p.sql(s.agent_class)}, ${p.sql(s.subagent_type)}, ${p.sql(s.workflow_run_id)},
        ${p.sql(s.spawn_tool_use_id)}, ${p.sql(s.spawn_depth)}, ${p.sql(s.is_fork)},
        ${p.sql(s.workflow_label)}, ${p.sql(s.workflow_phase)}, ${p.sql(s.entrypoint)},
        ${p.sql(s.model)}, ${p.sql(s.git_branch)}, ${p.sql(s.start_time)}, ${p.sql(s.end_time)},
        ${p.sql(s.duration_seconds)}, ${p.sql(s.input_tokens)}, ${p.sql(s.output_tokens)},
        ${p.sql(s.cache_creation_tokens)}, ${p.sql(s.cache_read_tokens)}, ${p.sql(s.cost_usd)},
        ${p.sql(s.num_turns)}, ${p.sql(s.num_tool_calls)}, ${p.sql(s.success)},
        ${p.sql(s.project_path)}, ${p.sql(s.source_file)}
      ) ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET
        session_dir = ${p.sql(s.session_dir)},
        agent_class = ${p.sql(s.agent_class)},
        subagent_type = ${p.sql(s.subagent_type)},
        workflow_run_id = ${p.sql(s.workflow_run_id)},
        spawn_tool_use_id = COALESCE(${p.sql(s.spawn_tool_use_id)}, sub_agents.spawn_tool_use_id),
        spawn_depth = COALESCE(${p.sql(s.spawn_depth)}, sub_agents.spawn_depth),
        is_fork = COALESCE(${p.sql(s.is_fork)}, sub_agents.is_fork),
        model = ${p.sql(s.model)},
        git_branch = ${p.sql(s.git_branch)},
        start_time = ${p.sql(s.start_time)},
        end_time = ${p.sql(s.end_time)},
        duration_seconds = ${p.sql(s.duration_seconds)},
        input_tokens = ${p.sql(s.input_tokens)},
        output_tokens = ${p.sql(s.output_tokens)},
        cache_creation_tokens = ${p.sql(s.cache_creation_tokens)},
        cache_read_tokens = ${p.sql(s.cache_read_tokens)},
        cost_usd = ${p.sql(s.cost_usd)},
        num_turns = ${p.sql(s.num_turns)},
        num_tool_calls = ${p.sql(s.num_tool_calls)},
        success = ${p.sql(s.success)},
        project_path = ${p.sql(s.project_path)},
        source_file = ${p.sql(s.source_file)}`;
      await this.conn.run(sql, p.bound);
      count++;
    }
    return count;
  }

  /**
   * F-SA: insert `sub_agent_tool_calls`. PK is the globally-unique tool_use id;
   * ON CONFLICT DO UPDATE refreshes the success/error outcome on re-aggregation.
   */
  private async insertSubAgentToolCalls(
    rows: SubAgentToolCallRow[],
  ): Promise<number> {
    let count = 0;
    for (const tc of rows) {
      const p = new SqlParams();
      const sql = `INSERT INTO sub_agent_tool_calls (
        tool_call_id, parent_session_id, agent_id, tool_name, tool_type,
        mcp_server, success, error_message, parameters, skill_name, skill_caller_type
      ) VALUES (
        ${p.sql(tc.tool_call_id)}, ${p.sql(tc.parent_session_id)}, ${p.sql(tc.agent_id)},
        ${p.sql(tc.tool_name)}, ${p.sql(tc.tool_type)}, ${p.sql(tc.mcp_server)},
        ${p.sql(tc.success)}, ${p.sql(tc.error_message)}, ${p.sql(tc.parameters)},
        ${p.sql(tc.skill_name)}, ${p.sql(tc.skill_caller_type)}
      ) ON CONFLICT(tool_call_id) DO UPDATE SET
        success = ${p.sql(tc.success)},
        error_message = ${p.sql(tc.error_message)},
        skill_name = COALESCE(${p.sql(tc.skill_name)}, sub_agent_tool_calls.skill_name),
        skill_caller_type = COALESCE(${p.sql(tc.skill_caller_type)}, sub_agent_tool_calls.skill_caller_type)`;
      await this.conn.run(sql, p.bound);
      count++;
    }
    return count;
  }

  /**
   * F-SA: upsert `workflow_runs`. Sourced from a manifest (fully populated) or a
   * stub (run_id + parent only). Every mutable column uses
   * `COALESCE(new, existing)` so, regardless of manifest-vs-stub processing
   * order, a stub never erases a manifest's fields and a manifest fills them in.
   */
  private async insertWorkflowRuns(rows: WorkflowRunRow[]): Promise<number> {
    let count = 0;
    for (const w of rows) {
      const p = new SqlParams();
      const sql = `INSERT INTO workflow_runs (
        run_id, parent_session_id, task_id, workflow_name, summary, status,
        default_model, num_phases, manifest_agent_count, manifest_total_tokens,
        manifest_total_tool_calls, start_time, end_time, duration_seconds, source_file
      ) VALUES (
        ${p.sql(w.run_id)}, ${p.sql(w.parent_session_id)}, ${p.sql(w.task_id)},
        ${p.sql(w.workflow_name)}, ${p.sql(w.summary)}, ${p.sql(w.status)},
        ${p.sql(w.default_model)}, ${p.sql(w.num_phases)}, ${p.sql(w.manifest_agent_count)},
        ${p.sql(w.manifest_total_tokens)}, ${p.sql(w.manifest_total_tool_calls)},
        ${p.sql(w.start_time)}, ${p.sql(w.end_time)}, ${p.sql(w.duration_seconds)}, ${p.sql(w.source_file)}
      ) ON CONFLICT(run_id) DO UPDATE SET
        parent_session_id = COALESCE(${p.sql(w.parent_session_id)}, workflow_runs.parent_session_id),
        task_id = COALESCE(${p.sql(w.task_id)}, workflow_runs.task_id),
        workflow_name = COALESCE(${p.sql(w.workflow_name)}, workflow_runs.workflow_name),
        summary = COALESCE(${p.sql(w.summary)}, workflow_runs.summary),
        status = COALESCE(${p.sql(w.status)}, workflow_runs.status),
        default_model = COALESCE(${p.sql(w.default_model)}, workflow_runs.default_model),
        num_phases = COALESCE(${p.sql(w.num_phases)}, workflow_runs.num_phases),
        manifest_agent_count = COALESCE(${p.sql(w.manifest_agent_count)}, workflow_runs.manifest_agent_count),
        manifest_total_tokens = COALESCE(${p.sql(w.manifest_total_tokens)}, workflow_runs.manifest_total_tokens),
        manifest_total_tool_calls = COALESCE(${p.sql(w.manifest_total_tool_calls)}, workflow_runs.manifest_total_tool_calls),
        start_time = COALESCE(${p.sql(w.start_time)}, workflow_runs.start_time),
        end_time = COALESCE(${p.sql(w.end_time)}, workflow_runs.end_time),
        duration_seconds = COALESCE(${p.sql(w.duration_seconds)}, workflow_runs.duration_seconds),
        source_file = COALESCE(${p.sql(w.source_file)}, workflow_runs.source_file)`;
      await this.conn.run(sql, p.bound);
      count++;
    }
    return count;
  }

  /**
   * Insert error rows.
   *
   * @param errors - Error rows to insert
   */
  private async insertErrors(errors: ErrorRow[]): Promise<number> {
    let count = 0;
    for (const e of errors) {
      const p = new SqlParams();
      const sql = `INSERT INTO errors (
        error_id, session_id, timestamp, error_type, message,
        is_retryable, retry_count
      ) VALUES (
        ${p.sql(e.error_id)}, ${p.sql(e.session_id)}, ${p.sql(e.timestamp)},
        ${p.sql(e.error_type)}, ${p.sql(e.message)}, ${p.sql(e.is_retryable)},
        ${p.sql(e.retry_count)}
      ) ON CONFLICT(error_id) DO NOTHING`;
      await this.conn.run(sql, p.bound);
      count++;
    }
    return count;
  }

  /**
   * Insert a full batch across all tables within a single transaction.
   * Rolls back the entire batch if any insert fails.
   *
   * @param batch - Batch containing rows for all tables
   * @returns Insertion result with counts and timing
   */
  async insert(batch: InsertionBatch): Promise<InsertionResult> {
    const start = Date.now();
    try {
      await this.conn.run("BEGIN TRANSACTION");

      const sessionsUpserted = await this.insertSessions(batch.sessions);
      const turnsInserted = await this.insertTurns(batch.conversationTurns);
      const toolCallsInserted = await this.insertToolCalls(batch.toolCalls);
      const errorsInserted = await this.insertErrors(batch.errors);
      // P-07: session_skills inside the same transaction so the batch stays
      // atomic. `?? []` guards batches built before the field was added.
      const sessionSkillsInserted = await this.insertSessionSkills(
        batch.sessionSkills ?? [],
      );
      // F-SA: migration-6 tables inside the same transaction. `?? []` guards
      // batches (session/desktop) that never populate these.
      const subAgentsUpserted = await this.insertSubAgents(batch.subAgents ?? []);
      const subAgentToolCallsInserted = await this.insertSubAgentToolCalls(
        batch.subAgentToolCalls ?? [],
      );
      const workflowRunsUpserted = await this.insertWorkflowRuns(
        batch.workflowRuns ?? [],
      );

      await this.conn.run("COMMIT");

      return {
        sessionsUpserted,
        turnsInserted,
        toolCallsInserted,
        errorsInserted,
        sessionSkillsInserted,
        subAgentsUpserted,
        subAgentToolCallsInserted,
        workflowRunsUpserted,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      try {
        await this.conn.run("ROLLBACK");
      } catch {
        // Swallow rollback errors
      }
      throw err;
    }
  }

  /**
   * Set the maximum batch size before flushing.
   * @param size - Batch size (default: 1000)
   */
  setBatchSize(size: number): void {
    this.batchSize = size;
  }
}
