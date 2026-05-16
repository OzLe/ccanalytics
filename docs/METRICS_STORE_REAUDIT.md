# Metrics Store — Wave 4 Re-Audit (2026-05-16)

**Purpose.** This document is the post-fix re-audit companion to
[METRICS_STORE.md](./METRICS_STORE.md). It records the state of every
ccanalytics metric after Wave 1-3 of the
[METRICS_STORE_IMPLEMENTATION_PLAN.md](./METRICS_STORE_IMPLEMENTATION_PLAN.md)
landed (PRs #3 through #16, covering 19 of the 20 SEM2-xxx tickets). It is
parallel to but distinct from the canonical METRICS_STORE.md — the canonical
doc has not been touched.

Treat this file as the **truth at a moment in time**: the source code paths,
formulas, live numbers, and outstanding issues observed on 2026-05-16 against
the dataset at `~/.ccanalytics/analytics.duckdb` (~975 sessions, ~67k assistant
turns, ~$8,335 stored cost).

**Inventory snapshot.** 64 metrics across 8 groups (cost 9, cache 4, session
15, tool 10, skill 10, token 6, prompt 6, activity 4).

---

> ### Validation summary — Wave 1-3 deliverables
>
> Eleven validation targets were checked across the 8 per-group reviews. Each
> reviewer ran the canonical formula against the live DB and confirmed the
> code path agrees.
>
> | # | Target (SEM2 ticket) | Status |
> |---|---|---|
> | 1 | Session median surfaced as primary KPI (SEM2-281) | PASS |
> | 2 | Tool ordering chronological — max streak = 8 (SEM2-283) | PASS |
> | 3 | Bash³ chain count restored (~13.6k, was 7.3k) (SEM2-284) | PASS |
> | 4 | `v_session_failure_chains` denominator preserves zero-failure sessions (SEM2-286) | PASS in inline SQL; FAIL in stored view |
> | 5 | Tool `avg_duration_ms` renders n/a when underlying is NULL (SEM2-282) | PASS |
> | 6 | Headline `total_tokens` = 2-way `input + output` (~41.4M) (SEM2-288) | PASS |
> | 7 | Secondary `context_volume_tokens` exists alongside (~12.1B) (SEM2-289) | PASS in code; FAIL in stored views |
> | 8 | `/api/tokens/total` and `/api/activity/hourly` agree (SEM2-296) | PASS |
> | 9 | Prompt model filter returns rows (~5.6k responded on `?model=opus`) (SEM2-292) | PASS |
> | 10 | Composite uses `distinct_tools_used` not `has_thinking` (SEM2-290/291) | PASS |
> | 11 | Skill token estimate length-based (avg 67.7 vs flat 45) (SEM2-287) | PASS in code; FAIL in stored view |
>
> **Passed: 8 / 11. Mixed pass (code path correct, persisted view stale on
> live DB): 3.** All three "mixed pass" entries collapse into one systemic
> finding — see [Systemic finding: stored views in live DuckDB are stale](#systemic-finding--stored-views-in-live-duckdb-are-stale).
>
> **Not addressed in Wave 1-3 (deferred):** SEM2-279 — cache savings naming
> divergence (`v_cache_efficiency.estimated_tokens_saved` is a token figure
> named like USD). See [Known issues](#known-issues).

---

## Table of contents

1. [Cost methodology preamble](#cost-methodology-preamble)
2. [Cost metrics](#cost-metrics)
3. [Cache metrics](#cache-metrics)
4. [Session metrics](#session-metrics)
5. [Tool metrics](#tool-metrics)
6. [Skill metrics](#skill-metrics)
7. [Token metrics](#token-metrics)
8. [Prompt metrics](#prompt-metrics)
9. [Activity metrics](#activity-metrics)
10. [Known issues](#known-issues)
11. [Wave 1-3 validation results](#wave-1-3-validation-results)
12. [Proposed new KPIs](#proposed-new-kpis)
13. [Glossary](#glossary)
14. [Maintenance footer](#maintenance-footer)

---

## Cost methodology preamble

Every USD figure surfaced by ccanalytics is computed by multiplying token
counts by Anthropic **API list-price** rates. The four cost components are:

```
cost_usd = (input_tokens          × inputPerM         / 1_000_000)
         + (output_tokens         × outputPerM        / 1_000_000)
         + (cache_creation_tokens × cacheCreationPerM / 1_000_000)
         + (cache_read_tokens     × cacheReadPerM     / 1_000_000)
```

Rates are model-specific and live in exactly one place:
[`src/utils/pricing.ts`](../src/utils/pricing.ts). The dashboard SQL `CASE`
expressions in
[`dashboard/src/server/routes/cost.ts`](../dashboard/src/server/routes/cost.ts)
and
[`dashboard/src/server/routes/cache.ts`](../dashboard/src/server/routes/cache.ts)
are generated from the same `PRICING` table via the helpers
`buildRateCaseSql()` and `buildCacheSavingsRateCaseSql()` — never hand-edit
them.

### MAX subscription users: read this caveat

If you are on a **Claude MAX subscription** (or any Anthropic fixed-fee plan),
you do not pay these dollar amounts. Your bill is flat. The cost figures show
**API-equivalent cost** — what the same workload would cost a customer paying
by the token at published list price. Useful for plan ROI, project/model
attribution, and trend signals; **not** a literal monthly bill.

### Canonical cost basis: stored `conversation_turns.cost_usd`

Cost is computed at ingest time by `calculateCost()` and **stored** on
`conversation_turns.cost_usd`. Every "Total Cost" read path sums this stored
column:

- CLI `CostAnalyzer.getTotalCost` ([`src/queries/cost-analyzer.ts:384`](../src/queries/cost-analyzer.ts))
- API `/api/cost/total` ([`dashboard/src/server/routes/cost.ts:54`](../dashboard/src/server/routes/cost.ts))
- View `v_daily_cost` ([`sql/views.sql:37`](../sql/views.sql))
- View `v_session_summary` ([`sql/views.sql:119`](../sql/views.sql))

All four apply the same **cost row predicate**:
`role = 'assistant' AND model IS NOT NULL AND model <> '<synthetic>'`,
plumbed through the SSOT helper `costRowPredicateSql()`
([`src/utils/sqlPredicates.ts:44`](../src/utils/sqlPredicates.ts)).

### When you change pricing, run the backfill

Because `cost_usd` is stored, any edit to `src/utils/pricing.ts` invalidates
the existing column values. The fix is one line:

```bash
npm run backfill:costs
```

It runs the idempotent UPDATE migration in
[`scripts/backfill-costs.ts`](../scripts/backfill-costs.ts), which recomputes
`conversation_turns.cost_usd` and `sessions.total_cost_usd` in place. Take a
fresh DB backup first. Do not run `ingest --reset`; incremental ingest stays
intact.

---

## Cost metrics

The cost group answers "how much did this workload cost at API list price?"
The cost basis is stored, the per-component breakdown is rate-derived live
from the shared `PRICING` table.

### total_cost_usd

**What it informs you.** Total USD spend for the filtered population of
cost-bearing assistant turns. The single canonical cost number for the entire
app.

**Formula.**

```sql
SELECT SUM(cost_usd)
FROM conversation_turns
WHERE role = 'assistant'
  AND model IS NOT NULL
  AND model <> '<synthetic>'
```

**Inputs.** `conversation_turns.cost_usd`, `.role`, `.model`, `.timestamp`.

**Computed in.**

- View: [`sql/views.sql:37`](../sql/views.sql) (`v_daily_cost`)
- TS: [`src/queries/cost-analyzer.ts:384`](../src/queries/cost-analyzer.ts) (`getTotalCost`)
- Route: [`dashboard/src/server/routes/cost.ts:54`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/total`)

**Interpretation.** No absolute threshold — varies wildly by usage. On the
live dataset: 976 sessions, $8,335.07 total, median $2.31 / session, max
single-session $160.59. A day over $300 is heavy use; a single session over
$50 is unusual.

**Caveats.**

- Stored `sessions.total_cost_usd` is still drifted on 10 / 976 sessions
  (sum of |diff| = $218.49). Endpoints no longer read it, but the column is
  still written by ingestion. See [COST-REAUDIT-002](#known-issues).
- `v_session_summary.turn_agg` has no cost-row predicate; it leaks $0 today
  because synthetic rows carry `cost_usd = 0`, but the contract is implicit.
  See [COST-REAUDIT-003](#known-issues).
- Period-clamped `/api/sessions/stats` vs `/api/cost/total` still disagree by
  ~1.4 - 2.5% because they filter on different time columns
  (`start_time` vs `timestamp`). See [COST-REAUDIT-001](#known-issues).

### daily_cost

**What it informs you.** Per-day cost trend, broken down by model. Spot
day-of-week patterns and outlier spend days.

**Formula.**

```sql
SELECT CAST(timestamp AS DATE) AS date, model, SUM(cost_usd) AS total_cost
FROM conversation_turns
WHERE ... cost row predicate ...
GROUP BY date, model
```

**Inputs.** `conversation_turns.cost_usd`, `.model`, `.timestamp`.

**Computed in.**

- View: [`sql/views.sql:37`](../sql/views.sql) (`v_daily_cost` — UTC date)
- TS: [`src/queries/cost-analyzer.ts:55`](../src/queries/cost-analyzer.ts) (`getDailyCosts` — user-tz local date)
- Route: [`dashboard/src/server/routes/cost.ts:140`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/daily`)

**Interpretation.** Live dataset median ~$100/day with peaks at $300+. Use
together with `daily_activity` to attribute spikes to volume vs price.

**Caveats.** The view bucket is UTC (documented at `sql/views.sql:29-35`);
the analyzer and route wrap timestamps through the user's IANA zone via
`wrapTimestampForTz()` so user-facing surfaces show local-date buckets. Same
formula, projected differently (ACT-001 / SEM2-293).

### cost_trend

**What it informs you.** Same `SUM(cost_usd)` basis as `daily_cost` but
bucket-parameterised (`hour | day | week | month`). Bucket boundaries follow
the user's local clock. Returns token columns alongside cost so charts can
render cost-vs-tokens on one query.

**Formula.** `DATE_TRUNC(bucket, localTs) AS ts, SUM(cost_usd) ... GROUP BY ts`.

**Inputs.** `conversation_turns.cost_usd`, `.timestamp`, token columns.

**Computed in.**

- TS: [`src/queries/cost-analyzer.ts:326`](../src/queries/cost-analyzer.ts) (`getCostTrend`)
- Route: [`dashboard/src/server/routes/cost.ts:339`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/trend`)

**Caveats.** No SQL view for `cost_trend`; if you reproduce ad-hoc, mirror the
analyzer's `DATE_TRUNC` over the tz-projected timestamp.

### cost_by_model

**What it informs you.** Per-model breakdown — "which model is driving spend?"
On the live dataset Opus 4.7 + 4.6 + 4.5 account for ~99.6% of spend.

**Formula.** `SUM(cost_usd)` per model + per-category USD via
`SUM(tokens × rate / 1_000_000)` rate-derived from the shared `PRICING` table.

**Inputs.** `conversation_turns.cost_usd`, `.model`, the four token columns,
`PRICING`.

**Computed in.**

- TS: [`src/queries/cost-analyzer.ts:111`](../src/queries/cost-analyzer.ts) (`getCostByModel`)
- Route: [`dashboard/src/server/routes/cost.ts:197`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/by-model`)

**Interpretation.** Live data: every model's stored `cost_usd` matches the
rate-derived per-category sum exactly — backfill state is clean. If
`Sonnet/Haiku` spend is small but Opus session count is high, consider
re-routing simple work to a cheaper tier.

### cost_by_project

**What it informs you.** Spend grouped by `sessions.project_path` — "which
repo costs the most?"

**Formula.** `SUM(cost_usd)` per project + per-category rate-derived USD.

**Inputs.** `sessions.project_path` (joined to `conversation_turns`),
`conversation_turns.cost_usd`, `.model`, four token columns.

**Computed in.**

- TS: [`src/queries/cost-analyzer.ts:181`](../src/queries/cost-analyzer.ts) (`getCostByProject`)
- Route: [`dashboard/src/server/routes/cost.ts:266`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/by-project`)

**Interpretation.** Top project on live data: `/Users/ozlevi/Development/omniwealth/os` at $4,925.22 (~59% of total). Per-project totals reconcile 1:1 with `v_session_summary`.

**Caveats.** `MAX(s.project_name)` is non-deterministic for projects whose
sessions disagree on `project_name` (e.g. path renamed mid-history). Today
data is clean; revisit if names ever diverge.

### input_cost_usd, output_cost_usd, cache_write_cost_usd, cache_read_cost_usd

**What they inform you.** Per-component USD split of `total_cost_usd`. All
four are rate-derived live (no stored column) from the shared `PRICING` via
`buildRateCaseSql('inputPerM'|'outputPerM'|'cacheCreationPerM'|'cacheReadPerM')`.

**Formula.** `SUM(tokens × rate / 1_000_000)` grouped by model.

**Computed in.** Across CostAnalyzer methods (lines 151-456) and dashboard
cost routes ([`cost.ts:67-74`](../dashboard/src/server/routes/cost.ts) for
`/total`, lines 210-217 for `/by-model`, 278-285 for `/by-project`).

**Interpretation.** On the live dataset, output is the dominant component
(rate ~5x input across Opus 4.x). Cache-read is bounded despite cache_read
tokens being 98%+ of context volume because the cache-read rate is 10% of
input. Cache-creation tracks system-prompt churn.

**Caveats.** Rate CASE expressions are GENERATED from
[`src/utils/pricing.ts`](../src/utils/pricing.ts) — never hand-edit.
A rate change without a backfill silently divides stored `cost_usd` from the
rate-derived per-category sum.

---

## Cache metrics

The cache group answers "is prompt caching pulling its weight?" The canonical
KPI is the hit rate; the canonical USD savings is computed per-model from the
input-vs-cache-read rate diff.

### cache_hit_rate

**What it informs you.** Share of model-processed input that came from cache.
A high rate means cheaper, faster runs (each cache hit saves ~90% of input
cost).

**Formula.**

```
cache_hit_rate = cache_read_tokens
                 / (cache_read_tokens + cache_creation_tokens + input_tokens)
```

**Inputs.** `conversation_turns.cache_read_tokens`, `.cache_creation_tokens`,
`.input_tokens` (all `WHERE role = 'assistant'`).

**Computed in.**

- View: [`sql/views.sql:161`](../sql/views.sql) (`v_session_summary`), [`sql/views.sql:224`](../sql/views.sql) (`v_cache_efficiency`)
- TS: [`src/queries/cache-analyzer.ts:64`](../src/queries/cache-analyzer.ts) (`getCacheHitRate`)
- Route: [`dashboard/src/server/routes/cache.ts:39`](../dashboard/src/server/routes/cache.ts) (`GET /api/cache/metrics`)

**Interpretation.**

| Band | Label | Action |
|---|---|---|
| `> 0.80` | effective | Cache is doing most of the work |
| `0.50 – 0.80` | moderate | Mixed cold/warm sessions |
| `< 0.50` | ineffective | Cold sessions or invalidating prompts |
| `< 0.30` | red flag (CLAUDE.md) | Not surfaced in code today |

Live dataset rate: **0.981**. Bands disagree across CLAUDE.md / code /
inventory — see [CACHE-RE-5](#known-issues).

**Caveats.**

- Three different row-inclusion rules coexist: `v_session_summary` filters no
  role; `v_cache_efficiency` and CacheAnalyzer filter `role = 'assistant'`
  only; cost surfaces use the stricter cost-row predicate. All three resolve
  identically today (user-role rows carry zero cache tokens) but the
  divergence is architecturally fragile. See [CACHE-RE-3](#known-issues).
- Denominator includes `cache_creation_tokens`, so a cold-start session with
  50k writes and 0 reads shows 0% even when caching works.

### estimated_cache_savings_usd

**What it informs you.** Dollar value of tokens served from cache vs the API
list-price of re-prompting them at the input rate.

**Formula.**

```sql
SUM(cache_read_tokens × (inputPerM - cacheReadPerM) / 1_000_000)  -- per model
```

**Inputs.** `conversation_turns.cache_read_tokens`, `.model`, `PRICING`.

**Computed in.**

- View: [`sql/views.sql:241`](../sql/views.sql) (`v_cache_efficiency.estimated_tokens_saved` — **token figure named like USD**, flat 0.9 proxy)
- TS: [`src/queries/cache-analyzer.ts:64`](../src/queries/cache-analyzer.ts) (`getCacheHitRate` — model-aware USD)
- Route: [`dashboard/src/server/routes/cache.ts:39`](../dashboard/src/server/routes/cache.ts) (`buildCacheSavingsRateCaseSql`)

**Interpretation.** Live: **$53,207.27** saved against $8,335.07 actual spend
— caching produced ~6.4x the value of the total bill at API list price.

**Caveats.**

- The view's `estimated_tokens_saved` is a TOKEN figure (10.66B on live data)
  named like a USD field, and uses a flat 0.9 multiplier; the TS/route emit
  model-aware USD ($53.2k). **This is SEM2-279, still open.** See
  [CACHE-RE-1](#known-issues).
- This is an **API-list-price counterfactual**, not realized cash on a MAX
  subscription. The caveat exists only in `src/utils/pricing.ts:131-135`; it
  is not surfaced on the wire. See [CACHE-RE-6](#known-issues).

### cache_efficiency_trend

**What it informs you.** Day-by-day cache_hit_rate series — detects caching
regressions (new prompt patterns destroying cache locality).

**Formula.** Same `cache_hit_rate` formula, `GROUP BY` local date.

**Computed in.**

- View: [`sql/views.sql:224`](../sql/views.sql) (`v_cache_efficiency` — UTC)
- TS: [`src/queries/cache-analyzer.ts:141`](../src/queries/cache-analyzer.ts) (`getCacheTrend`)
- Route: [`dashboard/src/server/routes/cache.ts:110`](../dashboard/src/server/routes/cache.ts) (`GET /api/cache/trend`)

**Interpretation.** Sudden drops > 10pp day-over-day are worth investigating.

**Caveats.** `AVG` over daily rates ≠ SUM-then-divide. On live data daily-AVG
= 0.957, ratio-of-sums = 0.981 (2.4pp gap). Always SUM the underlying token
columns and divide at the end. See [CACHE-RE-2](#known-issues).

### cache_by_session

**What it informs you.** Per-session cache metrics — find high-savings
sessions worth replicating and zero-cache sessions that may benefit from
prompt restructuring.

**Formula.** Per `(session, model)`: `cache_hit_rate` from
`v_session_summary`; `estimated_savings_usd` via per-model
`SUM(cache_read × (inputPerM - cacheReadPerM) / 1e6)`.

**Computed in.**

- TS: [`src/queries/cache-analyzer.ts:190`](../src/queries/cache-analyzer.ts) (`getCacheBySession`) — CLI only
- Route: none

**Caveats.** Reads `s.cache_hit_rate` from `v_session_summary` (which has no
role filter) but recomputes everything else inline from `conversation_turns`
(LEFT JOIN with no role filter either). Two halves can drift if either side
changes its predicate. See [CACHE-RE-4](#known-issues).

---

## Session metrics

The session group answers "what does a session look like — duration, cost,
turns, context pressure?"

### total_sessions

**What it informs you.** Count of distinct sessions in the period. Bedrock
denominator for every per-session average.

**Formula.** `COUNT(*) FROM v_session_summary WHERE start_time IN [range]`.

**Computed in.**

- View: [`sql/views.sql:119`](../sql/views.sql) (`v_session_summary`)
- TS: [`src/queries/session-analyzer.ts:304`](../src/queries/session-analyzer.ts) (`getSessionStats`)
- Route: [`dashboard/src/server/routes/sessions.ts:123`](../dashboard/src/server/routes/sessions.ts) (`GET /api/sessions/stats`)

**Interpretation.** Period-relative; absolute counts aren't meaningful without
project/team scope. Live: 975 all-time, 55 last 7d, 243 last 30d.

### total_turns

**What it informs you.** Sum of `num_turns` across filtered sessions.

**Formula.** `SUM(num_turns) FROM v_session_summary`.

**Computed in.**

- View: [`sql/views.sql:128`](../sql/views.sql) (`COUNT(*) AS num_turns` over
  `conversation_turns` per session)
- TS: [`src/queries/session-analyzer.ts:304`](../src/queries/session-analyzer.ts) (`getSessionStats`)
- Route: [`dashboard/src/server/routes/sessions.ts:123`](../dashboard/src/server/routes/sessions.ts) (`GET /api/sessions/stats`)

**Caveats.** `num_turns` counts **all** roles (assistant + user + synthetic),
which is undocumented and counter-intuitive. Live: 974/975 sessions have
`num_turns == total turn count`. With user turns outnumbering assistant ~1.4:1,
this inflates "work" by ~60% vs an assistant-only count. See
[SESSION-001](#known-issues).

### avg_turns_per_session

**What it informs you.** Arithmetic mean of `num_turns`. Average dialog
length.

**Formula.** `AVG(num_turns) FROM v_session_summary`.

**Interpretation.** < 5 = predominantly one-shot prompts; > 100 = long
agentic sessions. Live: 164.57 mean, 95 median, 1339 max.

**Caveats.** Same long-tail skew as duration — mean is 73% above median.
Recommend mirroring SEM2-281 pattern and adding `medianTurnsPerSession`.
See [SESSION-002](#known-issues).

### avg_duration_minutes (deprecated headline)

**What it informs you.** Plain arithmetic mean of session duration. Kept for
back-compat as a sanity-check diagnostic.

**Formula.** `AVG(duration_seconds) / 60.0`.

**Computed in.** [`src/queries/session-analyzer.ts:323`](../src/queries/session-analyzer.ts), [`dashboard/src/server/routes/sessions.ts:146`](../dashboard/src/server/routes/sessions.ts).

**Interpretation.** **Do not use as headline.** Live: 331.82 min mean vs 28.28
min median (11.7x ratio); driven by 2 zombie sessions of ~37.5 days each
(project = "Organize downloads folder…").

**Caveats.** Dashboard no longer renders this as primary — see
[SESSION-003](#known-issues) for the deprecation glidepath.

### capped_mean_duration_minutes

**What it informs you.** Robust mean — each session's duration is clamped at
12 hours before averaging (SEM2-281).

**Formula.** `AVG(LEAST(duration_seconds, 43200)) / 60.0`.

**Computed in.** [`src/queries/session-analyzer.ts:325`](../src/queries/session-analyzer.ts), [`dashboard/src/server/routes/sessions.ts:147`](../dashboard/src/server/routes/sessions.ts).

**Interpretation.** Live all-time: 138.31 min; 75 sessions (7.7%) clip at the
cap; 861 sessions sit below.

**Caveats.** 12h cap is a magic constant duplicated in two places — easy to
drift. See [SESSION-004](#known-issues).

### median_duration_minutes (primary headline)

**What it informs you.** Median session duration — robust headline for
"how long is a typical session" (SEM2-281). PR #12 surfaces this as primary
KPI on the Sessions page.

**Formula.** `MEDIAN(duration_seconds) / 60.0`.

**Computed in.** [`src/queries/session-analyzer.ts:327`](../src/queries/session-analyzer.ts), [`dashboard/src/server/routes/sessions.ts:149`](../dashboard/src/server/routes/sessions.ts).

**Interpretation.**

| Range | Pattern |
|---|---|
| `< 30min` | light / exploratory |
| `30 - 120min` | typical project work |
| `> 120min` | heavy agentic loops |

Live: 28.28 min all-time, 47.10 last 7d, 65.17 last 30d.

**Caveats.** DuckDB's `MEDIAN` skips NULL `duration_seconds` (39 zombies that
never wrote `end_time`). Correct behavior, but brittle to upstream
`COALESCE(duration_seconds, 0)`. See [SESSION-005](#known-issues).

### avg_cost_per_session

**What it informs you.** Average spend per session.

**Formula.** `AVG(total_cost_usd) FROM v_session_summary`.

**Computed in.** [`src/queries/session-analyzer.ts:329`](../src/queries/session-analyzer.ts), [`dashboard/src/server/routes/sessions.ts:151`](../dashboard/src/server/routes/sessions.ts).

**Interpretation.** Live: mean $8.51, median $2.30, p95 $38.91, max $160.59.
Mean is 3.7x median — same long-tail problem as duration.

**Caveats.** Recommend adding `medianCostPerSession` alongside; one extra
`MEDIAN()` in the same round-trip. See [SESSION-006](#known-issues).

### unique_models

**What it informs you.** Distinct model identifiers in filtered sessions —
spotting unintended cross-model traffic and powering the model-filter UI.

**Formula.** `SELECT DISTINCT model FROM v_session_summary WHERE model IS NOT NULL AND start_time IN [range]`.

**Computed in.** [`src/queries/session-analyzer.ts:346`](../src/queries/session-analyzer.ts), [`dashboard/src/server/routes/sessions.ts:158`](../dashboard/src/server/routes/sessions.ts).

**Caveats.** Includes `<synthetic>`; cost/token paths use the stricter
predicate that excludes it. Selecting `<synthetic>` from the dropdown returns
0 rows in every cost/token query. See [SESSION-007](#known-issues).

### session_summary

**What it informs you.** Per-session row joining metadata with derived turn
aggregates (`total_cost_usd`, `total_tokens` (2-way), `context_volume_tokens`,
`cache_hit_rate`, `num_turns`, `num_tool_calls`). The contract behind
`GET /api/sessions`.

**Formula.** `v_session_summary` CTE: `turn_agg` (SUM cost, token sums, COUNT)
JOIN `tool_agg` (COUNT) JOIN `sessions`. COST-004: derives via children to
avoid stored-aggregate drift.

**Computed in.**

- View: [`sql/views.sql:119`](../sql/views.sql) (`v_session_summary`)
- TS: [`src/queries/session-analyzer.ts:106`](../src/queries/session-analyzer.ts) (`getSessions`)
- Route: [`dashboard/src/server/routes/sessions.ts:34`](../dashboard/src/server/routes/sessions.ts) (`GET /api/sessions`)

**Caveats.** Live DB's `v_session_summary` DDL is **stale** — missing
`context_volume_tokens` (TOK-002) and `total_tokens` is still the 4-way sum.
Inline route SQL is correct; the stale view is benign today but breaks the
SSOT contract. See [SESSION-008](#known-issues) and the
[Systemic finding](#systemic-finding--stored-views-in-live-duckdb-are-stale).

### session_detail

**What it informs you.** Full drill-down: summary + turns + tool_calls +
errors for a single session.

**Computed in.** [`src/queries/session-analyzer.ts:170`](../src/queries/session-analyzer.ts), [`dashboard/src/server/routes/sessions.ts:358`](../dashboard/src/server/routes/sessions.ts) (`GET /api/sessions/:id`).

**Caveats.** Tool calls are ordered by `tool_call_id` (random base62), not by
`ct.timestamp` — same anti-pattern TOOL-002/SEM2-283 fixed for failure
chains. Users see them in shuffled order on the detail page. See
[SESSION-009](#known-issues).

### context_pressure_per_session

**What it informs you.** NEW-001 per-session context-window utilization
metrics. Leading indicator of quality degradation (CLAUDE.md: > 60%
utilization is the threshold).

**Formula.**

```
context_tokens = input + cache_read + cache_creation
window         = 1M if model id ends in '-1m' OR context > 200k, else 200k
utilization    = context_tokens / window
```

Per session: `MAX`, `AVG`, `COUNT FILTER (> 0.6)`, `COUNT FILTER (> 0.8)`,
`pressure_share`, `COUNT(stop_reason = 'max_tokens')`.

**Computed in.**

- View: [`sql/views.sql:449`](../sql/views.sql) (`v_context_pressure`)
- TS: [`src/queries/session-analyzer.ts:398`](../src/queries/session-analyzer.ts) (`getContextPressure`)
- Route: [`dashboard/src/server/routes/sessions.ts:245`](../dashboard/src/server/routes/sessions.ts) (`GET /api/sessions/context-pressure`)

**Interpretation.** Live: 49.6% of sessions with assistant turns hit > 60%,
34.6% hit > 80%; 3 turns hit `stop_reason = 'max_tokens'`.

**Caveats.** The model-aware denominator (200k vs 1M) has no third branch
for a future 2M-context model — a 1.5M-token turn would silently display as
100%. See [SESSION-010](#known-issues).

### peak_context_pct

**What it informs you.** Worst-case context-window utilization observed in a
session.

**Formula.** `MAX((input + cache_read + cache_creation) / window)` per session.

**Computed in.** Same path as `context_pressure_per_session`. View column
[`v_context_pressure.peak_context_pct`](../sql/views.sql).

### pressure_share

**What it informs you.** Share of a session's assistant turns that exceeded
60% context utilization. Distinguishes one-spike vs sustained-loading
sessions.

**Formula.** `COUNT(*) FILTER (utilization > 0.60) / COUNT(*)` per session.

**Computed in.** [`sql/views.sql:485`](../sql/views.sql), [`src/queries/session-analyzer.ts:426`](../src/queries/session-analyzer.ts), [`dashboard/src/server/routes/sessions.ts:281`](../dashboard/src/server/routes/sessions.ts).

### context_pressure_stats

**What it informs you.** Dataset-level rollup: `total_sessions`,
`sessions_over_60` / `_over_80`, `pressureRate`, `criticalRate`,
`worstPeakPct`, `max_tokens_turns`.

**Computed in.** [`src/queries/session-analyzer.ts:469`](../src/queries/session-analyzer.ts) (`getContextPressureStats`), [`dashboard/src/server/routes/sessions.ts:290`](../dashboard/src/server/routes/sessions.ts).

**Caveats.** `totalSessions` here = sessions with at least one assistant turn
(869 on live data); `/api/sessions/stats.totalSessions` = 975. The implicit
106-session gap is not surfaced. See [SESSION-011](#known-issues).

### max_tokens_turns

**What it informs you.** Hard-truncation indicator — turns where the model
literally ran out of output budget.

**Formula.** `COUNT(*) FILTER (stop_reason = 'max_tokens')`.

**Computed in.** [`sql/views.sql:490`](../sql/views.sql), [`src/queries/session-analyzer.ts:428`](../src/queries/session-analyzer.ts), [`dashboard/src/server/routes/sessions.ts:283`](../dashboard/src/server/routes/sessions.ts).

**Interpretation.** > 0 in a session always warrants a look; dataset-wide
> 1% of turns = systemic. Live: 3 total. The proposed
[`max-tokens-truncation-rate`](#proposed-new-kpis) KPI promotes this from a
raw count to a rate with thresholds.

---

## Tool metrics

The tool group answers "which tools succeed, which fail, how do they
sequence?"

### tool_usage

**What it informs you.** Per-tool aggregate: call count, success/failure
counts, success rate, avg duration, sessions-using, calls per session.

**Formula.**

```sql
GROUP BY tool_name, tool_type, mcp_server:
  COUNT(*),
  COUNT FILTER (success = TRUE / FALSE),
  success_rate (KPI-006 NULL rule),
  AVG(duration_ms),
  COUNT DISTINCT session_id,
  COUNT(*) / NULLIF(COUNT DISTINCT session_id, 0)
```

**Computed in.**

- View: [`sql/views.sql:188`](../sql/views.sql) (`v_tool_usage`)
- TS: [`src/queries/tool-analyzer.ts:75`](../src/queries/tool-analyzer.ts) (`getToolUsage`)
- Route: [`dashboard/src/server/routes/tools.ts:28`](../dashboard/src/server/routes/tools.ts) (`GET /api/tools/usage`)

### tool_success_rate

**What it informs you.** Per-tool success rate. Returns NULL (not 0) when no
underlying row has a non-NULL success — "no data" is distinct from "0%
success" (KPI-006).

**Formula.**

```sql
COUNT(*) FILTER (success = TRUE)
/ NULLIF(COUNT(*) FILTER (success IS NOT NULL), 0)
```

**Computed in.** [`sql/views.sql:196`](../sql/views.sql), [`src/queries/tool-analyzer.ts:148`](../src/queries/tool-analyzer.ts), [`dashboard/src/server/routes/tools.ts:100`](../dashboard/src/server/routes/tools.ts).

### tool_avg_duration_ms

**What it informs you.** Per-tool average duration in ms. **NULL** when
every underlying `duration_ms` is NULL (TOOL-001 / SEM2-282).

**Formula.** `AVG(duration_ms)` — NULL preserved through every layer.

**Computed in.** Across `ToolAnalyzer` (lines 99, 165, 228) and
`/api/tools/*` routes (lines 54, 119, 184).

**Interpretation.** **Both ingestion adapters currently write
`duration_ms = NULL`** ([`adapters/claude-code.ts:280`](../src/ingestion/adapters/claude-code.ts), [`adapters/claude-desktop.ts:512`](../src/ingestion/adapters/claude-desktop.ts)).
The UI correctly renders "n/a" everywhere. Until a backfill ships, this
column is honest signal that we have no per-tool latency telemetry. See
[TOOL-DURATION-NULL-DATASET-WIDE](#known-issues).

### avg_per_session (tool)

**What it informs you.** Per-tool calls per session using the tool.

**Formula.** `COUNT(*) / NULLIF(COUNT(DISTINCT session_id), 0)`.

**Computed in.** [`sql/views.sql:205`](../sql/views.sql), [`src/queries/tool-analyzer.ts:103`](../src/queries/tool-analyzer.ts), [`dashboard/src/server/routes/tools.ts:57`](../dashboard/src/server/routes/tools.ts).

**Caveats.** Denominator is **sessions using this tool**, not all sessions
in the period. Live: Bash = `27,633 / 710 = 38.92`; if normalized to all
976 sessions, it would be 28.3 (~27% lower). Worth a clarifying tooltip.
See [TOOL-USAGE-AVG-PER-SESSION-COUNTER-INTUITIVE](#known-issues).

### mcp_server_usage

**What it informs you.** Per MCP server: total calls, unique tools,
avg duration.

**Formula.** `GROUP BY mcp_server WHERE tool_type = 'mcp'`:
`COUNT(*), DISTINCT tool_name, AVG(duration_ms)`.

**Computed in.** [`src/queries/tool-analyzer.ts:223`](../src/queries/tool-analyzer.ts), [`dashboard/src/server/routes/tools.ts:176`](../dashboard/src/server/routes/tools.ts).

**Caveats.** `totalTokens` field is hard-coded to `0` (tool_calls table
doesn't track per-tool tokens). The field is in the public type but never
populated. Either drop or derive from host-turn tokens. See
[TOOL-MCP-SERVER-TOTAL-TOKENS-PLACEHOLDER](#known-issues).

### tool_chains

**What it informs you.** Common 3-tool sequential patterns within sessions
(e.g. `Read -> Edit -> Bash`).

**Formula.** `ROW_NUMBER OVER (PARTITION BY session ORDER BY ct.timestamp, tc.tool_call_id)`,
triple self-join on `rn+1, rn+2`; `GROUP BY chain HAVING COUNT(*) >= N`.

**Computed in.** [`src/queries/tool-analyzer.ts:283`](../src/queries/tool-analyzer.ts), [`dashboard/src/server/routes/tools.ts:456`](../dashboard/src/server/routes/tools.ts).

**Interpretation.** Live: `Bash -> Bash -> Bash` = 13,798 occurrences (was
~7.3k under the pre-PR-7 ordering bug).

**Caveats.** 3-leg `avg_duration_ms` is `NULL` only when **all three** legs
are NULL; partial NULL legs are COALESCED to 0 (matches pre-fix per-leg
behavior). Will systematically under-estimate when adapters start writing
durations. See [TOOL-CHAIN-AVG-PARTIAL-NULL](#known-issues).

### tool_failure_trend

**What it informs you.** NEW-002 — tool failure-rate trend, time-bucketed
and split builtin-vs-MCP.

**Formula.**

```sql
GROUP BY DATE_TRUNC(bucket, ts), tool_class:
  COUNT(*),
  COUNT FILTER (success IS NOT NULL),
  COUNT FILTER (success = FALSE),
  failure_rate = failure / NULLIF(evaluated, 0)
```

**Computed in.**

- View: [`sql/views.sql:512`](../sql/views.sql) (`v_tool_failure_trend` — daily, UTC)
- TS: [`src/queries/tool-analyzer.ts:376`](../src/queries/tool-analyzer.ts) (`getToolFailureTrend`)
- Route: [`dashboard/src/server/routes/tools.ts:242`](../dashboard/src/server/routes/tools.ts) (`GET /api/tools/failure-trend`)

**Caveats.** View buckets by UTC date; analyzer/route bucket by user tz —
same documented pattern as `v_cache_efficiency` / `v_hourly_activity`. See
[TOOL-FAILURE-TREND-VIEW-UTC](#known-issues).

### failure_chains

**What it informs you.** NEW-003 — consecutive runs of `success = FALSE`
within a session. Rework signal.

**Formula.** Gaps-and-islands:
`rn - ROW_NUMBER OVER (PARTITION BY session, success) = streak_group`;
`failure_streaks WHERE success = FALSE`; per session
`MAX(streak_len)`, `COUNT FILTER (>= 2)`, `COUNT FILTER (>= 3)`. Ordering
**MUST** use `ct.timestamp, tc.tool_call_id` (TOOL-003 / TOOL-004).

**Computed in.**

- View: [`sql/views.sql:579`](../sql/views.sql) (`v_session_failure_chains`)
- TS: [`src/queries/tool-analyzer.ts:476`](../src/queries/tool-analyzer.ts) (`getFailureChains`)
- Route: [`dashboard/src/server/routes/tools.ts:348`](../dashboard/src/server/routes/tools.ts) (`GET /api/tools/failure-chains`)

**Interpretation.** Live: `max_failure_streak` = 8, `chainRate3Plus` = 6.57%
(56 / 852 sessions). Streak distribution: 1: 2136, 2: 191, 3: 44, 4: 10,
5: 8, 6: 3, 7: 3, 8: 3.

**Caveats.**

- **Stored view `v_session_failure_chains` in the live DB is stale** — still
  uses the pre-PR-7 `ORDER BY tool_call_id` only, no `sessions_in_scope`
  LEFT JOIN. Reports max streak = 6 (real: 8) and 626 sessions (real: 852,
  with 247 zero-failure preserved). See [TOOL-STALE-VIEW](#known-issues) and
  the [Systemic finding](#systemic-finding--stored-views-in-live-duckdb-are-stale).
- Denominator excludes sessions whose tool calls all have NULL success.
  Today the delta is 0; worth documenting on the KPI tooltip. See
  [TOOL-CHAIN-RATE-EXCLUDES-NULL-SUCCESS-SESSIONS](#known-issues).

### max_failure_streak

**What it informs you.** Longest consecutive run of failures observed in a
session.

**Formula.** `MAX(streak_len)` per session from the gaps-and-islands CTE.

**Computed in.** [`sql/views.sql:617`](../sql/views.sql), [`src/queries/tool-analyzer.ts:521`](../src/queries/tool-analyzer.ts), [`dashboard/src/server/routes/tools.ts:390`](../dashboard/src/server/routes/tools.ts).

### chain_rate_3plus

**What it informs you.** Dataset-level share of tool-using sessions that
contain a failure streak of length >= 3.

**Formula.** `sessionsWithChains3Plus / sessionsWithToolCalls` (in JS from
per-session rows).

**Computed in.** [`src/queries/tool-analyzer.ts:559`](../src/queries/tool-analyzer.ts), [`dashboard/src/server/routes/tools.ts:422`](../dashboard/src/server/routes/tools.ts).

---

## Skill metrics

The skill group answers "which skills are loaded, invoked, dead-weight, or
thrashing?"

### skill_summary

**What it informs you.** F2K page-level KPI bundle: avg/max skills loaded per
session, distinct loaded / invoked, total invocations, success rate,
dead-weight count / ratio, invocation rate, avg loaded-skill tokens,
`loadedContextShare`, `tooManySkillsActive` (D11 flag).

**Formula.** Four sub-queries combined in JS:

1. **LOADED** — per-session `COUNT DISTINCT skill_name` + per-skill
   description-length token estimate
2. **INVOKED** — `Skill` tool_calls with `COALESCE(skill_name, parameters->>'skill')`
3. **DEAD-WEIGHT** — loaded NOT IN invoked
4. **CONTEXT proxy** — `AVG(input + cache_read + cache_creation)` over
   assistant turns

**Computed in.**

- TS: [`src/queries/skill-analyzer.ts:235`](../src/queries/skill-analyzer.ts) (`getSkillSummary`)
- Route: [`dashboard/src/server/routes/skills.ts:73`](../dashboard/src/server/routes/skills.ts) (`GET /api/skills/summary`)

**Interpretation.** Live: 232 sessions with loaded skills, 169 distinct
loaded names, 40 distinct invoked, 141 dead-weight (83.4% ratio), avg
loaded-skill tokens per session = 5,851, `loaded_context_share` = 0.0325
(D11(b) threshold 0.05 not breached).

**Caveats.**

- The per-session SUM does **not** dedupe `(session_id, skill_name)` rows;
  long sessions where `skill_listing` is re-parsed get up to 5.97x
  over-counted. Dataset-wide ~6% bias today (5,851 vs 5,510 dedup'd). See
  [SKILL-02](#known-issues).
- Dead-weight ratio threshold 0.5 always fires (live 0.83) — banner becomes
  wallpaper. Consider raising to 0.7 / 0.8 or pivot to delta-vs-baseline.
  See [SKILL-06](#known-issues).

### skill_loaded_per_skill

**What it informs you.** Per-skill loaded stats: `loadedInSessions`,
`estContextTokens` (length-based estimate × loadings), `invocations`,
`isDeadWeight`.

**Formula.** `loaded` CTE: `COUNT(DISTINCT session_id)` over `session_skills`
(period-scoped); `inv` CTE: `COUNT(*)` over `Skill` tool_calls.
`estContextTokens = loadedInSessions × COALESCE(CEIL(LENGTH(skill_description) / 4.0), 45)`.
`isDeadWeight = invocations == 0`.

**Computed in.**

- View: [`sql/views.sql:712`](../sql/views.sql) (`v_skill_loaded` — dataset-wide; **STALE on live DB**)
- TS: [`src/queries/skill-analyzer.ts:154`](../src/queries/skill-analyzer.ts) (`getLoadedSkills`)
- Route: [`dashboard/src/server/routes/skills.ts:274`](../dashboard/src/server/routes/skills.ts) (`GET /api/skills/loaded`)

**Caveats.** Stored `v_skill_loaded` in the live DB still hard-codes the
flat `× 45`, so every skill ties on `est_context_tokens`. Inline TS/route
paths use the correct length-based estimate. See [SKILL-01](#known-issues).

### skill_invocation_stats

**What it informs you.** Per-skill: invocations, sessions using,
success/failure counts, success rate (KPI-006 NULL rule), avg per session.

**Formula.** `WITH inv AS (Skill tool_calls + COALESCE name + filters)`:
`COUNT(*), COUNT DISTINCT session_id, COUNT FILTER (success = TRUE/FALSE), success_rate, COUNT(*) / NULLIF(COUNT DISTINCT session_id, 0)`.

**Computed in.** [`src/queries/skill-analyzer.ts:75`](../src/queries/skill-analyzer.ts), [`dashboard/src/server/routes/skills.ts:357`](../dashboard/src/server/routes/skills.ts).

**Interpretation.** Live: 422 `Skill` tool_calls, 419/422 succeeded (99.3%).

### skill_usage_per_session

**What it informs you.** Per `(session, skill)` loaded-vs-invoked rollup with
a `was_loaded` flag distinguishing dead-weight from invoked-but-not-loaded.

**Formula.** `FULL OUTER JOIN` between loaded (session_skills grouped) and
invoked (Skill tool_calls grouped).

**Computed in.** View only: [`sql/views.sql:647`](../sql/views.sql)
(`v_skill_usage`). Reference; no TS or route mirror today.

**Caveats.** 12 skills are invoked-but-not-loaded (Task subagents +
pre-migration-5 sessions). See [SKILL-11](#known-issues).

### skill_thrash (D12)

**What it informs you.** Same-session skill invocation thrash — pairs whose
`invocations_in_session >= SKILL_THRASH_MIN` (= 2). `isKnownReentrant` flag
applied in JS.

**Formula.** `WITH inv` (extracted skill name); `GROUP BY session_id, skill HAVING COUNT(*) >= 2`.

**Computed in.**

- View: [`sql/views.sql:772`](../sql/views.sql) (`v_skill_not_required`)
- TS: [`src/queries/skill-analyzer.ts:459`](../src/queries/skill-analyzer.ts) (`getSkillThrash`)
- Route: [`dashboard/src/server/routes/skills.ts:520`](../dashboard/src/server/routes/skills.ts) (`GET /api/skills/not-required`)

**Interpretation.** Live: 20 thrash rows in 15 sessions; 17 are
`KNOWN_REENTRANT` (babysitter, loop, schedule, handoff). 3 non-reentrant:
linear-pm (3 invocations), omniwealth-fe (2), mermaid-diagram (2). See
[SKILL-07](#known-issues).

### skill_trend

**What it informs you.** Per time bucket, AVG over the bucket's sessions of
(a) distinct skills loaded per session and (b) distinct skills invoked per
session.

**Formula.** `session_bucket: DATE_TRUNC(bucket, MIN(localTs))`;
`loaded_per_session: COUNT DISTINCT skill_name`;
`invoked_per_session: COUNT DISTINCT skill`. AVG per bucket.

**Computed in.** [`src/queries/skill-analyzer.ts:536`](../src/queries/skill-analyzer.ts), [`dashboard/src/server/routes/skills.ts:428`](../dashboard/src/server/routes/skills.ts).

**Caveats.** `loaded_per_session` uses `COUNT(DISTINCT skill_name)` —
the SKILL-02 dedup bug does NOT affect this metric.

### dead_weight_skills

**What it informs you.** Count of skills loaded in the period but never
invoked in the period.

**Formula.** `COUNT(*) FROM loaded WHERE skill NOT IN (SELECT skill FROM invoked WHERE skill IS NOT NULL)`.

**Computed in.** [`src/queries/skill-analyzer.ts:316`](../src/queries/skill-analyzer.ts) (within `getSkillSummary`), [`dashboard/src/server/routes/skills.ts:137`](../dashboard/src/server/routes/skills.ts).

### dead_weight_ratio

**What it informs you.** `deadWeightSkills / distinctSkillsLoaded`;
> `DEAD_WEIGHT_RATIO_THRESHOLD` (= 0.5) fires D11(a).

**Computed in.** [`src/queries/skill-analyzer.ts:391`](../src/queries/skill-analyzer.ts), [`dashboard/src/server/routes/skills.ts:203`](../dashboard/src/server/routes/skills.ts).

**Interpretation.** Live: 141 / 169 = 0.834. D11(a) fires every period.

### loaded_context_share

**What it informs you.** Avg loaded-skill description tokens / avg session
context tokens; > `LOADED_CONTEXT_SHARE_THRESHOLD` (= 0.05) fires D11(b).

**Formula.** `avgLoadedSkillTokens / avgSessionContextTokens`. Numerator is
per-session SUM of `COALESCE(CEIL(LENGTH(desc) / 4.0), 45)`, AVG'd across
sessions; denominator is AVG over assistant turns.

**Computed in.** [`src/queries/skill-analyzer.ts:398`](../src/queries/skill-analyzer.ts), [`dashboard/src/server/routes/skills.ts:210`](../dashboard/src/server/routes/skills.ts).

**Caveats.**

- Numerator is **per-session**; denominator is per-**turn**. Different
  grains. The variable name `avgSessionContextTokens` overstates what the SQL
  computes (no session GROUP BY on the denominator). See
  [SKILL-05](#known-issues).
- Biased UP by the SKILL-02 dedup bug; threshold not breached today
  (live 0.0325 < 0.05) but will worsen as long-session ratio grows.

### est_context_tokens_per_skill (SEM2-287)

**What it informs you.** Per-skill estimated context cost =
`loadedInSessions × per-skill description-length token estimate`.

**Formula.** `loadedInSessions × COALESCE(CEIL(LENGTH(skill_description) / 4.0), 45)`.

**Computed in.**

- View: [`sql/views.sql:712`](../sql/views.sql) (`v_skill_loaded.est_context_tokens`) — **STALE on live DB**
- TS: [`src/queries/skill-analyzer.ts:208`](../src/queries/skill-analyzer.ts) (via `estimateSkillTokens`)
- Route: [`dashboard/src/server/routes/skills.ts:322`](../dashboard/src/server/routes/skills.ts)

**Interpretation.** Real avg per-skill estimate = 67.68 tokens (median 60,
range 6 - 206), vs old flat 45. Per-session avg jumped from 3,963 to 5,851
tokens (+47.6%, matches the +45% expectation).

**Caveats.**

- 70 of 169 skills (41%) have multiple distinct `skill_description` values
  across loadings; `ANY_VALUE` picks an arbitrary variant. Deterministic
  today but spec-fragile. Recommend `MAX(skill_description)` (conservative).
  See [SKILL-04](#known-issues).
- 692 / 21,680 `session_skills` rows have `skill_name > 80 chars`
  (description bled into name). Inflates distinct-loaded count and dilutes
  per-skill `loadedInSessions`. Parser bug, out of scope for SEM2-287. See
  [SKILL-03](#known-issues).

---

## Token metrics

The token group answers "how much volume did the model process?" The
headline distinguishes new tokens (input + output) from total context
(adds cache replay).

### total_tokens (canonical headline)

**What it informs you.** Anthropic-API-style 2-way sum over the cost-row
population (TOK-001 / SEM2-288). Reconciles 1:1 with `total_cost_usd` because
both aggregate the same row population.

**Formula.**

```sql
SUM(input_tokens + output_tokens)
WHERE role = 'assistant'
  AND model IS NOT NULL
  AND model <> '<synthetic>'
```

**Inputs.** `conversation_turns.input_tokens`, `.output_tokens`.

**Computed in.**

- SSOT: [`src/utils/tokenSums.ts:78`](../src/utils/tokenSums.ts) (`buildTokenSumSql().totalTokensSql`)
- View: [`sql/views.sql:86`](../sql/views.sql) (`v_token_totals.total_tokens` — **STALE on live DB**), [`sql/views.sql:149`](../sql/views.sql) (`v_session_summary.total_tokens` — **STALE**)
- TS: [`src/queries/token-analyzer.ts:75`](../src/queries/token-analyzer.ts) (`getTotalTokens`)
- Route: [`dashboard/src/server/routes/tokens.ts:75`](../dashboard/src/server/routes/tokens.ts) (`GET /api/tokens/total`)

**Interpretation.** Live: **41,399,548** (~41.4M). The 24 UTC hour buckets in
`/api/activity/hourly` sum to the same 41,399,548 — exact reconciliation.

**Caveats.**

- Activity routes and prompt routes hand-write `SUM(input + output)` inline
  rather than importing `buildTokenSumSql()`. Numbers agree today by
  coincidence. See [TOK-RE-002](#known-issues).
- Stored views still hold pre-LANE-E 4-way DDL. See
  [TOK-RE-001](#known-issues) and the
  [Systemic finding](#systemic-finding--stored-views-in-live-duckdb-are-stale).

### context_volume_tokens

**What it informs you.** 4-way sum (input + output + cache_creation +
cache_read) — model-processed volume INCLUDING cached prompt replay.
Secondary KPI, **never** the headline (TOK-002 / SEM2-289).

**Formula.**

```sql
SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens)
WHERE role = 'assistant'
  AND model IS NOT NULL
  AND model <> '<synthetic>'
```

**Computed in.**

- SSOT: [`src/utils/tokenSums.ts:78`](../src/utils/tokenSums.ts) (`buildTokenSumSql().contextVolumeTokensSql`)
- View: [`sql/views.sql:86`](../sql/views.sql) (`v_token_totals`), [`sql/views.sql:156`](../sql/views.sql) (`v_session_summary` — **MISSING on live DB**)
- TS: [`src/queries/token-analyzer.ts:75`](../src/queries/token-analyzer.ts)
- Route: [`dashboard/src/server/routes/tokens.ts:75`](../dashboard/src/server/routes/tokens.ts)

**Interpretation.** Live: **12,118,013,244** (~12.1B). cache_read alone =
11.85B = 97.77% of total — confirms the "context replay" framing. Multiplier
context/headline = 292.7x.

**Caveats.** The Dashboard tooltip is under-explained — users see "12.12B"
next to "41.4M" and naturally read 12.12B as the "real" number. Recommend
surfacing the cache-replay share. See [TOK-RE-003](#known-issues).

### input_tokens

**What it informs you.** Uncached input-token sum (cache_read and
cache_creation are SEPARATE Anthropic API fields).

**Formula.** `SUM(input_tokens)`.

**Computed in.** SSOT: [`src/utils/tokenSums.ts:89`](../src/utils/tokenSums.ts), TS: [`src/queries/token-analyzer.ts:61`](../src/queries/token-analyzer.ts), Route: [`dashboard/src/server/routes/tokens.ts:32`](../dashboard/src/server/routes/tokens.ts).

**Live value:** 1,448,643.

### output_tokens

**What it informs you.** Sum of assistant-generated tokens.

**Formula.** `SUM(output_tokens)`.

**Computed in.** SSOT: [`src/utils/tokenSums.ts:90`](../src/utils/tokenSums.ts), TS: [`src/queries/token-analyzer.ts:62`](../src/queries/token-analyzer.ts), Route: [`dashboard/src/server/routes/tokens.ts:33`](../dashboard/src/server/routes/tokens.ts).

**Live value:** 39,950,905.

### cache_read_tokens

**What it informs you.** Sum of tokens served from cache (Anthropic
`cache_read_input_tokens`).

**Formula.** `SUM(cache_read_tokens)`.

**Computed in.** SSOT: [`src/utils/tokenSums.ts:92`](../src/utils/tokenSums.ts), TS: [`src/queries/token-analyzer.ts:64`](../src/queries/token-analyzer.ts), Route: [`dashboard/src/server/routes/tokens.ts:35`](../dashboard/src/server/routes/tokens.ts).

**Live value:** 11,848,193,457.

### cache_write_tokens

**What it informs you.** Sum of cache-creation tokens (Anthropic
`cache_creation_input_tokens`). Surfaced as "cache write" throughout the
codebase.

**Formula.** `SUM(cache_creation_tokens)`.

**Computed in.** SSOT: [`src/utils/tokenSums.ts:91`](../src/utils/tokenSums.ts), TS: [`src/queries/token-analyzer.ts:63`](../src/queries/token-analyzer.ts), Route: [`dashboard/src/server/routes/tokens.ts:34`](../dashboard/src/server/routes/tokens.ts).

**Live value:** 228,420,239.

---

## Prompt metrics

The prompt group answers "which prompts cost the most, ran the longest, or
went off the rails?"

### prompt_ranking

**What it informs you.** Paginated, sortable list of user-prompt-with-response
pairs with `response_cost`, `tool_call_count`, `total_tokens` (2-way),
`multi_turn_depth`, `has_thinking`, `model`, and a GLOBAL-percentile
`complexity_score`.

**Formula.** `buildPromptPairsCTE` (numbered turns, user/assistant pairing,
aggregated cost/tokens, tool counts) JOIN `g_scored_prompts` (GLOBAL
percentile composite). KPI-004: `WHERE multi_turn_depth > 0`.

**Computed in.**

- View: [`sql/views.sql:315`](../sql/views.sql) (`v_prompt_analysis` — advisory, **stale**)
- TS: [`src/queries/prompt-analyzer.ts:358`](../src/queries/prompt-analyzer.ts) (`getPromptRanking`)
- Route: [`dashboard/src/server/routes/prompts.ts:314`](../dashboard/src/server/routes/prompts.ts) (`GET /api/prompts/ranked`)

**Caveats.** `v_prompt_analysis` is stale on three counts: legacy 4-way
`total_tokens`, no `distinct_tools_used`, no `complexity_score`. No
production reader, but a future ad-hoc consumer would be misled. See
[PROMPT-RA-004](#known-issues).

### complexity_score (KPI-005)

**What it informs you.** Equal-weighted composite percentile (0-100) of:
`PERCENT_RANK(tool_call_count)`, `PERCENT_RANK(total_tokens)`,
`PERCENT_RANK(multi_turn_depth)`, `PERCENT_RANK(distinct_tools_used)`.

**Formula.**

```sql
ROUND(
  ( PERCENT_RANK(tool_call_count)       × 100
  + PERCENT_RANK(total_tokens)          × 100
  + PERCENT_RANK(multi_turn_depth)      × 100
  + PERCENT_RANK(distinct_tools_used)   × 100
  ) / 4.0,
  1
)
```

Computed GLOBALLY (`g_scored_prompts`) so a prompt's score is identical
regardless of active filter.

**Computed in.** [`src/queries/prompt-analyzer.ts:222`](../src/queries/prompt-analyzer.ts) (scored), :333 (global); [`dashboard/src/server/routes/prompts.ts:182`](../dashboard/src/server/routes/prompts.ts), :289.

**Interpretation.** Live distribution on responded prompts: 0-20: 11.86%,
20-40: 11.05%, 40-60: 26.30%, 60-80: 26.68%, 80-100: 24.11%.

**Caveats.**

- `tool_call_count` and `multi_turn_depth` still correlate r=0.9954 — 2 of
  4 dimensions in near-perfect lock-step. Composite is effectively
  3-dimensional. See [PROMPT-RA-002](#known-issues).
- Percentile pool includes 2,187 no-response prompts (all-zero rows); ranks
  inflated by 10-23 percentile points at the low end. See
  [PROMPT-RA-003](#known-issues).

### prompt_stats

**What it informs you.** Aggregate stats: `total_prompts` (responded only,
KPI-004), `prompts_with_no_response`, `avg_cost`, `max_cost`,
`avg_complexity` (GLOBAL), cost distribution histogram (7 buckets), complexity
distribution histogram (5 buckets).

**Computed in.** [`src/queries/prompt-analyzer.ts:462`](../src/queries/prompt-analyzer.ts), [`dashboard/src/server/routes/prompts.ts:424`](../dashboard/src/server/routes/prompts.ts).

**Caveats.** CLI analyzer's `complexity_distribution` lacks the
`WHERE multi_turn_depth > 0` filter that the dashboard route applies. Real
drift: CLI 0-20 bucket = 2,863 vs dashboard = 676. The 2,187 zero-score
no-response prompts collapse into the lowest bucket on CLI only. See
[PROMPT-RA-001](#known-issues).

### prompt_throughput (NEW-004)

**What it informs you.** `promptsPerSession`, `turnsPerPrompt`,
`toolCallsPerPrompt` — density of agentic activity (responded-only,
KPI-004).

**Formula.** `COUNT(*) FILTER (multi_turn_depth > 0)`,
`AVG(multi_turn_depth)`, `AVG(tool_call_count)`. `promptsPerSession` =
`totalPrompts / totalSessions` in JS.

**Computed in.** [`src/queries/prompt-analyzer.ts:633`](../src/queries/prompt-analyzer.ts), [`dashboard/src/server/routes/prompts.ts:603`](../dashboard/src/server/routes/prompts.ts).

**Interpretation.** Live: `promptsPerSession` ≈ 6.88, `turnsPerPrompt` ≈
11.54, `toolCallsPerPrompt` ≈ 10.63.

**Caveats.** Denominator for `promptsPerSession` is
`COUNT(DISTINCT session_id) FILTER (multi_turn_depth > 0)` — sessions whose
only prompts went unresponded are dropped. Empirically a no-op today. See
[PROMPT-RA-006](#known-issues).

### prompt_detail

**What it informs you.** Full detail for one user-prompt → assistant
response(s) pair: text, response_cost, complexity_score (GLOBAL), token
breakdown, tool calls.

**Computed in.** [`src/queries/prompt-analyzer.ts:677`](../src/queries/prompt-analyzer.ts) (`getPromptDetail`), [`dashboard/src/server/routes/prompts.ts:655`](../dashboard/src/server/routes/prompts.ts) (`GET /api/prompts/:turnId`).

### multi_turn_depth

**What it informs you.** Count of assistant turns following a user turn
(before the next user turn). 0 means no response.

**Formula.** `COUNT(ot.turn_id)` in `assistant_agg` CTE.

**Computed in.** [`sql/views.sql:368`](../sql/views.sql), [`src/queries/prompt-analyzer.ts:157`](../src/queries/prompt-analyzer.ts), [`dashboard/src/server/routes/prompts.ts:121`](../dashboard/src/server/routes/prompts.ts).

---

## Activity metrics

The activity group answers "when and how often is the user working?"

### hourly_activity (KPI-002 / ACT-005)

**What it informs you.** 24-row hour-of-day distribution: `message_count`,
`session_count`, `avg_cost`, `total_tokens` (2-way), `total_cost`,
`avg_tokens_per_turn`. Uses `costRowPredicateSql()` so it reconciles with
`v_daily_cost`.

**Formula.** Per-hour CTE over cost-bearing assistant turns;
`GROUP BY EXTRACT(HOUR FROM localTs)`;
`LEFT JOIN generate_series(0,23)` to pad empty hours with zeros
(ACT-003 / SEM2-295).

**Computed in.**

- View: [`sql/views.sql:274`](../sql/views.sql) (`v_hourly_activity` — UTC, 2-way per ACT-004; **STALE on live DB**)
- TS: [`src/queries/time-series.ts:87`](../src/queries/time-series.ts) (`getHourlyActivity` — user-tz)
- Route: [`dashboard/src/server/routes/activity.ts:50`](../dashboard/src/server/routes/activity.ts) (`GET /api/activity/hourly` — user-tz)

**Interpretation.** Live with TZ=Asia/Jerusalem (+3 May DST): peak hour
moves from UTC 11 to local 14, matching expectations.

**Caveats.**

- Live DB `v_hourly_activity` still uses pre-PR-13/14 body (no
  `generate_series`, 4-way `total_tokens`, no synthetic/null-model filter).
  Returns 20 rows. Inline route is correct. See
  [ACT-AUDIT-1](#known-issues) and the
  [Systemic finding](#systemic-finding--stored-views-in-live-duckdb-are-stale).
- Round precision differs between view (`ROUND` 6dp for `avg_cost`, 0dp for
  `avg_tokens_per_turn`) and inline mirror (no `ROUND`). Cosmetic; UI
  format hides it. See [ACT-AUDIT-7](#known-issues).

### daily_activity

**What it informs you.** Daily turn count series (user-local date buckets).
Cost-row predicate applied so the count reconciles with `/api/cost/daily`.

**Formula.** `SELECT CAST(localTs AS DATE) AS date, COUNT(*) AS value WHERE costRowPredicate ... GROUP BY date`.

**Computed in.** [`src/queries/time-series.ts:167`](../src/queries/time-series.ts), [`dashboard/src/server/routes/activity.ts:132`](../dashboard/src/server/routes/activity.ts).

**Interpretation.** Live: max daily-vs-`v_daily_cost` delta over 90 days = 0
turns across all 82 days with data (was up to 14 turns / 5.8% before
PR #14).

### activity_heatmap

**What it informs you.** DOW × hour-of-day heatmap. Cost-row predicate
applied; both axes use user-tz projection (ACT-001).

**Formula.** `SELECT EXTRACT(DOW FROM localTs), EXTRACT(HOUR FROM localTs), COUNT(*) ... GROUP BY DOW, hour`.

**Computed in.** [`src/queries/time-series.ts:210`](../src/queries/time-series.ts), [`dashboard/src/server/routes/activity.ts:179`](../dashboard/src/server/routes/activity.ts).

**Interpretation.** DuckDB `EXTRACT(DOW)` returns 0=Sun..6=Sat; UI
`DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']` aligns correctly
(PR #3 / SEM2-294 holds). Live: DOW=5 (Fri) is the lowest-volume row in
Asia/Jerusalem (Shabbat starts at sundown).

### weekly_trend

**What it informs you.** Weekly activity (turn count) trend with user-local
week boundaries. CLI only.

**Formula.** `SELECT DATE_TRUNC('week', localTs) AS week, COUNT(*) ... GROUP BY week`.

**Computed in.** [`src/queries/time-series.ts:255`](../src/queries/time-series.ts) (`getWeeklyTrend`). No dashboard route.

---

## Known issues

Every finding from the 8 per-group reviews, grouped by severity. Severity
labels are reviewer-assigned per-group; the cross-group systemic finding is
called out separately at the top.

### Systemic finding — stored views in live DuckDB are stale

Four reviewers independently flagged this. The `sql/views.sql` file is the
documented SSOT for view DDL (header at lines 6-17:
"_When a KPI definition changes, update BOTH the inline SQL and this view
so they can never drift apart_"). However,
[`src/db/schema.ts:130-141`](../src/db/schema.ts) short-circuits at
`if (currentVersion >= CURRENT_VERSION) return 0;` so the views are never
re-applied to databases that already passed the version gate. Every Wave 1-3
view edit (TOK-001/002, ACT-003/004/005, SEM2-287, TOOL-002/005) is in the
source file but **not** in the live DB.

> **token (TOK-RE-001, HIGH).** "DuckDB `information_schema.views.view_definition`
> for `v_token_totals`: `sum((((input_tokens + output_tokens) + cache_creation_tokens) + cache_read_tokens)) AS total_tokens` — old 4-way formula,
> with NO `context_volume_tokens` column. `SELECT * FROM v_token_totals`
> returns `total_tokens = 12,118,013,244` (the 4-way), NOT the new
> 41,399,548 (the canonical 2-way). `v_session_summary.context_volume_tokens`
> column doesn't even exist on the live DB."

> **skill (SKILL-01, HIGH).** "The persisted `v_skill_loaded` view in the
> live DB still hard-codes the flat `*45` and does NOT have the SEM2-287
> fix. All 169 skills show `est_context_tokens = 10,395 or 10,440` —
> identical for every skill regardless of description length."

> **activity (ACT-AUDIT-1, INFO).** "`v_hourly_activity` in the live DB lags
> `sql/views.sql` (operational drift, not a code defect). Probe returns 20
> rows in the live DB vs the expected 24. The dashboard re-runs
> `sql/views.sql` on every `SchemaManager.initialize()` invocation, so the
> next ingest / init / status / dashboard launch refreshes the view."

> **tool (TOOL-STALE-VIEW, LOW).** "Stored `v_session_failure_chains` in
> live DB is stale relative to `sql/views.sql` (still has the pre-PR-7
> `ORDER BY tool_call_id` and no `sessions_in_scope` LEFT JOIN). Stored
> view reports `max_failure_streak = 6` (real: 8) and 626 sessions (real:
> 852, with 247 zero-failure preserved)."

**Recommendation (collated).** Add a migration-6 (or unconditional views
replay) so `sql/views.sql` runs on every connection-open or schema migration
pass, not only at version 0. Every view is `CREATE OR REPLACE VIEW` so the
replay is idempotent by design. This restores the SSOT contract and protects
against future SQL-only view changes.

### Critical (0)

(No critical findings outstanding.)

### High (3)

- `[high]` **session/session_summary**: Live DB `v_session_summary` DDL is
  stale — missing `context_volume_tokens` and `total_tokens` is still the
  4-way sum — [`sql/views.sql:119-182`](../sql/views.sql) (SESSION-008)
- `[high]` **skill/est_context_tokens_per_skill**: Persisted `v_skill_loaded`
  view still hard-codes flat `*45` — [`sql/views.sql:712-748`](../sql/views.sql) (SKILL-01)
- `[high]` **token/total_tokens, context_volume_tokens**: Live DB views
  `v_token_totals`, `v_hourly_activity`, `v_session_summary`,
  `v_prompt_analysis` are STALE and still implement pre-LANE-E 4-way
  `total_tokens` — [`src/db/schema.ts:130-166`](../src/db/schema.ts) (TOK-RE-001)

### Medium (8)

- `[medium]` **cache/estimated_cache_savings_usd**: SEM2-279 still open —
  `v_cache_efficiency.estimated_tokens_saved` is a tokens-figure named like
  USD, flat 0.9 proxy while TS/route emit model-aware USD — [`sql/views.sql:241`](../sql/views.sql) (CACHE-RE-1)
- `[medium]` **cache/cache_efficiency_trend**: `v_cache_efficiency` exposes
  per-day rates whose AVG (0.957) differs from ratio-of-sums (0.981) by
  2.4pp — consumers may pick the wrong one — [`sql/views.sql:230-238`](../sql/views.sql) (CACHE-RE-2)
- `[medium]` **cache/cache_hit_rate, cache_by_session**: Predicate divergence
  — cache surfaces filter `role = 'assistant'` only, cost uses cost-row
  predicate, `v_session_summary` uses no role filter — [`src/queries/cache-analyzer.ts:74`](../src/queries/cache-analyzer.ts) (CACHE-RE-3)
- `[medium]` **cache/cache_by_session**: Reads `cache_hit_rate` from view but
  recomputes everything else inline — two halves can drift — [`src/queries/cache-analyzer.ts:194-205`](../src/queries/cache-analyzer.ts) (CACHE-RE-4)
- `[medium]` **session/total_turns**: `num_turns` counts BOTH user AND
  assistant turns; undocumented and inflates "work" by ~60% vs assistant-only
  — [`sql/views.sql:128`](../sql/views.sql) (SESSION-001)
- `[medium]` **session/avg_turns_per_session**: AVG inherits long-tail skew;
  mean exceeds median by 73% — recommend adding `medianTurnsPerSession` —
  [`src/queries/session-analyzer.ts:319-329`](../src/queries/session-analyzer.ts) (SESSION-002)
- `[medium]` **session/avg_cost_per_session**: Mean exceeds median by 3.7x
  (same long-tail problem as duration); recommend adding
  `medianCostPerSession` — [`src/queries/session-analyzer.ts:329`](../src/queries/session-analyzer.ts) (SESSION-006)
- `[medium]` **session/unique_models**: List includes `<synthetic>` placeholder
  that the cost predicate explicitly excludes — selecting it from a filter
  dropdown returns 0 rows everywhere — [`src/queries/session-analyzer.ts:346-353`](../src/queries/session-analyzer.ts) (SESSION-007)
- `[medium]` **session/session_detail**: `getSessionDetail` orders
  `tool_calls` by `tool_call_id` (random base62), so users see shuffled order
  on the detail page — [`src/queries/session-analyzer.ts:233`](../src/queries/session-analyzer.ts) (SESSION-009)
- `[medium]` **session/context_pressure_per_session**: Self-correcting window
  denominator masks legitimately-over-1M-token turns; would display as 100%
  — [`src/queries/session-analyzer.ts:34-37`](../src/queries/session-analyzer.ts) (SESSION-010)
- `[medium]` **skill/avgLoadedSkillTokens, loaded_context_share**: Per-session
  CTE sums over raw `session_skills` rows without dedup; long sessions where
  `skill_listing` is re-parsed get up to 5.97x over-counted — [`src/queries/skill-analyzer.ts:253-258`](../src/queries/skill-analyzer.ts) (SKILL-02)
- `[medium]` **token/total_tokens**: Hourly-activity TS analyzer and dashboard
  route hand-write `SUM(input + output)` inline instead of importing
  `buildTokenSumSql()` — SSOT covers only 2 of 4 callsites — [`src/queries/time-series.ts:108`](../src/queries/time-series.ts) (TOK-RE-002)
- `[medium]` **prompt/prompt_stats (complexityDistribution)**: CLI analyzer
  lacks `multi_turn_depth > 0` filter; CLI 0-20 bucket = 2,863 vs dashboard
  = 676 (~324% drift) — [`src/queries/prompt-analyzer.ts:550-584`](../src/queries/prompt-analyzer.ts) (PROMPT-RA-001)
- `[medium]` **prompt/complexity_score**: `tool_call_count` and
  `multi_turn_depth` still correlate r=0.9954 — composite is effectively
  3-dimensional — [`src/queries/prompt-analyzer.ts:226-235`](../src/queries/prompt-analyzer.ts) (PROMPT-RA-002)

### Low (12)

- `[low]` **cost/total_cost_usd**: Period-clamped `/api/sessions/stats` vs
  `/api/cost/total` still disagree by ~1.4 - 2.5% on period=7d/30d (filter
  on `start_time` vs `timestamp`) — [`dashboard/src/server/routes/sessions.ts:140-155`](../dashboard/src/server/routes/sessions.ts) (COST-REAUDIT-001)
- `[low]` **cost/session_summary.total_cost_usd**: Stored
  `sessions.total_cost_usd` column drifted on 10 / 976 sessions (~$218 abs);
  endpoints no longer read it but ingestion still writes it —
  [`sql/views.sql:107-117`](../sql/views.sql) (COST-REAUDIT-002)
- `[low]` **cost/total_cost_usd**: `v_session_summary.turn_agg` has no
  cost-row predicate; today $0 leak, but contract is implicit — [`sql/views.sql:119-182`](../sql/views.sql) (COST-REAUDIT-003)
- `[low]` **cache/cache_hit_rate**: Interpretation bands disagree across
  CLAUDE.md (`< 30% red flag`), CacheAnalyzer (`< 0.5 ineffective`), and
  inventory — pick one ladder and reference everywhere — [`CLAUDE.md`](../CLAUDE.md), [`src/queries/cache-analyzer.ts:115-121`](../src/queries/cache-analyzer.ts) (CACHE-RE-5)
- `[low]` **cache/estimated_cache_savings_usd**: API-list-price USD caveat
  exists only in `pricing.ts:131-135`, not on the wire — [`src/utils/pricing.ts:131-135`](../src/utils/pricing.ts) (CACHE-RE-6)
- `[low]` **session/avg_duration_minutes**: Deprecated KPI still ships in API
  response; remove after CLI dashboard migrates — [`src/queries/session-analyzer.ts:65`](../src/queries/session-analyzer.ts) (SESSION-003)
- `[low]` **session/capped_mean_duration_minutes**: 12h cap is a magic
  constant duplicated in 2 places; extract to shared util — [`src/queries/session-analyzer.ts:51`](../src/queries/session-analyzer.ts) (SESSION-004)
- `[low]` **session/median_duration_minutes**: NULL-skip semantics are
  implicit (DuckDB MEDIAN behavior); brittle to upstream COALESCE — [`src/queries/session-analyzer.ts:72-76`](../src/queries/session-analyzer.ts) (SESSION-005)
- `[low]` **session/context_pressure_stats**: `totalSessions` here = sessions
  with assistant turns (869); `/api/sessions/stats.totalSessions` = 975 —
  undocumented denominator mismatch — [`src/queries/session-analyzer.ts:469-525`](../src/queries/session-analyzer.ts) (SESSION-011)
- `[low]` **tool/max_failure_streak / failure_chains**: Stored
  `v_session_failure_chains` in live DB is stale relative to source — [`sql/views.sql:579-633`](../sql/views.sql) (TOOL-STALE-VIEW)
- `[low]` **skill/skill_name parsing**: 692 rows (3.2%) have `skill_name`
  containing the description (parser bug); inflates distinct loaded count —
  ingestion layer (SKILL-03)
- `[low]` **skill/est_context_tokens_per_skill**: `ANY_VALUE(skill_description)`
  is non-deterministic spec-wise; replace with `MAX` for conservative
  estimate — [`src/queries/skill-analyzer.ts:178`](../src/queries/skill-analyzer.ts) (SKILL-04)
- `[low]` **skill/loaded_context_share**: Numerator is per-session, denominator
  is per-turn; dimensionally inconsistent; rename to clarify — [`src/queries/skill-analyzer.ts:341-354`](../src/queries/skill-analyzer.ts) (SKILL-05)
- `[low]` **token/context_volume_tokens**: Dashboard UI labels "Context
  Volume" 292.7x higher than "Tokens In/Out"; surface needs to teach users
  why (cache replay) — [`dashboard/src/pages/DashboardPage.tsx:299-321`](../dashboard/src/pages/DashboardPage.tsx) (TOK-RE-003)
- `[low]` **token/cache_read_tokens, cache_write_tokens**: `v_hourly_activity`
  uses looser predicate (`role='assistant'` only) than the cost-row predicate
  the inline route uses; today zero divergence, drift-prone — [`sql/views.sql:287`](../sql/views.sql) (TOK-RE-004)
- `[low]` **token/total_tokens (per-prompt)**: `v_prompt_analysis.total_tokens`
  still computes legacy 4-way; TS/route inline use 2-way — [`sql/views.sql:362-367`](../sql/views.sql) (TOK-RE-005)
- `[low]` **prompt/complexity_score**: `PERCENT_RANK` pool includes 2,187
  no-response prompts (all-zero rows); inflates responded ranks by 10-23
  points at low end — [`src/queries/prompt-analyzer.ts:222-235`](../src/queries/prompt-analyzer.ts) (PROMPT-RA-003)
- `[low]` **prompt/v_prompt_analysis**: Advisory SQL view out-of-date with
  both LANE E and LANE F changes — [`sql/views.sql:315-421`](../sql/views.sql) (PROMPT-RA-004)
- `[low]` **prompt/group — METRICS_STORE.md doc**: Known-issues list does not
  strike-through F3 prompt (model filter) — bug is fixed in code but doc
  still flags it as HIGH open — [`docs/METRICS_STORE.md:1204`](../docs/METRICS_STORE.md) (PROMPT-RA-005)
- `[low]` **activity/v_hourly_activity**: View is intentionally UTC;
  downstream consumers must use inline CLI/route bodies — design choice,
  documented — [`sql/views.sql:274-300`](../sql/views.sql) (ACT-AUDIT-6)
- `[low]` **activity/avg_cost, avg_tokens_per_turn**: View rounds at
  different precision than inline mirror (6dp/0dp vs raw doubles) — cosmetic
  — [`sql/views.sql:280`](../sql/views.sql) (ACT-AUDIT-7)

### Info (15)

- `[info]` **tool/tool_avg_duration_ms**: Both ingestion adapters write
  `duration_ms = NULL`; every tool renders "n/a" — honest signal but zero
  diagnostic value until backfill — [`src/ingestion/adapters/claude-code.ts:280`](../src/ingestion/adapters/claude-code.ts), [`src/ingestion/adapters/claude-desktop.ts:512`](../src/ingestion/adapters/claude-desktop.ts) (TOOL-DURATION-NULL-DATASET-WIDE)
- `[info]` **tool/tool_chains.avgDurationMs**: 3-leg chain only goes to NULL
  when ALL three legs are NULL; partial-NULL legs COALESCE to 0 and bias
  averages low — [`src/queries/tool-analyzer.ts:312-317`](../src/queries/tool-analyzer.ts) (TOOL-CHAIN-AVG-PARTIAL-NULL)
- `[info]` **tool/avg_per_session**: Formula is `calls / sessions using tool`,
  not `calls / total sessions` — counter-intuitive name; add tooltip — [`sql/views.sql:205-209`](../sql/views.sql) (TOOL-USAGE-AVG-PER-SESSION-COUNTER-INTUITIVE)
- `[info]` **tool/chain_rate_3plus**: Denominator excludes sessions whose tool
  calls all have NULL success; today delta = 0 — [`src/queries/tool-analyzer.ts:476-572`](../src/queries/tool-analyzer.ts) (TOOL-CHAIN-RATE-EXCLUDES-NULL-SUCCESS-SESSIONS)
- `[info]` **tool/tool_failure_trend**: View buckets UTC; route/analyzer
  user-tz — established pattern across cost/activity/cache — [`sql/views.sql:512-533`](../sql/views.sql) (TOOL-FAILURE-TREND-VIEW-UTC)
- `[info]` **tool/mcp_server_usage.totalTokens**: Hard-coded to 0 in both
  layers; field is in the public type but never populated — remove or derive
  — [`src/queries/tool-analyzer.ts:269`](../src/queries/tool-analyzer.ts) (TOOL-MCP-SERVER-TOTAL-TOKENS-PLACEHOLDER)
- `[info]` **skill/DEAD_WEIGHT_RATIO_THRESHOLD**: Threshold 0.5 vs real 0.83
  — banner always fires, signal erodes; consider raising or pivoting to
  delta-vs-baseline — [`src/queries/skill-thresholds.ts:17`](../src/queries/skill-thresholds.ts) (SKILL-06)
- `[info]` **skill/KNOWN_REENTRANT_SKILLS**: Coverage 17/20 thrash rows;
  consider adding `linear-pm` after another observation period — [`src/queries/skill-thresholds.ts:72-79`](../src/queries/skill-thresholds.ts) (SKILL-07)
- `[info]` **skill/skill_summary, skill_thrash**: CLI ↔ API parity verified
  byte-for-byte — recorded as re-audit pass (SKILL-08)
- `[info]` **skill/skill_trend**: Implementation correct, business meaning
  matches — recorded as re-audit pass (SKILL-09)
- `[info]` **skill/skill success rate**: Per-skill and aggregate success-rate
  computations correctly apply KPI-006 — recorded as re-audit pass (SKILL-10)
- `[info]` **skill/skill_usage_per_session**: 12 invoked-but-not-loaded skills
  (Task subagents + pre-migration-5 sessions) — documented edge case — [`sql/views.sql:647-681`](../sql/views.sql) (SKILL-11)
- `[info]` **token/input_tokens, output_tokens, cache_***: No explicit
  thresholds; only CLAUDE.md narrative thresholds exist (TOK-RE-006)
- `[info]` **prompt/prompt_throughput**: `promptsPerSession` denominator =
  sessions with at least one responded prompt, not all sessions — document
  on tooltip — [`src/queries/prompt-analyzer.ts:645-646`](../src/queries/prompt-analyzer.ts) (PROMPT-RA-006)
- `[info]` **activity/v_hourly_activity** lags `sql/views.sql` (operational
  drift; resolved by next `SchemaManager.initialize()` invocation) — [`sql/views.sql:274-300`](../sql/views.sql) (ACT-AUDIT-1)
- `[info]` **activity/DAY_LABELS** starts with 'Sun' — PR #3 / SEM2-294 holds
  (ACT-AUDIT-2)
- `[info]` **activity/activity↔cost** row-population reconciled to 0 — PR #14
  / SEM2-297 holds (ACT-AUDIT-3)
- `[info]` **activity/24-bucket guarantee** verified — PR #13 / SEM2-295
  holds (ACT-AUDIT-4)
- `[info]` **activity/TZ projection** works — PR #9 / SEM2-293 holds
  (ACT-AUDIT-5)

---

## Wave 1-3 validation results

Each of the 20 SEM2-xxx tickets and its current state, derived from the per-group reviewer findings.

| Ticket | Lane | PR | Description | Re-audit status |
|---|---|---|---|---|
| SEM2-278 | A | #6 | sessions/stats vs cost/total reconcile | **Confirmed fixed** at period=all ($0 gap); ~1.4-2.5% residual at clamped periods (COST-REAUDIT-001) |
| SEM2-279 | — | — | Cache savings naming (token figure named like USD) | **DEFERRED — still open**; CACHE-RE-1 confirms divergence |
| SEM2-280 | A | #6 | Read total_cost from v_session_summary | **Confirmed fixed** (live: $8,335.07 endpoint = $8,335.07 view) |
| SEM2-281 | I | #12 | Surface MEDIAN as primary duration KPI | **Confirmed fixed** — KPI card label is "Median Session Duration" |
| SEM2-282 | C | #10 | Tool avg duration NULL-safe rendering | **Confirmed fixed** — UI shows "n/a" for every tool |
| SEM2-283 | B | #7 | Chronological tool ordering | **Confirmed fixed in inline SQL** (max streak = 8); stored view stale (TOOL-STALE-VIEW) |
| SEM2-284 | B | #7 | Chain detection ordering | **Confirmed fixed in inline SQL** (Bash³ = 13,798); stored view stale |
| SEM2-285 | B | #7 | Parallel tool_use tiebreaker docs | **Confirmed** — 28 parallel turns, tiebreak deterministic |
| SEM2-286 | B | #7 | v_session_failure_chains denominator preserves zero-failure sessions | **Confirmed fixed in inline SQL** (852 sessions, 247 zero); stored view stale (626 / 0) |
| SEM2-287 | H | #5 | Skill token estimate length-based | **Confirmed fixed in TS / route** (avg 67.7 vs flat 45); `v_skill_loaded` view stale (SKILL-01) |
| SEM2-288 | E | #8 | Headline total_tokens = input + output | **Confirmed fixed in TS / route** (41.4M); `v_token_totals` view stale (TOK-RE-001) |
| SEM2-289 | E | #8 | Secondary context_volume_tokens | **Confirmed fixed in TS / route** (12.1B); column missing from live `v_session_summary` |
| SEM2-290 | F | #11 | Composite drops has_thinking | **Confirmed fixed** — categorical badge in PromptsPage.tsx:306 |
| SEM2-291 | F | #11 | Composite adds distinct_tools_used | **Confirmed fixed** — but `tool_call_count`/`multi_turn_depth` still correlate r=0.9954 (PROMPT-RA-002) |
| SEM2-292 | G | #4 | Prompt model filter | **Confirmed fixed** — `?model=opus` returns 5,598 responded prompts (was 0) |
| SEM2-293 | D2 | #9 | Activity user-tz | **Confirmed fixed** — Asia/Jerusalem peak hour shifts UTC 11 → local 14 |
| SEM2-294 | D1 | #3 | Heatmap day labels | **Confirmed fixed** — `DAY_LABELS` starts with 'Sun' |
| SEM2-295 | D3 | #13 | Always 24 hour buckets | **Confirmed fixed** — 7d/1h/future windows all return 24 rows |
| SEM2-296 | E | #8 | Hourly total_tokens = 2-way | **Confirmed fixed in inline SQL**; `v_hourly_activity` view stale |
| SEM2-297 | J | #14, #16 | Activity ↔ cost predicate alignment | **Confirmed fixed** — 90-day max delta = 0 (was up to 14 turns / 5.8%) |

**Summary:** 19 / 20 tickets confirmed fixed in the load-bearing code paths.
SEM2-279 is the lone untouched deferral (cache savings naming). The 3
"mixed pass" entries (SEM2-283/284/286, SEM2-287, SEM2-288/289/296) all
share the same root cause and resolve as soon as `SchemaManager.initialize()`
runs, which happens on every `ccanalytics ingest | init | status | dashboard`
invocation; a one-line schema migration would force the resync.

---

## Proposed new KPIs

32 candidate KPIs across 8 themes, all implementable from the existing
schema unless noted. Top 5 picks first, then the full inventory.

### Top picks (ship these first)

#### max-tokens-truncation-rate

**Theme.** D — Session quality.
**Definition.** Share of assistant turns truncated by the context window
(`stop_reason = 'max_tokens'`).
**Formula.**

```sql
COUNT(*) FILTER (stop_reason = 'max_tokens')
/ NULLIF(COUNT(*) FILTER (role = 'assistant' AND stop_reason IS NOT NULL), 0)
```
**Informs.** When > 2% of turns truncate, split work into smaller scopes,
`/compact` more often, or move to a `-1m` context model. Today this signal
is buried inside `context_pressure_stats.max_tokens_turns` as a raw count
with no denominator.
**Thresholds.** green < 0.5%, yellow 0.5 - 2%, red > 2%.
**Effort.** Trivial. **Priority.** Must-have. **Schema changes.** None.

#### cost-per-completed-prompt

**Theme.** A — Cost efficiency.
**Definition.** Average USD spent per user prompt that actually got a
response (KPI-004 filter). The headline cost-of-work unit.
**Formula.** `SUM(response_cost) / COUNT(*) FROM scored_prompts WHERE multi_turn_depth > 0`.
**Informs.** Tracks whether the user is getting more or less expensive per
unit of intent. A spike means prompts got harder, the cache went cold, or
the wrong model is being used. Normalizes by intent, unlike
`avg_cost_per_session` which conflates session length and density.
**Thresholds.** Watch week-over-week change > 25%; absolute varies by user.
**Effort.** Trivial. **Priority.** Must-have. **Schema changes.** None.

#### cache-creation-payback-turns

**Theme.** B — Cache discipline.
**Definition.** Per session, how much cache read is being amortized over
cache writes. "Is the prompt prefix churning or sticking?"
**Formula.** Per session: `SUM(cache_read_tokens) / NULLIF(SUM(cache_creation_tokens), 0)`.
> 1 means the cache write paid for itself.
**Informs.** Median payback < 3 means the prompt prefix is too volatile
(system prompt changing, skills toggling, files shuffling). Action: pin a
stable system block / freeze skill set / fewer file-reads near session
start.
**Thresholds.** green >= 5x, yellow 2 - 5x, red < 2x.
**Effort.** Trivial. **Priority.** Must-have. **Schema changes.** None.

#### tool-retry-rate

**Theme.** C — Tool effectiveness.
**Definition.** Per tool: share of `(turn_id)` groups where the same
`tool_name` was called more than once with at least one failure.
**Formula.**

```sql
WITH g AS (
  SELECT turn_id, tool_name,
         COUNT(*) AS calls,
         COUNT(*) FILTER (success = FALSE) AS fails
  FROM tool_calls GROUP BY turn_id, tool_name
)
SELECT tool_name,
       COUNT(*) FILTER (calls > 1 AND fails > 0) * 1.0 / COUNT(*) AS retry_rate
FROM g GROUP BY tool_name
```

**Informs.** If `Bash` retry > 10%, the agent is fighting the shell
environment (missing perms, wrong cwd, flaky network). If `Edit` retry >
10%, the agent is misreading file contents — pre-`Read` more or scope
edits smaller.
**Thresholds.** green < 5%, yellow 5 - 10%, red > 10%.
**Effort.** Small. **Priority.** Must-have. **Schema changes.** None.

#### subscription-breakeven-cost

**Theme.** H — MAX subscription ROI.
**Definition.** Per calendar month: hypothetical cost at API list vs the
MAX/Pro plan price. Single number: "you saved (or wasted) $X this month".
**Formula.** `SUM(cost_usd) per month - SUBSCRIPTION_PRICE_USD` (config).
Positive = paid off. Negative = consider downgrade.
**Informs.** Tells the user when their workload no longer justifies the
plan (or when an upgrade would pay back). The most-asked question for any
subscription user.
**Thresholds.** Net savings >= 1.5x plan price = justified;
0.5 - 1.5x = breakeven; < 0.5x = downgrade candidate.
**Effort.** Small. **Priority.** Must-have. **Schema changes.** None
(config: `SUBSCRIPTION_PRICE_USD` env or settings).

### Full catalog (32 KPIs by theme)

| KPI | Theme | Priority | Effort | Informs |
|---|---|---|---|---|
| max-tokens-truncation-rate | D — Session quality | must-have | trivial | Share of turns hitting `stop_reason='max_tokens'`; > 2% = split work or move to `-1m` model |
| cost-per-completed-prompt | A — Cost efficiency | must-have | trivial | Normalizes spend by intent; spike means harder prompts, cold cache, or wrong model |
| cache-creation-payback-turns | B — Cache discipline | must-have | trivial | Payback < 3 means prefix is too volatile; freeze system block / skill set |
| tool-retry-rate | C — Tool effectiveness | must-have | small | `Bash` > 10% = env fighting; `Edit` > 10% = pre-Read more |
| subscription-breakeven-cost | H — MAX ROI | must-have | small | Hypothetical API cost vs plan price; positive = plan paid off |
| failed-prompt-rate | F — Prompt quality | must-have | small | Share of prompts whose response had any tool failure or bad `stop_reason`; > 15% = re-engineer prompts |
| dead-loop-detector | C — Tool effectiveness | must-have | small | Runs of >= 4 consecutive identical tool calls; flagged sessions need manual reset |
| skill-payoff-ratio | E — Skill / MCP ROI | must-have | trivial | Per-skill invocations / loaded context tokens; < 0.001 use/token = negative ROI |
| context-pressure-at-quit | D — Session quality | must-have | small | Context utilization on the LAST assistant turn — distinguishes natural finish from giving up at 95% |
| model-mix-suitability | G — Workflow patterns | should-have | small | Opus on trivial prompts (overspend) and Haiku on hard prompts (likely rework) |
| cache-decay-per-turn | B — Cache discipline | should-have | small | Within-session cache_hit_rate slope; negative slope = cache instability |
| tool-call-fan-out | C — Tool effectiveness | should-have | trivial | Avg tool calls per assistant turn; < 1.5 = serial waste |
| prompt-stability-score | B — Cache discipline | should-have | medium | Do users re-paste boilerplate vs use `@file` refs / memory? |
| wasted-cost-on-retries | A — Cost efficiency | should-have | medium | Cost of assistant turns followed by "try again" / "no, do X" / "undo" |
| mcp-server-roi | E — Skill / MCP ROI | should-have | small | tools used / tools registered per MCP server; < 20% = uninstall |
| clarification-loop-rate | F — Prompt quality | should-have | small | Share of prompts whose response is a short clarifying question |
| peak-productive-hour | G — Workflow patterns | should-have | small | Hour with highest completed-prompts-per-dollar; fuses count + cost + completion |
| context-window-headroom | D — Session quality | should-have | trivial | `window_size - peak_context_tokens` absolute; < 20k = next non-trivial response risks truncation |
| session-completion-proxy | D — Session quality | should-have | medium | Final user turn short + affirmative ("thanks", "lgtm") → completed; absence → abandoned |
| thinking-token-spend-share | A — Cost efficiency | should-have | trivial | Share of output tokens on turns with `has_thinking=TRUE`; > 50% = prompts forcing over-deliberation |
| cost-cliff-detector | A — Cost efficiency | should-have | small | Per-session turns whose cost > 3x rolling median — pinpoints the exact context-bloat moment |
| tool-thrash-after-prompt | F — Prompt quality | should-have | trivial | Distinct tool_names per prompt response; > 8 = exploratory wandering |
| subscription-utilization-pct | H — MAX ROI | should-have | small | Running monthly cost as % of plan; < 40% three months = downgrade |
| session-frequency-pattern | G — Workflow patterns | nice-to-have | trivial | Gap between consecutive sessions per project; > 30d = candidate for archive |
| first-response-latency | C — Tool effectiveness | nice-to-have | small | Time from user turn to first assistant turn; long = cache-cold opening |
| tool-mean-time-to-recover | C — Tool effectiveness | nice-to-have | medium | Turns until same tool succeeds again after failure; > 4 = thrashing |
| skill-load-cost-wasted | E — Skill / MCP ROI | nice-to-have | trivial | Dollar cost of dead-weight skill descriptions (via cache-creation rate) |
| parallel-tool-call-rate | G — Workflow patterns | nice-to-have | trivial | Share of turns with >= 2 tool_calls in one block; < 20% = leaving speed on the table |
| model-switch-rate | G — Workflow patterns | nice-to-have | trivial | Distinct models / num_turns per session; > 0.15 = cost panic or quality fallback |
| fast-mode-usage-share | G — Workflow patterns | nice-to-have | trivial | Share of assistant turns on Haiku-class models |
| error-density-by-project | C — Tool effectiveness | nice-to-have | trivial | Errors per session by `project_path`; identifies hostile environments |
| source-type-cost-split | A — Cost efficiency | nice-to-have | trivial | Total spend split by source_type (`claude-code` vs `claude-desktop`) |

---

## Glossary

- **input_tokens** — Anthropic API field. Uncached tokens sent to the model
  in the current request. **Not** a subset of `cache_read`; the two are
  separate API fields.
- **cache_read_tokens** — Anthropic API field. Prompt-prefix tokens served
  from cache; priced at ~10% of `input_tokens` rate.
- **cache_creation_tokens** — Anthropic API field. Tokens written to cache
  on first use of a prompt prefix (cache miss). Priced higher than fresh
  inputs (~125% of input rate).
- **output_tokens** — Anthropic API field. Tokens generated by the model in
  its response.
- **turn** — One row in `conversation_turns`. Can be `role='user'`,
  `'assistant'`, or `'system'`. A round-trip is one user turn + one or
  more assistant turns (`multi_turn_depth >= 1`).
- **session** — One row in `sessions`. A continuous conversation,
  identified by `session_id` (Claude Code UUID). Bounded by `start_time`
  and `end_time`.
- **conversation_turn vs message** — Same thing at the database level. UI
  sometimes says "messages"; underlying table is `conversation_turns`.
  Note: `session_summary.num_turns` currently counts ALL roles
  (assistant + user + synthetic), inflating "work" ~60% vs assistant-only.
  See [SESSION-001](#known-issues).
- **tool_call** — One row in `tool_calls`. A single tool invocation within
  an assistant turn. Multiple `tool_calls` can share a `turn_id` (parallel
  tool use; 28 such turns on live data).
- **error** — Tool call with `success = FALSE` AND non-NULL `error_message`.
  `NULL success` = "no data" (not failure), per KPI-006.

---

## Maintenance footer

### Single source of truth: pricing.ts → buildRateCaseSql

Cost rates **never** appear hand-written in SQL. The chain is:

```
src/utils/pricing.ts (PRICING table)
   |
   +-- getPricing(model)              <- consumed by TS analyzers
   |
   +-- buildRateCaseSql()             <- consumed by dashboard SQL routes
       |
       +-- buildCacheSavingsRateCaseSql()
```

After editing a rate in `PRICING`:

1. Run `npm run build` and `npm test` — rate constants live in test
   fixtures.
2. Run `npm run backfill:costs` — recomputes stored
   `conversation_turns.cost_usd` and `sessions.total_cost_usd` in place.
3. Take a DB backup first; backfill is idempotent but the column overwrite
   is destructive on rollback.

**Do not** edit `CASE` expressions in `dashboard/src/server/routes/cost.ts`
or `cache.ts` by hand. They are generated.

### Single source of truth: tokenSums.ts → buildTokenSumSql

Token sums share the same SSOT pattern in
[`src/utils/tokenSums.ts`](../src/utils/tokenSums.ts):

```
buildTokenSumSql() ->
  - totalTokensSql              (2-way: input + output)
  - contextVolumeTokensSql      (4-way: + cache_creation + cache_read)
  - inputTokensSql / outputTokensSql / cacheReadTokensSql / cacheCreationTokensSql
```

Consumed by `src/queries/token-analyzer.ts` and `dashboard/src/server/routes/tokens.ts`.
The activity and prompt routes hand-write the formulas inline today
(TOK-RE-002); reconcile by coincidence. Extending the SSOT helper to support
a `{ tableAlias: 'ct' }` overload would let those routes adopt it.

### Single source of truth: sqlPredicates.ts → costRowPredicateSql

Cost / token / activity row inclusion lives in
[`src/utils/sqlPredicates.ts`](../src/utils/sqlPredicates.ts):

```
costRowPredicateSql(alias) -> "(role='assistant' AND model IS NOT NULL AND model <> '<synthetic>')"
```

Consumed by every cost, token, and activity analyzer / route after PR #16.
Cache surfaces still use a looser `role='assistant'` only predicate (CACHE-RE-3).

### When a metric changes

1. Update the source SQL view in `sql/views.sql` **and** the inline TS /
   route mirror at the same time. The header at `sql/views.sql:6-17`
   documents this contract explicitly.
2. Add a one-line CHANGELOG entry to METRICS_STORE.md (the canonical doc).
3. **Force a stored-view refresh** on live DBs (currently the open systemic
   issue — see [Systemic finding](#systemic-finding--stored-views-in-live-duckdb-are-stale)).
4. Re-run the metrics inventory probe to refresh source line references.

### Cross-references

- Canonical doc: [`docs/METRICS_STORE.md`](./METRICS_STORE.md).
- Implementation plan: [`docs/METRICS_STORE_IMPLEMENTATION_PLAN.md`](./METRICS_STORE_IMPLEMENTATION_PLAN.md).
- Project-level guidance: [`/Users/ozlevi/Development/tooling/CLAUDE.md`](../../CLAUDE.md) — "Key formulas" and "Cost methodology" sections.
- Inventory: [`.a5c/artifacts/metrics-store-reaudit/inventory.json`](../.a5c/artifacts/metrics-store-reaudit/inventory.json), [`inventory.md`](../.a5c/artifacts/metrics-store-reaudit/inventory.md).
- Per-group reviews: [`.a5c/artifacts/metrics-store-reaudit/reviews/`](../.a5c/artifacts/metrics-store-reaudit/reviews/).
- New-KPI suggestions: [`.a5c/artifacts/metrics-store-reaudit/new-kpi-suggestions.json`](../.a5c/artifacts/metrics-store-reaudit/new-kpi-suggestions.json).
- Findings flat list: [`.a5c/artifacts/metrics-store-reaudit/findings-summary.md`](../.a5c/artifacts/metrics-store-reaudit/findings-summary.md).

End of re-audit document.
