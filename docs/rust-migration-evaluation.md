# Rust migration evaluation

> Evaluates rewriting ccanalytics as a single Rust binary for macOS and Linux.
> Baseline numbers were measured on this machine on 2026-09-03 against `main` at version 0.1.13 (commit 0107e5a).
> Status: evaluation only.
> No code has been ported.

> Update, 2026-09-28: the evaluation below is unchanged, and its five owner decisions (section 9) are still open; no port is planned.
> Since it was written, ccanalytics moved to version 0.1.19 and schema version 8, and to DuckDB 1.4.5 after 1.4.4 lost secondary-index entries on WAL replay (PER-44), which also removed the secondary indexes.
> The live database is now 555 MB; section 2 and Appendix A predate these changes.
> Gate G3 now follows the DuckDB 2.0 upgrade in `docs/duckdb-2-upgrade-plan-2026-09-28.md`: a port that starts after it should target the DuckDB 2.0 Rust crate.

---

## 1. Verdict

Recommendation: yes, port to Rust, but keep DuckDB as the storage engine.
Ship one statically linked binary that embeds the existing React dashboard and serves the API and the UI from one process.
Keeping DuckDB carries the 16 views and roughly 280 SQL statements over nearly verbatim and keeps the existing 492 MB database readable without migration.
Switching to SQLite would make the binary roughly 8 times smaller, but it means rewriting every query and re-validating every cost figure.
Choose SQLite only if a hard cap of about 20 MB on disk or 50 MB of RAM is a requirement.

The port is a full rewrite of about 21,000 lines of TypeScript (CLI core plus API server).
The 14,000-line React client stays as it is.
Estimated effort: 8 to 11 weeks of focused work for one engineer, after a 3 to 5 day spike.
The spike must confirm three things before porting starts: the ICU time-zone extension links statically, the release binary builds natively on all four targets, and the existing database opens cleanly.

## 2. Today's footprint

| Metric | Measured today |
|---|---|
| Install on disk | ~573 MB: Node runtime 84 MB, `node_modules` 174 MB (CLI) and 315 MB (dashboard). The DuckDB native library alone is 105 MB. |
| Runtime dependencies | Node 20 via nvm, npm, tsx and Vite are all required at run time, not only at build time. |
| Web dashboard | 5 processes and ~206 MB RSS while idle (API 159 MB, Vite preview 29 MB, wrappers 18 MB). |
| CLI cold start, no DB | 40 ms, 44 MB RSS |
| CLI query with DB open | 190 to 230 ms, 118 to 153 MB RSS |
| `status` | 560 ms, 226 MB RSS |
| Full ingest into an empty DB | 186 s wall, 324 s CPU, 1.08 GB peak RSS for 703 files (~640 MB of JSONL) |
| Code | 15.4 K lines CLI core, 5.5 K lines Express API, 14 K lines React client, 1.2 K lines SQL, 11 K lines of tests (486 tests) |

Two of these numbers explain most of the pain.
The web dashboard needs five processes because `ccanalytics web` spawns npm, which spawns tsx and Vite.
Ingestion runs at about 3.4 MB/s and peaks above 1 GB because every line becomes V8 objects before it reaches DuckDB.

## 3. Target shape

One crate, one binary, one process.

- CLI with the same nine commands and flags, built on `clap`.
- Ingestion in Rust: discovery, streaming JSONL parse with `serde_json`, both adapters, dedup, DuckDB Appender inserts, byte-offset tracker, file backup.
- DuckDB linked statically through the `duckdb` crate with the `bundled-cmake`, `icu`, `json` and `parquet` features.
- `schema.sql` and `views.sql` embedded with `include_str!` and applied by the same migration ladder (schema version 6).
- Web: `axum` serves the 44 `/api` routes and the prebuilt React bundle from one port. The client already calls a relative `/api`, so it needs no change.
- Terminal dashboard on `ratatui`, watcher on `notify`.
- Version from `Cargo.toml` plus a git hash from `build.rs`, replacing the shell scripts.
- Releases through `cargo-dist`: macOS arm64 and x86_64, Linux x86_64 and arm64, plus a Homebrew tap.

Node remains a build-time dependency for the React bundle only.

## 4. The decision that matters: DuckDB or SQLite

| | Rust + DuckDB (recommended) | Rust + SQLite |
|---|---|---|
| Binary size | 60 to 90 MB, DuckDB is most of it | 8 to 15 MB |
| Idle RAM, web | 60 to 150 MB, bounded by DuckDB's buffer pool | 30 to 60 MB |
| SQL port | Near verbatim: 16 views, ~280 statements | Rewrite: no `AT TIME ZONE`, `date_trunc`, `quantile`, `LATERAL`, `EXCLUDE`, `PIVOT` or `ROLLUP` |
| Existing 492 MB database | Opens as is, reads are backward compatible since DuckDB 0.10 | One-time export and import |
| Parquet export | Built in | Needs the `parquet` crate, about 10 MB more |
| Cost-figure risk | Low: same engine, same SQL | High: every audited metric is re-derived |
| Build complexity | High: compiles DuckDB C++ per target | Trivial |

DuckDB is the pragmatic choice because the SQL is the product.
The cost, cache and recommendation logic went through several audits, and a SQL rewrite would reopen all of them.
Revisit SQLite only if the spike shows the binary or memory numbers above are unacceptable.

## 5. Expected gains

Values below are estimates until the spike measures them.

| Metric | Today | Rust + DuckDB |
|---|---|---|
| Install | ~573 MB plus a Node toolchain | One file, 60 to 90 MB |
| Web processes | 5 | 1 |
| Web idle RSS | ~206 MB | 60 to 150 MB |
| CLI cold start | 40 ms, 44 MB | under 10 ms, under 10 MB |
| CLI query | ~200 ms | 80 to 150 ms, DuckDB open dominates |
| Full ingest | 186 s, 1.08 GB | 20 to 60 s, under 300 MB |

Ingestion is where Rust pays off most.
Parsing can run across cores with a single DuckDB writer, and the Appender avoids building SQL text for 1,000-row batches.
Query latency improves less because DuckDB does the work in both designs.

## 6. Risks and gates

Gates block the port until closed.
Risks are managed inside the plan.

- Gate G1, ICU. The crates.io `bundled` build omits the ICU extension, and 26 queries use `AT TIME ZONE`, including the liveness probe run on every connection. The fix is the `bundled-cmake` and `icu` features, which the docs mark experimental and which need a git checkout of the crate plus a CMake C++ build. Loading ICU at run time is not acceptable because it downloads from the network.
- Gate G2, build. Compiling DuckDB from source takes tens of minutes per target, and cross-compiling is best effort. CI must build natively on four runners with a cached `libduckdb-sys`. There is no Rust toolchain on this machine yet.
- Gate G3, database compatibility. The database was written by DuckDB 1.4.4 and the crate bundles 1.5.5. Reads are backward compatible. Do not set a newer `STORAGE_VERSION` while the Node build still opens the file, and never open it from both at once.
- Risk, API contract. The React client depends on the exact JSON shape of 44 endpoints, including timestamp and number formatting. Mitigation: golden diffs against the TypeScript API.
- Risk, dynamic SQL. Filters, time predicates and the pricing `CASE` table are generated in TypeScript. Port the generators, not only the SQL strings.
- Risk, feature freeze. The TypeScript code base is under active development. Parity is a moving target unless features pause or land in both.
- Risk, Linux behaviour. The Claude Desktop adapter reads a macOS-only path, and the LaunchAgent installer is macOS-only. Linux needs a graceful skip and a systemd user unit.

## 7. Plan

| Phase | Scope | Effort |
|---|---|---|
| 0. Spike | Cargo skeleton, DuckDB with ICU on macOS arm64 and Linux x86_64, open a copy of the live DB, run all 16 views, measure binary size, RSS and parse throughput. Closes G1 to G3. | 3 to 5 days |
| 1. Core and ingestion | Config, paths, pricing, schema and migrations, discovery, parser, both adapters, sub-agent and workflow files, dedup, Appender inserts, tracker, backup. Commands: `ingest`, `status`, `init`. | 2 to 3 weeks |
| 2. Queries and CLI | Seven query types, table, JSON and CSV output, `recommend`, `export`, `watch`. | 1 to 2 weeks |
| 3. Web | axum server, 44 routes, filter parsing, settings and ingest routes, embedded dashboard, one port. | 2 to 3 weeks |
| 4. Terminal dashboard and polish | ratatui dashboard, signals, exit codes, error messages. | 1 week |
| 5. Release engineering | cargo-dist, four targets, Homebrew tap, installer, LaunchAgent and systemd scripts, docs. | 1 week |

Parity is verified three ways.
Unit tests port with the same JSONL fixtures against an in-memory DuckDB.
A parity harness runs both implementations against a frozen copy of the database and diffs `status`, every `query --format json` output and all 44 API responses.
Ingesting the same corpus with both builds must produce identical row counts and cost sums to the cent.

Acceptance targets: binary under 100 MB, web idle RSS under 150 MB, full ingest under 60 s.

## 8. Alternatives considered

- Stay on Node and trim. Serving the React bundle from Express removes Vite and one process today, and is worth doing regardless. Single-file Node builds cannot absorb the 105 MB native DuckDB library, so the install stays near 200 MB and still needs Node.
- Rust with SQLite. Smallest footprint, see section 4. The right answer only under a hard size or memory cap.
- Go with DuckDB. A similar single-binary result, and go-duckdb ships prebuilt static libraries, which avoids the C++ build. Not pursued because the request is Rust, but it is the cheapest build story if G2 fails.

## 9. Decisions needed from the owner

1. Confirm the React dashboard stays as is and is embedded rather than rewritten.
2. State hard limits, if any, for binary size and memory. This settles DuckDB versus SQLite.
3. Decide whether the TypeScript code base freezes during the port or whether new features land in both.
4. Confirm Claude Desktop ingestion is macOS-only and may be skipped on Linux.
5. Confirm distribution: GitHub releases plus a Homebrew tap, with no npm package.

---

## Appendix A. Measurement details

Environment: macOS Darwin 25.6 on Apple Silicon, Node v20.19.6, DuckDB 1.4.4 via `@duckdb/node-api`.
All timings come from `/usr/bin/time -l`, single runs, machine under normal load.
The live database stayed locked by the `com.ccanalytics.web` LaunchAgent, so every DB benchmark ran against a copy of `analytics.duckdb` plus its WAL in the session scratchpad.

Corpus:

| Item | Value |
|---|---|
| JSONL files under `~/.claude/projects` | 457 files, 644 MB, ~120 K lines |
| Files modified in the last 30 days (default `maxAgeDays`) | 435 files, 637 MB |
| Largest single file | 43 MB, a sub-agent transcript |
| Live database | 492.5 MB plus 3.3 MB WAL, schema version 6, ~258 K conversation turns |

Web dashboard processes after 8 days of uptime:

| PID role | RSS |
|---|---|
| `node dist/cli.cjs web --no-open` wrapper | 4 MB |
| `npm run server` and `npm run preview` wrappers | 7 MB each |
| tsx bootstrap for the API | 4 MB |
| Express API under tsx (`src/server/index.ts`) | 159 MB |
| Vite preview on port 5173 | 29 MB |

CLI runs against the database copy:

| Command | Wall | Max RSS |
|---|---|---|
| `--version` (no DB, lazy imports) | 40 ms | 44 MB |
| `status` | 560 ms | 226 MB |
| `query cost --period 30d` | 230 ms | 121 MB |
| `query sessions --period 30d --limit 3` | 220 ms | 153 MB |
| `query tools --period 30d` | 210 ms | 146 MB |
| `query cache --period 30d` | 190 ms | 118 MB |
| `recommend --period 30d` | 200 ms | 119 MB |

Full ingestion into an empty database in the scratchpad (`--db` override, default sources and 30-day window):

| Item | Value |
|---|---|
| Files discovered and processed | 703 (Claude Code plus Claude Desktop audit logs) |
| Entries ingested, duplicates removed | 77,919 and 28,909 |
| Wall, CPU | 186 s, 324 s user + 32 s sys |
| Peak RSS | 1.08 GB |
| Resulting database | 117 MB |

Install footprint: `du -sh` of both `node_modules` trees, `ls -l` of the nvm Node binary and of `@duckdb/node-bindings-darwin-arm64/libduckdb.dylib`.

## Appendix B. DuckDB-specific SQL census

Occurrences across `sql/`, `src/` and `dashboard/src/server`, counted with grep.
Window functions and `FILTER` clauses port to SQLite.
Everything else in the table needs a rewrite if the engine changes.

| Construct | Count | SQLite status |
|---|---|---|
| Window functions (`OVER`) | 348 | Supported |
| `FILTER (WHERE ...)` on aggregates | 101 | Supported |
| Ranking functions | 45 | Supported |
| JSON extraction | 34 | Supported via `json_extract` |
| `ON CONFLICT` upserts | 29 | Supported |
| `AT TIME ZONE` | 26 | Not supported |
| `INTERVAL` arithmetic | 24 | Rewrite as datetime modifiers |
| `date_trunc` | 14 | Rewrite as `strftime` |
| `EXCLUDE` / `REPLACE` column lists | 13 | Not supported |
| `generate_series` / `range` | 10 | Extension only |
| `COPY` / `read_json` / `read_csv` | 10 | Not supported |
| `quantile` / `median` | 7 | Not supported |
| `UNNEST` | 5 | Not supported |
| `LATERAL` joins | 5 | Not supported |
| `PIVOT`, `ROLLUP` | 2 each | Not supported |

Statement counts: 128 `SELECT`-bearing strings in `src/queries`, 151 in `dashboard/src/server/routes`, plus 16 views in `sql/views.sql`.
The TypeScript layer uses a small DuckDB API surface: `run`, `runAndReadAll`, `prepare` with `bindValue` and `bindNull`, and `closeSync`.
The Rust crate covers all of it, and the Appender adds a faster insert path.

## Appendix C. Dependency map

| Today | Rust |
|---|---|
| `commander` | `clap` (derive) |
| `@duckdb/node-api` | `duckdb` with `bundled-cmake`, `icu`, `json`, `parquet`, `chrono`, `serde_json` |
| `chokidar` | `notify` and `notify-debouncer-full` |
| `cli-table3`, `picocolors`, `nanospinner` | `comfy-table`, `owo-colors`, `indicatif` |
| `express`, `cors` | `axum`, `tower-http` |
| Vite preview at run time | `rust-embed` serving the prebuilt `dashboard/dist` |
| Custom terminal render loop | `ratatui` and `crossterm` |
| `JSON.parse` per line | `serde_json` streaming, `simd-json` optional |
| `Date` and `Intl` time-zone handling | `chrono` and `chrono-tz`, SQL still uses ICU |
| `open` / `xdg-open` spawn | `webbrowser` |
| `update-version.sh`, `bump-patch.sh` | `Cargo.toml` version plus `build.rs` git metadata |
| `scripts/backfill-*.ts` | `ccanalytics backfill` subcommands |
| `tsup` | `cargo build --release` with LTO, `codegen-units = 1`, `strip` |
| `vitest` with 80% line coverage | `cargo test`, `insta` snapshots, `cargo-llvm-cov` |
| `npm link` | `cargo-dist` archives and a Homebrew tap |

## Appendix D. Sources

- DuckDB Rust client overview, feature flags and version scheme: https://duckdb.org/docs/current/clients/rust/overview.html
- DuckDB Rust client troubleshooting, ICU omission in `bundled` builds and prebuilt library linking: https://duckdb.org/docs/current/clients/rust/troubleshoot
- `duckdb` crate on crates.io, latest 1.10505.0 tracking DuckDB 1.5.5: https://crates.io/crates/duckdb
- duckdb-rs repository, `bundled-cmake` notes and MSRV policy: https://github.com/duckdb/duckdb-rs
- DuckDB storage versions and backward compatibility: https://duckdb.org/docs/current/internals/storage
- `frozen-duckdb`, prebuilt DuckDB binaries for Rust builds: https://crates.io/crates/frozen-duckdb
