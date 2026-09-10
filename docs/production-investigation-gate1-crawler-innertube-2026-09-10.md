# Production investigation — Gate 1 / dashboard, Discord crawler budgets, YouTube.js provider (2026-09-10)

Read-only investigation (SELECT-only via `oom_investigator_ro`). No code, config, or production changes made.
Follow-up to merged PR #459 (`78bc0dd`), which cannot be reopened once merged — opened as a new PR for review.

## A. Gate 1 / excluded-country channels reaching the dashboard

### Production flow

`discovery → processChannelThroughPipeline → Gate 1 (validateChannelCountry; halt on REJECT_EXCLUDED/REJECTED) → persistence → dashboard` via `server.ts:279 listChannelsPage → dbCore.channelListingWhere → buildChannelListingWhere`.

### Findings (production evidence)

- Production has **9,482 channels, 199 REJECTED** (115 of them `TRADING_CONFIRMED` — Gate 1 preserves trading state by design since PR #459).
- **All 199 REJECTED rows carry a REJECTED `COUNTRY_VALIDATION` trail step; zero without one.** Gate 1 validation is applied everywhere — no bypass for row creation.
- Attribution by latest rejected validation step: **164 startup exclusion audit** (`Database Country Exclusion Audit`), **25 queue live-revalidation** (`— Live About`), **10 ingestion Gate 1**. Rejection timestamps cluster on audit runs (102 on 08-26, 42 on 08-23; 6 on merge day 09-10), decisions `REJECT_EXCLUDED` at scores 86–100.
- Related population: **70 rows store an excluded-list country (29 live exclusions incl. Vietnam/Uganda/Zambia/Zimbabwe) without REJECTED status** (60 LIKELY @68–78, 10 UNCERTAIN, first-seen mostly Sep 6–9). These passed *through* Gate 1 correctly — the hard gate requires conclusive evidence.

### Why rejected channels appear in the dashboard (root cause)

The listing query never applies the operator-visible predicate in the default view: `buildChannelListingWhere` (`server/dbCore.ts:367`) starts clauses with `'TRUE'`; `OPERATOR_VISIBLE_CHANNEL_SQL` is used only *negated* for the diagnostics view, and `resolveChannelListingServingScope` (the function that would apply it) is **dead code — zero callers**. The frontend default view is labeled "(all persisted channels)" with a "REJECTED (Hard Gate)" filter option; aggregates (`COUNT(*) stored_channels`) include rejected rows too. This predates PR #459 (logic dates to ≥Aug 24) — a read-path/query mismatch, not a Gate-1 regression. The code contradicts its own contracts (`server.ts:274` "returns active validated channels by default"; `OPERATOR_VISIBLE_CHANNEL_SQL` documented as the anchored policy).

### Skipped Gate 1 test

`tests/countryPersistenceAndProjection.test.ts` ("Pipeline halts immediately on REJECT_EXCLUDED"): all DB assertions sit inside `if (process.env.DATABASE_URL)`, so it passes vacuously without a DB and does **not** explain the behavior (it doesn't cover listing at all). The sharper gap: `server/dashboardDiagnosticsPolicy.test.ts` guards the dead `resolveChannelListingServingScope`, giving false confidence while the real `buildChannelListingWhere` path has no test asserting the default view excludes REJECTED. PR #459's `gate1CountryRejectionPersistence.test.ts` is present in merged `main`, unskipped, unrelated.

### Recommendation

Decide whether all-rows-default is intended (UI labels suggest possibly accepted) or a bug (code contracts say bug). If rejected rows should be hidden by default, apply the serving predicate positively in `buildChannelListingWhere` plus a pinning test. Do not remove the diagnostics view.

## B. Discord crawler budgets vs production data

### Dataset

`external_acquisition_observations`, **747,203 rows, 2026-08-10 → 2026-09-10 (31 days)**. Rendered unit = one observation row ≈ one seed-crawl (code emits exactly one rendered observation per escalated seed). Rendered population: **181,022 crawls**. Caveat: scroll usage is **not recorded anywhere** (counted in code, never persisted; zero detail texts mention scrolls) — the scroll-limit question has no production answer.

### Discovery-depth distribution (rendered, n=181,022)

0 pages 150,301 (83.0%) · 1: 23,905 · 2: 1,786 · 3: 1,119 · 4: 618 · 5: 829 · **6: 1,552 (0.86%)** · ≥7: ~25 (<0.02%, likely retried pages double-counted). Outcomes: NO_MATCH 57.6%, FAILED 40.3%, PARTIAL 1.0%, **FOUND 1.0% (1,813)**. FOUND by pages — 1:1,084 (59.8% seed-direct) · 2:213 · 3:106 · 4:75 · 5:24 · **6:304 (16.8%)** · 7+: 6.

### Limit-hit rates

- **Page budget:** only **877 non-timed-out crawls (0.48%)** inspected a full 6 pages without finding Discord; **519 (0.29%)** additionally saturated clicks on all 6 pages (24 clicks; e.g. `yelza.com/nl`, `n1cm.com/?ib=200070` — broker/affiliate sites).
- **Time budget dominates:** **30.3% hit the 60s total timeout** (`budgetExhausted` ⟺ timed-out in code); 83% inspect zero pages, led by browser-infra failures (LAUNCH_FAILED 25,072; PERMISSION_DENIED 10,813; NO_PAGE_PROCESSED 26,215; only 192 `RENDERED_BUDGET_EXPIRED`).
- **Clicks:** 88.7% start zero clicks; 8.1% have a failed click; 7.6% reach ≥4 clicks started.
- **Enqueue filter, not page budget, ends 13.7% of crawls:** 24,833 completed with 1–5 pages and no find — queue emptied because only `COMMUNITY_HINTS`-matching same-host URLs are enqueued (`/blog`, `/resources`-style pages unreachable at any `maxPages`). Static corroborates (at its 9-page bound, 99.9% report links remaining beyond depth 2).
- Discovery is website-led: `discord_candidates` by source — CREATOR_WEBSITES 2,188 (802 selected), VIDEO_DESCRIPTIONS 526, CHANNEL_LINKS 285, SOCIAL 179.

### Cost and recommendation

Per-page marginal cost is code-bounded (≤15s nav timeout + ≤5×~0.5s scrolls + ≤4×(2s click + 0.4s)), already capped by the 60s total timeout; HTML snapshots are released immediately (OOM fix). Raising 6→10 would spend meaningfully only on the 0.48% non-timed-out full-budget crawls, most of which would then hit the 60s cap. **Recommendation: keep `maxPages=6`** (16.8% of rendered finds needed page 6 — do not lower it). For recall, redesign targeting (enqueue policy, browser reliability, timeout budget), not the page cap. Consider persisting `scrolls` to close the blind spot.

## C. YouTube.js / InnerTube production verification

- **Traffic: yes** — 26 `youtube-innertube` runs Sep 9 18:41 UTC → Sep 10 (registry ACTIVE since Sep 9 18:21 UTC via migration-130). **14 CHANNEL (349 raw) + 12 VIDEO (539 raw)** across BE/LU/DE/CH/SE/UK/NL/FR/US; up to 60 raw/run, quality_channels up to 24.
- **Real results downstream:** ~888 raw total, **117 distinct channels first-seen via innertube**, 60 sightings on top runs; unique/quality channel counts confirm pipeline ingestion.
- **Continuation works:** page observations show pages 1–3 per run (e.g. 20+20+20 with 7+3+3 creators).
- **No silent fallback:** `queueManager.ts:570` explicitly uses `[]` on empty innertube results (no official-API spend); empty runs show no compensating official calls.
- **Rates unmeasurable:** zero `provider_call_events` rows for `youtube-innertube` (vs 112,307 run-linked official `youtube` search events), so success/failure/timeout/cooldown rates cannot be computed; run-level counters are all zero. Run-level proxy: 21 COMPLETED / 4 RUNNING (jobs actively progressing, one routine stale-lock recovery) / 1 SCHEDULED, zero run errors. Pacing (30s timeout / 90s cooldown / 500ms interval) is in-memory only — no production telemetry.
- **Quota clean:** `quota_used=0`, `provider_cost_usd=0` on all 26 runs; provider imports only `youtubei.js`; official quota consumes normally (4,385/300,000 today; 5,165 official search events/48h).
- **Problems:** (1) the empty ledger is itself the finding — run-outcome math and lineage metrics read the absent events, so innertube runs are systematically misreported; likely `emit(...).catch(() => undefined)` swallowing write failures (emit wiring merged 10:29 UTC Sep 9, runs began 18:41 — deploy logs would confirm). Recommend logging emit failures instead of swallowing. (2) 97,304 `youtube_js` events (Aug 12–13 only) are a prior experiment label with no current code — unrelated, do not conflate. (3) No innertube-specific stuck-job pathology.
