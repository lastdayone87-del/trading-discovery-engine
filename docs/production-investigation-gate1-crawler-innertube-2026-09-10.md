# Production investigation — Gate 1 / dashboard, Discord crawler budgets, YouTube.js provider (2026-09-10)

Read-only investigation (SELECT-only via `oom_investigator_ro`). No code, config, or production changes made.
Follow-up to merged PR #459 (`78bc0dd`), which cannot be reopened once merged — opened as a new PR for review.
Final evidence pass completed 2026-09-10 ~15:50 UTC; addenda marked [FINAL PASS] below.

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

### [FINAL PASS] Direct verification (merged `main` @ `78bc0dd`, prod data ~15:50 UTC)

- **Exact default-listing path re-verified on merged main:** `server.ts:279` → `listChannelsPage` → `channelListingWhere` → `buildChannelListingWhere` (`server/dbCore.ts:372`, still `clauses=[diagnosticsOnly ? NOT(predicate) : 'TRUE']`). `resolveChannelListingServingScope` still has zero production callers (only its own policy test references it).
- **Direct quantification with the exact WHERE clauses:** **191 of 202 REJECTED rows pass the default listing filter** (TRUE + low-audience exclusion); **0 rows pass the operator-visible predicate** (202 REJECTED total at check time; channels table 9,501).
- **Gate 1 working post-merge:** Sep-10 rejections stamped after the merge, e.g. `Country Validation (South Africa/Nigeria/Vietnam/India)` at 14:45–15:37 UTC plus audit rejections at 05:07 UTC. Spot check: Canada-stored row `UCY3RWV4…` rejected by the audit for *detected India* (P0 `EXCLUSION_POLICY`, 92/100, `REJECT_EXCLUDED`) — correct behavior; the audit title carries the stale stored country, not the decision.
- **Skipped-test verdict:** unrelated to the observed behavior. `tests/countryPersistenceAndProjection.test.ts` never covers listing, and the listing-behavior test that exists guards dead code. Neither explains dashboard visibility; the `'TRUE'` default does.
- **Exact change spec (not implemented):** in `buildChannelListingWhere`, apply `defaultServing.predicate` positively when `!diagnosticsOnly` (i.e. `clauses=[diagnosticsOnly ? NOT(p) : (p)]`, keeping the `includeRejected` all-channel escape hatch semantics as a product decision), add a regression test asserting the default view excludes a REJECTED fixture while `diagnostics_only=true` still returns it, and correct the stale `server.ts:274` comment. Diagnostics endpoint, recovery, and Gate 1 untouched.

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

### [FINAL PASS] Telemetry-trace resolution (prod data ~15:50 UTC)

- **Emit site:** `executeInnertubeRetrievalPage` (`youtubeInnertubeProvider.ts:611/627`) emits on both success and failure via `emit()` → `appendProviderCallEvent`, each call trailed by `.catch(() => undefined)`. The INSERT has no provider whitelist and all CHECK constraints are satisfiable for these events, so a reached write should persist.
- **Not written elsewhere:** `provider_request_ledger` holds only 3 old brave rows (innertube reserves nothing by design — expected absence); `provider_budget_ledger` a single Aug-21 brave row; `query_execution_logs` for innertube runs contain only completion lines; `job_attempts` for innertube jobs show 60 COMPLETED vs 7 FAILED, all 7 being routine "Worker heartbeat expired; job recovered for retry" — zero provider error strings anywhere.
- **Deploy evidence:** registry row ACTIVE since Sep 9 18:21:54 UTC (migration-130); PR #457 merged 18:19 UTC including the emit wiring (added 10:29 UTC); first runs 18:41 UTC. The deployed build should therefore contain the emit calls, yet ~60+ expected events over 26 runs / 2 days are all absent.
- **Verdict:** observability bug, not silent provider bypass — retrieval demonstrably executes (page observations, sightings, downstream channels). Most likely the write fails at runtime and is swallowed; the exact error is unrecoverable from read-only DB access (needs Railway runtime logs or making emit failures visible). Not fully excludable: a process running a build where dispatch works but emit never fires — no build-version marker exists in production data to fingerprint it.
- **Impact confirmed:** success/failure/timeout/pacing/cooldown rates unmeasurable; run-level `provider_*` counters zeroed; lineage misclassifies these runs; the `queueManager` innertube outcome branch always reads zeros. Corroborating code fact: `resolveInnertubeRunOutcome` already repairs `rawResults > 0 with zero ledger successes` to `SUCCESS_NON_EMPTY` — the codebase anticipates exactly this condition, which is why traffic flows correctly despite the missing telemetry.
- **Quota re-confirmed:** still zero on all runs; no official spend attributable to the path.

## D. Follow-up: same-host enqueue, funnel, extraction, prioritization, timeout, retry, page-type, reproducibility (2026-09-10 ~16:30 UTC, same 31-day window)

### D1. Exact enqueue rules (code, `server/inspector.ts` static + `server/browserCommunityFallback.ts` rendered)

Static per discovered link: (1) direct Discord invite in href/label → captured immediately, never enqueued; (2) must be http/https; (3) same-origin, else must be on the 10-host `CROSS_DOMAIN_COMMUNITY_HOSTS` allowlist (linktr.ee, beacons.ai, bio.link, solo.to, campsite.bio, lnk.bio, skool.com, whop.com, circle.so, patreon.com + www variants); (4) `communityNavigationScore > 0` over path+query+label against 17 hints (discord=100, community/join=50, others=10: chat, member, membership, vip, group, private, trading-room, trading-floor, room, links, resources, social, contact, about) — score 0 means dropped, never queued; (5) dedup by URL; (6) first-navigation queue capped at 12 by score (>12 → exhausted); (7) BFS cap `explored < 8` fetches; (8) depth > 2 never fetched; (9) visited-set skip. Rendered per page: up to 12 hint-matching controls enumerated (`COMMUNITY_HINTS` regex — note: no standalone `room`/`trading-floor`/`resources`, unlike static), max 4 clicked; same-hostname link enqueue gated by the same hint test; max 6 requests per crawl; 60s total timeout.

### D2. Funnel (31-day window)

- Rendered seed-crawls (n=181,022) → ≥1 page inspected ~30.7k (17.0%) → FOUND crawls 1,813 (1.0%).
- Static website seed-crawls (~82k seed summaries): complete-clean NOMATCH 63,652 · budget-exhausted PARTIAL 7,908 · found-after-traversal 10,476.
- Candidates (all surfaces, n=3,201): VALIDATED 2,551 · VALIDATION_FAILED 511 · INVALID 134 · DISCOVERED 5; validation COMPLETED 2,685; liveness ACTIVE 2,595 / DEAD 141.
- **Largest loss point:** rendered zero-page crawls (150,301 = 83.0%, browser-infra dominated), then completed NOMATCH. Among crawls that actually run, the queue-emptied (enqueue-filter) endings dwarf page-budget endings (see D4/D7).

### D3. Bucket separation (same surface, CREATOR_WEBSITES)

- Never discovered (URL never seen by any crawl): unmeasurable from the ledger (misses leave no trace) — stated gap.
- Discovered but not enqueued: not recorded per-link (dropped links are never logged). Bounded indirectly: 63,652 static seeds ended complete-clean (queue fully consumed → every unvisited same-host page was dropped by score-0/protocol/cross-origin rules); rendered shallow-complete NOMATCH 24,833 (13.7%) likewise ended on the hint filter, not any budget.
- Enqueued but unvisited (page budget): static PARTIAL seeds 7,908 (explored<8 / >12-cap / depth>2 leftovers / truncation); rendered full-6 no-timeout no-find 877 (0.48%).
- Visited but not found: rendered complete NOMATCH ~129k obs (incl. zero-page infra failures); static complete-clean seeds 63,652.
- Attempted but failed/timed out: rendered FAILED 73,003 (40.3%); timed-out 54,854 (30.3%), of which 51,405 (93.7%) never inspected a page (seed navigation/launch burned the 60s).

### D4. Extraction false negatives

Extractor covers `discord.gg`, `discord.com/invite`, `discordapp.com/invite`, `discord.app/invite` (with reserved-path exclusions) and runs over full static HTML and fully rendered DOM — so JS-generated links, buttons (via href/text/aria in DOM), and script/JSON-embedded invites are scanned in both modes (rendered `inspect()` reads `page.content()` after scrolls/clicks). Residual code-grounded miss classes: cross-origin iframe inner content (not in DOM/HTML) and redirect chains that die before extraction. Production proxies: **108 channels found via rendered with no static find ever** (lower bound for dynamic-necessity); 272 static-only; **271 validated invites found as direct URLs with no traversal**. Verdict: extraction is not a material contributor — no production evidence of systematic misses; the misses that matter are pages never fetched (enqueue), not pages misread.

### D5. Prioritization

Inversion is impossible for score-0 URLs (dropped, never queued — e.g. bare `/blog`, `/courses`, `/faq`, `/pricing`). Among queued links order is score-descending, so `/community` (50+) beats everything except discord-links; `/contact`/`/about` (10) can follow `/join` (50) links — by design, since join pages are higher-yield. The binding constraint is the `explored<8` tail cut (7,908 PARTIAL static seeds), not misordering. Validated-invite page-type yields (distinct channel+locator, ACTIVE, n≈2,760): other-page 1,267 (affiliate/social/video-desc long tail) · homepage 303 · direct-discord-url 271 · contact 185 · link-hub 178 · community 153 · about 145 · youtube 35 · blog-article 7 · telegram 5 · resources 2. Blog/article contributes negligibly (7) — consistent with score-0 dropping; whether more hides there is unmeasurable without fetching (see recommendation).

### D6. Timeout impact

Of 54,854 timed-out rendered crawls: 51,405 (93.7%) inspected zero pages (budget burned in seed navigation/launch, `lastLifecycleStage` absent on 97% — instrumentation gap for older rows); ~1,495 productive PARTIAL timeouts at pages 1–5 (traversal underway, queue state at cutoff unrecorded — cannot confirm pages waiting); **233 FOUND+timed-out** (invite in hand, coverage incomplete). Timed-out population (30.3%) is ~60× the page-budget-bound population (0.48%), but its mass is seed-navigation failure, not deep-traversal cutoff. Timeout is the bigger practical bottleneck than `maxPages=6`, via navigation/launch — not via depth.

### D7. Retry / session-rotation impact

Code defaults: 3 request retries, 4 session rotations per crawl; rotations are unobservable in telemetry (no counter), retries visible via `requestsStarted/Failed`. Crawls with failed requests that still inspected pages find Discord at **12.82% (393/3,065)** vs **5.13% (1,421/27,710)** without failures (avg 2.02 vs 1.51 requests started) — failures correlate with deeper traversal, and recovery retries produce finds. Retries are productive, not pure cost (~0.5 extra requests/crawl on productive crawls).

### D8. Discovery by depth

Anchor `sourcePageDepth` on validated-candidate observations (n=3,524): depth 0: 1,409 · 1: 1,077 · 2: 1,038 — even spread, deep pages contribute ~60% of anchored finds. Rendered: found-on-seed 486 vs found-after-navigation 1,329 (73% required traversal).

### D9. Reproducibility

1,263 channels have repeat website seed crawls (>1h apart); **256 (20.3%) went clean-NOMATCH → FOUND later** — 58 on the SAME seed URL (flakiness/content change), 198 via a different seed (new surfaces). Re-crawling is materially productive.

### D10. Updated conclusions and recommendation

Earlier conclusion (keep `maxPages=6`) is **reinforced, not changed**: only 0.48% of rendered crawls exhaust pages without timing out, while 16.8% of rendered finds needed page 6 and ~60% of anchored finds sit at depth ≥1. Bottleneck ranking, largest first: (1) browser capacity/launch + 60s seed-navigation timeouts (83% rendered zero-page); (2) enqueue hint/score filters — 13.7% rendered queue-emptied endings + score-0 static drops + 7,908 static tail-cut PARTIALs; (3) page budget 6; (4) click slice (7.6% reach ≥4 clicks started; finds still occur); (5) extraction (minor; 108-channel dynamic lower bound shows the handling works).
Smallest safe change if recall work is warranted, in order: (a) **persist drop-reason counters (+scrolls)** — zero behavior risk, closes the measurement gap so the next tune is evidence-based; (b) raise **static** `explored` 8→12 (cheap bounded HTTP fetches, no browser; targets the 7,908 tail-cut PARTIAL seeds); (c) do NOT widen rendered enqueue hints without also raising page/time budgets — it converts queue-empty endings into timeouts. Expected impact of (b): bounded extra static fetches only on website seeds that currently exhaust; memory per page capped by the bounded-response cap and released per iteration (OOM work). Do NOT change `maxPages`/`maxScrolls`/`maxClicks` on current evidence.

## E. Follow-up: rejected-row recrawls + Quant Trade Edge false-Vietnam (2026-09-11, read-only)

### E1. Rejected channels still being crawled — no violation found

- Claim-time guards (current code): `ENRICH_CHANNEL` aborts on `isTerminalState` (`queueManager.ts:413`); `RETRY_COMMUNITY_ACQUISITION` → `inspectAndValidateChannel` aborts on terminal state (`queueManager.ts:895`); terminal includes `country_status='REJECTED'`. Guards date to Aug 10–11, predating PR #459. `TERM_HARVEST` performs zero fetches — not a crawl path.
- Only **3 of 203 REJECTED rows** have crawl observations after their rejection timestamp — all three are a **timestamp artifact, not post-rejection crawling**: trail steps are stamped with inspection-*start* time while fetches run 5–8 min (e.g. steps stamped 13:20:09, social fetches 13:26:03–35, row persisted 13:26:40 — one single inspection that produced the rejection). **0 rows** have any trail work >15 min after their rejection step: no second inspection ever ran on a REJECTED row.
- 6 crawl-capable jobs PENDING against now-REJECTED rows (4 `ENRICH_CHANNEL`, 2 `RETRY_COMMUNITY_ACQUISITION`) were **all created before** those rows were rejected and will be skipped at claim by the guards above — stale, not reintroduced. 77 pending `COUNTRY_BOUNDARY_REPROCESS` jobs are the intentional operator-gated recovery path (classify-first; only `RECOVERABLE` rows re-enter).
- Forensic caveat: trail timestamps record inspection start, not decision time — naive timestamp comparison mimics post-rejection activity.

### E2. Quant Trade Edge (`UC98QW7d7lshhUbxloCDlG9A`) — P2 bare-mention false domicile

- Sole rejection record, 2026-09-04T18:26:03Z, Gate-1 ingestion shape, identical across 3 sightings (CHANNEL/VIDEO lanes, US/France targets): P0 policy statement; **decisive P2 `CHANNEL_ABOUT_BIO: Vietnam (92)`** — "location: 'vietnam' indicates Vietnam"; corroborating-only P5 `lse`→UK / `hose`→Vietnam (78). No `candidateCountries`, no `AGGREGATED_CONTENT_LANGUAGE`, predates structured evidence.
- Evidence chain: 7-letter `vietnam` matches by substring in every code version; `socialBios` has no producer (always `[]`) and the channel name has no match — so the Sep-4 About bio necessarily contained literal "Vietnam". Live bio fetched today (keyless read, 641 chars): fully English, zero "vietnam" (contains "those", which pre-hardening substring rules would have matched as P5 `hose`; short-acronym token boundaries landed Sep 4 11:20/16:43 UTC, rejection evaluated 18:26 UTC — immaterial, P5 was never decisive).
- **Reproduced on current code:** an English bio with a single passing "Vietnam" mention → `REJECTED / Vietnam / 92 / REJECT_EXCLUDED` on the P2 line alone. A bare country-name mention is scored as domicile evidence at near-certainty with no corroboration, domicile-phrase, or word-sense requirement — this is the systemic mechanism.
- 8/10–80% rules, candidate-country logic, structured/fallback parsing, and stale data all confirmed uninvolved (zero Vietnam decisions in prod involve aggregated-language evidence).

### E3. Broader impact

Same P2-92-Vietnam decisive signature on **8 English-named REJECTED rows** (monkeymantrades, Luciani Capital, Quant Trade Edge, Guardeer Cartel, Maxime Trader, Weekly Trend Trader, Rob Mitchell, Gekko Trading LTD; HowToTrade at 100 has additional evidence). Live-checked 3 of 3: fully English today, zero "vietnam". Wider pool: **106 channels** carry P5 `hose→Vietnam` lines (weak-signal pool, corroborating only); 27 channels carry P2-bio Vietnam lines (10 REJECTED / 11 UNCERTAIN / 6 CONFIRMED — CONFIRMED rows were saved by stronger competing evidence). **Pre-existing behavior, not a PR #459 regression** (P2 bio substring matching dates to project-init era; PR #459 never touched it).

### E4. Recommended systemic fix (described only, not implemented)

Require more than a bare country-name mention for P2 bio domicile attribution (e.g. domicile-phrase match, already implemented as a separate loop, or ≥2 independent corroborating signals before a bio mention can become decisive exclusion evidence), keeping single-mention rows at most LIKELY/UNCERTAIN. No channel-specific exception, no fiat validator weakening, no exclusion-list or Gate-1 changes in this step.
