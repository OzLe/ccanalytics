# Plan: DuckDB 2.0 upgrade and housekeeping

Date: 2026-09-28.
Status: the owner chose the recommended option for D5 and D6 on 2026-09-28 (section 6); D6 is done.
Scope: step 4 of `docs/pricing-recovery-duckdb-plan-2026-09-28.md`, the DuckDB upgrade, plus leftovers from that work: the untracked Rust migration evaluation, stale PR #28 and a correction to the earlier plan.

## 1. Summary

Our database engine, DuckDB 1.4, loses community support on 2026-11-17.
DuckDB 2.0 is planned for 2026-10-21 and its first patch release, 2.0.1, for 2026-11-16.
The earlier plan chose to skip 1.5 and move to 2.0 after 2.0.1 (decision D3).

A test on a 2.0 development build, against copies of the live database, found no blocker.
All 4,822 SQL statements that the dashboard, the CLI and an ingest ran also ran on 2.0.
Their results matched, apart from two differences that are invisible today: a date type and the order of tied rows (section 3).
2.0 also kept the file in its old format, so version 1.4.5 could still open it after 2.0 had written to it.

That splits the upgrade into two stages.
Stage A swaps the engine and keeps the file format, so reinstalling 1.4.5 undoes it.
Stage B converts the file to the 2.0 format, which makes it 41% smaller but cannot be undone.

The open dependency is the Node.js package for DuckDB 2.0, which is not published yet.
If it misses 2026-11-17, stay on 1.4.5 until it ships.

## 2. Where things stand

| Version | Status on 2026-09-28 |
|---|---|
| 1.4.5 (ours, LTS) | Supported until 2026-11-17 |
| 1.5.6 | Released today; the 1.5 line ends 2026-11-01 |
| 2.0.0 | Planned for 2026-10-21, tentative |
| 2.0.1 | Planned for 2026-11-16, tentative |

2.0 brings a new default file format, a new SQL parser, a reworked C interface that client libraries build on, and a few breaking changes.
DuckDB has not said whether 2.0 is a long-term support (LTS) release; its policy since 1.4 makes every other version one.
`@duckdb/node-api`, the Node.js package we use, has no 2.0 build yet.
Its 1.4.5 and 1.5.5 builds shipped the same day as DuckDB itself, but 2.0 reworks the interface the package is built on.

1.5.6 no longer matters to us: the 1.5 line loses support two weeks before 1.4 does.

Correction to the earlier plan, whose section 1 says eight months of history exist only in the database.
Since 2026-03-14 every ingest also copies its transcripts into `~/.ccanalytics/backups/` (3,555 files, 4.0 GB), and those copies reach back to 2026-02-14.
Only 2025-12-29 to 2026-02-13 exists solely in the database.

## 3. Gates and how each closes

| Gate | Question | After today's test | Closes with |
|---|---|---|---|
| G1 | Is 2.0 an LTS release? | Open; likely, by policy | The 2.0.0 announcement |
| G2 | Does 1.4.5 still open the file after 2.0 has written to it? | Passed on the dev build | The rehearsal on the release build |
| G3 | Does our SQL give the same results on 2.0? | Passed on the dev build | The rehearsal's endpoint diff |
| G4 | Is `@duckdb/node-api` 2.0.x on npm and passing our tests? | Open | The package release |

G1 decides how long 2.0 stays supported, not whether to move: after 2026-11-17 it is the only supported line.

G2: opening the file with 2.0 changed nothing, byte for byte.
After 2.0 had written to a copy (views, an ingest, a checkpoint), the file kept its format, 1.4.5 opened it, and `npm run check:indexes` found every index whole.

G3 found two differences, neither visible in our output today:
- `DATE_TRUNC('day', …)` and `DATE_TRUNC('week', …)` return a timestamp instead of a date, with equal values.
  The API and the CLI convert both to the same JavaScript date, so their output does not change.
  The code uses `DATE_TRUNC` in 14 places.
- Rows that tie on their sort key, or come from a query without `ORDER BY`, can come back in another order.
  This affects 10 query shapes, such as tools with equal call counts.
  It can also happen between two runs of the same version, and it would make the rehearsal's endpoint diff noisy.

The earlier plan's gate on 1.5.6 is retired, for the reason in section 2.

## 4. The upgrade in two stages

### Stage A: the engine, reversible

Move both `package.json` pins to `@duckdb/node-api` 2.0.x after 2.0.1 and a full rehearsal (Appendix B).
The live file keeps its current format.
Rollback: reinstall 1.4.5 and restart, which worked on the dev build; the pre-upgrade backup is the second line of defence.
Expected effect: the dashboard's read queries took about 6% less time in total, and the checkpoint at dashboard start took 0.57 s instead of 0.04 s.

### Stage B: the file format, one-way

Convert the file with `COPY FROM DATABASE` into a new file, then swap the files with the dashboard stopped.
On a copy this took 2.5 s and kept every row, key, view and cost.
The file shrank from 582 MB to 343 MB, reads took another 6% less time, and the 2.0 format adds stronger corruption checks on read.
1.4.5 cannot open the converted file, so rollback means restoring the old file; the next ingest then re-reads what changed since.
Convert only with a release build: the dev build stamps converted files with a development version number, 999, that releases may reject.

### Timeline and fallback

| When | What |
|---|---|
| Now to 2026-10-21 | Prep pull request: tie-breakers for the 10 query shapes, and `scripts/compare-api.ts`, the endpoint-diff harness the earlier plan's Appendix C asks for |
| 2026-10-21, 2.0.0 | Rerun this test on the 2.0.0 release with `scripts/duckdb-probe/`; read the release notes for G1 and further breaking changes |
| When `@duckdb/node-api` 2.0.x ships | Run the test suite on it in a scratch checkout, then the rehearsal on a copy (Appendix B) |
| 2026-11-16, 2.0.1 | Stage A on the live database, with the usual stop, backup and verify routine |
| 2026-11-17 | 1.4 support ends |
| Two weeks after Stage A | Stage B, approved in D5 |

Fallback: if G4 is not met by 2026-11-17, stay on 1.4.5 until it is.
A few weeks on an unsupported engine is low risk for a local tool now that open failures never delete data.

## 5. Housekeeping

- The Rust migration evaluation (`docs/rust-migration-evaluation.md`, written 2026-09-03) lands in the same pull request as this plan, with a dated note on what changed since.
  Its five owner decisions stay open, and no port is planned.
  A port that starts after Stage A should target the DuckDB 2.0 Rust crate, since 2.0 will be writing the file by then.
- PR #28, a standalone bump to version 0.1.14, was obsolete: main is at 0.1.17, and the post-merge hook makes such bumps by design.
  It was closed and its branch deleted on 2026-09-28 (D6).
- The local branch `feature/rust-migration-evaluation` had no commits of its own and was deleted on 2026-09-28 (D6).
- The staged 0.1.19 version bump on main is the post-merge hook's normal resting state; nothing to do.
- The transcript backups confirm decision D1 of the earlier plan with recorded data.
  From February to September 2026, 98.6% to 100% of main-thread cache writes were 1-hour writes each month, and at least 99.9% of sub-agent writes were 5-minute writes.
  Backfilling the recorded split from the backups would move the stored cost by a few dollars, so it is not worth doing.

## 6. Decisions for you

The owner chose option (a) for both on 2026-09-28, and D6 was carried out the same day.

- **D5. Stage B, converting the file to the 2.0 format.**
  (a) Recommended: yes, two weeks after Stage A, on a release build, after a rehearsal on a copy.
  (b) Keep the old format: rollback stays trivial, but the file stays 41% larger and misses the stronger checks.
- **D6. Stale PR and branches.**
  (a) Recommended: close PR #28, delete its branch `chore/bump-version-0.1.14` locally and on GitHub, and delete the local `feature/rust-migration-evaluation`.
  (b) Keep them.

## 7. Order of work

| Step | Work | Depends on |
|---|---|---|
| 1 | This pull request: this plan, the Rust evaluation and the test scripts | Review |
| 2 | Close PR #28 and delete the stale branches | Done 2026-09-28 |
| 3 | Prep pull request: tie-breakers and `scripts/compare-api.ts` | None |
| 4 | Rerun the test on 2.0.0 | 2.0.0 release |
| 5 | Rehearsal with the Node.js package | G4, step 3 |
| 6 | Stage A on the live database | 2.0.1, step 5 |
| 7 | Stage B | Two weeks of Stage A |

---

## Appendix A: test on the 2.0 development build (2026-09-28)

Setup:
- Engines: DuckDB `2.0.0.dev2609250715`, which reports `v2.0.0-alpha43385`, and 1.4.5, both from PyPI in throwaway Python environments; `@duckdb/node-api` 1.4.5-r.1 for the rollback check.
- Database: byte-identical copies of the live file, 582,234,112 bytes in storage format 64, taken while the dashboard ran and no WAL existed.
- Capture: a preload script logged every statement and its bound values while a second API server answered 264 requests across all 42 GET routes (periods 7d, 30d, 90d and all; model and project filters; a session with 152 sub-agents), then ran one incremental ingest of 8 files and 414 entries.
  38 CLI runs added every `query` type with period, model and project variants, `recommend`, `status` and a Parquet export.
- Replay: each engine ran the logged statements in order on its own fresh copy, and the results were compared row by row with a relative tolerance of 1e-9 on floating-point values.

Results:
- API and ingest: all 2,447 statements ran on both engines.
  2,365 gave identical results, 60 differed only in the order of tied or unordered rows, and 22 returned a date bucket as a timestamp with equal values.
  Row counts and cost totals were identical after the replay.
- CLI: all 2,375 statements ran on both engines; 2,368 gave identical results and 7 differed only in the order of tied rows.
- Fresh install: `sql/schema.sql` and `sql/views.sql` built identical catalogs on both engines: 10 tables, 258 columns, 42 constraints and 16 views.
- File format: opening, reading and closing the file with 2.0 left it byte-identical.
  After 2.0 had replayed everything on a copy, the header still read format 64; `@duckdb/node-api` 1.4.5 opened the copy and queried all 16 views, and `check:indexes` reported every index whole.
- Conversion: `COPY FROM DATABASE` into a new file took 2.5 s and kept the row counts of all 10 tables, the 11 primary-key and unique constraints, the 16 views and the cost total.
  The file went from 582,234,112 to 343,158,784 bytes.
  1.4.5 refused it: "Trying to read a database file with version number 999, but we can only read versions between 64 and 67".
- Speed: the 965 dashboard read statements took 9.25 s in total on 1.4.5, 8.71 s on 2.0 with the old format and 8.18 s on 2.0 with the converted file.
  The median statement rose from 0.56 ms to 0.89 ms; the same per-statement overhead roughly doubled the CLI replay, from 2.4 s to 4.6 s over 2,375 short statements.
  `CHECKPOINT` took 568 ms instead of 37 ms.
- Date type: `typeof(DATE_TRUNC('day', <timestamp>))` is `DATE` on 1.4.5 and `TIMESTAMP` on 2.0, with or without a time-zone conversion.
  `getRowObjectsJS()`, which the API and the CLI executor use, turns both into the same JavaScript `Date`, so both serialize as `2026-09-21T00:00:00.000Z`.
- Tie order: the 10 query shapes are tool usage and success rates, MCP servers, failure chains, tool chains, projects by session count, the session list, tool error messages, MCP tool names and the model filter list.

To reproduce, see `scripts/duckdb-probe/README.md`.

## Appendix B: changes to the rehearsal checklist

These amend Appendix C of `docs/pricing-recovery-duckdb-plan-2026-09-28.md`.
- Before step 3: rerun `scripts/duckdb-probe` on the release build.
- Step 3: read the file header before and after (`od -A n -t u8 -j 12 -N 8 <file>`); for Stage A it must stay 64.
- Step 5: run `scripts/compare-api.ts` after the tie-breaker pull request and expect no differences; since the date-type change is invisible through `getRowObjectsJS()`, any difference is a finding.
- Step 7: expect 1.4.5 to open the file after 2.0 has written to it, and run `check:indexes` with 1.4.5 as well.
- New: time the dashboard's start, because its checkpoint got slower on the dev build.
- Stage B: convert a copy, compare row counts, constraints, views and cost totals, run the full endpoint diff against the converted copy, and keep the old-format file for two weeks after the live swap.

## Appendix C: sources

- Release calendar: https://duckdb.org/release_calendar and https://endoflife.date/duckdb, read 2026-09-28.
- "A Preview of DuckDB v2.0", 2026-08-17: https://duckdb.org/2026/08/17/duckdb-20-highlights
- Storage versions and compatibility: https://duckdb.org/docs/current/internals/storage
- Packages on 2026-09-28: npm `@duckdb/node-api` dist-tags `lts-v1.4` 1.4.5-r.1 and `latest` 1.5.5-r.5, with no 2.0 build; PyPI `duckdb` 2.0.0 dev builds since 2026-09-12; GitHub release v1.5.6 on 2026-09-28; crates.io `duckdb` 1.10505.0, which bundles DuckDB 1.5.5.
- Transcript backups: `src/ingestion/file-backup.ts`, added in `4c51282` on 2026-03-14.
