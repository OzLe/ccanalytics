# Subscription Recommendation — Implementation Spec

**Feature branch:** `feature/subscription-recommendation`
**Status:** ready to build
**Scope discipline:** This is a presentation/analysis feature. It does **not** change how `conversation_turns.cost_usd` is computed (per-model rates stay only in `src/utils/pricing.ts`; tier prices stay only in `src/config/subscription.ts`). It adds one new read-only analyzer + one read-only API route + one new SSOT config module + a config-schema extension persisted through the existing settings write path + UI additions to the existing Subscription Value surface.

The recommendation answers a single question for the user: **"Given my Claude Code usage, can I DOWNGRADE (I'm under-utilizing my tier), should I UPGRADE (I'm frequently at/near my limits), or should I STAY?"** — with an explicit confidence level and an honest "estimate" caveat.

---

## 1. Data source justification — local-only, never blocked, advisory estimate

### 1.1 Only already-ingested local data is used

The analyzer reads exclusively from the two DuckDB tables that the ingestion pipeline already populates (`sql/schema.sql`):

- **`conversation_turns`** — columns used: `turn_id`, `session_id`, `role`, `timestamp`, `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `cost_usd`, `model`, `request_id`. (`stop_reason` is read too, only to confirm there is **no** rate-limit signal — see §1.3.)
- **`sessions`** — used only for filter joins (`project_path`, `source_type`) when a filter is active, exactly as the existing cost path does.

There are **no** network calls: no Anthropic API, no `claude.ai` scraping, no Console API, no auth. The recommendation route is therefore subject to the same single dependency every other dashboard route has — the local DuckDB file — so it can never be "blocked" by an upstream service, rate limit, or auth expiry. This mirrors the existing read path in `dashboard/src/server/routes/cost.ts`, which only ever touches `query()` from `dashboard/src/server/helpers/db.js`.

### 1.2 Why it must be an ESTIMATE (and labelled as one)

Claude Code's JSONL does **not** log structured 5-hour / weekly limit-hit events. Verified against the schema and the codebase:

- There is no rate-limit `stop_reason` in the data. The only `stop_reason` values the codebase keys on are `end_turn` and `max_tokens` (see `CONTEXT_WINDOW_CASE` / `max_tokens_turns` handling in `src/queries/session-analyzer.ts`). No `isApiErrorMessage` / "rate_limit" / "overloaded" record type is ingested into any of the five tables.
- Anthropic does not publish exact 5-hour or weekly message ceilings, and true headroom varies by model, message length, attachments, and tool use.

Therefore the recommendation is a **proxy reconstructed from usage intensity**, not a readout of real limit hits. Every surface (CLI text, API payload, UI card) MUST carry the caveat string, defined once as a constant in the new SSOT module (§3):

> **"Estimate from local session data; Anthropic's exact limits are not published."**

### 1.3 Cost SSOT is untouched

The analyzer never recomputes `cost_usd`. Where it needs dollars (the up/downgrade $ delta), it reuses tier monthly prices from `src/config/subscription.ts` (`DEFAULT_MONTHLY_USD`) and the same proration constant the dashboard already uses (`AVG_DAYS_PER_MONTH = 30.4375` in `dashboard/src/hooks/useSubscriptionValue.ts`). No `pricing.ts` rate is read or changed; no `backfill:costs` run is implied by this feature.

---

## 2. Window reconstruction algorithm + blended fill%

All math runs in **TypeScript on rows returned by one SQL query**, not in SQL window functions. Rationale: the greedy "session-start anchoring" is a stateful single-pass scan that is far clearer in TS than in a recursive CTE, and it keeps DuckDB read-only and bind-param-simple. This mirrors how `CostAnalyzer.getCostByProject()` (`src/queries/cost-analyzer.ts`) already pulls grouped rows and aggregates them in a JS `Map`.

### 2.1 The single source query

One query pulls every cost-bearing assistant turn in the period, ordered by time, with the model class tagged. It reuses the canonical cost-row predicate `costRowPredicateSql()` from `src/utils/sqlPredicates.ts` so the population matches the cost/activity surfaces exactly, and the standard `timestamp >= $1 AND timestamp < $2` window with `buildTurnFilters(filters, 3)` from `src/queries/filter-builder.ts` (filters start at `$3`).

```sql
SELECT
  ct.request_id,
  ct.timestamp,
  ct.role,
  (ct.input_tokens + ct.output_tokens + ct.cache_creation_tokens + ct.cache_read_tokens) AS total_tokens,
  -- Model class for the per-model weekly split (Max enforces separate caps).
  CASE
    WHEN LOWER(COALESCE(ct.model, '')) LIKE '%opus%'   THEN 'opus'
    WHEN LOWER(COALESCE(ct.model, '')) LIKE '%sonnet%' THEN 'sonnet'
    ELSE 'other'
  END AS model_class
FROM conversation_turns ct
WHERE ${costRowPredicateSql("ct")}
  AND ct.timestamp >= $1 AND ct.timestamp < $2
  ${turnFilterClauses}            -- buildTurnFilters(filters, 3); needs ct.* rewrite like cost.ts by-model
ORDER BY ct.timestamp ASC
```

> Note on aliasing: `buildTurnFilters` emits bare `model` / `session_id`. Apply the same `.replace(/\bmodel\b/, "ct.model").replace(/\bsession_id\b/, "ct.session_id")` rewrite used in `CostAnalyzer.getCostByModel()` and `dashboard/.../cost.ts` `/by-model`. The dashboard route uses `buildTurnFilterClauses` from `parseFilters.ts` identically.

### 2.2 The "prompt-like" usage unit (blended)

Per the spec, the primary unit is **model requests**:

- `requests` in a window = `COUNT(DISTINCT request_id)` over the rows in that window.
- **Fallback** when `request_id` is NULL/empty for a window's rows (older data): count of `role = 'assistant'` turns in the window. The predicate already restricts to `role = 'assistant'`, so the fallback is simply the row count.
- `tokens` in a window = `SUM(total_tokens)`.

### 2.3 Greedy session-start anchoring (shared helper)

A single pure function `reconstructWindows(rows, windowMs)` is reused for both the 5h and weekly passes:

```
sort rows by timestamp ascending           (already sorted by SQL)
windows = []
current = null
for each row r:
  if current is null OR r.timestamp >= current.anchor + windowMs:
     current = { anchor: r.timestamp, requestIds: Set(), assistantTurns: 0, tokens: 0 }
     windows.push(current)
  if r.request_id present: current.requestIds.add(r.request_id)
  current.assistantTurns += 1
  current.tokens += r.total_tokens
```

Then per window:
- `requests = requestIds.size > 0 ? requestIds.size : assistantTurns`  (the §2.2 fallback)
- `fillPct = max(requests / ceiling.requests, tokens / ceiling.tokens)`  (the **blended fill%** — either dimension can drive the signal; clamp display at a sane max but keep the raw value for thresholds)

Constants:
- `FIVE_HOUR_MS = 5 * 60 * 60 * 1000`
- `WEEK_MS = 7 * 24 * 60 * 60 * 1000`

"Session-start anchoring" = the **first request opens a window `[t, t+span)`**; every request before `t+span` accrues to it; the first request at/after `t+span` opens the next window. This is a rolling window keyed off first-activity, exactly as the 2026 limits model describes (resets N after the session's first activity, not on a fixed wall clock). Anchoring on the row timestamp (not a fixed clock) is why this is done in TS.

### 2.4 5-hour windows

Call `reconstructWindows(rows, FIVE_HOUR_MS)` with `ceiling = { requests: fiveHourRequests, tokens: fiveHourTokens }` (calibrated ceilings, §3). Compute over the resulting windows:
- `peakFill` = max fillPct
- `p95Fill` = 95th percentile fillPct (nearest-rank on the sorted fill array)
- `medianFill` = median fillPct
- `nearLimitWindows` = count of windows with `fillPct >= 0.90`
- `activeWindows` = windows.length (drives confidence)

### 2.5 Weekly windows + per-model split

Call `reconstructWindows(rows, WEEK_MS)` on the **same row set** for the all-models weekly figure, against `ceiling = { requests: weeklyRequests, tokens: weeklyTokens }`. Then, to mirror Max's separate weekly caps, **partition the rows by `model_class` and re-run the weekly reconstruction per class**:

- `all` — every row.
- `sonnet` — rows where `model_class = 'sonnet'`.
- `opus` — rows where `model_class = 'opus'`.

Each produces its own `{ peakFill, p95Fill, medianFill, nearLimitWindows, activeWindows }`. The all-models weekly `peakFill` is the primary weekly signal; the per-class peaks are reported for transparency (Max enforces all-models AND Sonnet-only weekly limits plus a separate Opus quota). Because exact per-class ceilings are not published, the per-class passes reuse the same `weeklyRequests`/`weeklyTokens` ceilings as a deliberate, documented approximation surfaced under the same estimate caveat (do not invent separate per-class numbers).

### 2.6 Active-day count (confidence input)

`activeDays` = `COUNT(DISTINCT CAST(timestamp AS DATE))` over the same population — computed in TS from the row timestamps (UTC date is sufficient here; this is a data-volume proxy for confidence, not a localized display, so no `userTimezone` projection is required). `recencyDays` = days between the most recent row's date and "now".

---

## 3. New SSOT module: tier ceilings + auto-calibration

### 3.1 Module path and exports

New file: **`src/config/limits.ts`** — the single source of truth for tier ceilings, modeled on the structure and doc-comment style of `src/config/subscription.ts`.

```ts
// src/config/limits.ts
import type { SubscriptionTier } from "../types/config.js";

/** Estimated rate-limit ceilings for one tier. ALL VALUES ARE ESTIMATES. */
export interface TierLimitCeilings {
  fiveHourRequests: number;
  fiveHourTokens: number;
  weeklyRequests: number;
  weeklyTokens: number;
}

/**
 * Avg blended tokens per model request — used to derive token ceilings from
 * request ceilings. Grounded in the live dataset's per-request token mix
 * (input+output+cache_creation+cache_read). Documented ESTIMATE.
 */
export const AVG_TOKENS_PER_REQUEST = 35_000;

/** Caveat string shown on EVERY recommendation surface (CLI/API/UI). */
export const RECOMMENDATION_ESTIMATE_CAVEAT =
  "Estimate from local session data; Anthropic's exact limits are not published.";

/**
 * Default per-tier ceilings. ESTIMATES grounded in 2026 research:
 *   Pro     ≈ 45 prompts / 5h
 *   Max 5x  ≈ 225 prompts / 5h   (5×)
 *   Max 20x ≈ 900 prompts / 5h   (20×)
 * Token ceilings = requests × AVG_TOKENS_PER_REQUEST.
 * Weekly requests ≈ fiveHourRequests × ~25 active 5h windows/week (heuristic).
 */
export const DEFAULT_TIER_LIMITS: Record<SubscriptionTier, TierLimitCeilings> = {
  none:    { fiveHourRequests: 0,   fiveHourTokens: 0,           weeklyRequests: 0,     weeklyTokens: 0 },
  pro:     { fiveHourRequests: 45,  fiveHourTokens: 45 * 35_000,  weeklyRequests: 1_125, weeklyTokens: 1_125 * 35_000 },
  "max-5x":  { fiveHourRequests: 225, fiveHourTokens: 225 * 35_000, weeklyRequests: 5_625, weeklyTokens: 5_625 * 35_000 },
  "max-20x": { fiveHourRequests: 900, fiveHourTokens: 900 * 35_000, weeklyRequests: 22_500, weeklyTokens: 22_500 * 35_000 },
};

/** Ordered tiers for up/downgrade neighbour lookup (excludes "none"). */
export const PAID_TIER_ORDER: SubscriptionTier[] = ["pro", "max-5x", "max-20x"];
```

> `none` ceilings are zero/sentinel: tier `none` is API pay-as-you-go and gets the neutral "no recommendation, just stats" treatment (§5), so its ceilings are never used for a fill% denominator (guard divide-by-zero → fill 0).

### 3.2 Mirror into the dashboard (do not silently duplicate)

The React side cannot import CLI source for runtime values (confirmed: `dashboard/src/lib/types.ts` mirrors `SUBSCRIPTION_TIERS` manually with a comment pointing back to `src/config/subscription.ts`; the dashboard build does not import CLI source for types). The **server** routes, however, import directly across the tree (e.g. `dashboard/src/server/routes/cost.ts` imports `buildRateCaseSql` from `../../../../src/utils/pricing.js`; `settings.ts` imports from `../../../../src/config/subscription.js`).

Therefore:
- **Server (`recommendation.ts`)**: import `DEFAULT_TIER_LIMITS`, `AVG_TOKENS_PER_REQUEST`, `RECOMMENDATION_ESTIMATE_CAVEAT`, `PAID_TIER_ORDER` from `../../../../src/config/limits.js`. No duplication.
- **React (`dashboard/src/lib/types.ts`)**: mirror only the **types** the UI renders (`TierLimitCeilings`, the recommendation payload type), with a comment `// Mirrors src/config/limits.ts — kept in sync manually (dashboard build does not import CLI source for types).` — identical pattern to the existing `SubscriptionTier` mirror. All numeric ceilings reach the UI **through the API payload**, never hard-coded in React.

### 3.3 Auto-calibration rule (opt-in, default ON)

After window reconstruction with **default** ceilings, if `autoCalibrate` is on:

- For each ceiling dimension, if the observed peak (the max raw `requests` across 5h windows, and the max raw `tokens`) exceeds the default ceiling, raise that ceiling to **at least** the observed peak:
  `calibrated.fiveHourRequests = max(default.fiveHourRequests, observedPeak5hRequests)` (and likewise for tokens, and for the weekly dimensions using observed weekly peaks).
- The analyzer then **re-computes fill% against the calibrated ceilings** so a user who blows past the published estimate is not pinned at a meaningless ">100%".
- The payload reports both the `default` and `calibrated` ceilings plus a per-dimension `calibrated: boolean` flag and a top-level `ceilingSource: "default" | "calibrated"` so every surface can show "calibrated" vs "default".

When `autoCalibrate` is off, ceilings = `DEFAULT_TIER_LIMITS[tier]` verbatim and `ceilingSource = "default"`.

---

## 4. Config schema additions + non-clobbering persistence

### 4.1 Type additions (`src/types/config.ts`)

Add a new optional block to `CCAnalyticsConfig`, alongside `subscription` and `display`:

```ts
/** Editable rate-limit ceilings + recommendation behaviour. All ESTIMATES. */
export interface RecommendationConfig {
  /** Opt-in auto-calibration of ceilings to observed peaks. Default: true. */
  autoCalibrate: boolean;
  /**
   * Per-tier ceiling overrides. Sparse: any tier/dimension omitted falls back
   * to DEFAULT_TIER_LIMITS in src/config/limits.ts. Never stored fully unless
   * the user edits it.
   */
  ceilings?: Partial<Record<SubscriptionTier, Partial<TierLimitCeilings>>>;
}

// in CCAnalyticsConfig:
/** Subscription-recommendation ceilings + auto-calibrate toggle. */
recommendation?: RecommendationConfig;
```

Import `TierLimitCeilings` from `../config/limits.js` (types only).

### 4.2 Default (`src/config/defaults.ts`)

Extend `DEFAULT_CONFIG` with:

```ts
recommendation: {
  autoCalibrate: true,
  // ceilings omitted → DEFAULT_TIER_LIMITS is the effective default.
},
```

### 4.3 Persistence through the settings route (no clobbering)

`dashboard/src/server/routes/settings.ts` is the **only** write path. Today its PUT does a deliberate shallow merge that preserves untouched top-level keys:

```ts
const merged: Record<string, unknown> = { ...existing };
if (nextSubscription) merged.subscription = nextSubscription;
if (nextDisplay) merged.display = nextDisplay;
await fs.writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf-8");
```

Extend this **in the same style** — add a third optional key, validate it independently, and merge it only when present:

1. Accept `recommendation?` in the typed `body`. The "at least one key present" guard becomes: reject 400 only if **all three** (`subscription`, `display`, `recommendation`) are `undefined`.
2. Add `resolveRecommendation(config)` mirroring `resolveSubscription` / `resolveDisplay`: fall back to `{ autoCalibrate: true }` when absent/malformed; coerce `autoCalibrate` to a boolean; sanitize `ceilings` so only known `SubscriptionTier` keys and the four numeric `TierLimitCeilings` fields survive (drop NaN/negative/non-finite). This guards the only write path against garbage exactly as the timezone gate does.
3. In PUT, build `nextRecommendation` only when `incomingRecommendation !== undefined`, validating with the same approach (reject non-object with 400; sanitize numeric fields server-side).
4. `if (nextRecommendation) merged.recommendation = nextRecommendation;` — same one-line merge, so `dbPath` / `ingestion` / `watcher` / `database` / `subscription` / `display` are never clobbered.
5. GET `/api/settings` returns `{ subscription, display, recommendation }` (add the third key to both the GET and PUT `envelope(...)` payloads).

`GET /api/recommendation` (§6) reads the effective `recommendation` block via a small shared resolver (the analyzer is handed the resolved `autoCalibrate` + merged ceilings; it never reads the file itself, keeping it pure and unit-testable).

> Effective ceilings = `DEFAULT_TIER_LIMITS[tier]` deep-merged with `config.recommendation.ceilings?.[tier]` (per-dimension override). This merge lives in `src/config/limits.ts` as `resolveCeilings(tier, overrides?)` so CLI and API share it.

---

## 5. Recommendation logic + confidence

Implemented as a **pure function** `recommend(input): Recommendation` in the core (`src/recommendation/engine.ts`, §6) so it is trivially unit-testable with no DB. Inputs: current `tier`, the 5h window stats, the all-models weekly stats, the calibrated ceilings, `DEFAULT_MONTHLY_USD` (from `src/config/subscription.ts`), and `{ activeDays, activeWindows, recencyDays }`.

### 5.1 Tier neighbours

Using `PAID_TIER_ORDER = ["pro", "max-5x", "max-20x"]`:
- `tierUp` = next tier up (or null at `max-20x`).
- `tierDown` = next tier down (or null at `pro`).
- `tier === "none"` → **neutral**: `verdict = "neutral"`, no up/downgrade, payload still carries window stats so the UI can show them. (Spec: API pay-as-you-go is neutral.)

### 5.2 Thresholds (exact)

Define named constants in the engine:

```
NEAR_LIMIT_FILL          = 0.90   // a window is "near-limit" at ≥90% fill
UPGRADE_NEAR_LIMIT_SHARE = 0.15   // ≥15% of active 5h windows near-limit ⇒ upgrade lean
UPGRADE_WEEKLY_PEAK      = 0.90   // OR weekly peak fill ≥90% ⇒ upgrade lean
DOWNGRADE_FILL           = 0.70   // both 5h & weekly peak < 70% of tier-DOWN ceiling ⇒ downgrade lean
```

Let `nearLimitShare = nearLimitWindows5h / max(activeWindows5h, 1)`.

- **UPGRADE lean** (only if `tierUp` exists): `nearLimitShare >= UPGRADE_NEAR_LIMIT_SHARE` **OR** `weekly.peakFill >= UPGRADE_WEEKLY_PEAK`.
  Quantify: `extraMonthlyUSD = DEFAULT_MONTHLY_USD[tierUp] - DEFAULT_MONTHLY_USD[tier]`.
- **DOWNGRADE lean** (only if `tierDown` exists): re-express the user's observed **peak raw usage** against the **tier-DOWN** ceilings and require comfortable headroom on **both** windows:
  `fiveHourPeakVsDown = max(peak5hRequests / down.fiveHourRequests, peak5hTokens / down.fiveHourTokens)` and `weeklyPeakVsDown` similarly; downgrade only if **both** `< DOWNGRADE_FILL`.
  Quantify: `savedMonthlyUSD = DEFAULT_MONTHLY_USD[tier] - DEFAULT_MONTHLY_USD[tierDown]`.
- **STAY**: anything in the healthy band between the two (and the default when a neighbour is missing — e.g. already at `max-20x` with high usage stays; already at `pro` with low usage stays).
- Precedence: evaluate **UPGRADE first**, then DOWNGRADE, else STAY. (A user can't be both near-limit and have comfortable downgrade headroom, but checking upgrade first makes the "at limit" signal win any edge case.)

### 5.3 Confidence (low / medium / high)

Two axes, combined to the **lower** of the two:

**Data-volume axis** (sparse data ⇒ low):
- `high` if `activeDays >= 14` AND `activeWindows5h >= 20` AND `recencyDays <= 3`
- `medium` if `activeDays >= 5` AND `activeWindows5h >= 6`
- else `low`

**Margin axis** (how far the deciding metric is from its threshold):
- For an UPGRADE/DOWNGRADE verdict, `margin = abs(decidingMetric - threshold)`. `high` if `margin >= 0.15`, `medium` if `>= 0.05`, else `low`. For STAY, margin = distance to the *nearer* of the two thresholds.

`confidence = min(volumeConfidence, marginConfidence)` (ordering low < medium < high). Low confidence ⇒ the human-readable message uses **softer wording** ("Your data is sparse — this is a weak signal; consider re-checking after more usage.") The engine returns both `confidence` and a `confidenceReason` string.

### 5.4 Output shape

```ts
type Verdict = "upgrade" | "downgrade" | "stay" | "neutral";

interface Recommendation {
  verdict: Verdict;
  currentTier: SubscriptionTier;
  suggestedTier: SubscriptionTier | null;       // null for stay/neutral
  monthlyDeltaUSD: number;                        // +extra for upgrade, −saved for downgrade, 0 otherwise
  confidence: "low" | "medium" | "high";
  confidenceReason: string;
  headline: string;                               // e.g. "Consider upgrading to MAX 20x"
  detail: string;                                 // one-paragraph rationale, soft when low-confidence
  caveat: string;                                 // RECOMMENDATION_ESTIMATE_CAVEAT
}
```

The dollar framing reuses the existing ROI/savings language (`formatCost`, the "$X saved" / "$X extra" phrasing already in `SubscriptionValueBand.tsx` / `SubscriptionValueSection.tsx`).

---

## 6. File-by-file change list

### New — core analysis (`src/`)
- **`src/config/limits.ts`** *(new)* — SSOT ceilings, `AVG_TOKENS_PER_REQUEST`, `RECOMMENDATION_ESTIMATE_CAVEAT`, `PAID_TIER_ORDER`, `resolveCeilings()`. (§3)
- **`src/recommendation/windows.ts`** *(new)* — `reconstructWindows(rows, windowMs)` greedy anchoring + percentile/median/near-limit helpers (pure, no DB). (§2.3–2.6)
- **`src/recommendation/engine.ts`** *(new)* — `recommend(input): Recommendation`, the threshold + confidence logic (pure, no DB). (§5)
- **`src/queries/recommendation-analyzer.ts`** *(new)* — `RecommendationAnalyzer` class taking a `QueryExecutor` (constructor pattern identical to `CostAnalyzer`/`SessionAnalyzer`). Runs the §2.1 query, calls `reconstructWindows` for 5h + weekly + per-class, applies auto-calibration (§3.3), then `recommend()`. Returns the full structured analysis (`{ windowStats5h, weeklyStats, perModelWeekly, ceilings: {default, calibrated}, ceilingSource, recommendation, activeDays, recencyDays, caveat }`).
- **`src/queries/index.ts`** *(modified)* — add `export { RecommendationAnalyzer } from "./recommendation-analyzer.js";`.

### Modified — config (`src/`)
- **`src/types/config.ts`** *(modified)* — add `RecommendationConfig` interface + optional `recommendation?` on `CCAnalyticsConfig`. (§4.1)
- **`src/config/defaults.ts`** *(modified)* — add `recommendation: { autoCalibrate: true }` to `DEFAULT_CONFIG`. (§4.2)

### New + modified — CLI (`src/`)
- **`src/commands/recommend.ts`** *(new)* — `registerRecommendCommand(parent)`. Mirrors `src/commands/status.ts` (lazy dynamic imports, config load with global overrides) and `src/commands/query.ts` (period parsing via `parsePeriod`, `OutputFormatter.auto(rows, columns, format)` for `--format table|json|csv`). Options: `--period today|7d|30d|90d|all` (default `30d`); honors global `--format`. Output: current tier; 5h peak/typical (median) fill; weekly fill incl. per-model; verdict + confidence + `$` delta; the estimate caveat. For `json` format, print the full structured analysis object; for `table`/`csv`, print a small labelled rows table.
- **`src/cli.ts`** *(modified)* — `import { registerRecommendCommand } from "./commands/recommend.js";` and call `registerRecommendCommand(program);` in `createProgram()` next to the other `register*Command(program)` calls.

### New + modified — API (`dashboard/src/server/`)
- **`dashboard/src/server/routes/recommendation.ts`** *(new)* — read-only `GET /` route. Uses `parseFilters(req)` + `buildTurnFilterClauses(filters, 3)` + `costRowPredicateSql` + `wrapTimestampForTz` imports exactly like `cost.ts`. Reads the effective `recommendation` config block (shared resolver, §4.3) to get `autoCalibrate` + merged ceilings, runs the same window reconstruction + `recommend()` logic the analyzer uses (import the pure `windows.ts`/`engine.ts`/`limits.ts` from `../../../../src/...`, the established cross-tree import precedent), and returns `envelope(analysis, filters.period)`. **Read-only** — no writes.
- **`dashboard/src/server/index.ts`** *(modified)* — `import recommendationRoutes from "./routes/recommendation.js";` and `app.use("/api/recommendation", recommendationRoutes);` next to the other `app.use("/api/...")` mounts; add the endpoint to the startup `console.log` list.

### Modified — Dashboard UI (`dashboard/src/`)
- **`dashboard/src/hooks/useRecommendation.ts`** *(new)* — TanStack Query hook (`useQuery`, `queryKey: ["recommendation", period]`, `queryFn: apiGet("/recommendation?period=…")`, `select: res => res.data`), period-aware via `useFilters()`, modeled on `useSubscriptionValue.ts` + `useSettings.ts`.
- **`dashboard/src/lib/types.ts`** *(modified)* — mirror the recommendation payload types + `TierLimitCeilings` with the "kept in sync manually" comment (§3.2). Add a `recommendation?` field to the `SettingsData`/`SubscriptionSettings` mirror so the Settings controls can read it.
- **`dashboard/src/hooks/useSettings.ts`** *(modified)* — extend `UpdateSettingsBody` with `recommendation?: { autoCalibrate?: boolean; ceilings?: ... }`; on success, when `variables.recommendation` is present, `invalidateQueries({ queryKey: ["recommendation"] })` (recommendation depends on ceilings/autoCalibrate). Add `recommendation` to the `SettingsData` interface.
- **`dashboard/src/components/ui/SubscriptionValueSection.tsx`** *(modified)* — add a recommendation **card/band** below the existing ROI card, consuming `useRecommendation()`. Reuse `ChartCard`/`KPICard`/`SectionHeader` and the existing visual tokens (no new design system). Show verdict headline, confidence pill, the `$` delta, the per-model weekly breakdown, and the estimate caveat as caption text. Render the neutral variant (stats only, no verdict) when `verdict === "neutral"`.
- **`dashboard/src/components/ui/SubscriptionValueBand.tsx`** *(optional, modified)* — optionally surface a compact one-line verdict chip in the Overview hero band (same `useRecommendation()` hook). Keep it small; reuse existing `BandStat`/tone styling. (Lower priority than the Section card.)
- **`dashboard/src/pages/SettingsPage.tsx`** *(modified)* — add a new `RecommendationSection` (mirroring `SubscriptionSection`/`TimezoneSection`): an `autoCalibrate` toggle and optional per-tier ceiling number inputs, saved via `useUpdateSettings().mutate({ recommendation: {...} })`. Honest "estimate" copy in the subtitle. Mount it next to `<SubscriptionSection />`.

### New — tests (`tests/`) — see §7.

---

## 7. Test plan (Vitest, 80% line coverage, config + DB isolation)

The repo enforces **80% line coverage** (`npm run test:coverage`). Lint is `npm run lint` (`tsc --noEmit`); build is `npm run build` + `npm run build:dashboard`. The live DB `~/.ccanalytics/analytics.duckdb` is **locked by the `com.ccanalytics.web` LaunchAgent** — all tests use temp fixture DBs, never the live DB.

### 7.1 Pure-unit tests (no DB) — the bulk of coverage
- **`tests/recommendation/windows.test.ts`** — `reconstructWindows`:
  - first request opens a window; a request at exactly `t+span` opens the next (boundary).
  - blended fill = `max(requests/ceil, tokens/ceil)` — assert tokens dimension can drive it even when requests are low.
  - `request_id`-NULL fallback uses assistant-turn count.
  - percentile/median/near-limit (`>=0.90`) counts on a hand-built fill array.
- **`tests/recommendation/engine.test.ts`** — `recommend()`:
  - UPGRADE when `nearLimitShare >= 0.15`; UPGRADE when `weekly.peakFill >= 0.90`; `monthlyDeltaUSD` equals the real tier price gap from `DEFAULT_MONTHLY_USD`.
  - DOWNGRADE only when **both** 5h & weekly peak `< 0.70` of the tier-DOWN ceiling; `savedMonthlyUSD` correct.
  - STAY in the healthy band; `tier === "none"` → `neutral` with no suggestion.
  - confidence = `min(volume, margin)`; sparse data ⇒ `low` + softened `detail`; verify `caveat === RECOMMENDATION_ESTIMATE_CAVEAT`.
  - `tierUp`/`tierDown` null-guards at the `max-20x` / `pro` ends.
- **`tests/config/limits.test.ts`** — `resolveCeilings()` deep-merges per-dimension overrides over `DEFAULT_TIER_LIMITS`; auto-calibration raises a ceiling to the observed peak; `none` yields zero ceilings (no divide-by-zero downstream).

### 7.2 Analyzer integration test (temp DuckDB) — mirror `tests/queries/cost-analyzer.test.ts`
- **`tests/queries/recommendation-analyzer.test.ts`** — uses `createTestDB` / `seedTestData` / `closeTestDB` from `tests/helpers/db-setup.js` and a `QueryExecutor` exactly like `cache-analyzer.test.ts`. Seed turns clustered to produce a known number of 5h windows and a near-limit window; assert `windowStats5h.peakFill`, `nearLimitWindows`, weekly per-model split, `ceilingSource` flips to `"calibrated"` when a seeded burst exceeds the default ceiling, and the final `verdict`. Include an empty-range case returning a `neutral`/`stay` zero-window result without throwing.

### 7.3 Route integration test (temp DuckDB + isolated config) — mirror `tests/server/activity-route.test.ts`
- **`tests/server/recommendation-route.test.ts`** — copy the `activity-route.test.ts` isolation harness exactly:
  - `process.env.DB_PATH = <temp>.duckdb` **before** dynamically importing `dashboard/src/server/routes/recommendation.js` and `helpers/db.js` (the helper caches its connection on first call).
  - `process.env.CCANALYTICS_CONFIG_PATH = path.join(tmpDir, "config.json")` so the route never reads the dev machine's `~/.ccanalytics/config.json` (the LaunchAgent reads the live one). Save/restore both env vars in `beforeAll`/`afterAll` and `closeDb()` + `rmSync(tmpDir)` on teardown — identical to the activity test.
  - Seed `sessions` + `conversation_turns` via `dbHelper.query(...)` (tz-naive timestamps, strip trailing `Z` as that test does).
  - Assert: `GET /api/recommendation?period=all` returns 200 with `data.recommendation.verdict`, `data.caveat === RECOMMENDATION_ESTIMATE_CAVEAT`, the window stats, and per-model weekly keys.
  - Write a temp `config.json` with `recommendation.autoCalibrate=false` and assert `ceilingSource === "default"`; flip to `true` (or omit) and assert calibration kicks in on a high-usage fixture.
  - Param-index regression: `?period=7d&model=…&project=…` + `X-User-Timezone` header executes without a SQL `$N` error (the same guard the activity test asserts).
- **`tests/server/settings-route.test.ts`** *(extend existing)* — add cases proving PUT `recommendation` round-trips, that sending only `recommendation` preserves `subscription`/`display` on disk (read the temp file back and assert the other keys survive — the non-clobbering guarantee), and that a malformed `recommendation` body is rejected 400.

### 7.4 Command + e2e
- **`tests/commands/recommend.test.ts`** *(new, if a command-test harness exists; otherwise fold into the CLI e2e)* — invoke the built CLI against a temp DB (`--db <temp>`) for each `--format table|json|csv`, asserting the JSON form contains `verdict`/`confidence`/`caveat` and the table form prints the tier + fill rows. Reuse whatever spawn/exec pattern the existing CLI tests use.
- Coverage: the pure-unit suites (§7.1) carry most of the 80% line target cheaply because `windows.ts`/`engine.ts`/`limits.ts` are DB-free; the integration + route tests cover the analyzer SQL and the route wiring. Run `npm run test:coverage` before opening the PR and backfill any uncovered branch in the engine's threshold ladder.

---

## 8. Architecture-constraint checklist (must all hold)

- [ ] Per-model rates stay only in `src/utils/pricing.ts`; tier prices stay only in `src/config/subscription.ts`. This feature reads tier prices, computes nothing into `cost_usd`. No `backfill:costs` needed.
- [ ] Ceilings live only in `src/config/limits.ts`; the dashboard server imports them; React mirrors only **types** (numbers arrive via the API payload).
- [ ] `GET /api/recommendation` is **read-only**. The settings route remains the only write path; the `recommendation` block is merged with the same shallow, non-clobbering merge as `subscription`/`display`.
- [ ] All tests use temp fixture DBs and isolate config via `CCANALYTICS_CONFIG_PATH`; never touch the LaunchAgent-locked live DB.
- [ ] `npm run lint`, `npm run build`, `npm run build:dashboard`, and `npm run test:coverage` (≥80% lines) all pass.
- [ ] No new design system — UI reuses `ChartCard`/`KPICard`/`SectionHeader`/`BandStat` and existing CSS tokens.
- [ ] Every recommendation surface shows `RECOMMENDATION_ESTIMATE_CAVEAT`.
