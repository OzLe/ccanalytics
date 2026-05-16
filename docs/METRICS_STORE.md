# Metrics Store

**Source of truth for every metric ccanalytics computes.** This document describes _what_ each metric measures, _how_ it is calculated, _where_ it lives in code, and _how to interpret_ the resulting number. It is intended for two audiences:

1. **Dashboard users** who want to know what a given KPI actually means before acting on it.
2. **Engineers** who modify the analytics code and need to keep SQL views, TypeScript analyzers, and dashboard routes in lockstep.

**Date stamped:** May 15, 2026
**Inventory snapshot:** 67 metrics across 8 groups (cost, cache, session, tool, skill, token, prompt, activity)

---

## How to read this doc

Each metric section follows a fixed template:

- **What it informs you** — one or two sentences in plain English, written for a user reading the dashboard
- **Formula** — algebraic and/or SQL expression
- **Inputs** — columns and tables that feed the calculation
- **Computed in** — SQL view + TS analyzer + dashboard route, each with `file:line` references that link directly into the codebase
- **Interpretation** — what good/bad numbers look like, with explicit thresholds where known
- **Caveats** — edge cases, NULL handling, hidden filters, and known bugs

Headline metrics (the ones you actually see on dashboard cards) get the full template. Secondary metrics are collected at the end of each group section as a compact table — same information, less repetition.

References use the convention `path/to/file.ext:LINE`. Every line number in this document was sourced from the metric inventory at [.a5c/artifacts/metrics-store/inventory.json](../.a5c/artifacts/metrics-store/inventory.json).

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
11. [Proposed new KPIs](#proposed-new-kpis)
12. [Glossary](#glossary)
13. [Maintenance footer](#maintenance-footer)

---

## Cost methodology preamble

Every USD figure surfaced by ccanalytics is computed by multiplying token counts by Anthropic **API list-price** rates. Specifically:

```
cost_usd = (input_tokens         × inputPerM         / 1_000_000)
         + (output_tokens        × outputPerM        / 1_000_000)
         + (cache_creation_tokens × cacheCreationPerM / 1_000_000)
         + (cache_read_tokens     × cacheReadPerM     / 1_000_000)
```

Rates are model-specific and live in exactly one place: [`src/utils/pricing.ts`](../src/utils/pricing.ts). The dashboard SQL routes never hand-code rates — the `CASE` expressions in [`dashboard/src/server/routes/cost.ts:32`](../dashboard/src/server/routes/cost.ts) and [`dashboard/src/server/routes/cache.ts:28`](../dashboard/src/server/routes/cache.ts) are generated from the same `PRICING` table via the helpers `buildRateCaseSql()` and `buildCacheSavingsRateCaseSql()`.

### MAX subscription users: read this caveat

If you are on a **Claude MAX subscription** (or any Anthropic fixed-fee plan), you do not pay these dollar amounts. Your bill is flat. The cost figures in ccanalytics show **API-equivalent cost** — what the same workload would cost a customer paying by the token at the published list price.

This framing is useful for three things:

1. **Plan ROI** — compare what your usage would cost on the API vs your subscription price (see the proposed `subscription-breakeven-cost` KPI below).
2. **Project / model attribution** — which projects and models drive the most "cost" (i.e., the most expensive tokens to replicate elsewhere).
3. **Trend signals** — cost trend reflects token volume × rate, so a rising trend means rising work, not rising spend.

It is **not** a literal monthly bill. The dashboard does not yet add a "list-price counterfactual" label to these numbers; the [Known issues](#known-issues) section flags this as a documentation gap (cost-4, CACHE-004).

### Canonical cost basis: stored `conversation_turns.cost_usd`

Cost is computed at ingest time and stored on `conversation_turns.cost_usd`. Every "Total Cost" read path sums this stored column:

- CLI `CostAnalyzer.getTotalCost` ([`src/queries/cost-analyzer.ts:393`](../src/queries/cost-analyzer.ts)) — `SUM(cost_usd)`
- API `/api/cost/total` ([`dashboard/src/server/routes/cost.ts:66`](../dashboard/src/server/routes/cost.ts)) — `SUM(cost_usd)`
- SQL view `v_daily_cost` ([`sql/views.sql:29`](../sql/views.sql)) — `SUM(cost_usd)`
- SQL view `v_session_summary` ([`sql/views.sql:94`](../sql/views.sql)) — per-session `SUM(cost_usd)`

All four apply the same **cost row predicate**: `role = 'assistant' AND model IS NOT NULL AND model <> '<synthetic>'`.

### When you change pricing, run the backfill

Because `cost_usd` is _stored_, any edit to `src/utils/pricing.ts` invalidates the existing column values. The fix is a one-line script:

```bash
npm run backfill:costs
```

It runs the idempotent UPDATE migration in [`scripts/backfill-costs.ts`](../scripts/backfill-costs.ts), which recomputes `conversation_turns.cost_usd` and `sessions.total_cost_usd` in place. Take a fresh DB backup first. Do not run `ingest --reset` — incremental ingest stays intact.

The dashboard `/api/sessions/stats` endpoint sums the stored `sessions.total_cost_usd` aggregate column directly (not the per-turn column), which means it drifts between backfills if any session is re-ingested with a price change. See [known issue F1 / cost-1](#known-issues) — this is the single largest open data-quality bug.

---

## Cost metrics

The cost group answers "how much did this workload cost at API list price?" It splits the total along several dimensions: per-model, per-project, per-day, per-hour. Every cost endpoint shares the same row predicate and the same stored column basis.

### total_cost_usd

**What it informs you.** The dollar value of all assistant turns in the selected period, priced at Anthropic API list rates. This is the headline number on the dashboard.

**Formula.**

```sql
SELECT SUM(cost_usd)
FROM conversation_turns
WHERE role = 'assistant'
  AND model IS NOT NULL
  AND model <> '<synthetic>'
  AND timestamp BETWEEN :start AND :end;
```

**Inputs.** `conversation_turns.cost_usd`, `conversation_turns.role`, `conversation_turns.model`, `conversation_turns.timestamp`.

**Computed in.**

- View: [`sql/views.sql:29`](../sql/views.sql) (`v_daily_cost`)
- TS: [`src/queries/cost-analyzer.ts:393`](../src/queries/cost-analyzer.ts) (`getTotalCost`)
- Route: [`dashboard/src/server/routes/cost.ts:66`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/total`)

**Interpretation.** No universal "good" number — depends on workload. Useful for trend comparisons (week over week, project over project) and for MAX subscription ROI (if total > monthly subscription price, you'd lose money on the API).

**Caveats.**

- This number reflects **stored** `cost_usd` values; if you change `pricing.ts` without running `npm run backfill:costs`, the stored column is stale.
- The `<synthetic>` filter drops 87 synthetic turns from the live dataset; these are tool-result echo rows that have no model and would otherwise null-multiply.
- `/api/sessions/stats` sums a different stored column (`sessions.total_cost_usd`) and currently reports **$203 (2.45%) less** than this endpoint due to a stale-aggregate bug. See [cost-1](#known-issues).

### input_cost_usd

**What it informs you.** The dollar share of `total_cost_usd` attributable to non-cached input tokens — i.e., fresh prompt content sent to the model.

**Formula.**

```sql
SUM(input_tokens * inputPerM / 1e6)  -- per model
```

**Inputs.** `conversation_turns.input_tokens`, `conversation_turns.model`.

**Computed in.**

- TS: [`src/queries/cost-analyzer.ts:458`](../src/queries/cost-analyzer.ts) (`getTotalCost`), [`src/queries/cost-analyzer.ts:164`](../src/queries/cost-analyzer.ts) (`getCostByModel`)
- Route: [`dashboard/src/server/routes/cost.ts:83`](../dashboard/src/server/routes/cost.ts) (`/total`), [`dashboard/src/server/routes/cost.ts:223`](../dashboard/src/server/routes/cost.ts) (`/by-model`)
- Rates from: [`src/utils/pricing.ts`](../src/utils/pricing.ts) via `buildRateCaseSql()`

**Interpretation.** A low share of input cost (vs cache_read + cache_creation) means the cache is doing its job. On the live dataset, input is ~0.34% of total tokens — most of the bill rides on cache writes and the initial cold-start input.

**Caveats.**

- This is a **rate-derived** number, computed at read time from token counts; `total_cost_usd` is **stored**. The two reconcile to 7e-12 USD on the live dataset, but if `pricing.ts` changes without a backfill the gap becomes structural. See [cost-5](#known-issues).

### output_cost_usd, cache_write_cost_usd, cache_read_cost_usd

The other three components of the per-category breakdown follow the same `tokens * rate / 1e6` pattern; the only differences are the token column and the rate field used:

| Metric                  | Tokens                   | Rate field          | TS                                              | Route                                          |
| ----------------------- | ------------------------ | ------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `output_cost_usd`       | `output_tokens`          | `outputPerM`        | [`cost-analyzer.ts:459`](../src/queries/cost-analyzer.ts) | [`cost.ts:84`](../dashboard/src/server/routes/cost.ts) |
| `cache_write_cost_usd`  | `cache_creation_tokens`  | `cacheCreationPerM` | [`cost-analyzer.ts:460`](../src/queries/cost-analyzer.ts) | [`cost.ts:85`](../dashboard/src/server/routes/cost.ts) |
| `cache_read_cost_usd`   | `cache_read_tokens`      | `cacheReadPerM`     | [`cost-analyzer.ts:461`](../src/queries/cost-analyzer.ts) | [`cost.ts:86`](../dashboard/src/server/routes/cost.ts) |

`cacheReadPerM` is typically 10% of `inputPerM` (Anthropic's published discount), which is why cache_read tokens cost ~90% less than equivalent fresh inputs.

### daily_cost_by_model

**What it informs you.** Per-day per-model cost timeline. Drives the "Cost by Day" stacked bar chart on the cost page.

**Formula.**

```sql
SELECT
  CAST(timestamp AS DATE) AS day,
  model,
  SUM(cost_usd)            AS stored_cost_usd,
  SUM(input_tokens)        AS input_tokens,
  SUM(output_tokens)       AS output_tokens,
  SUM(cache_creation_tokens) AS cache_write_tokens,
  SUM(cache_read_tokens)   AS cache_read_tokens,
  COUNT(*)                 AS turn_count,
  COUNT(DISTINCT session_id) AS session_count
FROM conversation_turns
WHERE role = 'assistant'
  AND model IS NOT NULL
  AND model <> '<synthetic>'
GROUP BY day, model;
```

**Inputs.** `conversation_turns.{cost_usd, timestamp, model, session_id, *_tokens}`.

**Computed in.**

- View: [`sql/views.sql:29`](../sql/views.sql) (`v_daily_cost`)
- TS: [`src/queries/cost-analyzer.ts:72`](../src/queries/cost-analyzer.ts) (`getDailyCosts`)
- Route: [`dashboard/src/server/routes/cost.ts:152`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/daily`)

**Interpretation.** Day-by-day trend; useful for spotting expensive sessions or rate changes. Stacked by model reveals which models drive cost on each day.

**Caveats.**

- `session_count` here is `COUNT(DISTINCT session_id)` per `(date, model)` — a session that spans midnight or uses two models is **counted twice**. Naive sum across a 7-day window double-counts. See [cost-3](#known-issues).
- Empty time buckets are not zero-filled; charts drawn naively from this data will visually compress dead hours. See [cost-6](#known-issues).

### cost_by_model

**What it informs you.** "Where did the money go by model?" Total cost, token breakdown, and unique session count grouped by model.

**Formula.**

```sql
SELECT model,
       SUM(cost_usd) AS stored_cost_usd,
       SUM(input_tokens)        AS input_tokens,
       SUM(output_tokens)       AS output_tokens,
       SUM(cache_creation_tokens) AS cache_write_tokens,
       SUM(cache_read_tokens)   AS cache_read_tokens,
       COUNT(DISTINCT session_id) AS session_count
FROM conversation_turns
WHERE role = 'assistant' AND model IS NOT NULL AND model <> '<synthetic>'
GROUP BY model;
```

**Inputs.** `conversation_turns.cost_usd`, `conversation_turns.model`, `conversation_turns.session_id`.

**Computed in.**

- TS: [`src/queries/cost-analyzer.ts:124`](../src/queries/cost-analyzer.ts) (`getCostByModel`)
- Route: [`dashboard/src/server/routes/cost.ts:206`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/by-model`)

**Interpretation.** On the live dataset, claude-opus-4-7 accounts for $4,499.62 of $8,294.41 (54%). High concentration on premium models suggests cost-saving opportunities by routing non-critical work to Sonnet or Haiku.

**Caveats.** None significant; both code paths agree on the stored column.

### cost_by_project

**What it informs you.** Cost grouped by Claude Code project path — answers "which repo did I spend the most on?"

**Formula.**

```sql
SELECT s.project_path,
       SUM(ct.cost_usd) AS stored_cost_usd,
       ...
FROM conversation_turns ct
JOIN sessions s ON ct.session_id = s.session_id
WHERE ct.role = 'assistant' AND ct.model IS NOT NULL AND ct.model <> '<synthetic>'
GROUP BY s.project_path;
```

**Inputs.** `sessions.project_path`, `conversation_turns.cost_usd`.

**Computed in.**

- TS: [`src/queries/cost-analyzer.ts:194`](../src/queries/cost-analyzer.ts) (`getCostByProject`)
- Route: [`dashboard/src/server/routes/cost.ts:275`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/by-project`)

**Interpretation.** Useful for chargeback in multi-tenant consulting setups, and for spotting projects with disproportionate cost-per-task.

**Caveats.**

- 107 of 974 sessions (live data) have no cost-eligible turns and are invisible to this endpoint while still appearing in `/api/sessions`. See [cost-7](#known-issues).
- The TS analyzer uses a fragile two-query pattern that accumulates per-(project, model) session counts then overrides them with a corrective sub-query. The dashboard route does it correctly in a single pass. See [cost-2](#known-issues).

### cost_trend

**What it informs you.** Time-bucketed cost series — pick hour/day/week/month. Drives the cost chart on the trend tab.

**Formula.**

```sql
SELECT DATE_TRUNC(:bucket, timestamp) AS bucket,
       SUM(cost_usd)            AS stored_cost_usd,
       SUM(input_tokens)        AS input_tokens,
       SUM(output_tokens)       AS output_tokens,
       SUM(cache_creation_tokens) AS cache_write_tokens,
       SUM(cache_read_tokens)   AS cache_read_tokens
FROM conversation_turns
WHERE role = 'assistant' AND model IS NOT NULL AND model <> '<synthetic>'
GROUP BY bucket
ORDER BY bucket;
```

**Inputs.** `conversation_turns.cost_usd`, `conversation_turns.timestamp`.

**Computed in.**

- TS: [`src/queries/cost-analyzer.ts:339`](../src/queries/cost-analyzer.ts) (`getCostTrend`)
- Route: [`dashboard/src/server/routes/cost.ts:348`](../dashboard/src/server/routes/cost.ts) (`GET /api/cost/trend`)

**Interpretation.** Watch for upward inflection points; they correlate with longer sessions, more thinking, or higher-tier model usage.

**Caveats.** Empty buckets are not zero-filled; client must handle gaps. See [cost-6](#known-issues).

### Secondary cost metrics

| Metric                              | Definition                                                                                  | Sources                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `turn_count`                        | Per-day per-model assistant turn count                                                       | [`views.sql:38`](../sql/views.sql), [`cost-analyzer.ts:83`](../src/queries/cost-analyzer.ts), [`cost.ts:166`](../dashboard/src/server/routes/cost.ts) |
| `session_count_per_day`             | `COUNT(DISTINCT session_id)` per `(date, model)` — over-counts straddlers                    | [`views.sql:39`](../sql/views.sql), [`cost-analyzer.ts:84`](../src/queries/cost-analyzer.ts), [`cost.ts:167`](../dashboard/src/server/routes/cost.ts) |
| `stored_cost_usd`                   | SQL projection alias of `SUM(cost_usd)` — canonical total per COST-003                       | [`cost-analyzer.ts:401`](../src/queries/cost-analyzer.ts), [`cost.ts:78`](../dashboard/src/server/routes/cost.ts)                                     |
| `per_model_rate_input`              | `PRICING[model].inputPerM` — single source                                                    | [`pricing.ts`](../src/utils/pricing.ts), [`cost.ts:32`](../dashboard/src/server/routes/cost.ts)                                                       |
| `per_model_rate_cache_read_savings` | `inputPerM − cacheReadPerM` per model — feeds `estimated_cache_savings_usd`                  | [`cache-analyzer.ts:101`](../src/queries/cache-analyzer.ts), [`cache.ts:28`](../dashboard/src/server/routes/cache.ts)                                 |

---

## Cache metrics

The cache group answers "is prompt caching pulling its weight?" The canonical KPI is the hit rate, and the canonical USD saving is computed via the per-model rate diff. The advisory `v_cache_efficiency` view exposes a simpler token-count proxy that does **not** reconcile with the load-bearing dollar figure.

### cache_hit_rate

**What it informs you.** KPI-001. Fraction of input-side tokens served from the cache rather than re-prompted. Higher = cheaper, faster runs.

**Formula.**

```
cache_hit_rate = cache_read_tokens
                 / (cache_read_tokens + cache_creation_tokens + input_tokens)
```

**Inputs.** `conversation_turns.cache_read_tokens`, `conversation_turns.cache_creation_tokens`, `conversation_turns.input_tokens` (all WHERE `role = 'assistant'`).

**Computed in.**

- View: [`sql/views.sql:126`](../sql/views.sql) (`v_session_summary`), [`sql/views.sql:198`](../sql/views.sql) (`v_cache_efficiency`)
- TS: [`src/queries/cache-analyzer.ts:111`](../src/queries/cache-analyzer.ts) (`getCacheHitRate`)
- Route: [`dashboard/src/server/routes/cache.ts:70`](../dashboard/src/server/routes/cache.ts) (`GET /api/cache/metrics`)

**Interpretation.**

| Band              | Label         | Meaning                                                       |
| ----------------- | ------------- | ------------------------------------------------------------- |
| `> 0.80`          | effective     | Cache is doing most of the work                              |
| `0.50 – 0.80`     | moderate      | Mixed cold/warm sessions                                      |
| `< 0.50`          | ineffective   | Cache rarely hit — possibly cold sessions or invalidating prompts |

Live data: 105 of 106 days fall in `effective`, suggesting the bands are **mis-calibrated for power users**. See [CACHE-002](#known-issues) for proposed re-banding to 0.70/0.85/0.95 plus a minimum-volume gate.

**Caveats.**

- `input_tokens` here is the Anthropic API field for **uncached** input; it is not a subset of cache_read. Live ratio: cache_read is ~8000× larger than input on average.
- Denominator includes `cache_creation_tokens` (writes), so a fresh cold-start session with 50k writes and 0 reads shows 0% hit rate even though caching works perfectly. See [CACHE-005](#known-issues).
- Cache views/analyzers filter `role = 'assistant'` only and **do not** apply the `<synthetic>` filter that the cost path uses. 87 synthetic turns currently leak in (zero cache tokens today, but turn-count denominators don't reconcile with `v_daily_cost`). See [CACHE-003](#known-issues).

### estimated_cache_savings_usd

**What it informs you.** Dollar value of tokens served from cache vs the API-list price of re-prompting them. Marketed as "cache savings" in the UI.

**Formula.**

```sql
SUM(cache_read_tokens * (inputPerM - cacheReadPerM) / 1e6)  -- per model
```

**Inputs.** `conversation_turns.cache_read_tokens`, `conversation_turns.model`, rates from `PRICING`.

**Computed in.**

- View: [`sql/views.sql:201`](../sql/views.sql) (`v_cache_efficiency.estimated_tokens_saved` — **advisory, uses simplified proxy**)
- TS: [`src/queries/cache-analyzer.ts:99`](../src/queries/cache-analyzer.ts) (`getCacheHitRate`)
- Route: [`dashboard/src/server/routes/cache.ts:46`](../dashboard/src/server/routes/cache.ts) (`/metrics`)

**Interpretation.** Live dataset: **$52,596.51** saved against $8,294.41 actual spend — caching produced ~6.3× the value of the total bill at API list price.

**Caveats.**

- **This is an API-list-price counterfactual, not realized cash.** MAX subscribers do not actually save dollars here; they save **headroom utilization** within a flat fee. The UI does not currently surface this caveat. See [CACHE-004](#known-issues).
- The advisory view `v_cache_efficiency` computes a flat `cache_read * 0.9` token-count proxy that does **not** reconcile with the load-bearing per-model rate diff (live: 10.5 billion proxy vs $52,596 exact). See [CACHE-001](#known-issues).

### cache_efficiency_trend

**What it informs you.** Day-by-day cache_hit_rate series, charted on the cache page.

**Formula.** Daily `GROUP BY CAST(timestamp AS DATE)` applied to the canonical `cache_hit_rate` formula.

**Inputs.** Same as `cache_hit_rate`, plus `timestamp`.

**Computed in.**

- View: [`sql/views.sql:185`](../sql/views.sql) (`v_cache_efficiency`)
- TS: [`src/queries/cache-analyzer.ts:140`](../src/queries/cache-analyzer.ts) (`getCacheTrend`)
- Route: [`dashboard/src/server/routes/cache.ts:107`](../dashboard/src/server/routes/cache.ts) (`/trend`)

**Interpretation.** Look for sudden drops — they correlate with a CLAUDE.md edit invalidating the cache prefix, or with model switches.

**Caveats.** Accepts a `TimeBucket` param but **ignores it**; daily-only granularity is hard-coded. See [CACHE-008](#known-issues).

### session_cache_hit_rate

**What it informs you.** Per-session cache hit rate, surfaced on the sessions list and detail view.

**Formula.** Identical to `cache_hit_rate` but grouped per `session_id`.

**Computed in.**

- View: [`sql/views.sql:126`](../sql/views.sql) (`v_session_summary`)
- TS: [`src/queries/cache-analyzer.ts:186`](../src/queries/cache-analyzer.ts) (`getCacheBySession`)
- Route: [`dashboard/src/server/routes/sessions.ts:52`](../dashboard/src/server/routes/sessions.ts) (`GET /api/sessions`)

**Interpretation.** Long sessions with stable system prompts should sit at > 95%; sub-5-turn sessions naturally underperform because the cache hasn't warmed up.

**Caveats.** `getCacheBySession` both reads `s.cache_hit_rate` from the view AND recomputes it from joined turns — dual code path is a maintenance hazard. See [CACHE-007](#known-issues).

### Secondary cache metrics

| Metric                          | Definition                                                                       | Sources                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cache_hit_rate_interpretation` | 3-band label string (`effective` / `moderate` / `ineffective`)                   | [`cache-analyzer.ts:113`](../src/queries/cache-analyzer.ts), [`cache.ts:74`](../dashboard/src/server/routes/cache.ts)                    |
| `cache_read_tokens`             | `SUM(cache_read_tokens)` — single column projection                              | [`views.sql:188`](../sql/views.sql), [`cache-analyzer.ts:69`](../src/queries/cache-analyzer.ts), [`cache.ts:43`](../dashboard/src/server/routes/cache.ts) |
| `cache_write_tokens`            | `SUM(cache_creation_tokens)`                                                      | [`views.sql:188`](../sql/views.sql), [`cache-analyzer.ts:70`](../src/queries/cache-analyzer.ts), [`cache.ts:44`](../dashboard/src/server/routes/cache.ts) |
| `uncached_input_tokens`         | `SUM(input_tokens)` (already excludes cached — separate Anthropic API field)      | [`views.sql:189`](../sql/views.sql), [`cache-analyzer.ts:109`](../src/queries/cache-analyzer.ts), [`cache.ts:68`](../dashboard/src/server/routes/cache.ts) |

---

## Session metrics

The session group answers "what does a session look like — duration, cost, turns, context pressure?" Sessions are bounded by the start/end timestamps in the `sessions` fact table; cost and turn counts are stored aggregates that drift if ingest happens incrementally between rate changes.

### total_sessions

**What it informs you.** Count of sessions in the period — bedrock denominator for every per-session average.

**Formula.** `COUNT(*) FROM sessions WHERE start_time >= :start`.

**Inputs.** `sessions.start_time`.

**Computed in.**

- TS: [`src/queries/session-analyzer.ts:278`](../src/queries/session-analyzer.ts) (`getSessionStats`)
- Route: [`dashboard/src/server/routes/sessions.ts:120`](../dashboard/src/server/routes/sessions.ts) (`/stats`)

**Interpretation.** Live: 974 sessions across all data. Useful as a denominator only when normalized — see "stub sessions" caveat below.

**Caveats.**

- **108 of 974 sessions (11.1%) are stubs** with NULL or `<synthetic>` model and 0 cost / ~0 turns. They inflate denominators. If excluded, `avg_cost_per_session` rises $8.31 → $9.33 and `avg_turns_per_session` rises 163 → 183. See [F5](#known-issues).
- `/api/sessions/stats.totalSessions = 974` but `/api/sessions/context-pressure.totalSessions = 868` — 11% denominator asymmetry invisible to the user. See [F10](#known-issues).

### total_turns

**What it informs you.** Sum of `sessions.num_turns` — total messages across all sessions.

**Formula.** `SUM(sessions.num_turns)`.

**Inputs.** `sessions.num_turns` (stored aggregate column).

**Computed in.**

- TS: [`src/queries/session-analyzer.ts:279`](../src/queries/session-analyzer.ts) (`getSessionStats`)
- Route: [`dashboard/src/server/routes/sessions.ts:121`](../dashboard/src/server/routes/sessions.ts) (`/stats`)

**Interpretation.** Live: ~160,393 — but **this counts user + assistant + system rows**, not round-trips. The UI label "turns" is misleading; the value is ~2.4× larger than what a user thinks of as a turn. See [F3](#known-issues).

**Caveats.**

- `sessions.num_turns` is a stored aggregate; live drift is ~1,909 turns (1.2%) across 100 sessions vs the actual `COUNT(*)` from `conversation_turns`. The backfill script fixes `cost_usd` but not `num_turns`. See [F2](#known-issues).

### avg_turns_per_session, avg_duration_minutes, median_duration_minutes

Three standard aggregates over the period:

| Metric                    | Formula                                | Caveats                                                                                                       |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `avg_turns_per_session`   | `AVG(sessions.num_turns)`              | Mixes user + assistant + system; inflated by stubs                                                            |
| `avg_duration_minutes`    | `AVG(duration_seconds) / 60.0`         | Mean = 332 min vs median = 28 min on live data — 12× outlier skew from 2 zombie sessions of ~37.5 days each |
| `median_duration_minutes` | `MEDIAN(duration_seconds) / 60.0`      | Robust; should be promoted to primary KPI                                                                     |

All three computed in [`session-analyzer.ts:280-282`](../src/queries/session-analyzer.ts) and [`sessions.ts:122-124`](../dashboard/src/server/routes/sessions.ts).

See [F4](#known-issues) for the duration skew issue.

### avg_cost_per_session

**What it informs you.** Average $ per session over the period.

**Formula.** `AVG(sessions.total_cost_usd)`.

**Inputs.** `sessions.total_cost_usd` (stored aggregate column).

**Computed in.**

- TS: [`src/queries/session-analyzer.ts:284`](../src/queries/session-analyzer.ts) (`getSessionStats`)
- Route: [`dashboard/src/server/routes/sessions.ts:126`](../dashboard/src/server/routes/sessions.ts) (`/stats`)

**Interpretation.** Live: ~$8.31. Inflated by the 108 stub sessions; true average for cost-bearing sessions is ~$9.33.

**Caveats.** Stored column drifts between backfills. See [F1](#known-issues).

### total_cost_usd_session_stats

**What it informs you.** Total cost as reported by `/api/sessions/stats` (NOT `/api/cost/total`).

**Formula.** `SUM(sessions.total_cost_usd)`.

**Inputs.** `sessions.total_cost_usd`.

**Computed in.**

- TS: [`src/queries/session-analyzer.ts:283`](../src/queries/session-analyzer.ts) (`getSessionStats`)
- Route: [`dashboard/src/server/routes/sessions.ts:125`](../dashboard/src/server/routes/sessions.ts) (`/stats`)

**Interpretation.** Currently reports **$8,091** vs `/api/cost/total`'s **$8,294** — a $203 (2.45%) gap. The single largest open data-quality issue in the system. See [F1 / cost-1](#known-issues).

**Caveats.** Stale stored aggregate. Reads from `sessions.total_cost_usd`, which is overwritten (not accumulated) by [`batch-inserter.ts:113`](../src/ingestion/batch-inserter.ts) on each incremental ingest batch. Fix is to read from `v_session_summary` instead.

### session_summary_view (v_session_summary)

**What it informs you.** Per-session rollup that re-derives every aggregate from the child tables — the post-COST-004 fix that lets dashboards read consistent per-session totals.

**Formula.** See [`sql/views.sql:94`](../sql/views.sql). Joins `sessions` LEFT JOIN per-session `turn_agg` LEFT JOIN per-session `tool_agg`.

**Computed in.**

- View: [`sql/views.sql:94`](../sql/views.sql)
- TS: [`src/queries/session-analyzer.ts:76`](../src/queries/session-analyzer.ts) (`getSessions`)
- Route: [`dashboard/src/server/routes/sessions.ts:24`](../dashboard/src/server/routes/sessions.ts) (`GET /api/sessions`)

**Interpretation.** This view is the source-of-truth for any per-session aggregate; if you need cost or turn counts per session, read from this view, not the stored `sessions.*` columns.

**Caveats.** None known.

### context_utilization_per_turn

**What it informs you.** NEW-001. Per assistant turn, the fraction of the model's context window currently in use. Above 60% risks quality degradation (per CLAUDE.md guidance).

**Formula.**

```
context_utilization = (input + cache_read + cache_creation) / window_size

window_size = 1_000_000  if model_id matches '-1m' OR '1m-context' OR context_tokens > 200_000
            = 200_000    otherwise
```

**Inputs.** `conversation_turns.input_tokens`, `conversation_turns.cache_read_tokens`, `conversation_turns.cache_creation_tokens`, `conversation_turns.model`.

**Computed in.**

- View: [`sql/views.sql:374`](../sql/views.sql) (`v_context_pressure`)
- TS: [`src/queries/session-analyzer.ts:350`](../src/queries/session-analyzer.ts) (`getContextPressure`)
- Route: [`dashboard/src/server/routes/sessions.ts:218`](../dashboard/src/server/routes/sessions.ts) (`GET /api/sessions/context-pressure`)

**Interpretation.**

| Band         | Label    | Action                                                |
| ------------ | -------- | ----------------------------------------------------- |
| `< 0.40`     | safe     | No action needed                                       |
| `0.40-0.60`  | warming  | Watch for compaction-worthy state                      |
| `> 0.60`     | pressure | Consider `/compact` or `/clear`                        |
| `> 0.80`     | critical | Quality degradation likely; `/clear` recommended      |

**Caveats.**

- Window denominator is **self-correcting**: if observed context tokens exceed 200k, the formula assumes the model is on the 1M tier even if the model ID doesn't disclose it. This is the `CONTEXT_WINDOW_CASE` constant in [`session-analyzer.ts`](../src/queries/session-analyzer.ts).

### peak_context_pct, pressure_share, pressure_rate_dataset, critical_rate_dataset

The four "context pressure summary" metrics, all derived from `context_utilization_per_turn`:

| Metric                       | Formula                                                            | What it tells you                                                  |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `peak_context_pct`           | `MAX(context_utilization)` per session                              | Highest-pressure moment in a session                                |
| `pressure_share`             | `COUNT(util > 0.60) / COUNT(*)` per session                         | Share of turns under pressure                                       |
| `pressure_rate_dataset`      | `sessions_over_60 / total_sessions`                                 | Share of sessions that ever hit 60%                                 |
| `critical_rate_dataset`      | `sessions_over_80 / total_sessions`                                 | Share of sessions that ever hit 80% (critical)                      |

Sources: [`views.sql:405-415`](../sql/views.sql), [`session-analyzer.ts:373-421`](../src/queries/session-analyzer.ts), [`sessions.ts:249-312`](../dashboard/src/server/routes/sessions.ts).

**Caveats.**

- Strict `>` is used for 0.60 and 0.80 thresholds; CLAUDE.md is ambiguous on whether these should be `>=`. See [F7](#known-issues).
- 0.80 "critical" threshold has no documentary basis in CLAUDE.md. See [F8](#known-issues).
- Live: 301 of 868 sessions (~35%) ever hit `peak >= 0.80`.

### max_tokens_turns

**What it informs you.** Count of assistant turns that hit the response token cap (`stop_reason = 'max_tokens'`) — a hard signal of truncation.

**Formula.** `COUNT(*) FILTER (WHERE stop_reason = 'max_tokens')`.

**Inputs.** `conversation_turns.stop_reason`.

**Computed in.**

- View: [`sql/views.sql:415`](../sql/views.sql) (`v_context_pressure`)
- TS: [`src/queries/session-analyzer.ts:380`](../src/queries/session-analyzer.ts) (`getContextPressure`)
- Route: [`dashboard/src/server/routes/sessions.ts:256`](../dashboard/src/server/routes/sessions.ts) (`/context-pressure`)

**Interpretation.** Truncations cost a retry. A non-zero count means the user pays for two turns where they should have paid for one. See the proposed `max-tokens-truncation-rate` KPI for a rate-based reframing.

**Caveats.**

- Only 82.27% of assistant turns have a non-NULL `stop_reason` in the live dataset. So this is a **lower bound**; the actual number is higher. See [F9](#known-issues).

### Secondary session metrics

| Metric                            | Definition                                                                       | Sources                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unique_models`                   | Distinct list of models across sessions                                          | [`session-analyzer.ts:300`](../src/queries/session-analyzer.ts), [`sessions.ts:134`](../dashboard/src/server/routes/sessions.ts)                  |

---

## Tool metrics

The tool group answers "which tools are used, how often, and how reliably?" Tool calls live in the `tool_calls` table with FK to `conversation_turns`. Three of the most-load-bearing tool metrics (avg duration, chain detection, failure streaks) have **critical bugs** flagged below.

### tool_call_count

**What it informs you.** Number of times each tool was invoked in the period.

**Formula.** `COUNT(*) FROM tool_calls JOIN conversation_turns GROUP BY tool_name`.

**Inputs.** `tool_calls.tool_name`, `tool_calls.session_id`, `conversation_turns.timestamp`.

**Computed in.**

- View: [`sql/views.sql:158`](../sql/views.sql) (`v_tool_usage.call_count`)
- TS: [`src/queries/tool-analyzer.ts:76`](../src/queries/tool-analyzer.ts) (`getToolUsage`)
- Route: [`dashboard/src/server/routes/tools.ts:37`](../dashboard/src/server/routes/tools.ts) (`/usage`)

**Interpretation.** Live: 62,229 total tool rows. Top tools typically: Bash, Read, Edit, Grep, Glob.

**Caveats.** None significant.

### tool_success_rate

**What it informs you.** KPI-006. Fraction of tool calls that succeeded; returns **NULL** (not 0%) when no row has non-NULL `success`.

**Formula.**

```sql
COUNT(*) FILTER (WHERE success = TRUE)
  / NULLIF(COUNT(*) FILTER (WHERE success IS NOT NULL), 0)
```

**Inputs.** `tool_calls.success`.

**Computed in.**

- View: [`sql/views.sql:161`](../sql/views.sql) (`v_tool_usage.success_rate`)
- TS: [`src/queries/tool-analyzer.ts:79`](../src/queries/tool-analyzer.ts) (`getToolUsage`), [`tool-analyzer.ts:138`](../src/queries/tool-analyzer.ts) (`getToolSuccessRates`)
- Route: [`dashboard/src/server/routes/tools.ts:40`](../dashboard/src/server/routes/tools.ts) (`/usage`), [`tools.ts:101`](../dashboard/src/server/routes/tools.ts) (`/success-rates`)

**Interpretation.** Live overall: 95.17% success. Per-tool, anything under 80% warrants investigation. KPI-006 "NULL on no data" prevents tools without evaluated success states from being rendered as failing.

**Caveats.**

- The `evaluatedCount` (denominator) is not surfaced in the API response, so a tool with high NULL rate looks the same as a high-volume tool with verified success. See [TOOL-006](#known-issues).

### tool_avg_duration_ms

**What it informs you.** Mean latency per tool — meant to surface slow tools.

**Formula.** `AVG(tool_calls.duration_ms)`.

**Inputs.** `tool_calls.duration_ms`.

**Computed in.**

- TS: [`src/queries/tool-analyzer.ts:85, 147, 209`](../src/queries/tool-analyzer.ts)
- Route: [`dashboard/src/server/routes/tools.ts:46, 109, 173`](../dashboard/src/server/routes/tools.ts)

**Interpretation.** Should surface slow MCP tools or heavy Bash commands. **Currently displays 0 for every tool.**

**Caveats.**

- **CRITICAL: 100% of `tool_calls.duration_ms` rows are NULL.** Both ingestion adapters explicitly set `duration_ms: null`. The UI renders `formatDuration(0)` for every tool. See [TOOL-001](#known-issues).

### tool_avg_per_session, sessions_using_tool

Two more from the `v_tool_usage` family:

| Metric                  | Formula                                       | Sources                                                                                                                                                     |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_avg_per_session`  | `COUNT(*) / NULLIF(COUNT(DISTINCT session_id), 0)` | [`views.sql:170`](../sql/views.sql), [`tool-analyzer.ts:89`](../src/queries/tool-analyzer.ts), [`tools.ts:50`](../dashboard/src/server/routes/tools.ts)   |
| `sessions_using_tool`   | `COUNT(DISTINCT session_id)` per tool           | [`views.sql:175`](../sql/views.sql), [`tool-analyzer.ts:86`](../src/queries/tool-analyzer.ts), [`tools.ts:47`](../dashboard/src/server/routes/tools.ts)   |

### tool_failure_rate_by_class

**What it informs you.** NEW-002. Per-day failure rate, bucketed by class (`mcp` vs `builtin`). Helps separate "my MCP server is flaky" from "Bash itself is failing".

**Formula.**

```sql
SELECT
  CAST(timestamp AS DATE) AS day,
  CASE WHEN tool_type = 'mcp' THEN 'mcp' ELSE 'builtin' END AS class,
  COUNT(*) FILTER (WHERE success = FALSE) AS failures,
  COUNT(*) FILTER (WHERE success IS NOT NULL) AS evaluated,
  failures::DOUBLE / NULLIF(evaluated, 0) AS failure_rate
FROM tool_calls
JOIN conversation_turns USING (turn_id)
GROUP BY day, class;
```

**Inputs.** `tool_calls.success`, `tool_calls.tool_type`, `conversation_turns.timestamp`.

**Computed in.**

- View: [`sql/views.sql:433`](../sql/views.sql) (`v_tool_failure_trend`)
- TS: [`src/queries/tool-analyzer.ts:332`](../src/queries/tool-analyzer.ts) (`getToolFailureTrend`)
- Route: [`dashboard/src/server/routes/tools.ts:229`](../dashboard/src/server/routes/tools.ts) (`/failure-trend`)

**Interpretation.** Live overall failure rate: 4.65%. MCP servers tend to fail at 2-3× the rate of builtin tools.

**Caveats.**

- "native" tool_type is bucketed as "builtin"; verify intent. See [TOOL-010](#known-issues).

### max_failure_streak

**What it informs you.** NEW-003. Per session, longest consecutive run of `success = FALSE` tool calls. A streak of 3+ is a strong signal that the agent is thrashing.

**Formula.** Gaps-and-islands over `tool_calls` partitioned by `session_id`, ordered chronologically, then `MAX(streak_len) WHERE success = FALSE`.

**Inputs.** `tool_calls.success`, `tool_calls.tool_call_id`, `tool_calls.session_id`.

**Computed in.**

- View: [`sql/views.sql:470`](../sql/views.sql) (`v_session_failure_chains.max_failure_streak`)
- TS: [`src/queries/tool-analyzer.ts:427`](../src/queries/tool-analyzer.ts) (`getFailureChains`)
- Route: [`dashboard/src/server/routes/tools.ts:330`](../dashboard/src/server/routes/tools.ts) (`/failure-chains`)

**Interpretation.** Per the [Known issues](#known-issues), the streak length is **systematically under-reported** due to TOOL-002. True worst-case on live data: 8 (vs 6 reported).

**Caveats.**

- **CRITICAL: Gaps-and-islands ordering uses `tool_call_id` (a random base62 ID), not `timestamp`.** 98.65% of rows are out of chronological order. 183 sessions get different `max_failure_streak` under proper ordering. See [TOOL-002](#known-issues).
- Intra-turn parallel tool_uses get tie-broken alphabetically — 28 turns affected. See [TOOL-004](#known-issues).

### chain_rate_3plus

**What it informs you.** Dataset KPI: share of sessions containing a failure streak ≥ 3. Operational signal for "the agent is stuck somewhere".

**Formula.** `sessions_with_chains_3plus / sessions_with_tool_calls`.

**Computed in.**

- View: [`sql/views.sql:502`](../sql/views.sql) (`v_session_failure_chains.failure_chains_3plus`)
- TS: [`src/queries/tool-analyzer.ts:507`](../src/queries/tool-analyzer.ts) (`getFailureChains`)
- Route: [`dashboard/src/server/routes/tools.ts:412`](../dashboard/src/server/routes/tools.ts) (`/failure-chains`)

**Interpretation.** A rising rate is the canonical "agent quality regressed" signal.

**Caveats.**

- Inherits TOOL-002 ordering bug — rate is computed off a randomly-ordered streak count.
- The view's denominator silently excludes 0-failure sessions; if a future optimization "uses the view" instead of the inline code, the rate inflates by 37%. See [TOOL-005](#known-issues).

### tool_chain_occurrence

**What it informs you.** Count of times any 3-tool sequence (A → B → C) appears across sessions. Surfaces common workflows.

**Formula.** Window join on `tool_calls` ordered by `tool_call_id` per session; `GROUP BY (a, b, c) HAVING COUNT(*) >= :min`.

**Computed in.**

- TS: [`src/queries/tool-analyzer.ts:262`](../src/queries/tool-analyzer.ts) (`getToolChains`)
- Route: [`dashboard/src/server/routes/tools.ts:433`](../dashboard/src/server/routes/tools.ts) (`/chains`)

**Interpretation.** Bash → Bash → Bash is typically the top chain — multi-step shell sessions.

**Caveats.**

- **CRITICAL: Same `tool_call_id` ordering bug.** Live: Bash → Bash → Bash counts 7,307 by ID vs 13,656 by timestamp — random ordering invents ~3,000 fake patterns. See [TOOL-003](#known-issues).
- Overlapping window counting — a single 4-tool sequence A→B→C→D contributes both (A,B,C) and (B,C,D). Acceptable, but undocumented.

### Secondary tool metrics

| Metric                        | Definition                                                                       | Sources                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `failure_chains_2plus`        | Per-session count of failure streaks of length ≥ 2                                | [`views.sql:501`](../sql/views.sql), [`tool-analyzer.ts:466`](../src/queries/tool-analyzer.ts), [`tools.ts:368`](../dashboard/src/server/routes/tools.ts) — inherits TOOL-002 bug |
| `mcp_server_total_calls`      | Per-MCP-server invocation total                                                   | [`tool-analyzer.ts:204`](../src/queries/tool-analyzer.ts), [`tools.ts:165`](../dashboard/src/server/routes/tools.ts)                                  |
| `mcp_unique_tools_per_server` | Distinct tool names per MCP server                                                | [`tool-analyzer.ts:225`](../src/queries/tool-analyzer.ts), [`tools.ts:184`](../dashboard/src/server/routes/tools.ts)                                  |
| `common_errors_per_tool`      | Top 5 distinct `error_message` strings per failed tool                            | [`tool-analyzer.ts:177`](../src/queries/tool-analyzer.ts), [`tools.ts:131`](../dashboard/src/server/routes/tools.ts)                                  |

---

## Skill metrics

The skill group is a relatively new section (added with the Total Tokens / Skill Analysis feature). It answers "which skills are loaded, which are actually used, and how much context do they cost?" Two opposing populations matter:

- **Loaded skills** — surfaced into the system reminder block (one row per `(session_id, skill_name)` in `session_skills`)
- **Invoked skills** — actually called via `tool_name = 'Skill'` (one row per call in `tool_calls`)

The gap between the two is "dead weight" — skills consuming context budget without being used.

### avg_skills_loaded_per_session, max_skills_loaded_per_session, distinct_skills_loaded

| Metric                          | Formula                                                       | Sources                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `avg_skills_loaded_per_session` | `AVG(per_session COUNT(DISTINCT skill_name))`                  | [`skill-analyzer.ts:225`](../src/queries/skill-analyzer.ts), [`skills.ts:69`](../dashboard/src/server/routes/skills.ts)                           |
| `max_skills_loaded_per_session` | `MAX(per_session COUNT(DISTINCT skill_name))`                  | [`skill-analyzer.ts:225`](../src/queries/skill-analyzer.ts), [`skills.ts:93`](../dashboard/src/server/routes/skills.ts)                           |
| `distinct_skills_loaded`        | `COUNT(DISTINCT skill_name) FROM session_skills WHERE in_period` | [`views.sql:583`](../sql/views.sql), [`skill-analyzer.ts:248`](../src/queries/skill-analyzer.ts), [`skills.ts:94`](../dashboard/src/server/routes/skills.ts) |

**Live data.** Distinct loaded: 168. Avg per session: 87.90 (using current denominator) vs 77.52 (using all sessions).

**Caveats.**

- Denominator for `avg_skills_loaded_per_session` is **sessions-with-skill-rows, not all-period-sessions** — biases the average ~13% high. Claude Desktop sessions where `audit.jsonl` doesn't emit `skill_listing` are silently excluded. See [S-2](#known-issues).

### distinct_skills_invoked, skill_total_invocations, skill_success_rate

| Metric                    | Formula                                                                                                  | Sources                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `distinct_skills_invoked` | `COUNT(DISTINCT COALESCE(skill_name, parameters->>'skill')) FROM tool_calls WHERE tool_name = 'Skill'` | [`skill-analyzer.ts:281`](../src/queries/skill-analyzer.ts), [`skills.ts:116`](../dashboard/src/server/routes/skills.ts) |
| `skill_total_invocations` | `COUNT(*) FROM tool_calls WHERE tool_name = 'Skill'` (period-bounded)                                  | [`skill-analyzer.ts:282`](../src/queries/skill-analyzer.ts), [`skills.ts:117`](../dashboard/src/server/routes/skills.ts) |
| `skill_success_rate`      | KPI-006: `COUNT(success = TRUE) / NULLIF(COUNT(success IS NOT NULL), 0)`                                | [`skill-analyzer.ts:359`](../src/queries/skill-analyzer.ts), [`skills.ts:181`](../dashboard/src/server/routes/skills.ts) |

**Live data.** Distinct invoked: 22. Total invocations: 105. So 168 skills loaded, only 22 ever fired.

### dead_weight_skills, invocation_rate, dead_weight_ratio

The "is the skill loaded set bloated?" trio:

| Metric                | Formula                                                       | Sources                                                                                                                                                |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dead_weight_skills`  | `COUNT(loaded NOT IN invoked)`                                | [`views.sql:601`](../sql/views.sql), [`skill-analyzer.ts:312`](../src/queries/skill-analyzer.ts), [`skills.ts:137`](../dashboard/src/server/routes/skills.ts) |
| `invocation_rate`     | `distinct_skills_invoked / distinct_skills_loaded`             | [`skill-analyzer.ts:362`](../src/queries/skill-analyzer.ts), [`skills.ts:183`](../dashboard/src/server/routes/skills.ts)                              |
| `dead_weight_ratio`   | `dead_weight_skills / distinct_skills_loaded`                  | [`skill-analyzer.ts:366`](../src/queries/skill-analyzer.ts), [`skills.ts:187`](../dashboard/src/server/routes/skills.ts)                              |

**Live data.** Dead weight ratio: **0.875** — 87.5% of loaded skills are never used.

**Interpretation.** A high dead_weight_ratio is the signal to prune your skill set or move to lazy-loading via the `find-skills` skill.

### avg_loaded_skill_tokens, loaded_context_share, too_many_skills_active

The "how much context is the skill bloat costing?" trio:

**avg_loaded_skill_tokens**

**Formula.** `avg_skills_loaded_per_session × FLAT_SKILL_TOKEN_ESTIMATE` where `FLAT_SKILL_TOKEN_ESTIMATE = 45`.

**Sources.** [`skill-analyzer.ts:370`](../src/queries/skill-analyzer.ts), [`skills.ts:191`](../dashboard/src/server/routes/skills.ts), [`views.sql:599`](../sql/views.sql), constant in [`skill-thresholds.ts:30`](../src/queries/skill-thresholds.ts).

**Caveats.** The flat constant of 45 understates real skill description tokens by ~45%. Actual avg is ~65 tokens, p90 is 96, max is 220. See [S-1](#known-issues).

**loaded_context_share**

**Formula.** `avg_loaded_skill_tokens / avg_session_context_tokens`.

**Sources.** [`skill-analyzer.ts:372`](../src/queries/skill-analyzer.ts), [`skills.ts:193`](../dashboard/src/server/routes/skills.ts).

**Caveats.** Numerator is per-session-average × constant; denominator is per-turn-average across all assistant turns. Definitional inconsistency. See [S-10](#known-issues).

**too_many_skills_active**

**Formula.** `(dead_weight_ratio > 0.30) OR (loaded_context_share > 0.05)` → boolean.

**Sources.** [`skill-analyzer.ts:378`](../src/queries/skill-analyzer.ts), [`skills.ts:199`](../dashboard/src/server/routes/skills.ts).

**Interpretation.** Currently fires reliably (87.5% > 50%) but offers no actionable remediation in UI. See [S-3](#known-issues).

### skill_thrash_invocations

**What it informs you.** D12. (session_id, skill) pairs where the same skill was invoked ≥ SKILL_THRASH_MIN times — usually a sign the agent didn't understand the skill output the first time.

**Formula.** `COUNT(*) GROUP BY session_id, skill HAVING COUNT(*) >= 2`.

**Sources.**

- View: [`sql/views.sql:628`](../sql/views.sql) (`v_skill_not_required`)
- TS: [`src/queries/skill-analyzer.ts:432`](../src/queries/skill-analyzer.ts) (`getSkillThrash`)
- Route: [`dashboard/src/server/routes/skills.ts:489`](../dashboard/src/server/routes/skills.ts) (`/not-required`)

**Caveats.** `SKILL_THRASH_MIN = 2` is too aggressive — only 2 pairs flagged in 30-day live window, 50% are known-reentrant noise. See [S-4](#known-issues).

### Secondary skill metrics

| Metric                       | Definition                                                                       | Sources                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `is_known_reentrant_skill`   | Presentation flag: skill name in `KNOWN_REENTRANT_SKILLS` set                      | [`skill-analyzer.ts:477`](../src/queries/skill-analyzer.ts), [`skills.ts:533`](../dashboard/src/server/routes/skills.ts)                          |
| `skills_per_session_trend`   | Time-bucketed AVG loaded vs invoked per session                                    | [`skill-analyzer.ts:509`](../src/queries/skill-analyzer.ts), [`skills.ts:400`](../dashboard/src/server/routes/skills.ts)                          |
| `skill_loaded_in_sessions`   | Per-skill count of sessions where loaded                                          | [`views.sql:584`](../sql/views.sql), [`skill-analyzer.ts:172`](../src/queries/skill-analyzer.ts), [`skills.ts:273`](../dashboard/src/server/routes/skills.ts) |

---

## Token metrics

This group has exactly two metrics — the "Total Tokens" KPI introduced in the latest commit. Both are simple SUMs over the four token columns, with the cost row predicate applied to keep the 1:1 reconciliation with Total Cost. The TWO open issues in this group both involve metric semantics rather than implementation.

### total_tokens_period

**What it informs you.** F1. Sum of all four token classes (input + output + cache_creation + cache_read) over the selected period.

**Formula.**

```sql
SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens)
WHERE role = 'assistant'
  AND model IS NOT NULL
  AND model <> '<synthetic>'
  AND timestamp BETWEEN :start AND :end;
```

**Inputs.** All four `conversation_turns.*_tokens` columns.

**Computed in.**

- View: [`sql/views.sql:65`](../sql/views.sql) (`v_token_totals` — advisory)
- TS: [`src/queries/token-analyzer.ts:94`](../src/queries/token-analyzer.ts) (`getTotalTokens`)
- Route: [`dashboard/src/server/routes/tokens.ts:78`](../dashboard/src/server/routes/tokens.ts) (`GET /api/tokens/total`)

**Interpretation.** Live: 11.98 billion. **97.78% of that is cache_read** — i.e., replayed prompt context, not work performed.

**Caveats.**

- **HIGH SEVERITY: 97.78% cache_read inflation.** The headline overstates Anthropic-API-comparable workload by ~294×. See [TOK-001](#known-issues).
- **HIGH SEVERITY: Two contradictory definitions of "total tokens" coexist in the codebase.** `/api/tokens/total` returns 11.98B (4-way sum). `/api/activity/hourly` aggregate returns 40.75M (input + output only). Same field name, 294× different. See [TOK-002](#known-issues).
- The docstring justifies the 4-way sum as "reconciles 1:1 with Total Cost", but cost reconciliation is about row predicates (which rows participate), not column expressions. The 4-way choice is independent. See [TOK-003](#known-issues).

### total_tokens_all_time

**What it informs you.** D7. Same SUM as `total_tokens_period` but unfiltered — a constant returned alongside the period total for the comparison hint card.

**Formula.** Identical to `total_tokens_period` minus the timestamp/model/project filters.

**Sources.** [`token-analyzer.ts:111`](../src/queries/token-analyzer.ts), [`tokens.ts:98`](../dashboard/src/server/routes/tokens.ts).

**Caveats.**

- Adds little signal as the 5th hint item; respects no filters while the period number does. See [TOK-004](#known-issues).
- Inherits the cache_read inflation of `total_tokens_period`.

---

## Prompt metrics

The prompt group is the most sophisticated section — it defines a **prompt window** (one user turn → next user turn) and computes per-prompt aggregates: cost, depth, complexity. It also defines the canonical complexity scoring (KPI-005) — a 0-100 global percentile composite.

### prompt_complexity_score

**What it informs you.** KPI-005. 0-100 score combining four signals into one ranking — drives the "top 10 most complex prompts" list and the complexity distribution chart.

**Formula.**

```
complexity_score =
  (PERCENT_RANK(tool_call_count)   * 100
 + PERCENT_RANK(total_tokens)      * 100
 + PERCENT_RANK(multi_turn_depth)  * 100
 + (has_thinking ? 100 : 0))
 / 4
```

Percentiles are computed over the **entire dataset** (not the filtered period) so the score is stable across views.

**Inputs.** Computed `tool_call_count`, `total_tokens`, `multi_turn_depth`, `has_thinking` per prompt window.

**Computed in.**

- TS: [`src/queries/prompt-analyzer.ts:184`](../src/queries/prompt-analyzer.ts) (filtered `scored_prompts`), [`prompt-analyzer.ts:283`](../src/queries/prompt-analyzer.ts) (global `g_scored_prompts`)
- Route: [`dashboard/src/server/routes/prompts.ts:140`](../dashboard/src/server/routes/prompts.ts), [`prompts.ts:240`](../dashboard/src/server/routes/prompts.ts)

**Interpretation.**

| Range  | Bucket  | Meaning                                |
| ------ | ------- | -------------------------------------- |
| 0-20   | trivial | Quick reply, no tools                  |
| 20-40  | light   | Some token volume or one tool          |
| 40-60  | mid     | Multi-turn or noticeable tool use      |
| 60-80  | heavy   | Agentic workflow                       |
| 80-100 | extreme | Many tools, deep multi-turn, thinking  |

**Caveats.**

- `has_thinking` is a binary 25-point step function — 98.8% of prompts pay 0/100, 1.2% pay 100/100. Mixing a step function with three continuous percentiles makes the composite dimensionally inconsistent. See [F1 prompt](#known-issues).
- `tool_call_count` and `multi_turn_depth` correlate at 0.995 on live data — they triple-weight one signal in a "4-dimensional" composite. See [F2 prompt](#known-issues).
- Any prompt query with a `model` filter applies the filter **inside the ordered_turns CTE before user/assistant partitioning**. User turns have NULL model and silently drop → `?model=opus` returns **zero prompts**. See [F3 prompt](#known-issues).

### response_cost_per_prompt

**What it informs you.** Total $ cost of all assistant turns responding to one user prompt — the dollar value of one round-trip.

**Formula.**

```sql
SUM(ct.cost_usd)
WHERE ct.role = 'assistant'
  AND ct.rn > user_rn
  AND (next_user_rn IS NULL OR ct.rn < next_user_rn)
```

**Inputs.** `conversation_turns.cost_usd`, `conversation_turns.role`, prompt window boundaries.

**Computed in.**

- View: [`sql/views.sql:284`](../sql/views.sql) (`v_prompt_analysis.response_cost`)
- TS: [`src/queries/prompt-analyzer.ts:118`](../src/queries/prompt-analyzer.ts) (`prompt_pairs` CTE)
- Route: [`dashboard/src/server/routes/prompts.ts:79`](../dashboard/src/server/routes/prompts.ts)

**Interpretation.** Live: p95 = $5.94, max = $47.62. Top prompts by cost are typically long agentic loops or deep refactor tasks.

**Caveats.** None significant.

### multi_turn_depth

**What it informs you.** Number of consecutive assistant turns that respond to one user prompt. `1` = simple Q&A; `> 1` = agentic loop.

**Formula.** `COUNT(turn_id) WHERE role='assistant' AND turn_id is in prompt window`.

**Computed in.** [`sql/views.sql:293`](../sql/views.sql), [`prompt-analyzer.ts:126`](../src/queries/prompt-analyzer.ts), [`prompts.ts:87`](../dashboard/src/server/routes/prompts.ts).

**Interpretation.** Average depth is a measure of agentic complexity. Live: highly correlated (0.995) with `tool_call_count_per_prompt` — the agent and tool-use depth are essentially the same signal.

**Caveats.** Same model-filter NULL-drop issue as `prompt_complexity_score`. See [F3 prompt](#known-issues).

### tool_call_count_per_prompt

**What it informs you.** Total tools fired across all assistant turns of one prompt window.

**Formula.** `COUNT(tool_call_id)` via LATERAL UNNEST of tool calls onto turn rows within the window.

**Computed in.** [`sql/views.sql:317`](../sql/views.sql), [`prompt-analyzer.ts:146`](../src/queries/prompt-analyzer.ts) (`tool_counts` CTE), [`prompts.ts:105`](../dashboard/src/server/routes/prompts.ts).

**Caveats.** None significant (counts are correct; the ordering issue from TOOL-002 doesn't apply because we're counting, not sequencing).

### prompts_with_no_response

**What it informs you.** KPI-004. Count of user turns immediately followed by another user turn — sessions where the user gave up or canceled before assistant replied.

**Formula.** `COUNT(*) FILTER (WHERE multi_turn_depth = 0)`.

**Computed in.** [`prompt-analyzer.ts:434`](../src/queries/prompt-analyzer.ts), [`prompts.ts:400`](../dashboard/src/server/routes/prompts.ts).

**Interpretation.** Live: 2,182 of 7,874 prompts (27.7%) have no response. High share = lots of canceled or interrupted requests.

**Caveats.**

- 60 "synthetic-only" windows (containing only `<synthetic>` model assistant rows) are classified as **responded with $0 cost**. The headline 2,182 undercounts true 2,242. See [F5 prompt](#known-issues).

### avg_prompt_cost, max_prompt_cost, avg_complexity_score

Three summary aggregates over the responded prompts in the period:

| Metric                  | Formula                                                                   | Sources                                                                                            |
| ----------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `avg_prompt_cost`       | `AVG(response_cost) FILTER (WHERE multi_turn_depth > 0)`                  | [`prompt-analyzer.ts:435`](../src/queries/prompt-analyzer.ts), [`prompts.ts:401`](../dashboard/src/server/routes/prompts.ts) |
| `max_prompt_cost`       | `MAX(response_cost)`                                                       | [`prompt-analyzer.ts:436`](../src/queries/prompt-analyzer.ts), [`prompts.ts:402`](../dashboard/src/server/routes/prompts.ts) |
| `avg_complexity_score`  | `AVG(complexity_score) FILTER (WHERE multi_turn_depth > 0)`                | [`prompt-analyzer.ts:437`](../src/queries/prompt-analyzer.ts), [`prompts.ts:403`](../dashboard/src/server/routes/prompts.ts) |

### cost_distribution_buckets, complexity_distribution_buckets

Two histograms surfacing distribution of prompts:

**cost_distribution_buckets** — 7 fixed bins: `$0`, `<$0.001`, `<$0.01`, `<$0.05`, `<$0.10`, `<$0.50`, `$0.50+`. Sources: [`prompt-analyzer.ts:453`](../src/queries/prompt-analyzer.ts), [`prompts.ts:409`](../dashboard/src/server/routes/prompts.ts).

**Caveats.** Under-resolves the high end — 2,744 of 5,692 prompts (48%) collapse into the single `$0.50+` bucket. Split into `$0.50-$2`, `$2-$10`, `$10+` or use quantile breaks. See [F4 prompt](#known-issues).

**complexity_distribution_buckets** — 5 even bins of 20 across 0-100. Sources: [`prompt-analyzer.ts:500`](../src/queries/prompt-analyzer.ts), [`prompts.ts:448`](../dashboard/src/server/routes/prompts.ts).

**Caveats.** CLI analyzer missing the `WHERE sp.multi_turn_depth > 0` filter that the dashboard has — CLI consumers see a different shape. See [F8 prompt](#known-issues).

### Secondary prompt metrics

| Metric                  | Definition                                                                       | Sources                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `prompt_total_tokens`   | Sum of all 4 token categories per prompt window                                   | [`views.sql:287`](../sql/views.sql), [`prompt-analyzer.ts:119`](../src/queries/prompt-analyzer.ts), [`prompts.ts:80`](../dashboard/src/server/routes/prompts.ts) — conflates cache_read with real work, see [F6 prompt](#known-issues) |
| `prompts_per_session`   | `responded_prompts / distinct_sessions`                                           | [`prompt-analyzer.ts:615`](../src/queries/prompt-analyzer.ts), [`prompts.ts:581`](../dashboard/src/server/routes/prompts.ts) |
| `turns_per_prompt`      | `AVG(multi_turn_depth)` over responded prompts                                    | [`prompt-analyzer.ts:616`](../src/queries/prompt-analyzer.ts), [`prompts.ts:562`](../dashboard/src/server/routes/prompts.ts) |
| `tool_calls_per_prompt` | `AVG(tool_call_count)` over responded prompts                                     | [`prompt-analyzer.ts:617`](../src/queries/prompt-analyzer.ts), [`prompts.ts:563`](../dashboard/src/server/routes/prompts.ts) |

---

## Activity metrics

The activity group answers "when do I work, and how productively?" Hourly and daily turn counts, drawn from `conversation_turns.timestamp`. **Every metric in this group has at least one critical or high bug** — timezone, day-of-week labeling, token-class consistency.

### hourly_message_count

**What it informs you.** KPI-002. Number of assistant turns per hour of day (0-23) — drives the activity bar chart.

**Formula.** `COUNT(*) GROUP BY EXTRACT(HOUR FROM timestamp) WHERE role = 'assistant'`.

**Inputs.** `conversation_turns.timestamp`, `conversation_turns.role`.

**Computed in.**

- View: [`sql/views.sql:213`](../sql/views.sql) (`v_hourly_activity.message_count`)
- TS: [`src/queries/time-series.ts:65`](../src/queries/time-series.ts) (`getHourlyActivity`)
- Route: [`dashboard/src/server/routes/activity.ts:28`](../dashboard/src/server/routes/activity.ts) (`/hourly`)

**Interpretation.** Reveals working hours. Peak hour on live data is reported as 10am, which is **wrong** — the user's actual peak is 1pm Israel time. The display labels them as local but the data is UTC. See [ACT-001](#known-issues).

**Caveats.**

- **CRITICAL: All hour buckets are UTC, not user local time.** Heatmap and KPIs are shifted -3h relative to what the user thinks is happening. See [ACT-001](#known-issues).
- Empty hour buckets are missing from the API response (0-2 and 23 absent in live data). Client must zero-fill. See [ACT-003](#known-issues).
- Named `message_count` but counts assistant turns only. Naming nit. See [ACT-011](#known-issues).

### hourly_session_count, hourly_avg_cost, hourly_total_cost, avg_tokens_per_turn

The four sibling hourly metrics — all share the same UTC bug and the same missing-bucket issue:

| Metric                  | Formula                                          | Caveat                                                                                                  |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `hourly_session_count`  | `COUNT(DISTINCT session_id)` per hour            | Double-counts long sessions across hours. Name suggests "started", reality is "present". See [ACT-006](#known-issues) |
| `hourly_avg_cost`       | `AVG(cost_usd)` per hour                          | No `<synthetic>` filter; 87 rows pollute AVG by 0.1-0.5%. See [ACT-007](#known-issues)                  |
| `hourly_total_cost`     | `SUM(cost_usd)` per hour                          | Same lack of `<synthetic>` filter                                                                       |
| `avg_tokens_per_turn`   | `AVG(input + output)` or `SUM/COUNT` per hour    | View and TS/route compute differently but reconcile when no NULL rows. See [ACT-009](#known-issues)     |

All four computed in [`time-series.ts:65-78`](../src/queries/time-series.ts), [`activity.ts:40-44`](../dashboard/src/server/routes/activity.ts), [`views.sql:215-220`](../sql/views.sql).

### activity_heatmap

**What it informs you.** KPI-002. Assistant turn count per `(day_of_week, hour_of_day)` cell — drives the heatmap on the activity page.

**Formula.** `COUNT(*) WHERE role='assistant' GROUP BY EXTRACT(DOW), EXTRACT(HOUR)`.

**Computed in.** [`src/queries/time-series.ts:149`](../src/queries/time-series.ts) (`getActivityHeatmap`), [`dashboard/src/server/routes/activity.ts:121`](../dashboard/src/server/routes/activity.ts).

**Interpretation.** Identifies "deep work hours". Currently misleading on two axes.

**Caveats.**

- **CRITICAL: Hour axis is UTC** (see ACT-001).
- **CRITICAL: Day-of-week labels are shifted by one day.** DuckDB `EXTRACT(DOW FROM '2025-05-11')` returns 0 (Sunday, Postgres convention). UI `DAY_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']`. Friday's 5,291 turns appear under 'Sat' label; Thursday's 12,106 (real peak) appears under 'Fri'. See [ACT-002](#known-issues).
- Empty (DOW, hour) cells omitted; client fills. See [ACT-010](#known-issues).

### daily_activity

**What it informs you.** Assistant turn count per day — drives the "Turns Today" KPI and the activity timeline.

**Formula.** `COUNT(*) WHERE role='assistant' GROUP BY CAST(timestamp AS DATE)`.

**Computed in.** [`time-series.ts:117`](../src/queries/time-series.ts), [`activity.ts:84`](../dashboard/src/server/routes/activity.ts).

**Interpretation.** Day-by-day work volume.

**Caveats.**

- Counts every assistant row (no `<synthetic>` filter), while `v_daily_cost` applies the cost row predicate. Populations differ up to 5.8% on some days. See [ACT-005](#known-issues).
- The "Turns Today" KPI uses `new Date().toISOString().slice(0,10)` (UTC date) — may show tomorrow's day from 21:00-23:59 Israel time. See [ACT-008](#known-issues).
- Also see [ACT-004](#known-issues): inventory marked `v_hourly_activity.total_tokens` as "agree" with route, but the view sums all 4 token classes while route sums input+output only — **266× divergence** at hour 10.

---

## Known issues

Every finding from the per-group reviews, grouped by severity. Items marked **[TICKET]** are recommended for Linear ticket creation (severity = critical or high).

### Critical (5)

- **[TICKET] [CRITICAL] activity:hourly_* — ACT-001 — Hour-of-day buckets are UTC, not user local** ([`sql/schema.sql:34`](../sql/schema.sql), [`views.sql:213`](../sql/views.sql), [`activity.ts:38`](../dashboard/src/server/routes/activity.ts))
  Heatmap and hourly KPIs are systematically shifted by user's UTC offset. Peak Hour shows '10am' when user actually worked at 1pm Israel time. Recommended fix: convert at query time with user_tz; minimum label "(UTC)" until conversion lands.

- **[TICKET] [CRITICAL] activity:activity_heatmap — ACT-002 — Heatmap DAY_LABELS shifted by one day** ([`HourlyHeatmap.tsx:13`](../dashboard/src/components/charts/HourlyHeatmap.tsx))
  DuckDB DOW=0 is Sunday but UI labels 0=Monday. Friday's data appears under 'Sat', Thursday's under 'Fri'. Single-line fix to DAY_LABELS or query-time adjustment.

- **[TICKET] [CRITICAL] tool:tool_avg_duration_ms — TOOL-001 — Avg Time column displays 0 for every tool, 100% of duration_ms NULL** ([`adapters/claude-code.ts:280`](../src/ingestion/adapters/claude-code.ts), [`adapters/claude-desktop.ts:512`](../src/ingestion/adapters/claude-desktop.ts), [`tool-analyzer.ts:85`](../src/queries/tool-analyzer.ts), [`ToolsPage.tsx:196`](../dashboard/src/pages/ToolsPage.tsx))
  Both ingestion adapters explicitly set `duration_ms: null`. UI renders `formatDuration(0)` everywhere. Recommended fix: coerce to NULL through the pipeline and render 'n/a', OR backfill from conversation_turn timestamp deltas.

- **[TICKET] [CRITICAL] tool:max_failure_streak — TOOL-002 — Gaps-and-islands ordering uses tool_call_id (random base62 ID), chronologically wrong on 98.65% of rows** ([`tool-analyzer.ts:442`](../src/queries/tool-analyzer.ts), [`views.sql:475`](../sql/views.sql))
  `ROW_NUMBER OVER (ORDER BY tc.tool_call_id)`. IDs are random `toolu_...` strings. 183 sessions get different `max_failure_streak`; worst streak 6 reported vs 8 true. Fix: `ORDER BY ct.timestamp, tc.tool_call_id`.

- **[TICKET] [CRITICAL] tool:tool_chain_occurrence — TOOL-003 — Chain detection ordering is wrong; ~2× under-counts true chains** ([`tool-analyzer.ts:262`](../src/queries/tool-analyzer.ts), [`tools.ts:433`](../dashboard/src/server/routes/tools.ts))
  Same `tool_call_id` ordering bug. Bash→Bash→Bash shows 7,307 by ID but 13,656 by timestamp. 7,727 distinct chains by ID vs 4,735 by timestamp (random ordering invents ~3,000 fake patterns).

- **[TICKET] [CRITICAL] session:total_cost_usd_session_stats — F1 — /api/sessions/stats reports $203 (2.45%) less than /api/cost/total — sessions.total_cost_usd stale** ([`sessions.ts:125`](../dashboard/src/server/routes/sessions.ts), [`session-analyzer.ts:283`](../src/queries/session-analyzer.ts), [`batch-inserter.ts:113`](../src/ingestion/batch-inserter.ts))
  Documented as COST-004 in views.sql. 9 of 974 sessions diverged; worst single session under-reports by $60.43 (84%). Backfill script fixes but is manual. Recommended fix: read total_cost_usd from `v_session_summary` in /sessions/stats.

### High (12)

- **[TICKET] [HIGH] cost:total_cost_usd (via /api/sessions/stats) — cost-1 — Stale sessions.total_cost_usd causes $203 endpoint mismatch** (same as F1; appears in both reviews)

- **[TICKET] [HIGH] cache:estimated_cache_savings_usd — CACHE-001 — v_cache_efficiency uses flat cache_read*0.9 proxy while TS+route compute exact per-model USD** ([`views.sql:201`](../sql/views.sql), [`cache-analyzer.ts:99`](../src/queries/cache-analyzer.ts), [`cache.ts:28`](../dashboard/src/server/routes/cache.ts))
  View `estimated_tokens_saved` returns 10.5B (token-count × 0.9). TS+route compute exact $52,596.51 via per-model rate diff. Name misleading. Fix: drop column or replace with USD computed via shared helper.

- **[TICKET] [HIGH] session:avg_duration_minutes — F4 — Mean 332 min vs median 28 min (12×); 2 sessions ~37.5 days each (zombies); 39 NULL durations counted in denominator** ([`session-analyzer.ts:281`](../src/queries/session-analyzer.ts), [`sessions.ts:123`](../dashboard/src/server/routes/sessions.ts))
  Recommended fix: surface MEDIAN as primary KPI; cap mean at sane upper bound; add 'active duration' from gap-clamping.

- **[TICKET] [HIGH] tool:max_failure_streak — TOOL-004 — Intra-turn parallel tool_uses ordered alphabetically (28 turns affected, edge case)** ([`tool-analyzer.ts:442`](../src/queries/tool-analyzer.ts))
  Acceptable to keep tool_call_id as tie-breaker; document that parallel tool_uses get deterministic-but-arbitrary order.

- **[TICKET] [HIGH] tool:chain_rate_3plus — TOOL-005 — v_session_failure_chains denominator silently excludes 0-failure sessions** ([`views.sql:501`](../sql/views.sql))
  View emits 622 sessions; inline code (correct) emits 851. 229 zero-failure sessions dropped. If a future optimization "uses the view", rate inflates by 37%. Fix: rewrite view with LEFT JOIN to match inline code.

- **[TICKET] [HIGH] skill:avg_loaded_skill_tokens — S-1 — FLAT_SKILL_TOKEN_ESTIMATE=45 understates real skill-description tokens by ~45%** ([`skill-thresholds.ts:30`](../src/queries/skill-thresholds.ts), [`skillThresholds.ts:58`](../dashboard/src/lib/skillThresholds.ts), [`views.sql:599`](../sql/views.sql))
  Real avg ~65 tokens, p90=96, max=220. D11 threshold (>5%) never fires from this side in real data. Fix: COALESCE(LENGTH(skill_description)/4.0, 45).

- **[TICKET] [HIGH] token:total_tokens_period — TOK-001 — 'Total Tokens' KPI is 97.78% cache_read (11.98B headline vs 40.8M true work, ~294× inflation)** ([`DashboardPage.tsx:266`](../dashboard/src/pages/DashboardPage.tsx), [`token-analyzer.ts:62`](../src/queries/token-analyzer.ts), [`tokens.ts:37`](../dashboard/src/server/routes/tokens.ts))
  cache_read is replayed context, not work. Recommended fix: reframe headline as "Tokens In/Out" (input+output); demote 4-way sum to "Context Volume Processed" secondary.

- **[TICKET] [HIGH] token:total_tokens (cross-codebase) — TOK-002 — Two contradictory total_tokens definitions side-by-side (11.98B vs 40.75M)** ([`activity.ts:42`](../dashboard/src/server/routes/activity.ts), [`views.sql:217`](../sql/views.sql), [`tokens.ts:42`](../dashboard/src/server/routes/tokens.ts), [`prompts.ts:80`](../dashboard/src/server/routes/prompts.ts))
  Same field name, 293.95× different values. activity.ts uses input+output ONLY; v_hourly_activity uses 4-way. Pick ONE definition; add unit test.

- **[TICKET] [HIGH] prompt:prompt_complexity_score — F1 prompt — has_thinking is 25-pt step function in 100-pt composite; 98.8% of prompts pay 0/100** ([`prompt-analyzer.ts:189`](../src/queries/prompt-analyzer.ts), [`prompts.ts:148`](../dashboard/src/server/routes/prompts.ts))
  Mixing step function with 3 continuous percentiles is dimensionally inconsistent. Fix: drop has_thinking + re-weight to thirds, OR continuous thinking_tokens.

- **[TICKET] [HIGH] prompt:prompt_complexity_score (composite weights) — F2 prompt — tool_call_count and multi_turn_depth correlate 0.995; composite triple-weights one signal** ([`prompt-analyzer.ts:189`](../src/queries/prompt-analyzer.ts))
  50% of composite is essentially same signal twice. Fix: replace pair with single dimension; add non-redundant 4th (error_count, sub-agent fan-out, distinct_tools).

- **[TICKET] [HIGH] prompt:All prompt metrics filtered by model — F3 prompt — Model filter breaks prompt pairing; all user turns NULL model and dropped silently** ([`filter-builder.ts:33`](../src/queries/filter-builder.ts), [`parseFilters.ts:108`](../dashboard/src/server/helpers/parseFilters.ts))
  Filter applies inside ordered_turns CTE before user/assistant partitioning. NULL LIKE anything = NULL → excluded. `?model=opus` returns zero prompts. Fix: `AND (role='user' OR model LIKE ...)`.

- **[TICKET] [HIGH] activity:hourly_total_tokens (v_hourly_activity) — ACT-004 — v_hourly_activity.total_tokens INCLUDES cache_read+cache_creation; TS/route exclude — 266× divergence at h=10** ([`views.sql:217`](../sql/views.sql), [`time-series.ts:77`](../src/queries/time-series.ts), [`activity.ts:42`](../dashboard/src/server/routes/activity.ts))
  Inventory claimed "agree" but the view drifted from route silently.

- **[TICKET] [HIGH] activity:hourly_* — ACT-003 — Empty hour-of-day buckets missing from API; only ActivityPage fills, others would drop**
  Recommended fix: LEFT JOIN against generate_series(0,23,1) server-side; always return 24 rows.

- **[TICKET] [HIGH] activity:daily_activity vs daily_cost — ACT-005 — daily_activity counts every assistant row; v_daily_cost adds <synthetic> filter; populations differ up to 5.8%**
  Apply costRowPredicate to activity surfaces OR document divergence with tooltip.

### Medium (24)

- [MEDIUM] cost:cost_by_project — cost-2 — TS layer accumulates per-(project,model) session counts then corrects with second query; fragile two-query pattern ([`cost-analyzer.ts:194-301`](../src/queries/cost-analyzer.ts))
- [MEDIUM] cost:session_count_per_day — cost-3 — Session counts double-count sessions spanning midnight or using multiple models; undocumented ([`views.sql:39`](../sql/views.sql), [`cost.ts:167`](../dashboard/src/server/routes/cost.ts))
- [MEDIUM] cost:per_model_rate_cache_read_savings — cost-4 — Cache-savings USD is API-list-price proxy; MAX subscribers see misleading figures ([`pricing.ts:124`](../src/utils/pricing.ts), [`cache.ts:46`](../dashboard/src/server/routes/cache.ts))
- [MEDIUM] cache:cache_hit_rate_interpretation — CACHE-002 — Bands mis-calibrated; 81% of sessions land in same bucket; re-band to 0.70/0.85/0.95 plus min-volume gate
- [MEDIUM] cache:cache_hit_rate — CACHE-003 — Cache views filter role='assistant' only; cost path adds <synthetic> AND model IS NOT NULL; turn-counts don't reconcile
- [MEDIUM] cache:estimated_cache_savings_usd — CACHE-004 — $52,596 "savings" is API-list-price counterfactual, not realized cash on MAX subscription; no UI caveat
- [MEDIUM] session:total_turns — F2 — sessions.num_turns drifts ~1,909 turns (1.2%) vs conversation_turns count; backfill fixes cost not num_turns
- [MEDIUM] session:total_turns — F3 — sum_num_turns (160,393) == COUNT(*) conversation_turns; mixes user+assistant+system; UI label "turns" misleading
- [MEDIUM] session:total_sessions — F5 — 108 of 974 sessions (11.1%) are stubs (NULL/synthetic model, 0 cost/~0 turns); inflate denominators
- [MEDIUM] session:unique_models — F6 — sessions.model captures only first/primary; claude-haiku-4-5 in 70 turns but 0 sessions.model values
- [MEDIUM] session:max_tokens_turns — F9 — Only 82.27% of assistant turns have non-NULL stop_reason; max_tokens_turns is lower bound
- [MEDIUM] tool:common_errors_per_tool — TOOL-008 — Top-5 errors not normalized; path-specific strings drown out error classes
- [MEDIUM] tool:failure_chains_2plus — TOOL-011 — Inherits TOOL-002 ordering bug; chain counts inflated by random adjacency
- [MEDIUM] skill:avg_skills_loaded_per_session — S-2 — Denominator is sessions-with-skill-rows, not all-period-sessions; biased ~13% high; Claude Desktop sessions without skill_listing silently excluded
- [MEDIUM] skill:too_many_skills_active — S-3 — Threshold fires reliably (87.5% > 50%) but offers no actionable remediation in UI; add tiered banner + top-N dead-weight list
- [MEDIUM] token:total_tokens_period (rationale) — TOK-003 — Docstring justifies 4-way sum as "reconciles 1:1 with Total Cost"; cost reconciliation is about row set, not column expression
- [MEDIUM] token:total_tokens_all_time — TOK-004 — All-time number adds little signal; replace with "Replay Xx" = cache_read / max(1, input+output)
- [MEDIUM] prompt:cost_distribution_buckets — F4 prompt — Buckets under-resolve high end; 2,744 of 5,692 prompts (48%) collapse into single $0.50+ bucket
- [MEDIUM] prompt:prompts_with_no_response — F5 prompt — Synthetic-only windows (60) classified as "responded" with $0 cost; headline undercounts true 2,242
- [MEDIUM] prompt:prompt_total_tokens — F6 prompt — total_tokens conflates cache_read with real work; long sessions with warm caches score artificially high
- [MEDIUM] prompt:v_prompt_analysis (maintenance) — F7 prompt — v_prompt_analysis exists but no API path reads it; three implementations of same logic in views/analyzer/route
- [MEDIUM] activity:hourly_session_count — ACT-006 — COUNT(DISTINCT session_id) per hour double-counts long sessions; name "session_count" suggests "sessions started"
- [MEDIUM] activity:hourly_avg_cost — ACT-007 — Activity surfaces lack costRowPredicate; 87 synthetic rows pollute AVG by 0.1-0.5%
- [MEDIUM] activity:daily_activity — ACT-008 — "Turns Today" uses new Date().toISOString().slice(0,10) (UTC date); may show tomorrow's day from 21:00-23:59 Israel time

### Low (28)

- [LOW] cost:total_cost_usd, cost_by_model — cost-5 — Per-category breakdown rate-derived, headline stored; 1e-11 USD reconciliation residual; structural mismatch after rate edit without backfill
- [LOW] cost:cost_trend — cost-6 — Empty time buckets have no row; charts compress dead time
- [LOW] cost:cost_by_project — cost-7 — 107 sessions have no cost-eligible turns; visible in /api/sessions but invisible in /api/cost
- [LOW] cache:cache_hit_rate — CACHE-005 — Denominator includes cache_creation; cold-start sessions show "ineffective" even when caching works perfectly
- [LOW] cache:uncached_input_tokens — CACHE-006 — View column "uncached_tokens" name suggests "all not cached"; actually just uncached input
- [LOW] cache:session_cache_hit_rate — CACHE-007 — getCacheBySession reads s.cache_hit_rate from view AND recomputes from joined turns; dual code path is maintenance hazard
- [LOW] cache:cache_efficiency_trend — CACHE-008 — getCacheTrend accepts TimeBucket param but ignores it; daily-only granularity hard-coded
- [LOW] session:pressure_share — F7 — Uses strict ">" for 0.60/0.80 cutoffs; CLAUDE.md ambiguous; should be ">="
- [LOW] session:critical_rate_dataset — F8 — 0.80 "critical" band has no documentary support
- [LOW] session:pressure_rate_dataset — F10 — Denominator asymmetry: /sessions/stats.totalSessions=974 vs /context-pressure.totalSessions=868
- [LOW] tool:tool_success_rate — TOOL-006 — Denominator excludes NULL-success (correct) but evaluatedCount not surfaced in response
- [LOW] tool:mcp_server_total_calls — TOOL-007 — Two unrelated "mcp_server" shapes coexist (human-readable names + 36-char UUIDs)
- [LOW] tool:mcp_unique_tools_per_server — TOOL-009 — Unique-tool list includes redundant mcp__<server>__ prefix in every name
- [LOW] tool:tool_failure_rate_by_class — TOOL-010 — Class normalization buckets "native" as "builtin"; verify intent
- [LOW] skill:skill_thrash_invocations — S-4 — SKILL_THRASH_MIN=2 produces near-empty results; 2 flagged pairs in 30-day window, 50% are KNOWN_REENTRANT noise
- [LOW] skill:is_known_reentrant_skill — S-5 — KNOWN_REENTRANT_SKILLS is hardcoded 6-entry list; doesn't match plugin-namespace format
- [LOW] skill:dead_weight_skills — S-6 — "WHERE skill IS NOT NULL" filter is defensive and never fires (schema NOT NULL); correct as-is
- [LOW] skill:skill_loaded_in_sessions — S-7 — Flat 45 constant duplicated in 3 places (thresholds.ts, skillThresholds.ts, SQL view literal); drift risk
- [LOW] skill:skill_success_rate — S-8 — Denominator is "evaluated" (success NOT NULL); silently inflates if future ingest regression drops success state
- [LOW] skill:skills_per_session_trend — S-9 — Sessions bucketed by EARLIEST timestamp; multi-day sessions only contribute to start bucket
- [LOW] skill:loaded_context_share — S-10 — Mixes per-session numerator (avg_loaded × 45) with per-turn denominator (avg context across all assistant turns); definitional inconsistency
- [LOW] skill:distinct_skills_loaded — S-11 — Cross-location agreement verified; all sites produce identical numbers given same period (informational)
- [LOW] token:total_tokens_period (structural) — TOK-005 — Top 5 cache_read turns: cache_share >= 0.999; longer sessions with stable system prompts inflate metric most; KPI rewards verbosity
- [LOW] token:v_token_totals (maintenance) — TOK-006 — No time-bucketed sibling view; every period query reimplements TOKEN_SUM_COLUMNS inline
- [LOW] prompt:complexity_distribution_buckets — F8 prompt — CLI analyzer missing WHERE sp.multi_turn_depth > 0 filter that dashboard has; internal CLI consumers see different shape
- [LOW] prompt:(per-prompt model label) — F9 prompt — MIN(model) picks alphabetically; "<synthetic>" over real models, "haiku" over "opus"/"sonnet"; 26 of 31 multi-model windows mislabeled
- [LOW] prompt:(performance) — F10 prompt — scored_prompts.complexity_score (local PERCENT_RANK) computed but never used externally; dead compute on every prompt query
- [LOW] prompt:(unit of analysis) — F11 prompt — "Responded" prompts mix natural-language (~86%) with CLI injections (skill skeletons, command-message, tool_result echoes); score ranks "agent-side workload" not "human request"
- [LOW] activity:avg_tokens_per_turn — ACT-009 — AVG vs SUM/COUNT equivalence holds for current schema (0 NULL token rows); pin invariant
- [LOW] activity:activity_heatmap — ACT-010 — Empty (DOW, hour) cells omitted from API; client backfills; other consumers may not
- [LOW] activity:hourly_message_count — ACT-011 — Named "message_count" but counts assistant turns only; naming nit

**Total: 67 findings** (6 critical, 13 high, 24 medium, 24 low) across 8 groups. **19 are recommended for Linear tickets.**

---

## Proposed new KPIs

Nineteen suggestions organized by theme. Each is implementable with **no schema changes**.

### Theme A — Cost & failure

#### cost-on-failed-tool-turns

**Definition.** USD cost of assistant turns containing at least one failed tool call — wasted spend on rework.

**Formula.**

```sql
SUM(ct.cost_usd)
WHERE ct.turn_id IN (
  SELECT DISTINCT turn_id FROM tool_calls WHERE success = FALSE
)
```

**What it informs.** Puts dollars on tool failures. > 15% of spend = fix offending tool.

**Thresholds.** < 5% normal; 5-15% drag; > 15% urgent.

**Effort.** Small. **Priority.** Must-have.

### Theme B — Cache & efficiency

#### cache-warmup-payback-turns

**Definition.** Per session, turn index N at which cumulative cache_read savings exceed cumulative cache_creation cost.

**Formula.** Per session ordered by ts: `MIN(turn_index) WHERE running_savings >= running_write_cost`.

**What it informs.** Sessions too short for cache to pay back. Recommend longer sessions or persistent prompts.

**Thresholds.** Median <= 3 excellent; > 8 sessions too short.

**Effort.** Medium. **Priority.** Should-have.

#### low-cache-session-share

**Definition.** Share of sessions where `cache_hit_rate < 0.5 AND num_turns >= 5` — long enough to benefit but not getting any.

**Formula.**

```sql
COUNT(DISTINCT session_id) FILTER (cache_hit_rate < 0.50 AND num_turns >= 5)
  / COUNT(DISTINCT session_id) FILTER (num_turns >= 5)
```

**What it informs.** Sessions where prompts change every turn (cache invalidation). Fix by stabilizing CLAUDE.md.

**Thresholds.** < 10% ok; > 25% prompts killing cache.

**Effort.** Trivial. **Priority.** Should-have.

### Theme C — Tools & workflow

#### tool-fan-out-per-turn

**Definition.** AVG `tool_calls` per assistant turn + share of turns with >= 4 — how aggressively the agent batches.

**Formula.** `AVG(per_turn_tool_count); share = COUNT(*) FILTER (per_turn_tool_count >= 4) / COUNT(*)`.

**What it informs.** Higher = more parallelism = fewer roundtrips + lower cache writes. < 1.5 is sequential.

**Thresholds.** >= 2.5 strong; 1.5-2.5 moderate; < 1.5 rewrite prompts.

**Effort.** Small. **Priority.** Must-have.

#### tool-retry-rate

**Definition.** Per-tool share of consecutive same-tool calls where first failed.

**Formula.** LAG by `tool_call_id` per `session_id`: `COUNT(prev=tool AND prev_success=FALSE) / COUNT(prev_success=FALSE)` per `tool_name`.

**What it informs.** High retry rate = agent flailing on a tool. > 40% = replace or wrap.

**Thresholds.** < 20% ok; > 40% systemic.

**Effort.** Small. **Priority.** Must-have.

#### mean-time-to-recover

**Definition.** Within session, median `tool_calls` between failure and next success.

**Formula.** `MEDIAN(steps_to_next_success)` over FALSE rows.

**What it informs.** MTTR > 3 = thrash. Add "if X fails do Y" to CLAUDE.md.

**Thresholds.** <= 2 healthy; > 5 add recovery.

**Effort.** Medium. **Priority.** Should-have.

#### dead-loop-detection

**Definition.** Sessions with 5+ consecutive identical tool calls (same `tool_name` + same `MD5(parameters)`).

**Formula.** Gaps-and-islands on `(tool_name, MD5(parameters::VARCHAR))` per session, runs >= 5.

**What it informs.** Dead loops = hung agent. `/clear` and rewrite prompt.

**Thresholds.** Any >= 5 = signal; > 2% sessions = systemic.

**Effort.** Medium. **Priority.** Nice-to-have.

### Theme D — Session completion

#### completion-rate

**Definition.** Share of sessions whose final turn is `role='assistant'` with `stop_reason IN ('end_turn','stop_sequence','tool_use')` — proxy for tasks taken to clean stop vs abandoned.

**Formula.**

```sql
COUNT(DISTINCT session_id) FILTER (
  last_role = 'assistant'
  AND last_stop_reason IN ('end_turn','stop_sequence','tool_use')
) / COUNT(DISTINCT session_id)
```

**What it informs.** Whether sessions finish cleanly. < 60% = sessions quitting before resolution.

**Thresholds.** >= 80% healthy; 60-80% moderate; < 60% review.

**Effort.** Small. **Priority.** Must-have.

#### context-pressure-at-quit

**Definition.** AVG `context_utilization` on LAST assistant turn per session — "how full was the window when I gave up?"

**Formula.** `AVG(context_utilization_on_last_assistant_turn)` per session using `v_context_pressure` CASE.

**What it informs.** If users routinely quit at > 70%, they're hitting degradation. Recommend `/clear` and `/compact` earlier.

**Thresholds.** < 0.40 healthy; 0.40-0.60 acceptable; > 0.60 systemic exhaustion.

**Effort.** Small. **Priority.** Must-have.

#### max-tokens-truncation-rate

**Definition.** Share of assistant turns with `stop_reason = 'max_tokens'`.

**Formula.** `COUNT FILTER (stop_reason='max_tokens') / COUNT FILTER (stop_reason IS NOT NULL)`.

**What it informs.** Truncations force retries. > 2% = raise `max_tokens` or split tasks.

**Thresholds.** < 1% healthy; > 3% adjust.

**Effort.** Trivial. **Priority.** Must-have.

#### session-quit-while-failing

**Definition.** Share of sessions where LAST `tool_call` had `success = FALSE`.

**Formula.** `COUNT(DISTINCT session_id) FILTER (last_tool_success=FALSE) / COUNT(DISTINCT session_id) FILTER (has_tools)`.

**What it informs.** > 20% = systemic dropout during failures. Add recovery scripts or change tooling.

**Thresholds.** < 10% normal; > 20% systemic.

**Effort.** Small. **Priority.** Should-have.

### Theme E — MCP / Skill ROI

#### mcp-server-roi

**Definition.** Per MCP server: `success_rate × call_count / share-of-loaded-sessions`.

**Formula.** `roi_score = (success_rate * call_count) / sessions_using_or_loaded_server`.

**What it informs.** Identify MCPs to uninstall/fix. Loaded-never-used MCPs = permanent context tax.

**Thresholds.** < 0.5 success AND >= 20 calls = remove; loaded but 0 invocations across 10+ sessions = remove.

**Effort.** Medium. **Priority.** Should-have.

### Theme F — Prompt quality

#### clarify-loop-rate

**Definition.** Share of assistant turns ending in `?` AND no `tool_use`.

**Formula.** `COUNT FILTER (role='assistant' AND has_tool_use=FALSE AND TRIM(content_text) LIKE '%?') / COUNT(*)`.

**What it informs.** Frequent clarifications = underspecified prompts. > 15% = upgrade CLAUDE.md.

**Thresholds.** < 5% clear; > 15% improve specificity.

**Effort.** Small. **Priority.** Should-have.

#### tool-thrash-after-prompt

**Definition.** Tool calls per turn within prompt window.

**Formula.** `tool_call_count_per_prompt / NULLIF(multi_turn_depth, 0)`.

**What it informs.** p95 = prompts too vague (agent grep'd everything).

**Thresholds.** <= 3 normal; > 8 rewrite.

**Effort.** Small. **Priority.** Should-have.

### Theme G — Time & habits

#### model-switch-rate

**Definition.** Share of sessions using > 1 model.

**Formula.** `COUNT(DISTINCT session_id) FILTER (per_session_distinct_models > 1) / COUNT(DISTINCT session_id)`.

**What it informs.** Frequent switching breaks cache (each model has own cache).

**Thresholds.** < 10% ok; > 30% review habit.

**Effort.** Trivial. **Priority.** Should-have.

#### peak-productivity-hours

**Definition.** Hour-of-day ranked by `completion-rate` (not raw volume) — finds effective working hours.

**Formula.** Per hour bucket of `session.start_time`: `sessions_with_clean_finish / total_sessions`.

**What it informs.** User's most effective hours; schedule deep work then.

**Thresholds.** Show top-3 / bottom-3.

**Effort.** Small. **Priority.** Should-have.

#### parallel-tool-call-rate

**Definition.** Share of assistant turns with >= 2 `tool_calls` in ONE turn (true parallelism).

**Formula.** `COUNT FILTER (per_turn_tool_count >= 2) / COUNT FILTER (has_tool_use = TRUE)`.

**What it informs.** Pairs with fan-out. Tells if prompts unlock parallelism.

**Thresholds.** >= 40% strong; < 20% prompts artificially serial.

**Effort.** Trivial. **Priority.** Nice-to-have.

### Theme H — Pricing & efficiency

#### subscription-breakeven-cost

**Definition.** API-priced cost vs configured MAX subscription price.

**Formula.** `savings = SUM(cost_usd) - MAX_SUB_PRICE_PER_MONTH` (configurable, default $200, prorated).

**What it informs.** Drives concrete plan decision: subscribe or stay API.

**Thresholds.** ratio > 1.0 subscribe (MAX pays for itself); < 0.5 keep API.

**Effort.** Trivial. **Priority.** Must-have.

#### turns-per-dollar

**Definition.** Total assistant turns / total cost.

**Formula.** `COUNT FILTER (assistant AND model<>'<synthetic>') / NULLIF(SUM(cost_usd), 0)`.

**What it informs.** Trend = real story. Rising = more efficient prompts.

**Thresholds.** Flag > 25% drop MoM.

**Effort.** Trivial. **Priority.** Nice-to-have.

### Top picks (recommended for next implementation)

These five each map to a single, concrete user action that the existing inventory does not surface:

1. **completion-rate** — exposes abandonment
2. **context-pressure-at-quit** — pairs with completion-rate to answer "why did I quit?"
3. **cost-on-failed-tool-turns** — puts dollars on rework (the inventory has failure chains but never converts to USD)
4. **tool-fan-out-per-turn** — drives prompt-rewriting toward parallelism
5. **subscription-breakeven-cost** — the only metric that converts ccanalytics into a billing-plan decision tool

All five are trivial-to-small effort, **NO schema changes**, and each terminates in an action.

---

## Glossary

- **input_tokens** — Anthropic API field. Fresh prompt content sent to the model, **not** including cached prefix. Already excludes cache reads.
- **cache_read_tokens** — Anthropic API field. Prompt prefix tokens served from cache; priced at ~10% of `input_tokens` rate.
- **cache_creation_tokens** — Anthropic API field. Tokens written to cache on first use of a prompt prefix (cache miss). Priced higher than fresh inputs.
- **output_tokens** — Anthropic API field. Tokens generated by the model in its response.
- **turn** — One row in `conversation_turns`. Can be `role='user'`, `role='assistant'`, or `role='system'`. A round-trip is one user turn + one or more assistant turns (multi-turn depth >= 1).
- **session** — One row in `sessions`. A continuous conversation, identified by `session_id` (Claude Code UUID). Bounded by `start_time` and `end_time`.
- **conversation_turn vs message** — These are the same thing at the database level. UI sometimes says "messages", but the underlying table is `conversation_turns`. Total Turns KPI sums `sessions.num_turns`, which currently counts all roles (see [F3 known issue](#known-issues)).
- **tool_call** — One row in `tool_calls`. A single tool invocation within an assistant turn. Multiple `tool_calls` can share a `turn_id` (parallel tool use).
- **error** — Tool call with `success = FALSE` AND non-NULL `error_message`. NULL success = "no data" (not failure) per KPI-006.
- **multi_turn_depth** — Number of consecutive assistant turns responding to one user turn. Defines a "prompt window": user turn → assistant turn(s) → next user turn.
- **prompt window** — Logical unit: (one user turn) → (zero or more assistant turns) → (next user turn or session end). The atomic unit for prompt-level metrics (cost, complexity, tool count).
- **cost row predicate** — `role = 'assistant' AND model IS NOT NULL AND model <> '<synthetic>'`. The canonical filter applied by every cost metric. Cache/activity/skill metrics use looser filters today, which is one source of cross-endpoint divergence.

---

## Maintenance footer

### When a metric changes

1. Update its section in this doc — keep the headline metrics fully described, secondary ones in the compact table.
2. Date-stamp the change at the top of the doc.
3. Re-run [the metrics inventory probe](../.a5c/artifacts/metrics-store/inventory.json) to refresh the source line references.

### Single source of truth: pricing.ts → buildRateCaseSql

Cost rates **never** appear hand-written in SQL. The chain is:

```
src/utils/pricing.ts (PRICING table)
   │
   ├─ src/utils/pricing.ts:getPricing(model)     ← consumed by TS analyzers
   │
   └─ src/utils/pricing.ts:buildRateCaseSql()    ← consumed by dashboard SQL routes
       └─ src/utils/pricing.ts:buildCacheSavingsRateCaseSql()
```

If you edit a rate in `PRICING`, immediately:

1. Run `npm run build` and `npm test` — the rate constants are referenced in test fixtures.
2. Run `npm run backfill:costs` — recomputes stored `cost_usd` and `sessions.total_cost_usd` in place.
3. Take a DB backup first; the backfill is idempotent but the column overwrite is destructive on rollback.

**Do not** edit the `CASE` expressions in `dashboard/src/server/routes/cost.ts` or `cache.ts` by hand. They are generated.

### When to re-run audits

The audit artifacts in `.a5c/artifacts/metrics-store/` should be regenerated when:

- A new metric is added to a SQL view, TS analyzer, or dashboard route (re-run the inventory probe).
- A metric definition changes (re-run the per-group review probes).
- A rate-table change goes through (re-run the cost and cache reviews to confirm reconciliation residuals stay below 1e-9).

After any audit re-run, regenerate this doc by re-synthesizing the new artifacts.

### Cross-references

- Project-level guidance: [`/Users/ozlevi/Development/tooling/CLAUDE.md`](../../CLAUDE.md) — see "Key formulas" and "Cost methodology" sections.
- Inventory artifacts: [`.a5c/artifacts/metrics-store/inventory.json`](../.a5c/artifacts/metrics-store/inventory.json), [`inventory.md`](../.a5c/artifacts/metrics-store/inventory.md).
- Per-group reviews: [`.a5c/artifacts/metrics-store/reviews/`](../.a5c/artifacts/metrics-store/reviews/).
- New-KPI suggestions: [`.a5c/artifacts/metrics-store/new-kpi-suggestions.json`](../.a5c/artifacts/metrics-store/new-kpi-suggestions.json).
- Findings flat list: [`.a5c/artifacts/metrics-store/findings-summary.md`](../.a5c/artifacts/metrics-store/findings-summary.md).

End of document.
