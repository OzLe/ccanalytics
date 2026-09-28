# Filtered queries that missed rows

> Investigated and fixed on 2026-09-28.
> Tracked in Linear as PER-44.
> Replaces the diagnosis in section 6 of docs/ingestion-performance-2026-09-28.md, which blamed the stored table data.

---

## 1. Summary

Parts of the dashboard showed incomplete data without any error.
The sub-agent tree and timeline dropped agents for 35 of the 198 sessions that have sub-agents; some showed none.
The Skills pages undercounted Skill invocations: over 7 days they reported 97 of 107 loaded skills as never invoked, where 95 was right.
Cost and token totals were not affected.

The data itself was intact.
DuckDB, the embedded database, lost entries from its lookup indexes when it replayed its write-ahead log (WAL) after a restart.
A query that DuckDB answered through such an index skipped the lost rows.

The fix upgrades DuckDB to 1.4.5, removes the 24 lookup indexes, and folds the WAL into the database file after every ingest and at every dashboard start.
The indexes gave no measurable speed benefit.
A new script, `npm run check:indexes`, proves the remaining indexes are whole.

## 2. What was wrong

Every table row was present.
The eleven PRIMARY KEY and UNIQUE indexes were complete and held no duplicate keys.
Thirteen of the 24 secondary (non-unique) indexes had lost entries, 67,584 in all (appendix A).

DuckDB decides at run time whether to answer a filter through an index.
It uses the index when the filter is selective: at most 2,048 matching rows by default.
So a per-session query went through the damaged index, while a broad query scanned the table and was right.

Two things hid the cause.
`EXPLAIN` shows a sequential scan whether or not DuckDB later switches to the index.
A `CREATE TABLE AS SELECT` copy carries no indexes, so it showed no misses.

## 3. Why it happened

DuckDB 1.4.4 dropped index entries while replaying the WAL on open.
Four measurements show it (appendix B):

- The checkpointed database file alone had no misses in `idx_turns_session_id`.
- Replaying the server's WAL on top of it left every WAL-added row missing from that index: 419 turns, 173 tool calls, 277 sub-agent tool calls.
- The running server, which wrote those rows directly, returned all of them.
- DuckDB 1.4.5 replayed the same WAL with no loss.

The WAL was replayed on almost every start.
Neither the CLI nor the dashboard closed the DuckDB instance on exit, so the log was never folded into the file.
Since February the dashboard had rebuilt eight of the indexes at every start, which hid the loss there and let it accumulate in the other sixteen.

Synthetic reproductions did not trigger the loss, so the exact trigger inside 1.4.4 is not known.
The 1.4.5 release notes do not name it either.
They do fix two related bugs: string data corrupted after a reverted append (DuckDB #22279), and an index left inconsistent by an `UPDATE` followed by `CREATE INDEX` (#21394), which is what the startup rebuild did.

## 4. The fix

1. **DuckDB 1.4.5.** Both `package.json` files pin `@duckdb/node-api` 1.4.5-r.1 exactly, because the dashboard's ingest runs CLI code in the server process.
2. **Migration 7 drops all 24 secondary indexes.** PRIMARY KEY and UNIQUE indexes stay, because `ON CONFLICT` needs them. `sql/schema.sql` no longer creates secondary indexes. Without them every dashboard query shape still answers in about a millisecond (appendix C).
3. **Checkpoints.** `runIngestion()` checkpoints after an ingest that wrote rows, and the dashboard checkpoints once at start. The WAL now holds at most one ingest's worth of data.
4. **The dashboard applies pending migrations at start.** An upgraded dashboard is correct before its first ingest. The startup index rebuild is gone.
5. **`npm run check:indexes`.** It compares every index against a full scan, key by key, and fails on any secondary index. It needs exclusive access to the database: stop the LaunchAgent or run it on a copy.

The fix changes no table data.

## 5. Verification

| Check | Result |
|---|---|
| Full suite, types, builds | 556 tests pass, including new tests for migration 7, the DuckDB pin and the post-ingest checkpoint |
| Checkpoint test on the old code | Fails: a 71,329-byte WAL is left behind |
| New dashboard started on a copy of the live database | Applied migration 7, rebuilt views and checkpointed in under 0.35 s |
| 962 API requests, old server against new, same data and settings | Only the sub-agent and Skills routes lost rows; the rest matched, apart from the 9th significant digit of float sums and which of two tied rows a `LIMIT` kept |
| Ingest through the new server | 6 files, 723 entries in 4.0 s, no WAL left |
| `check:indexes` after killing the server with `kill -9` | Every index whole, no secondary index |

## 6. Deploying

1. Merge the branch into `main`.
2. Run `npm ci` in the repository root and in `dashboard/`, then `npm run build` and `npm run build:dashboard`.
3. Stop the LaunchAgent and back up `~/.ccanalytics/analytics.duckdb` and its `.wal`.
4. Start the LaunchAgent. On its first query the server applies migration 7 and checkpoints.
5. Check the sub-agent timeline of a session that showed too few agents, and run `npm run check:indexes` on a copy of the database.

To roll back, stop the agent, restore the backup, check out the previous commit, repeat step 2 and start the agent.
The next ingest re-reads whatever the backup is missing from the transcripts.

## 7. Follow-ups, not in this change

- **DuckDB 1.5.x.** DuckDB 1.5.5 crashed with a segmentation fault in two of three runs against a copy of the live database and its 1.4.4 WAL, and the run that completed lost the same entries as 1.4.4. Upgrade only from a checkpointed database, after repeating the rehearsal above.
- **Pricing.** `claude-opus-5-5` has no pricing entry, so its 1,699 turns are costed at Sonnet rates.
- **Recovery that deletes data.** When opening fails with certain error messages, the CLI and the dashboard delete the WAL, and in some cases the whole database file. A transient error could destroy history that no longer exists in the transcripts.
- **`ccanalytics watch`** does not checkpoint after each pass, which can run every few seconds. It relies on DuckDB's 16 MB automatic checkpoint, which is safe on 1.4.5.

---

## Appendix A — Index damage in the live database

Measured on a copy taken at 13:25 on 2026-09-28, replayed with DuckDB 1.4.5 so that only damage already in the database file counts.
Indexes not listed had no misses.

| Index | Keys missing rows | Rows missing |
|---|---|---|
| `tool_calls.idx_tools_tool_name` | 199 | 31,242 |
| `sub_agent_tool_calls.idx_sub_tools_name` | 40 | 14,267 |
| `session_skills.idx_session_skills_session` | 118 | 9,848 |
| `session_skills.idx_session_skills_skill_name` | 223 | 9,848 |
| `sessions.idx_sessions_start_time` | 487 | 487 |
| `sessions.idx_sessions_project_path` | 74 | 487 |
| `errors.idx_errors_timestamp` | 449 | 451 |
| `errors.idx_errors_type` | 1 | 451 |
| `sub_agents.idx_sub_agents_session` | 36 | 210 |
| `sub_agents.idx_sub_agents_type` | 5 | 210 |
| `tool_calls.idx_tools_skill_name` | 22 | 68 |
| `sub_agents.idx_sub_agents_workflow` | 1 | 14 |
| `workflow_runs.idx_workflow_runs_session` | 1 | 1 |

A 2026-07-07 backup already had misses in `session_skills`.
A scan of the key columns found no malformed identifiers and no orphan rows, so the string corruption fixed in 1.4.5 left no visible trace there.

## Appendix B — WAL replay by DuckDB version

The same database file and the same WAL, copied from the live server, opened by each version.
Each cell counts the WAL-added rows missing from the index.

| Index | Rows the WAL added | 1.4.4 | 1.4.5 | 1.5.5 |
|---|---|---|---|---|
| `conversation_turns.idx_turns_session_id` | 419 | 419 | 0 | 419 |
| `tool_calls.idx_tools_session_id` | 173 | 173 | 0 | 173 |
| `sub_agent_tool_calls.idx_sub_tools_name` | 277 | 277 | 0 | 277 |

A WAL written by the CLI's own ingest, killed before a checkpoint, replayed without loss on 1.4.4.
The server's WAL also held the tail of the startup index rebuild, but a synthetic WAL with the same kind of statements replayed without loss too.

## Appendix C — Query time without secondary indexes

Dashboard-shaped queries as prepared statements on the full live database, DuckDB 1.4.5, median of 9 to 120 runs each.

| Query | With indexes (ms) | Without (ms) |
|---|---|---|
| Turns of one session | 1.04 | 0.97 |
| Tool calls of one session | 0.58 | 0.87 |
| Errors of one session | 0.48 | 0.46 |
| Loaded skills of one session | 0.34 | 0.54 |
| Sub-agents of one session | 0.37 | 0.39 |
| Sessions since a date | 0.91 | 0.39 |
| Daily turn cost since a date | 1.29 | 0.89 |
| Tool calls of one tool | 1.36 | 1.01 |
