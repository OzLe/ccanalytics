# Ingestion failure: NUL characters in a sub-agent transcript

> Diagnosed on 2026-09-28 against commit 0107e5a; line references in sections 3 and 4 are to that commit.
> Status: fixed (see section 5); deployment steps are in section 7.

---

## 1. Summary

One sub-agent transcript fails every ingestion run because a tool result inside it contains NUL characters (U+0000).
The batch inserter writes every value into the SQL text as an inline string literal.
DuckDB treats the NUL as the end of the statement, so the literal never closes and the statement is rejected with a parser error.
The failure is contained to that one file, but it repeats on every run and that sub-agent's data is missing from the database.
The fix binds text that contains a NUL as a statement parameter; everything else is inlined exactly as before.

## 2. The file

`~/.claude/projects/-Users-ozlevi-Development-AIEdgeGroupDev/109a6f31-0526-476b-9af4-33c3dc950941/subagents/agent-ad4b46f13df78d952.jsonl`

It is the transcript of sub-agent `ad4b46f13df78d952`, launched from session `109a6f31…` in `~/Development/AIEdgeGroupDev`.
It has 806 lines (2.5 MB) and was last written on 2026-09-27 at 10:42 local time.

Line 174 is a Bash call that downloads an AWS CloudWatch pricing file with `curl` into `cw-units.json`, prints its first 600 bytes with `head -c 600`, and parses it with Python.
The downloaded file was gzip-compressed: it starts with the gzip magic bytes `1F 8B 08`.
So `head` printed raw binary into the tool output, including 7 NUL bytes, and the Python step failed with exit code 1.

Line 176 (2026-09-27 07:21:55 UTC) holds that tool result, flagged `is_error: true`.
Claude Code stored the NULs correctly as the JSON escape `\u0000`.
The JSONL itself is valid, and the parser reports 0 parse errors for it.

## 3. Why it fails

1. JSON parsing turns each `\u0000` escape back into a real NUL character.
2. The failed tool call becomes a `sub_agent_tool_calls` row whose `error_message` is `Exit code 1`, the `ls` line and the binary bytes.
3. `sqlVal()` in `src/ingestion/batch-inserter.ts:59-79` inlines each value into the SQL text and escapes only single quotes.
   All 8 INSERT statements in that file are built this way (180 `sqlVal()` calls, no bound parameters).
4. DuckDB reads the statement text only up to the first NUL.
   The literal `'Exit code 1…` is cut off before its closing quote, and DuckDB rejects the statement (the last three bytes are shown as hex):

   ```
   Parser Error: unterminated quoted string at or near "'Exit code 1
   -rw-r--r--  1 ozlevi  wheel  239067 27 ספט׳ 10:21 cw-units.json
   \x1f\x8b\x08"

   LINE 7:         FALSE, 'Exit code 1
                          ^
   ```

   Line 7 of the `sub_agent_tool_calls` INSERT (`batch-inserter.ts:299-307`) is `success, error_message, parameters`.
   The quoted text stops exactly at the first NUL.
5. The whole file's batch runs in one transaction (`batch-inserter.ts:387-426`), so it rolls back.
   The pipeline records the file as failed (`src/ingestion/index.ts:201-207`) and does not advance its byte offset.

## 4. Impact

- **Contained.**
  Every other file ingests normally.
  The reproduction processed 12 files with new data (715 entries) alongside the one failure.
- **Data gap.**
  Nothing from this sub-agent is in the database: it has no `sub_agents` row and no `ingestion_state` row.
- **Recurring.**
  The byte offset never advances, so every dashboard or CLI ingest retries the file and fails again.
  The dashboard will keep reporting "1 files failed" until the code changes.
- **Silent.**
  The file path and error travel only in the `POST /api/ingest` response.
  The dashboard toast shows only the count (`dashboard/src/components/layout/TopBar.tsx:183`), and nothing is logged.
  The `Failed to execute prepared statement` line in `~/.ccanalytics/logs/web.err.log` is a different error, because per-file failures are never logged.
- **Latent.**
  A NUL in any text value (a main-session tool error, a prompt, a turn) would break ingestion the same way.
  This is the only file that triggers it today: failures are sticky, and it is the only file failing.

## 5. Fix

Implemented on branch `feature/ingest-nul-bytes`.

- **Bind text that contains a NUL.**
  `sqlVal()` is replaced by a per-statement `SqlParams` collector in `src/ingestion/batch-inserter.ts`.
  Text containing a NUL becomes a `$n` placeholder passed to `run(sql, values)`.
  Every other value is inlined exactly as before, so stored costs and token counts cannot shift and no backfill is needed.
  All 8 INSERT statements use it.
  The first version bound every string, Date and JSON value; that made each statement about 0.5 ms slower, so it was narrowed (docs/ingestion-performance-2026-09-28.md).
- **Name failed files.**
  `POST /api/ingest` logs each failed file and its error to the server log (`~/.ccanalytics/logs/web.err.log` under the LaunchAgent).
  The dashboard toast lists up to three failed file names with the first line of each error.
- **Tests.**
  `tests/ingestion/batch-inserter-text.test.ts` round-trips NULs, quotes, backslashes, control characters, `$1` and `?` look-alikes and non-BMP text through all 8 inserts, both bound (with NULs) and inlined (without), including the ON CONFLICT DO UPDATE and COALESCE upsert paths.
  It also checks that only NUL-bearing text is bound, that timestamps, numbers, booleans and JSON are stored as before, and ingests a sub-agent transcript with `\u0000` in a failed tool result end to end.
  `tests/server/db-concurrency.test.ts` gains a check that the dashboard's serialized connection proxy forwards bound values.

Considered and rejected:

- Stripping NULs in `sqlVal()`: a one-line change, but it silently alters stored text.
- Binding numbers too: the driver binds JS numbers as DOUBLE, so stored values could differ in the last bit from today's literals, with no benefit for this bug.

## 6. Verification

| Check | Result |
|---|---|
| New regression tests on the original code | 9 of 11 fail with the production parser error; the 2 non-string guards pass |
| New regression tests with the fix | 11 of 11 pass |
| Full suite (`vitest run`) | 47 files, 539 tests pass |
| Type checks (`src`, dashboard, new test file) | Clean |
| Full ingest of a frozen snapshot of all inputs (942 files), original vs fixed code | 941 processed and 1 failed vs 942 processed and 0 failed; 302 s vs 287 s; peak memory 946 MB vs 1,027 MB |
| Table-by-table comparison of those two databases | Identical in both directions except the previously failing sub-agent: 1 `sub_agents` row, its 115 tool calls, and its file's `ingestion_state` row |
| Incremental ingest on a fresh copy of the live database | 25 files processed, 0 failed; the sub-agent is present with 115 tool calls and $7.72 API-equivalent cost; its file is tracked to its full 2,516,414 bytes |

The snapshot holds no workflow runs, so the `workflow_runs` upsert path is covered by the unit tests only.
These results are for the first version; the narrowed version was verified again (docs/ingestion-performance-2026-09-28.md, section 4).

## 7. Deploying

1. Merge `feature/ingest-nul-bytes` into `main`.
2. Run `npm run build`: the `ccanalytics ingest` CLI runs from the `dist/cli.cjs` bundle.
3. Run `npm run build:dashboard` to ship the toast change.
4. Restart the `com.ccanalytics.web` LaunchAgent: the API server keeps the ingestion code it loaded on its first ingest.
5. Run one ingest.
   The sub-agent file is read from byte 0, so no reset or backfill is needed.

## 8. How the diagnosis was verified

- Reproduced by running the shared `runIngestion()` from source, which is the same code path as `POST /api/ingest`, against a scratchpad copy of `~/.ccanalytics/analytics.duckdb` and its WAL.
  The live database and the `com.ccanalytics.web` LaunchAgent were not touched.
- Isolated in an in-memory DuckDB (`@duckdb/node-api` 1.4.4-r.1).
  An inline literal containing a NUL fails with the same parser error.
  The NUL-stripped literal succeeds, and so does a bound parameter.
- Decoded line 176 and its originating call on line 174 directly from the JSONL.
