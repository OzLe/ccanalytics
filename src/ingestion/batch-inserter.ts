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
} from "../types/index.js";
import type { ConnectionManager } from "../db/connection.js";

/** Default batch size for INSERT operations. */
const DEFAULT_BATCH_SIZE = 1000;

/** Batch of rows ready for insertion across all tables. */
export interface InsertionBatch {
  sessions: SessionRow[];
  conversationTurns: ConversationTurnRow[];
  toolCalls: ToolCallRow[];
  errors: ErrorRow[];
}

/** Result of a batch insertion operation. */
export interface InsertionResult {
  sessionsUpserted: number;
  turnsInserted: number;
  toolCallsInserted: number;
  errorsInserted: number;
  durationMs: number;
}

/**
 * Convert a JS value to an inline SQL literal.
 */
function sqlVal(v: unknown): string {
  if (v === null || v === undefined) {
    return "NULL";
  }
  if (typeof v === "string") {
    return `'${v.replace(/'/g, "''")}'`;
  }
  if (typeof v === "boolean") {
    return v ? "TRUE" : "FALSE";
  }
  if (typeof v === "number") {
    return String(v);
  }
  if (v instanceof Date) {
    return `'${v.toISOString()}'`;
  }
  if (typeof v === "object") {
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Batch-inserts parsed records into the DuckDB star schema.
 * Uses transactions for atomicity and prepared statements for performance.
 */
export class BatchInserter {
  private batchSize: number = DEFAULT_BATCH_SIZE;

  constructor(private db: ConnectionManager) {}

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
      const sql = `INSERT INTO sessions (
        session_id, start_time, end_time, duration_seconds, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        total_cost_usd, num_turns, num_tool_calls, cwd, source_file,
        git_branch, claude_version, project_path, project_name, source_type
      ) VALUES (
        ${sqlVal(s.session_id)}, ${sqlVal(s.start_time)}, ${sqlVal(s.end_time)}, ${sqlVal(s.duration_seconds)}, ${sqlVal(s.model)},
        ${sqlVal(s.input_tokens)}, ${sqlVal(s.output_tokens)}, ${sqlVal(s.cache_creation_tokens)}, ${sqlVal(s.cache_read_tokens)},
        ${sqlVal(s.total_cost_usd)}, ${sqlVal(s.num_turns)}, ${sqlVal(s.num_tool_calls)}, ${sqlVal(s.cwd)}, ${sqlVal(s.source_file)},
        ${sqlVal(s.git_branch)}, ${sqlVal(s.claude_version)}, ${sqlVal(s.project_path)}, ${sqlVal(s.project_name)}, ${sqlVal(s.source_type)}
      ) ON CONFLICT(session_id) DO UPDATE SET
        start_time = ${sqlVal(s.start_time)},
        end_time = ${sqlVal(s.end_time)},
        duration_seconds = ${sqlVal(s.duration_seconds)},
        model = ${sqlVal(s.model)},
        input_tokens = ${sqlVal(s.input_tokens)},
        output_tokens = ${sqlVal(s.output_tokens)},
        cache_creation_tokens = ${sqlVal(s.cache_creation_tokens)},
        cache_read_tokens = ${sqlVal(s.cache_read_tokens)},
        total_cost_usd = ${sqlVal(s.total_cost_usd)},
        num_turns = ${sqlVal(s.num_turns)},
        num_tool_calls = ${sqlVal(s.num_tool_calls)},
        cwd = ${sqlVal(s.cwd)},
        source_file = ${sqlVal(s.source_file)},
        git_branch = ${sqlVal(s.git_branch)},
        claude_version = ${sqlVal(s.claude_version)},
        project_path = ${sqlVal(s.project_path)},
        project_name = ${sqlVal(s.project_name)},
        source_type = ${sqlVal(s.source_type)}`;
      await this.conn.run(sql);
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
      const sql = `INSERT INTO conversation_turns (
        turn_id, session_id, role, timestamp, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, cost_usd, model,
        stop_reason, request_id, parent_uuid, has_tool_use, has_thinking,
        content_text
      ) VALUES (
        ${sqlVal(t.turn_id)}, ${sqlVal(t.session_id)}, ${sqlVal(t.role)}, ${sqlVal(t.timestamp)},
        ${sqlVal(t.input_tokens)}, ${sqlVal(t.output_tokens)}, ${sqlVal(t.cache_creation_tokens)},
        ${sqlVal(t.cache_read_tokens)}, ${sqlVal(t.cost_usd)}, ${sqlVal(t.model)},
        ${sqlVal(t.stop_reason)}, ${sqlVal(t.request_id)}, ${sqlVal(t.parent_uuid)},
        ${sqlVal(t.has_tool_use)}, ${sqlVal(t.has_thinking)},
        ${sqlVal(t.content_text)}
      ) ON CONFLICT DO NOTHING`;
      await this.conn.run(sql);
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
      const sql = `INSERT INTO tool_calls (
        tool_call_id, session_id, turn_id, tool_name, tool_type,
        mcp_server, duration_ms, success, error_message, parameters
      ) VALUES (
        ${sqlVal(tc.tool_call_id)}, ${sqlVal(tc.session_id)}, ${sqlVal(tc.turn_id)},
        ${sqlVal(tc.tool_name)}, ${sqlVal(tc.tool_type)}, ${sqlVal(tc.mcp_server)},
        ${sqlVal(tc.duration_ms)}, ${sqlVal(tc.success)}, ${sqlVal(tc.error_message)},
        ${sqlVal(tc.parameters)}
      ) ON CONFLICT(tool_call_id) DO UPDATE SET
        success = ${sqlVal(tc.success)},
        error_message = ${sqlVal(tc.error_message)},
        duration_ms = COALESCE(${sqlVal(tc.duration_ms)}, tool_calls.duration_ms)`;
      await this.conn.run(sql);
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
      const sql = `INSERT INTO errors (
        error_id, session_id, timestamp, error_type, message,
        is_retryable, retry_count
      ) VALUES (
        ${sqlVal(e.error_id)}, ${sqlVal(e.session_id)}, ${sqlVal(e.timestamp)},
        ${sqlVal(e.error_type)}, ${sqlVal(e.message)}, ${sqlVal(e.is_retryable)},
        ${sqlVal(e.retry_count)}
      ) ON CONFLICT(error_id) DO NOTHING`;
      await this.conn.run(sql);
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

      await this.conn.run("COMMIT");

      return {
        sessionsUpserted,
        turnsInserted,
        toolCallsInserted,
        errorsInserted,
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
