# Contributing to ccanalytics

Thanks for your interest in improving ccanalytics. This document covers how to
set up the project, the development workflow, and a few project-specific
conventions worth knowing before you open a pull request.

## Getting started

**Prerequisites:** Node.js 20 or newer.

```bash
git clone https://github.com/OzLe/ccanalytics.git
cd ccanalytics
npm install
npm run build
```

`npm run build` regenerates `src/version.ts` (git-derived build metadata) and
bundles the CLI to `dist/cli.cjs` with tsup.

## Development workflow

| Command | Purpose |
|---------|---------|
| `npm run build` | Build the CLI with tsup |
| `npm run dev` | Build in watch mode |
| `npm test` | Run the Vitest suite |
| `npm run test:coverage` | Run tests with coverage (80% line threshold) |
| `npm run lint` | Type-check with `tsc --noEmit` |
| `npm run build:dashboard` | Production build of the React web dashboard |

Please make sure `npm run build`, `npm run lint`, and `npm test` all pass
before opening a PR — CI runs the same checks.

### Working on the web dashboard

The dashboard (`dashboard/`) is a separate package with its own dependencies:

```bash
cd dashboard && npm install
npm run build        # production build
```

From the repo root, `ccanalytics web` starts the Express API and the Vite
server together.

## Project structure

```
src/cli.ts            CLI entry point (Commander)
src/commands/         One file per subcommand
src/ingestion/        File discovery → JSONL parsing → dedup → batch insert
src/queries/          Analytical query builders (cost, cache, tools, …)
src/db/               DuckDB connection and schema management
src/utils/            Shared helpers (pricing, paths, formatting, …)
sql/                  Schema and the pre-built analytical views
dashboard/            React + Express web UI
tests/                Vitest unit and integration tests + JSONL fixtures
docs/architecture/    C4 model, data architecture, component design docs
```

## Cost methodology — read before touching pricing

Cost numbers are the heart of ccanalytics, so the rate handling is deliberately
centralized:

- **Per-model rates live in exactly one place: `src/utils/pricing.ts`.**
- The SQL `CASE` rate tables in `dashboard/src/server/routes/{cost,cache}.ts`
  are **generated** from it via `buildRateCaseSql()` /
  `buildCacheSavingsRateCaseSql()` — never hand-edit them.
- `conversation_turns.cost_usd` is computed and **stored at ingest time**. Every
  cost read path sums that stored column. Changing a rate therefore does *not*
  retroactively fix already-ingested rows.
- After any rate-table change, run `npm run backfill:costs` — an idempotent
  migration that recomputes the stored `cost_usd` / `total_cost_usd` columns in
  place. Take a fresh copy of your `~/.ccanalytics/analytics.duckdb` first.

## Testing

Tests use Vitest. Fixtures in `tests/fixtures/` are small, fully synthetic
JSONL files — when adding a fixture, keep it synthetic (no real session data)
and minimal. New behavior should come with coverage; `npm run test:coverage`
enforces an 80% line threshold.

## Code style

- TypeScript throughout; keep modules single-responsibility with typed public
  interfaces, matching the surrounding code.
- Match the existing comment density and JSDoc style — most modules open with a
  `@module` block explaining their role.
- No formatter is enforced in CI; follow the conventions already in the file
  you're editing.

## Git hooks (maintainers, optional)

`.githooks/` contains optional hooks that auto-generate version metadata and
bump the patch version on merge. They are **not** installed automatically.
Maintainers who want them can opt in:

```bash
git config core.hooksPath .githooks
```

Contributors do not need these — `npm run build` regenerates version metadata
on its own.

## Submitting changes

1. Branch off `main`.
2. Make your change with tests, and run `build` / `lint` / `test` locally.
3. Open a pull request against `main` with a clear description of the change
   and its motivation.
4. Make sure CI is green.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
