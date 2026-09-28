# Ingestion performance: background priority and bound statements

> Investigated on 2026-09-28, after the NUL-byte fix (docs/ingestion-failure-nul-byte-2026-09-28.md) was deployed.
> Status: both causes fixed and deployed on 2026-09-28.
> Section 6 records a separate, pre-existing storage issue found while verifying the deployment; it is not resolved.

---

## 1. Summary

After the NUL-byte fix was deployed, the first two dashboard ingests took 252 s (25 files) and 51 s (8 files).
Two separate causes were found.

1. **The dashboard server ran at background priority.**
   The LaunchAgent that runs it declared `ProcessType` `Background`.
   macOS runs such jobs at the lowest CPU priority, only on efficiency cores on Apple Silicon, with throttled disk I/O.
   On a busy machine that made every ingest about 23 times slower.
   This predates the NUL-byte fix.
2. **The NUL-byte fix made each insert about 0.5 ms slower.**
   It bound every string as a statement parameter, which puts every statement on DuckDB's slower prepare path.
   It now binds only text that actually contains a NUL.

## 2. Background priority

The same ingest was reproduced outside the server: the same code path (the dashboard's database helper and its serializing proxy), the database state from just before the first live ingest, and the live transcripts.
It took 15.8 s against 252 s in the live server.

The live server's processes ran at scheduling priority 4, against 31 for a normal process.
This Mac has 6 performance cores and 2 efficiency cores, and the load average was about 12.

Re-running the identical reproduction under background priority (`taskpolicy -b`) confirmed the cause:

| Phase | Normal priority | Background priority |
|---|---|---|
| Whole ingest (27 files, about 3,100 entries) | 15.8 s | 369.6 s |
| Inserts | 13.4 s | 287.1 s |
| Claude Desktop file discovery | 0.8 s | 55.4 s |
| Offset lookups | 0.3 s | 11.5 s |
| Parsing | 0.5 s | 8.3 s |

Every phase slows by a similar factor, which is the signature of CPU and I/O throttling rather than of a slow code path.

The fix sets `ProcessType` to `Standard` in `scripts/install-launchagent.sh`, which generates the LaunchAgent.
The server is idle between requests, so running at normal priority costs nothing when nothing is happening.
After the fix the server's processes run at priority 20, launchd's default for agents.
Only the background band (priority 4) is confined to efficiency cores and throttled.

## 3. Cost of binding every string

The NUL-byte fix passed every string, Date and JSON value as a bound parameter.
With bound values the driver makes three calls per statement (split, prepare, execute) instead of one.
DuckDB also plans each statement twice, because text bound for a TIMESTAMP or JSON column does not match the parameter type it inferred.

Per-row cost, measured with the variants interleaved in one process against the real schema and indexes (median of 5 rounds):

| Approach | tool_calls | conversation_turns |
|---|---|---|
| Original (inline literals) | 1.64 ms | 1.91 ms |
| Bind every string (the NUL-byte fix as deployed) | 2.17 ms | 2.61 ms |
| Bind every string, with typed casts | 1.98 ms | 2.31 ms |
| One prepared statement per table, reused | 1.67 ms | 1.86 ms |

Full re-ingests of all files were too noisy on this machine to resolve a difference of this size: the same code varied by 13% between runs.

Options considered:

- **Typed casts** (`$n::VARCHAR::TIMESTAMP`) stop the second planning pass but recover only part of the cost.
- **Reusing one prepared statement per table** matches the original speed, but it needs every value bound, numbers included.
  That stores some costs one bit (1 ulp) differently from before, and the dashboard's serializing proxy would also have to queue prepared-statement execution.
- **Binding only text that contains a NUL** restores the original statements exactly for every other row.
  A quoted DuckDB string has no escape other than the doubled quote, so the NUL is the only character an inline literal cannot carry.

The last option was chosen.
Statements without a NUL are byte-for-byte the ones the original code produced.

## 4. Verification

| Check | Result |
|---|---|
| Text round-trip tests | Pass on both paths: bound (with NULs) and inlined (without) |
| New statement-path test | Fails on the deployed bind-everything inserter, passes on the narrowed one |
| Full suite and type checks | 548 tests pass; `src`, dashboard and test file clean |
| Full ingest of a frozen snapshot (945 files), original vs narrowed inserter | Identical in both directions except the sub-agent the original cannot ingest (1 `sub_agents` row, 115 tool calls, 1 `ingestion_state` row); 299 s vs 289 s |
| Per-row cost, one interleaved run | tool_calls: 1.72 ms original, 2.25 ms deployed, 1.70 ms narrowed; conversation_turns: 1.94, 2.81 and 2.03 ms |
| Background priority | 15.8 s at normal priority vs 369.6 s under `taskpolicy -b`, same workload |
| Live ingest after deployment | 11 files, 1,348 entries in 7.4 s; before the fix, 8 files and 590 entries took 51 s |

## 5. Deploying

1. Merge the branch into `main`.
2. Run `npm run build` and `npm run build:dashboard`.
3. Stop the agent, back up `~/.ccanalytics/analytics.duckdb`, then run `./scripts/install-launchagent.sh`.
   It rewrites `~/Library/LaunchAgents/com.ccanalytics.web.plist` with `ProcessType` `Standard` and restarts the agent.
4. Check that the server's processes are out of the background band (`ps -o pri` shows 20; 4 means Background), then run one ingest.

## 6. Open issue: filtered queries that miss rows

Found while checking the deployment.
It predates both fixes and is not resolved.

Some filtered queries return fewer rows than the tables hold, depending on the query's shape.
The rows are present: a full scan, or the same filter written differently, returns all of them.
Confirmed in the live dashboard: after a restart, the sub-agent timeline for one session returned 7 of its 10 sub-agents.

Measured on copies of the database, an equality filter on each key against a full scan:

| Table | Keys whose rows the filter misses: 7 Jul, 28 Sep before the fixes, 28 Sep after | Rows missed now |
|---|---|---|
| `sub_agents` | 0, 24, 36 | 210 |
| `conversation_turns` | 0, 26, 4 | 369 |
| `tool_calls` | 0, 22, 4 | 152 |
| `errors` | 0, 13, 2 | 3 |
| `session_skills` | 25, 112, 118 | 9,848 |
| `sessions`, `sub_agent_tool_calls` | 0, 0, 0 | 0 |

A time filter on `sessions.start_time` in the same form counted 62 sessions since 21 September; 94 are present.
The same time filters on `conversation_turns` and `sub_agents` returned every row, so turn-based cost totals were not affected in this check.

Both query plans are sequential scans with the filter pushed into the scan, so the misses come from the stored table data, not from an index.
Copying the rows into a fresh table removes every miss.

Open before choosing a fix:

- Which dashboard queries are affected; only the query shapes above were measured.
- Which write path leaves the stored data inconsistent; the `ON CONFLICT DO UPDATE` upserts are the prime suspect.
- Whether a newer DuckDB release avoids it, so that rebuilding the tables does not just reset the clock.
