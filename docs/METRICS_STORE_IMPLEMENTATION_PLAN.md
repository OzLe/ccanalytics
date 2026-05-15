# Metrics Store — Implementation Plan

**Companion to [METRICS_STORE.md](./METRICS_STORE.md).** Sequences the 20 Linear tickets (SEM2-278 through SEM2-297) into parallel workstreams. Identifies the critical path, shared-file conflicts, and the one definitional decision that gates three lanes.

**Date:** May 15, 2026
**Tickets:** 20 (6 critical + 14 high)
**Linear team:** `semanticops`

---

## TL;DR

- **10 workstream lanes**, most independent.
- **One critical-path decision** must land before three lanes can finish: the canonical `total_tokens` formula (LANE E). Until that's chosen, LANES D, F, and J risk re-doing work.
- **3 "free-money" lanes** can start today with zero conflict surface: **G** (prompt model filter), **H** (skill token estimate), **D1** (heatmap day labels).
- **Single longest lane** is **D2** (activity timezone conversion) — estimated 2-3 days.
- **Recommended landing order** (3 waves): see [Phasing](#phasing) below.

---

## Lane summary

| Lane | Tickets | Severity | Estimated effort | Critical conflicts |
|------|---------|----------|------------------|--------------------|
| **A** — Session cost basis | SEM2-278, SEM2-280 | critical + high | 1 day | session-analyzer.ts |
| **B** — Tool ordering | SEM2-283, SEM2-284, SEM2-285, SEM2-286 | 2 critical + 2 high | 1 day | tool-analyzer.ts, views.sql |
| **C** — Tool duration display | SEM2-282 | critical | half day | tool-analyzer.ts (after B) |
| **D1** — Heatmap day labels | SEM2-294 | critical | 30 min | none |
| **D2** — Activity timezone | SEM2-293 | critical | 2-3 days | activity.ts, time-series.ts |
| **D3** — Empty hour buckets | SEM2-295 | high | half day | activity.ts (after D2) |
| **E** — Token semantics unify | SEM2-288, SEM2-289, SEM2-296 | 3 high | 1-2 days | tokens.ts, activity.ts, prompts.ts, views.sql, DashboardPage.tsx |
| **F** — Prompt complexity | SEM2-290, SEM2-291 | 2 high | 1 day | prompt-analyzer.ts (after E) |
| **G** — Prompt model filter | SEM2-292 | high | half day | none |
| **H** — Skill token estimate | SEM2-287 | high | half day | views.sql (sec 599 — different) |
| **I** — Session duration | SEM2-281 | high | half day | session-analyzer.ts (after A) |
| **J** — Daily activity predicate | SEM2-297 | high | half day | time-series.ts (after D2) |

**Total ticket count: 20.** All 20 map to one of the 10 lanes.

---

## Dependency graph

```
                          ┌─────────────────────────┐
                          │ definitional decision:  │
                          │ canonical total_tokens? │
                          │ (input+output OR 4-way) │
                          └────────────┬────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼                              ▼                              ▼
   ┌────────┐                     ┌────────┐                     ┌────────┐
   │ LANE E │                     │ LANE D │                     │ LANE F │
   │ token  │                     │activity│                     │ prompt │
   │unify   │                     │tz/heat │                     │complex │
   └───┬────┘                     └───┬────┘                     └───┬────┘
       │                              │                              │
       │                              │                              │
       ▼                              ▼                              ▼
  (rebases F, J)                  (rebases J)                   (consumes E)


  Independent lanes (no cross-dependencies, any order):

   ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
   │ LANE A │  │ LANE B │  │ LANE G │  │ LANE H │  │  D1    │
   │session │  │ tool   │  │ prompt │  │ skill  │  │heatmap │
   │ cost   │  │ order  │  │ filter │  │tokens  │  │ labels │
   └───┬────┘  └───┬────┘  └────────┘  └────────┘  └────────┘
       │          │
       ▼          ▼
   ┌────────┐  ┌────────┐
   │ LANE I │  │ LANE C │
   │session │  │ tool   │
   │ dur    │  │duration│
   └────────┘  └────────┘
```

Arrows = "land first to avoid rebase pain." There are no **logical** dependencies — every lane works on its own data path. The arrows are purely about merge-conflict avoidance.

---

## Critical path

**Longest serial chain = the gating decision + the most-touched lane.**

```
[Decision: total_tokens formula]  →  LANE E (1-2 days)  →  LANE F (1 day)
                                  ↘
                                    LANE D2 (2-3 days)  →  D3 + J (half day each)
```

**Critical path: D2 takes longest (2-3 days).** Everything else can complete in parallel within that window if owners are assigned per lane.

**Total wall-clock with full parallelism: ~3 days.**
**Total wall-clock with single owner: ~10 days.**

---

## Lanes in detail

### LANE A — Session cost basis (1 PR, half-to-full day)

- **Tickets:** SEM2-280 (F1-session, critical), SEM2-278 (cost-1, high)
- **Symptom:** `/api/sessions/stats` reports $203 (2.45%) less than `/api/cost/total`. 9 sessions diverged >$1, worst is $60.43 under-reported (84%).
- **Root cause:** `sessions.total_cost_usd` is a stored aggregate; `batch-inserter.ts:113` upserts with the per-batch recomputed cost (overwrite, not accumulate). Documented as COST-004 in `views.sql:82-92`.
- **Fix:**
  ```sql
  -- in dashboard/src/server/routes/sessions.ts:125 and src/queries/session-analyzer.ts:283
  SELECT SUM(total_cost_usd) FROM v_session_summary WHERE ...
  -- instead of
  SELECT SUM(total_cost_usd) FROM sessions WHERE ...
  ```
- **Files:** `dashboard/src/server/routes/sessions.ts:113-144`, `src/queries/session-analyzer.ts:274-298`.
- **Also fixes:** `total_turns` drift (F2-session, medium — not in major-ticket set but auto-resolves if `num_turns` also reads from view).
- **Conflicts:** Lane I (session duration) touches the same `getSessionStats` function. Land A first.
- **Tests:** Add an integration test asserting `/api/sessions/stats.totalCostUsd === /api/cost/total.totalCostUsd` on a fixture DB.

---

### LANE B — Tool ordering (1 PR, 1 day)

- **Tickets:** SEM2-283 (TOOL-002, critical), SEM2-284 (TOOL-003, critical), SEM2-285 (TOOL-004, high), SEM2-286 (TOOL-005, high)
- **Symptom:** `max_failure_streak` shows 6 (real: 8). `Bash→Bash→Bash` chain shows 7,307 occurrences (real: 13,656). 98.65% of rows mispositioned.
- **Root cause:** `ROW_NUMBER OVER (ORDER BY tc.tool_call_id)` — `tool_call_id` is a random base62 string, not chronological.
- **Fix:**
  ```sql
  -- Replace everywhere:
  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY tc.tool_call_id)
  -- With:
  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ct.timestamp, tc.tool_call_id)
  ```
- **Files:** `src/queries/tool-analyzer.ts:272,442`, `dashboard/src/server/routes/tools.ts:344,444`, `sql/views.sql:475`. View `v_session_failure_chains` needs a `JOIN conversation_turns ct` added.
- **Also:** TOOL-005 fix — `v_session_failure_chains` denominator (rewrite with `LEFT JOIN` so 0-failure sessions stay). TOOL-004 is documentation only (parallel tool_uses tie-break behavior).
- **Conflicts:** Lane C touches `tool-analyzer.ts` lines 85/147/209/288 (different from 272/442); manageable, but land B first.
- **Validation:** After fix, expect: `Bash³` count ≈ 2x; worst streak rises 6→8; ~21 sessions enter/exit failure-chain set.
- **Migration note:** No data migration needed — the formulas are pure-read.

---

### LANE C — Tool duration display (1 PR, half day, after B)

- **Tickets:** SEM2-282 (TOOL-001, critical)
- **Symptom:** "Avg Time" column shows 0s for every tool — 100% of `tool_calls.duration_ms` is NULL.
- **Root cause:** Both ingestion adapters explicitly set `duration_ms: null`. The `COALESCE(AVG(duration_ms), 0)` then renders as `formatDuration(0)` in the UI.
- **Recommended fix:** Stop pretending we have the data. Coerce `NULL`, propagate `number | null` through the API and types, render "n/a" in the UI (matches the KPI-006 success_rate pattern).
- **Files:**
  - `src/queries/tool-analyzer.ts:85,147,209,288` — change `COALESCE(..., 0)` to `ELSE NULL`
  - `dashboard/src/server/routes/tools.ts:46,109,173,460` — same
  - `dashboard/src/pages/ToolsPage.tsx:196-202,293-301` — render `n/a` when null
  - `dashboard/src/lib/types.ts:322,336,344` — type changes
- **Conflicts:** B (above) touches `tool-analyzer.ts` line 272/442; C touches 85/147/209/288. No overlapping lines but same file. Rebase C onto B's merged head.
- **Future option:** Backfill `duration_ms` from `conversation_turns.timestamp` deltas (next-assistant minus current-assistant). Separate ticket — not part of this fix.

---

### LANE D1 — Heatmap day labels (1 PR, 30 min)

- **Ticket:** SEM2-294 (ACT-002, critical)
- **Symptom:** Friday's 5,291 turns show under "Sat"; real-peak Thursday shows under "Fri".
- **Root cause:** DuckDB `EXTRACT(DOW)` = 0 for Sunday; UI `DAY_LABELS = ['Mon','Tue',...,'Sun']`.
- **Fix:** One file, 2 lines.
  ```typescript
  // dashboard/src/components/charts/HourlyHeatmap.tsx:13
  const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];  // was: ['Mon',...,'Sun']
  // Line 59 comment: // dayOfWeek (0=Sun..6=Sat)
  ```
- **Files:** `dashboard/src/components/charts/HourlyHeatmap.tsx` (only).
- **Conflicts:** None.
- **Suggested:** Ship this first as a confidence-builder — it's a textbook one-line correctness fix.

---

### LANE D2 — Activity timezone (1 PR, 2-3 days, **critical path**)

- **Ticket:** SEM2-293 (ACT-001, critical)
- **Symptom:** "Peak Hour 10am" shown when user worked at 1pm Israel time. Shifted -3h (DST) systemically.
- **Root cause:** `timestamp TIMESTAMP NOT NULL` (no tz). Stored as UTC ISO. `EXTRACT(HOUR)` returns UTC hour. UI labels `formatHour(10)` as `'10am'` with no UTC tag.
- **Fix strategy:** Two-phase.
  - **Phase 1 (cheap, ship first):** Add `(UTC)` label on every hourly KPI and heatmap caption. Buys correctness while Phase 2 is built.
  - **Phase 2 (real fix):** Add a `userTimezone` setting (default = `Intl.DateTimeFormat().resolvedOptions().timeZone`). Pipe into queries as `:user_tz`. Convert at query time: `EXTRACT(HOUR FROM (timestamp AT TIME ZONE 'UTC') AT TIME ZONE :user_tz)`. Apply to: `v_hourly_activity`, `getHourlyActivity`, `getActivityHeatmap`, `getDailyActivity`, all 3 activity routes, and the `daily-bucket` selector in `ActivityPage.tsx`.
- **Files:**
  - `dashboard/src/server/routes/settings.ts` — new `userTimezone` setting
  - `sql/views.sql:213` — `v_hourly_activity` query rewrite
  - `src/queries/time-series.ts:73,149` — `getHourlyActivity`, `getActivityHeatmap`
  - `dashboard/src/server/routes/activity.ts:38,121` — both endpoints
  - `dashboard/src/pages/ActivityPage.tsx:29-33,73` — local-date selector
- **Conflicts:** Touches views.sql + activity.ts + time-series.ts — all three are also touched by LANES E and J. **Land D2 before J**, and **resolve E's views.sql edits separately** (different sections).
- **Migration note:** No schema change required if we use `AT TIME ZONE` at query time. If we want to backfill to `TIMESTAMPTZ`, that's a separate (larger) migration — defer.

---

### LANE D3 — Empty hour buckets (1 PR, half day, after D2)

- **Ticket:** SEM2-295 (ACT-003, high)
- **Symptom:** API returns 20 of 24 hours; missing hours have no row. Only the React page backfills; other consumers would drop them.
- **Fix:** Server-side `LEFT JOIN generate_series(0,23,1) AS h(hour_of_day)`. Always return 24 rows.
- **Files:** `dashboard/src/server/routes/activity.ts:38`, `src/queries/time-series.ts:73`, `sql/views.sql:213`.
- **Conflicts:** Same files as D2. Rebase onto D2's merged head.

---

### LANE E — Token semantics + cross-codebase unification (1 PR, 1-2 days)

- **Tickets:** SEM2-288 (TOK-001, high), SEM2-289 (TOK-002, high), SEM2-296 (ACT-004, high)
- **Symptom:** "Total Tokens" KPI = 11.98B (97.78% cache_read). `/api/activity/hourly` says 40.75M for the same population. 293.95× gap between two endpoints using the same field name.
- **Root cause:** Two contradictory `total_tokens` definitions exist side-by-side. The 4-way sum (input + output + cache_creation + cache_read) is dominated by cache replays.
- **Decision required** (BLOCKS this lane):
  - **Option A (recommended):** Headline = `input + output` (Anthropic-API-style). Demote 4-way to a secondary "Context Volume" metric with clear label.
  - **Option B:** Standardize on 4-way everywhere (matches v_hourly_activity).
  - Defer this decision to product/owner. Pick before opening the PR.
- **Files (with Option A):**
  - `dashboard/src/pages/DashboardPage.tsx:266-290` — reframe KPI label and value
  - `src/queries/token-analyzer.ts:62-67` — `TOKEN_SUM_COLUMNS` helper
  - `dashboard/src/server/routes/tokens.ts:37-42`
  - `sql/views.sql:65-76` (v_token_totals), `sql/views.sql:217-218` (v_hourly_activity)
  - `dashboard/src/server/routes/activity.ts:42,45`
  - `dashboard/src/server/routes/prompts.ts:80-82`
- **Conflicts:** This lane has the **widest blast radius**. It touches files modified by LANES D, F, and indirectly G. Sequence:
  1. Make the definitional decision.
  2. Land E (it's the cross-cutting fix).
  3. F, D2, D3 rebase on top.
- **Refactor opportunity:** Centralize `TOKEN_SUM_COLUMNS` as a `buildTokenSumSql()` helper (mirrors `buildRateCaseSql()` from `pricing.ts`). One source for the canonical SUM expression.

---

### LANE F — Prompt complexity composite (1 PR, 1 day, after E)

- **Tickets:** SEM2-290 (F1-prompt, high), SEM2-291 (F2-prompt, high)
- **Symptom:** `has_thinking` is a 25-pt step in a 100-pt composite (98.8% of prompts pay 0/100). `tool_call_count` and `multi_turn_depth` correlate 0.995 — composite triple-weights one signal.
- **Recommended fix:**
  - Drop `has_thinking` from the composite; surface as a categorical badge alongside the score.
  - Replace `(tool_call_count, multi_turn_depth)` with one of: `max(of the two)`, `distinct_tools_used`, or `error_count`. Re-weight remaining 3 dimensions equally.
- **Files:** `src/queries/prompt-analyzer.ts:189-191,288-292`, `dashboard/src/server/routes/prompts.ts:148-150,243-247`.
- **Conflicts:** `prompts.ts` is also touched by LANE E. Rebase F onto E's merged head.
- **Owner decision:** Which 4th dimension to add. Defer to product or pick by data exploration.

---

### LANE G — Prompt model filter (1 PR, half day, **start today**)

- **Ticket:** SEM2-292 (F3-prompt, high)
- **Symptom:** `?model=opus` silently returns zero prompts.
- **Root cause:** `AND model LIKE '%' || $N || '%'` applied to user turns; user turns have `model IS NULL`; `NULL LIKE` returns NULL; rows dropped.
- **Fix:** Wrap as `AND (role='user' OR model LIKE '%' || $N || '%')` so user rows pass through, OR apply filter only inside the `assistant_agg` JOIN.
- **Files:** `src/queries/filter-builder.ts:33-37`, `dashboard/src/server/helpers/parseFilters.ts:108-112`.
- **Conflicts:** None.
- **Suggested:** Free money. Start now.

---

### LANE H — Skill token estimate (1 PR, half day, **start today**)

- **Ticket:** SEM2-287 (S-1, high)
- **Symptom:** `FLAT_SKILL_TOKEN_ESTIMATE = 45` understates real skill-description tokens by ~45%.
- **Fix:**
  ```typescript
  // src/queries/skill-thresholds.ts:30 (and dashboard mirror)
  // Replace flat constant usage with:
  // est_tokens = COALESCE(CEIL(LENGTH(skill_description) / 4.0), 45)
  ```
- **Files:** `src/queries/skill-thresholds.ts:30`, `dashboard/src/lib/skillThresholds.ts:58`, `sql/views.sql:599`.
- **Conflicts:** `views.sql` is touched by LANES B, D, E — but section 599 is the `v_skill_loaded` view, distinct from the sections those lanes edit. Low conflict risk.
- **Suggested:** Free money. Start now.

---

### LANE I — Session duration (1 PR, half day, after A)

- **Ticket:** SEM2-281 (F4-session, high)
- **Symptom:** `avg_duration_minutes` = 332 min (driven by 2 zombie sessions of ~37.5 days each). Median = 28 min.
- **Fix:** Surface MEDIAN as the primary KPI; cap MEAN's input at 12h or use trimmed mean. Optionally add `active_duration` (clamping inter-turn gaps > 30 min to 30 min).
- **Files:** `src/queries/session-analyzer.ts:281`, `dashboard/src/server/routes/sessions.ts:123`, UI change to swap primary/secondary KPI labels.
- **Conflicts:** Same files as LANE A but different lines. Rebase I onto A.

---

### LANE J — Daily activity predicate (1 PR, half day, after D2)

- **Ticket:** SEM2-297 (ACT-005, high)
- **Symptom:** `daily_activity` counts every `role='assistant'` row; `v_daily_cost` adds `model<>'<synthetic>' AND model IS NOT NULL`. Populations differ by up to 5.8% on some days.
- **Fix:** Add `costRowPredicate()` to all activity surfaces. Touches `time-series.ts:123` and `dashboard/src/server/routes/activity.ts`.
- **Conflicts:** Same files as D2/D3. Rebase J onto whichever of those lands last.

---

## Phasing

### Wave 1 — Start immediately (no conflicts, day 1)

These have zero conflict surface with any other lane. Three engineers can run them in parallel today.

- **LANE D1** (heatmap labels) — 30 min — `dashboard/src/components/charts/HourlyHeatmap.tsx`
- **LANE G** (prompt model filter) — half day — `filter-builder.ts`, `parseFilters.ts`
- **LANE H** (skill token estimate) — half day — `skill-thresholds.ts`, `skillThresholds.ts`, `views.sql:599`

### Wave 2 — Foundational (after Wave 1, day 1-3)

These touch files that downstream lanes depend on. Land them before their dependents.

- **LANE A** (session cost basis) — 1 day — unblocks LANE I
- **LANE B** (tool ordering) — 1 day — unblocks LANE C
- **Decision: pick canonical `total_tokens` formula** (Option A vs B)
- **LANE E** (token unify) — 1-2 days, starts after the decision — unblocks F + simplifies D
- **LANE D2** (activity timezone) — 2-3 days (longest, **critical path**) — unblocks D3 + J

### Wave 3 — Dependents (rebased onto Wave 2 heads)

- **LANE C** (tool duration) — half day after B
- **LANE F** (prompt complexity) — 1 day after E
- **LANE I** (session duration) — half day after A
- **LANE D3** (empty hour buckets) — half day after D2
- **LANE J** (daily predicate) — half day after D2

### Wave 4 — Integration

- Run full test suite on the merged result.
- Re-audit: re-run `.a5c/processes/metrics-store-audit.js` against the post-fix DB to confirm findings are resolved.
- Close all 20 Linear tickets.

---

## Shared-file conflict matrix

The 9 files touched by 2+ tickets, with the recommended landing order:

| File | Tickets | Recommended order |
|------|---------|-------------------|
| `sql/views.sql` | ACT-001, ACT-004, CACHE-001, S-1, TOK-002, TOOL-002 | Different sections — coordinate via clear section comments, accept light rebases |
| `dashboard/src/server/routes/activity.ts` | ACT-001, ACT-004, TOK-002 | E → D2 → D3 → J |
| `dashboard/src/server/routes/sessions.ts` | F1-session, cost-1, F4-session | A (combines F1+cost-1) → I |
| `dashboard/src/server/routes/tokens.ts` | TOK-001, TOK-002 | One PR (LANE E) |
| `dashboard/src/server/routes/prompts.ts` | F1-prompt, TOK-002 | E → F |
| `src/queries/session-analyzer.ts` | F1-session, cost-1, F4-session | A → I |
| `src/queries/time-series.ts` | ACT-001, ACT-004 | LANE D (single PR covers both) |
| `src/queries/tool-analyzer.ts` | TOOL-001, TOOL-002 | B → C |
| `src/ingestion/batch-inserter.ts` | ACT-001, F1-session, cost-1 | If A also fixes batch-inserter, do that first; D2 only touches it for timezone storage decision (likely no edit) |

---

## Open decisions before starting

These three product/owner decisions should be made before Wave 2 starts:

1. **Canonical `total_tokens` formula** — input+output (Option A, recommended) vs 4-way (Option B). Gates LANE E.
2. **Activity timezone storage** — query-time conversion (cheap, no migration) vs `TIMESTAMPTZ` migration (cleaner, ~1 day). Gates LANE D2 Phase 2.
3. **Prompt complexity 4th dimension** — drop `has_thinking`, then pick replacement: `distinct_tools_used`, `error_count`, or `thinking_tokens` (continuous version). Gates LANE F.

If decisions are blocked, a sensible default for each: Option A; query-time conversion; `distinct_tools_used`.

---

## Validation plan

After all 20 tickets close, re-run the audit to confirm resolution:

```bash
cd /Users/ozlevi/Development/tooling/ccanalytics
# Take a fresh DB backup (CLAUDE.md requirement before any cost-touching work)
TS=$(date +%Y%m%d-%H%M%S)
cp ~/.ccanalytics/analytics.duckdb ~/.ccanalytics/backups/analytics-pre-metrics-fix-$TS.duckdb

# Re-run the audit
babysitter run:create \
  --process-id ccanalytics/metrics-store-audit \
  --entry .a5c/processes/metrics-store-audit.js#process \
  --inputs .a5c/processes/metrics-store-audit-inputs.json \
  --json
```

Expected after-fix outcomes (each maps to a closed ticket):

| Metric | Before | Target after |
|--------|--------|--------------|
| `/api/sessions/stats.totalCostUsd` vs `/api/cost/total` | $203 gap (2.45%) | $0 gap |
| `tool_avg_duration_ms` displayed in UI | `0s` for every row | `n/a` or real value |
| `max_failure_streak` global max | 6 | 8 (real chronological max) |
| `Bash→Bash→Bash` chain count | 7,307 | ~13,656 |
| `Peak Hour` label | `10am` (UTC) | `1pm` (local) or `10am UTC` |
| Heatmap Friday column | labelled `Sat` | labelled `Fri` |
| `Total Tokens` KPI | 11.98B (97.78% cache_read) | reframed to ~40.8M In/Out + secondary "Context Volume" |
| `?model=opus` on `/api/prompts/ranked` | returns 0 prompts | returns filtered prompts |

---

## Maintenance

When a ticket closes:
1. Update [METRICS_STORE.md](./METRICS_STORE.md) — strike through the "Known issues" entry and add a date + commit ref.
2. Update this plan — strike through the lane row.
3. Comment on the Linear ticket with the PR link.

When all 20 close: archive this plan into `docs/archive/` and start the next audit cycle if desired.
