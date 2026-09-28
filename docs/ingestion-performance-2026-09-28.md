# Ingestion performance: background priority and bound statements

> Investigated on 2026-09-28, after the NUL-byte fix (docs/ingestion-failure-nul-byte-2026-09-28.md) was deployed.
> Status: both causes fixed; deployment steps are in section 5.

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

## 5. Deploying

1. Merge the branch into `main`.
2. Run `npm run build` and `npm run build:dashboard`.
3. Stop the agent, back up `~/.ccanalytics/analytics.duckdb`, then run `./scripts/install-launchagent.sh`.
   It rewrites `~/Library/LaunchAgents/com.ccanalytics.web.plist` with `ProcessType` `Standard` and restarts the agent.
4. Check that the server's processes run at normal priority (`ps -o pri` shows 31, not 4), then run one ingest.
