# Plan: pricing fixes, safe database recovery, DuckDB upgrade path

Date: 2026-09-28.
Status: approved 2026-09-28 with the recommended option for each of D1 to D4 (section 7).
Scope: the three follow-ups left open by the fix for PER-44, the filtered-query-misses bug (`docs/filtered-query-misses-2026-09-28.md`, section 7).

## 1. Summary

The dashboard misprices four models and prices one kind of cache write too low.
The per-model errors are large but cancel out in the total: Opus 5 is $915 too low and Fable 5.1 $927 too high.
Pricing 1-hour cache writes correctly adds up to $2,760 (+13%) to the all-time stored cost of $21,114.

When DuckDB fails to open, the CLI and the dashboard can delete the whole database file.
Claude Code deletes transcripts after 30 days, so eight months of history (2025-12-29 to 2026-08-28) exist only in the database and its manual backups.

Our DuckDB 1.4 loses support on 2026-11-17, and 1.5 on 2026-11-01.
Skip 1.5.x and move from 1.4.5 to 2.0.x after its first patch release.

Order: the recovery fix first, since it guards every later step, then pricing in two pull requests, then the DuckDB upgrade once 2.0 ships.

## 2. Pricing: what is wrong today

`src/utils/pricing.ts` matches model ids by prefix and falls back to Sonnet rates for unknown ids.
Rates below come from the live Anthropic pricing page, read 2026-09-28.

| Gap | Cause | Effect on all-time stored cost |
|---|---|---|
| Opus 5 (`claude-opus-5`) has no entry | Priced at the Sonnet fallback ($3 / $15) instead of $5 / $25 | $915 too low |
| Opus 5.5 (`claude-opus-5-5`) has no entry | Sonnet fallback instead of $4 / $20 with $0.20 cache reads | $21 too high |
| Fable 5.1 (`claude-fable-5-1`) inherits Fable 5 rates | The prefix `claude-fable-5` matches it; its cache reads cost $0.25, not $1 | $927 too high |
| Sonnet 5 priced at $3 / $15 | The $2 / $10 launch price became permanent | $13 too high |
| Every cache write priced as a 5-minute write | Claude Code caches the main thread for 1 hour, which costs 2x input, not 1.25x | up to $2,760 too low |

Two process gaps let these through.
The unknown-model warning goes only to `~/.ccanalytics/logs/web.out.log`, where it fired 37 times unseen.
Prefix matching hides point releases: `claude-fable-5` matched Fable 5.1, so no warning fired.

Sub-agent costs ($5,980 in `sub_agents.cost_usd`) stay out of the main totals by design.
But `npm run backfill:costs` skips them, so they keep old rates after every rate fix.

## 3. Pricing: the fix

### PR A: rates, matching, visibility

1. Set live rates in `PRICING`: Opus 5.5 $4 / $20 / $5 write / $0.20 read; Opus 5 $5 / $25 / $6.25 / $0.50; Fable 5.1 and Mythos 5.1 $10 / $50 / $12.50 / $0.25; Sonnet 5 $2 / $10 / $2.50 / $0.20.
2. Match exact model ids, ignoring a trailing date suffix such as `-20251001`, instead of prefixes (decision D4).
   A new point release then trips the unknown-model warning instead of inheriting a sibling's rates.
   `buildRateCaseSql()` emits the same match for the dashboard SQL.
3. Add `npm run check:pricing`, which lists unpriced models in the database and exits 1 if any exist.
4. Add `unpricedModels` to `/api/health` and show a dashboard banner while it is not empty.
5. Make `scripts/backfill-costs.ts` also recompute `sub_agents.cost_usd` and print before and after totals per model.
   Each sub-agent uses one model (355 of 355 on disk), so the recompute is exact.
6. Fix stale text in the `pricing.ts` header and the "each cache hit saves 90%" formula in the workspace `CLAUDE.md` (`~/Development/tooling/CLAUDE.md`): Opus 5.5 saves 95%, Fable 5.1 97.5%.
7. Test each new id, the suffix handling, shadowed entries and the sub-agent backfill.

### PR B: 1-hour cache writes

1. Parse `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` in the `claude-code.ts` and `claude-desktop.ts` adapters.
2. Migration 8 adds `cache_creation_5m_tokens` and `cache_creation_1h_tokens` to `conversation_turns` and `sub_agents`; `NULL` means not recorded.
3. Add a 1-hour write rate (2x input) to `ModelPricing`; `calculateCost()` prices each part at its own rate.
4. Fill the new columns for turns whose transcripts remain on disk, matched on `request_id`, with `UPDATE` only, never a re-ingest.
5. Price turns without a recorded split as decision D1 says.
6. Split cache-write cost in the CLI breakdowns (`src/queries/cost-analyzer.ts`) and the dashboard cost routes.

### Deploying each PR

Stop the `com.ccanalytics.web` LaunchAgent, back up into `~/.ccanalytics/backups/`, and rehearse the backfill on a copy against Appendix A.
Then run it live, restart the agent, and check `/api/cost/by-model` and `check:pricing`.

## 4. Recovery code: stop deleting data

When DuckDB fails to open, `ConnectionManager.open()` (`src/db/connection.ts:53-125`) and `initConnection()` (`dashboard/src/server/helpers/db.ts:119-157`) try to recover.
If the error mentions "replaying WAL", they delete the write-ahead log (WAL) and with it every write since the last checkpoint.
If it matches patterns such as `INTERNAL Error` or `IO Error: Could not read`, they delete the database file and start empty.

Commits `8b3881a` and `f347ff6` (2026-02-26 and 27) added this when the database could be rebuilt from transcripts and leftover WALs were routine.
Neither holds now: transcripts last 30 days, and since PR #32 (the PER-44 fix) every ingest and dashboard start checkpoints.
Patterns like `INTERNAL Error` also match DuckDB bugs that are not file damage, such as a failure after an upgrade.

The fix, scoped by decision D2:
1. Never delete or overwrite on an open failure; throw an error that names the DuckDB message, the files, whether a WAL exists, and the next step.
2. Keep the dashboard up: it already opens lazily and answers `/api/health` with 503, so add the reason and next step there and in the UI.
3. Add an opt-in `ccanalytics db recover` that copies the database and WAL into `~/.ccanalytics/backups/`, moves the WAL aside as `.wal.quarantined-<timestamp>`, and retries.
   It never creates an empty database; for a damaged file it lists backups and prints the restore command.
4. Test that every error that used to delete now leaves both files byte-identical.

## 5. DuckDB: where versions stand

| Version | Status on the release calendar, 2026-09-28 |
|---|---|
| 1.4.5 (ours, LTS) | Supported until 2026-11-17 |
| 1.5.5 (npm `latest`) | End of life 2026-11-01; 1.5.6 scheduled for 2026-09-28, not yet on npm |
| 2.0.0 | Planned for 2026-10-21; 2.0.1 planned for 2026-11-16 |

In the PER-44 rehearsal, 1.5.5 crashed in 2 of 3 runs that opened the live database with its 1.4 WAL.
Moving to 1.5.x now buys five weeks of support for a possibly irreversible change.

Recommendation (decision D3): stay on 1.4.5, then move to 2.0.x once 2.0.1 ships on 2026-11-16, a day before 1.4 support ends.
Gate G1, whether 2.0 is an LTS release and changes the file format one way, closes with the 2.0 announcement.
Gate G2, whether 1.5.6 fixes the crash, matters only if 2.0 slips.
A few weeks on an unsupported 1.4.5 is low risk for a local tool once the recovery fix is in.
Appendix C lists the rehearsal.

## 6. Order of work

| Step | Work | Depends on | Live database step |
|---|---|---|---|
| 1 | Recovery fix (section 4) | D2 | none, code only |
| 2 | PR A: rates, matching, visibility | D4 | cost backfill |
| 3 | PR B: 1-hour cache writes | D1, PR A | migration 8 and backfill |
| 4 | DuckDB rehearsal and upgrade | step 1, G1, the 2.0.1 release | version upgrade |

Steps 1 and 2 can run in parallel; step 1 must land before step 4.

## 7. Decisions for you

The owner chose option (a) for all four on 2026-09-28.

- **D1. Cache TTL for turns before 2026-08-29.**
  Their transcripts are gone, so the split cannot be recorded.
  (a) Recommended: price them as 1-hour writes, like every main-thread write on disk, adding about $2,170 on top of the $590 recorded.
  (b) Keep the 5-minute rate, leaving a step in cost trends on 2026-08-29.
- **D2. Recovery scope.**
  (a) Recommended: refuse and report, plus the opt-in `db recover`.
  (b) Refuse and report only, with manual steps in the docs.
  (c) As (a), plus a daily automatic snapshot with retention, since backups are manual today.
- **D3. DuckDB target.**
  (a) Recommended: skip 1.5.x and upgrade to 2.0.x after 2.0.1.
  (b) Upgrade to 1.5.6 now, then again to 2.0.
- **D4. Model-id matching.**
  (a) Recommended: exact ids, ignoring the date suffix.
  (b) Keep prefixes and add a test that fails when an entry shadows a later one.

## 8. Not planned, with evidence

None of these modifiers occurs in the 28,337 deduplicated assistant turns on disk (2026-08-29 to 2026-09-28):
- Fast mode (2x): no turn has `speed: "fast"`.
- Web search ($10 per 1,000): no `web_search_requests`.
- US-only inference (1.1x): every turn reports `inference_geo: "not_available"`.
- Batch discount: Claude Code does not use the Batch API.
- Long-context premium: Claude 4.6 and later bill the whole 1M window at standard rates; older Sonnet 4.5 turns total $2.64.

---

## Appendix A: cost impact per model

`conversation_turns`, all time, in USD.
The last column prices every main-thread cache write at the 1-hour rate, which is option D1 (a).

| Model | Stored | Rates fixed | Rates fixed, 1-hour writes |
|---|---:|---:|---:|
| `claude-opus-4-7` | 5,758.59 | 5,758.59 | 6,331.24 |
| `claude-fable-5` | 4,208.90 | 4,208.90 | 4,778.30 |
| `claude-opus-4-6` | 3,571.48 | 3,571.48 | 3,976.95 |
| `claude-opus-4-8` | 3,346.37 | 3,346.37 | 3,875.21 |
| `claude-fable-5-1` | 2,307.96 | 1,381.10 | 1,681.79 |
| `claude-opus-5` | 1,373.07 | 2,288.44 | 2,575.76 |
| `claude-opus-5-5` | 282.69 | 261.43 | 300.35 |
| `claude-opus-4-5-20251101` | 196.39 | 196.39 | 241.41 |
| `claude-sonnet-5` | 39.05 | 26.04 | 31.60 |
| `claude-sonnet-4-6` | 25.81 | 25.81 | 31.22 |
| `claude-sonnet-4-5-20250929` | 2.64 | 2.64 | 3.29 |
| `claude-haiku-4-5-20251001` | 1.26 | 1.26 | 1.74 |
| **Total** | **21,114.21** | **21,068.45** | **23,828.87** |

For the models whose rates do not change, the "Rates fixed" column reproduces the stored cost to the cent, which validates the method.

Sub-agents: on the transcripts on disk, the rate fixes move Opus 5 from $504 to $841, Opus 5.5 from $683 to $546, Fable 5.1 from $423 to $259 and Sonnet 5 from $24 to $16, a net +$28 over 30 days.
All sub-agent cache writes are 5-minute writes, so PR B does not change sub-agent costs.
The extended backfill reports the exact all-time change.

## Appendix B: evidence and sources

- Rates: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), read 2026-09-28.
  Cache reads cost 0.05x input on Opus 5.5 and 0.025x on Fable 5.1 and Mythos 5.1, and 0.1x elsewhere.
  1-hour cache writes cost 2x input on every model.
  Sonnet 5's $2 / $10 is now the standard price.
- Stored totals: `GET /api/cost/by-model?period=all` and `GET /api/agents/summary?period=all` on the live dashboard, 2026-09-28.
- Unseen warnings: `~/.ccanalytics/logs/web.out.log` holds 28 `[pricing]` warnings naming `claude-opus-5`, 6 naming `claude-opus-5-5` and 3 naming both.
- History only in the database: the oldest of the 327 main-thread transcripts on disk dates from 2026-08-29, since Claude Code's `cleanupPeriodDays` is unset (default 30); the database's first cost day is 2025-12-29.
- Recovery code origin: commits `8b3881a` and `f347ff6`; the LaunchAgent plist sets `KeepAlive`, so a server that exited on an open failure would restart in a loop.
- DuckDB: [release calendar](https://duckdb.org/release_calendar) and [endoflife.date](https://endoflife.date/duckdb), read 2026-09-28; npm dist-tags `lts-v1.4` = 1.4.5-r.1 and `latest` = 1.5.5-r.5; 1.5.5 results in `docs/filtered-query-misses-2026-09-28.md`, Appendix B.
- Cache TTL split, from `~/.claude/projects/**/*.jsonl`, deduplicated by message id.
  Main-thread turns use only 1-hour writes, and sub-agent turns (files under `subagents/`) only 5-minute writes.
  The database's Fable 5.1 cache writes (40,092,808 tokens) and output (11,380,795 tokens) equal the main-thread totals on disk exactly, which confirms that `conversation_turns` holds main-thread turns only.

| Model | Thread | Turns | 1-hour writes | 5-minute writes |
|---|---|---:|---:|---:|
| `claude-fable-5-1` | main | 4,060 | 40,092,808 | 0 |
| `claude-fable-5-1` | sub-agent | 1,471 | 0 | 15,873,474 |
| `claude-opus-5` | main | 5,057 | 30,484,362 | 0 |
| `claude-opus-5` | sub-agent | 5,602 | 0 | 33,771,199 |
| `claude-opus-5-5` | main | 1,977 | 12,526,774 | 0 |
| `claude-opus-5-5` | sub-agent | 6,447 | 0 | 35,718,621 |
| `claude-sonnet-5` | main | 116 | 1,295,266 | 0 |
| `claude-sonnet-5` | sub-agent | 347 | 0 | 2,687,876 |

## Appendix C: DuckDB upgrade rehearsal checklist

1. Prerequisites: the recovery fix is deployed, a fresh backup exists, and the live database is checkpointed, with no `.wal` file beside it.
2. Install the target version in a scratch directory, not in the main checkout: the LaunchAgent loads DuckDB from the main checkout's `node_modules`.
3. Open a copy of the live database five times with the target version; any crash fails the rehearsal.
4. Run `npm run check:indexes` and compare row counts per table with 1.4.5.
5. Start a second API server on port 3101 on the copy, with the live `config.json`, and diff every endpoint against port 3001 before any write.
   Rebuild the endpoint-diff harness used for PER-44 as `scripts/compare-api.ts`; the 2026-09-28 copies live in a temporary scratch directory.
6. Ingest on the copy, including a short `ccanalytics watch` run, kill the process before it checkpoints, and reopen five times: the target version must replay its own WAL cleanly.
7. Check rollback: after the target version has written to the copy, try opening it with 1.4.5.
   If that fails, the pre-upgrade backup is the only rollback, and the gap is re-ingested from transcripts.
8. Compare dashboard query medians with Appendix C of the PER-44 write-up, and flag any query that got more than twice as slow.
9. Confirm that the ICU time-zone probe in `applySessionDefaults()` passes.
10. Bump both `package.json` pins together (`tests/db/duckdb-version.test.ts` enforces it), rebuild, deploy with the live-database routine, and verify.
