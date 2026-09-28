# DuckDB upgrade probe

Tests a new DuckDB version against copies of the live database before `@duckdb/node-api` ships that version.
It produced Appendix A of `docs/duckdb-2-upgrade-plan-2026-09-28.md`.

The probe captures every SQL statement, with its bound values, that the API, an ingest and the CLI run on the current version.
It then replays the log on the old and the new version from PyPI and compares the results statement by statement.
Every step writes to the copy it runs on, so never point it at `~/.ccanalytics/analytics.duckdb`.

## Steps

Run from the repo root, with `T` a scratch directory.

1. Install both versions in throwaway Python environments.

   ```bash
   T=$(mktemp -d)
   python3 -m venv $T/old && $T/old/bin/pip install 'duckdb==1.4.5'
   python3 -m venv $T/new && $T/new/bin/pip install --pre 'duckdb==2.0.0'
   ```

2. Copy the live database; no `.wal` file may exist next to it.

   ```bash
   cp -p ~/.ccanalytics/analytics.duckdb $T/pristine.duckdb
   cp -p $T/pristine.duckdb $T/capture.duckdb
   cp -p $T/pristine.duckdb $T/cli.duckdb
   ```

3. Start a second API server on the capture copy with the logger preloaded.

   ```bash
   (cd dashboard && CC_ROOT=$PWD/.. SQL_LOG=$T/sql.jsonl \
     NODE_OPTIONS="--require $PWD/../scripts/duckdb-probe/capture-sql.cjs" \
     DB_PATH=$T/capture.duckdb CCANALYTICS_DB_PATH=$T/capture.duckdb PORT=3101 \
     node_modules/.bin/tsx src/server/index.ts) &
   ```

4. Call every GET route with period, model and project variants, the routes that take a session or turn id, and one ingest.
   The route list is in `dashboard/src/server/routes/*.ts`; the 2026-09-28 run used periods 7d, 30d, 90d and all.
   The ingest copies the transcripts it reads into `$T/backups`.

   ```bash
   curl -s "http://localhost:3101/api/cost/by-model?period=30d&model=claude-opus-4-8" > /dev/null  # and so on
   curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:3101/api/ingest
   ```

5. Stop the server, then capture the CLI into the same log.

   ```bash
   cli() { CC_ROOT=$PWD SQL_LOG=$T/sql.jsonl node --require scripts/duckdb-probe/capture-sql.cjs dist/cli.cjs --db $T/cli.duckdb "$@" > /dev/null; }
   for t in cost tokens sessions tools cache activity skills; do cli query $t --period 30d --format json; done
   cli recommend --period 30d; cli status
   ```

6. Replay on fresh copies and compare.

   ```bash
   cp -p $T/pristine.duckdb $T/old.duckdb && cp -p $T/pristine.duckdb $T/new.duckdb
   $T/old/bin/python scripts/duckdb-probe/replay.py $T/old.duckdb $T/sql.jsonl $T/old.pickle
   $T/new/bin/python scripts/duckdb-probe/replay.py $T/new.duckdb $T/sql.jsonl $T/new.pickle
   $T/new/bin/python scripts/duckdb-probe/compare.py $T/old.pickle $T/new.pickle $T/sql.jsonl
   ```

7. Check the rollback path: the storage version must still be 64, and the current build must open the file the new version wrote.

   ```bash
   od -A n -t u8 -j 12 -N 8 $T/new.duckdb
   npm run check:indexes -- $T/new.duckdb
   ```

8. Delete `$T`: it holds copies of the database and of transcripts.

## Reading the comparison

- "same rows, different order" comes from rows that tie on their sort key, or from a query without `ORDER BY`.
- "mismatch: values" needs a look: on 2.0 the causes found were `DATE_TRUNC` returning a timestamp instead of a date, floating-point noise, and ties at a `LIMIT` cut-off.
- "regression" means a statement fails only on the new version; any such statement blocks the upgrade.
