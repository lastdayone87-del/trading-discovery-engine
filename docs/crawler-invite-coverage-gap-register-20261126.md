# Crawler Invite-Discovery Coverage — Gap Register & Investigation Report

**Status:** INVESTIGATION PASS 2 COMPLETE — **no implementation is authorized by this document**
**Date opened:** 2026-11-26
**Last updated:** 2026-11-26
**Scope:** Site navigation reach and Discord-invite recall ("despite where it is"),
including all supported countries and languages
**Production baseline:** `1bf93568` (Coolify `main`, schema 210, deployed 2026-11-26 ~05:27 UTC)
**Reviewed code baseline:** crawler modules byte-identical from `6aaf66e5` through `4f592c02` and `1bf93568`; only `queueManager.ts` and `dbCore.ts` changed in the provider-capacity deploys
**Method:** read-only production database, source inspection, static fixture matrix,
real-browser tests in a disposable production-image container, live HTTP/Discord
probes, and public YouTube/Innertube probes

---

## 0. Document control

This is the living register. All 27 original gap IDs are retained. New findings
are added as `GAP-28` onward; no original ID was renumbered or removed.

Rules:

1. Gap IDs are stable.
2. Status values: `OPEN`, `NEEDS-PROOF`, `CONFIRMED`, `REFUTED`, `ACCEPTED`,
   `OUT-OF-SCOPE`, `DEFERRED`, `CLOSED`.
3. No item closes without a linked decision or change.
4. Scores remain interim until a larger labelled benchmark is run; the measured
   matrix in §6 is the current evidence.
5. This document records findings only. It does not authorize code, config,
   deployment, or production changes.

### 0.1 Production baseline changed during the investigation

| Time (UTC) | App revision | Schema | Observation |
|---|---|---|---|
| start of review | `6aaf66e5` | 208 | original baseline |
| 2026-11-26 02:06 | `4f592c02` | 209 | external redeploy during review |
| 2026-11-26 ~05:27 | `1bf93568` | 210 | second external redeploy during review |

`SOURCE_COMMIT=1bf93568...`, `COOLIFY_BRANCH=main`, `NODE_ENV=production`.
A diff of every crawler file across these revisions is empty. `4f592c02` added
provider index work to `dbCore.ts`; `1bf93568` changed `queueManager.ts` semantic
provider-capacity gating (149 lines), not invite extraction or navigation. The
audit applies to all three revisions. `/api/version` still reports
`commitSha:"unknown"` (GAP-32).

### 0.2 What this review does not cover

- Classification, admission scoring, storage, or dashboard quality.
- Legal/ToS questions.
- Production changes of any kind.

---

## 1. Executive findings and revised scores

| Dimension | Gemini | First-pass review | Measured pass 2 | V4 pass 3 |
|---|---:|---:|---:|---:|
| Site navigation | 72 | 88 → 78 reconciled | 64 (60–68) | **62** (58–66) |
| Catching invites anywhere | 76 | 80 → 80 reconciled | 70 (66–74) | **68** (64–72) |
| Conditional on a page being reached | — | ~92 | ~90 | **~90** |

The crawler is strong at extraction **once a page is reached**. Comprehensive
coverage is much lower because of reachability and throughput:

1. **Browser admission starvation is the dominant blocker.** 11,111 site
   inspections were `GATE_SATURATED`; 83% of render sites inspected **0 pages**;
   only 214 sites have `coverageReason=COMPLETE`. The governor allows **64
   renders/hour** (72 emergency) with **2 browser slots**, and
   `MAX_BROWSER_RUNTIME_CONCURRENCY=2` is a hard code cap. 63,941 creator-website
   URL rows have never been browser-executed. At 64/h the existing 73,040-row
   website workload is ~47 days for one pass.
2. **Static depth/queue caps are binding.** Production recorded ~1,009,186
   `depth-limit` drops, ~942,532 `exploration-limit` drops, and ~213,082
   `queue-cap` drops. The fixture matrix finds an invite at depth 2 and the 12th
   queued link, and misses depth 3 and the 13th link.
3. **Cross-origin new-tab and JS popups are missed.** Same-tab anchors are found
   with the production flag OFF (click fallback); `target="_blank"` is missed;
   `window.open` is missed **even with `crossOriginEnqueue:true`**.
4. **Non-English navigation is not covered.** 12 of 13 tested non-English CTA
   phrases were missed; only the French “Rejoindre” passed, because it
   accidentally contains the substring “join.” All 10 supported non-English
   languages failed, including Irish and Luxembourgish. 4,000+ channels are in
   non-English-majority supported countries.
5. **YouTube surfaces are materially under-read.** Creator-owned live invites
   were found in a **pinned comment** and in **non-pinned comments/older video
   descriptions** that production never recorded. A targeted 10-channel sample
   found 3 globally new live invites; a random 90-channel sample found 3 globally
   new live Community-post invites (3.3%). Community posts are public and
   paginated; comments and older uploads are public too.
6. **Reserved-code rejection is a confirmed false negative.** 16 of 26 codes in
   the `reserved` set are valid live Discord invites (`store`, `home`, `about`,
   `contact`, `support`, `channels`, `download`, `api`, `widget`, `terms`,
   `privacy`, `before`, `after`, `next`, `index`, `template`).
7. **Pinned-comment inspection is dead code.** Production has **zero**
   `PINNED_COMMENT` candidates; no fetcher populates `pinnedComment`. A live
   creator-owned pinned invite was confirmed (`is_pinned:true`,
   `author_is_channel_owner:true`).
8. **First-invite suppression is real, but its global yield is unproven.**
   170 TRADING_CONFIRMED static-FOUND sites had no rendered attempt. An 11-site
   live sample found **0 globally new live codes**, though 2 sites exposed 3 live
   codes already owned by other channels. The mechanism is confirmed; the
   global-coverage gain is low in this sample.

---

## 2. Production reality (V1, V2, V3, V8)

### 2.1 Deployment and runtime

| Item | Verified value |
|---|---|
| Host | Coolify `45.94.58.135`, project `my-first-project`, env `production` |
| App container | `7zp5h5tz4dkjteaag4phxyme-20261126T052736` |
| Image / `SOURCE_COMMIT` | `1bf93568...` |
| Branch | `main` |
| Schema | 210 (`210_provider_capacity_state.sql`, applied 05:34:53 UTC) |
| App containers | one; no alternate crawler service |
| DB container | `4anodpyfvgjn9ybl2jqs9eoa`, IP `10.0.1.2:5432` (doc says `10.0.1.5`; stale) |
| DB access | `muse_readonly`, `transaction_read_only=on`, statement timeout 60s |

`/api/version` returns `commitSha:"unknown"`, `buildTimeSource:"startup"`.
The image tag and `SOURCE_COMMIT` confirm the revision; the app's build-info
wiring does not.

### 2.2 Feature flags that matter

| Setting | Production | Effect |
|---|---|---|
| `acquisition_ladder_enabled` | **absent → false** | no sitemap seeding, no JSON-LD/`sameAs` structured navigation |
| `frontier_manager_enabled` | **absent → false** | no frontier/stopping arbiter; legacy static crawl only |
| `site_profiler_enabled` | **absent → false** | no robots/sitemap/feed profiling in the crawl path |
| `RENDERED_ADMISSION_GOVERNOR_ENABLED` | `true` | admission governor active |
| `RENDERED_ADMISSION_NOMINAL_PER_HOUR` | `64` | global nominal render ceiling |
| `RENDERED_ADMISSION_EMERGENCY_PER_HOUR` | `72` | emergency ceiling |
| `RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT` | `35` | discovery minimum share |
| `BROWSER_RUNTIME_CONCURRENCY` | `2` | two browser slots |
| `RENDERED_FALLBACK_MAX_WAIT_MS` | `90000` | 90s maximum gate wait |
| `CLASSIFICATION_RENDERED_FALLBACK_MAX_WAIT_MS` | `5000` | classification lane wait |
| `crossOriginEnqueue` | **absent → false** | rendered cross-origin enqueue off; no caller enables it |
| `login block semantics` | `true` | login/paywall detection active |
| relevance `BLOCK/DEMOTE` enforcement | `false` | admission is permissive; not a recall restriction |
| `frontier_allocation_enabled` | `true` | this is discovery allocation, **not** the crawler frontier |

`acquisition_ladder_enabled`, `frontier_manager_enabled`, and
`site_profiler_enabled` have no `app_settings` rows. No environment override
was present in the production container. This is the legacy configuration.

### 2.3 Runtime wrapper / variant check

- The only production caller is `runChannelInspection` in `server/inspector.ts`.
- No production wrapper passes `crossOriginEnqueue`, custom `maxPages`, or a
  custom rendered function.
- `renderedFallback` is only passed in tests; production uses
  `crawlRenderedCommunitySurface` directly.
- One app container, one image; no second crawler variant.
- `server/discovery/probeExecutor.ts` is inert: no automatic caller, requires an
  approved probe and `discovery_probe_enabled`; it is a YouTube retrieval path,
  not an invite crawler. No active `frontierCrawl` production reference exists.
- `crawlSocialBios` and the seed path both call the same `crawlExternalLinks`;
  there is no parallel external-crawl implementation.

---

## 3. How the evidence was gathered

| Method | What it proves |
|---|---|
| Read-only production SQL | actual flags, counts, outcomes, telemetry, source surfaces |
| Static fixture matrix (`runChannelInspectionForTest` + local fetch) | exact static detection boundaries without a browser |
| Disposable production-image container (`docker run --rm`, no DB writes) | real Chromium/Crawlee behavior for same-tab, new-tab, popups |
| Live HTTP redirects/403s and Discord API | case sensitivity, reserved codes, redirect behavior |
| Public YouTube/Innertube (`youtubei.js`) | actual accessibility of posts, comments, older videos, pinned comments |
| Read-only live URL samples | whether production FOUND/no-render sites yield additional invites when rendered |

No crawler code, production config, schema, or data was modified. The only
production state change observed was an external redeploy at 02:06 UTC.

---

## 4. Gemini review reconciliation (updated)

| # | Gemini claim | Verdict | Evidence / correction |
|---|---|---|---|
| G1 | `crossOriginEnqueue` off, no caller | **VERIFIED** | option at `browserCommunityFallback.ts:71`; defaults lack it (`:413-421`); only honoured when `===true` (`:5607`) |
| G1a | cross-origin SPA links are dropped | **NUANCED → CONFIRMED for new-tab** | same-tab eligible anchor **found** with flag off; new-tab **missed**; popup **missed even with flag on** |
| G2 | Playwright does not inspect iframes | **VERIFIED** | main-frame `page.content()` (`:5003`); frames counted only (`:2136-2180`); no `page.frames()` text scan |
| G3 | no XHR/JS payload or external bundle scan | **VERIFIED** | only document responses for declarative-shadow count (`:1937-1964`); no JSON/API body extraction |
| G4 | static depth 2, queue 12 | **VERIFIED** | `inspector.ts:887, 924`; fixture: depth 2 found, depth 3 missed; 12th found, 13th missed |
| G5 | rendered 6/4/5/60s, 64 controls | **VERIFIED** | `:413-421`, `:3041`; production averages 0.25 pages because gate saturation, not these caps |
| G6 | six-hub allowlist | **VERIFIED** | `destinationPolicy.ts:17-24`; copies in `inspector.ts:354`, `acquisitionRelevance.ts:91-96` |
| G7 | shorteners not resolved second-hop | **VERIFIED** | recognised at `acquisitionRelevance.ts:124`, never blocked (`:296-297`); cross-origin evidence still required at `destinationPolicy.ts:41-50`; `bit.ly` fixture missed |
| G8 | no OCR/closed shadow | **VERIFIED** | no OCR dependency; closed roots counted only (`:1691-1716`) |
| G9 | login/paywall/anti-bot surfaced truthfully | **VERIFIED** | terminal barriers and `PARTIALLY_INSPECTED` / `EXTERNALLY_BLOCKED` paths |
| G10 | 20 redirects | **VERIFIED** | `siteProfiler.ts:679`; Discord public surfaces use 5 hops |
| G11 | data-href/meta/form/location controls | **VERIFIED, MISATTRIBUTED** | parser is `staticControlTargets.ts`, not `crawlerExtraction.ts`; fixture finds meta/form/location |
| G12 | Discord server/widget pages | **VERIFIED** | `discordPublicSurface.ts`; widget JSON `instant_invite` |
| G13 | Telegram/WhatsApp preview escalation | **VERIFIED** | `MESSAGING` + bridge evidence |
| G14 | 3 hosts × 2 pages hub budget | **VERIFIED** | `destinationPolicy.ts:236-237` |

New corrections to the earlier report:

- **Reserved codes were not a theoretical risk.** 16/26 are valid invites.
- **Pinned comments are not a strength.** The surface has no producer and zero
  production candidates.
- **The creatorLikelyTrading gate is real but smaller than feared.** The measured
  no-match/no-render population is 7 UNCERTAIN sites, not thousands; the big
  losses are capacity and first-invite suppression.
- **Case folding is real at merge/claim time.** `mergeDiscordCandidates` collapses
  `AbC123` and `abc123` to one; registry claims use the lowercase key. Production
  has zero observed case-variant collisions among 6,171 candidates.

---

## 5. Gap register — all 27 original IDs plus 5 new

### 5.1 Navigation and reachability

| ID | Gap | Measured evidence | Status | Pri | Source |
|---|---|---|---|---|---|
| GAP-01 | Iframe content unread; cross-origin can be certified clean | static cross-origin iframe → `INSPECTED_NO_MATCH` (false clean); rendered same-origin and cross-origin → `CONTEXT_UNREACHABLE`, no invite; static skips at `inspector.ts:845`; rendered counts frames only | **CONFIRMED** | P1 | Both |
| GAP-02 | Rendered XHR/API/JSON bodies unread | only document/main-frame shadow scan; no JSON body extraction | **CONFIRMED** | P1 | Gemini |
| GAP-03 | External JS/CSS bundles unread | static raw HTML + page.content only; assets excluded (`inspector.ts:323-336`); no response-body scan | **CONFIRMED** | P1 | Both |
| GAP-04 | Cross-origin new-tab/popups; flag off | matrix below: same-tab OFF **found**, new-tab OFF **missed**, new-tab ON found, popup OFF **missed**, popup ON **missed**; 241,298 `cross-origin-disallowed` drops; 815 no-match sites with cross-origin drops | **CONFIRMED** | P1 | Gemini + new |
| GAP-05 | Static depth/queue caps | depth 2 found, depth 3 **missed** (`depth-limit`); 12th found, 13th **missed** (`queue-cap`); 4,479 queue-cap sites, 1,202 depth-limit sites; 1,009,186 depth drops | **CONFIRMED** | P1 | Gemini |
| GAP-06 | Rendered breadth/depth caps | 6 pages/4 clicks/5 scrolls/60s; after capacity fix these will bind; production averages 0.25 pages because gate | **CONFIRMED** | P2 | Gemini |
| GAP-07 | Hub allowlist narrow | `linktr.ee` found; `stan.store` **missed**; production linktr.ee 1,107 sites, whop 925, patreon 474, beacons 104; stan/bento/taplink/hoo.be/komi/zaap mostly one-off and unpursued | **CONFIRMED** | P2 | Gemini |
| GAP-08 | Generic shorteners weak-anchor dropped | `bit.ly` fixture **missed**; shorteners are recognised but not resolved pre-admission | **CONFIRMED** | P2 | Gemini |
| GAP-09 | Sitemap/profiler/JSON-LD/frontier off by default | production: all three settings absent → false; only legacy navigation active | **CONFIRMED** | P1 | New |
| GAP-10 | `creatorLikelyTrading` render gate | 7 UNCERTAIN no-match/no-render sites; 37 non-confirmed failed/partial no-render; live sample of 3 found no invite; V4 random/zero sample did not add; mechanism confirmed, measured yield low | **CONFIRMED (mechanism); yield low** | P3 | New |
| GAP-11 | First-invite suppression | 170 TRADING_CONFIRMED FOUND sites with no rendered attempt; fixture proves second rendered invite lost; V4 11-site live sample: **0 globally new live**, 2 sites exposed 3 live codes already owned by another channel; creator-level completeness still real | **CONFIRMED (mechanism); global yield 0/10** | P2 | New |
| GAP-12 | `<area>`, `<object>/<embed>`, `rel=me` not navigated | anchor scan `a[href]`; object/embed counted only; structured inventory flag-gated | **OPEN** | P3 | New |
| GAP-13 | YouTube surfaces under-read | 10 newest only; targeted 10-channel sample: 3 globally new live (comments/pinned/older); random 90-channel sample: 3 globally new live (Community posts; 3.3%); 440 posts/444 comments/440 older descriptions in random sample; 6/100 total; production `PINNED_COMMENT=0` | **CONFIRMED** | P1 | New |

### 5.2 Extraction and normalization

| ID | Gap | Measured evidence | Status | Pri | Source |
|---|---|---|---|---|---|
| GAP-14 | Tag-fragmented invite text | `disc<span>ord</span>.gg/TAGSPLIT` fixture **missed**; shadow text join inserts spaces | **CONFIRMED** | P2 | New |
| GAP-15 | Obfuscation beyond decode list | `base64` fixture **missed**; double-encoded `%252F` **missed**; no ROT13/homoglyph/spaced/`discord dot gg` | **CONFIRMED** | P2 | Both |
| GAP-16 | Redirect/failure-path extraction | redirect-to-invite **found**; redirect-to-403 **missed**; 403 body with invite **missed**; final URL not extracted on failure | **CONFIRMED** | P2 | New |
| GAP-17 | XHTML/XML rejected on 2xx | fixture `application/xhtml+xml` **missed** with no render; **found** when rendered stub runs; production 2 sites/2 obs (low), but aggregate can report `INSPECTED_NO_MATCH` | **CONFIRMED** | P2 | New |
| GAP-18 | PDF/RSS/docs not parsed | production: PDF 292 sites/530 obs; RSS 355/567; text/xml 100/112; application/xml 83/87; atom 45/57; docx 5/9; xlsx 10/25; fixture PDF **missed**; V4 real sample: **0 codes in 12 RSS/XML and 12 PDFs** (PDF text extraction limited) | **CONFIRMED; measured yield 0/24** | P3 | New |
| GAP-19 | No OCR/QR/canvas | no OCR dependency | **OUT-OF-SCOPE (cost)** | P3 | Both |
| GAP-20 | Closed shadow roots unread | counted only (`:1691-1716`); correctly surfaced | **OUT-OF-SCOPE (platform)** | P3 | Both |
| GAP-21 | Reserved-word rejection discards valid codes | live Discord API: **16/26 valid** — `channels, store, download, api, widget, terms, privacy, before, after, next, index, home, about, contact, support, template`; crawler rejects all | **CONFIRMED** | P2 | New |
| GAP-22 | Case-fold identity collapses distinct codes | `canonicalDiscordInviteId('AbC123') === canonicalDiscordInviteId('abc123')`; `mergeDiscordCandidates` returns 1; registry claim uses lowercase; production 0 observed collisions among 6,171 | **CONFIRMED (mechanism); risk low** | P3 | New |
| GAP-23 | Non-English CTA hints | 12/13 tested non-English phrases **missed**; only accidental French `Rejoindre` (substring `join`) passed; all 10 supported non-English languages failed (de/fr/nl/da/no/sv/ar/zh/ga/lb); supported countries include 4,000+ non-English-majority channels | **CONFIRMED** | P1 | New |
| GAP-24 | Discord public surface narrow/short deadline | `/servers/<slug-id>` and `/widget?id=` only; 8s timeout; 5 hops | **OPEN** | P3 | New |
| GAP-25 | 2 MB response cap | bounded; truncated/partial, never clean | **ACCEPTED (deliberate bound)** | P3 | New |
| GAP-26 | Settle timing may miss late content | inspect on load/scroll/click; no final quiet-period scan | **NEEDS-PROOF** | P3 | New |
| GAP-27 | `robots.txt` not enforced on crawl | profiler records state; crawler does not gate | **OUT-OF-SCOPE (compliance)** | — | New |
| **GAP-28** | **Pinned-comment surface is dead code** | no producer for `pinnedComment`; production `PINNED_COMMENT=0`; live creator pinned invite `wjXSpHeJCm` (`is_pinned:true`, `author_is_channel_owner:true`) missed | **CONFIRMED** | P1 | New |
| **GAP-29** | **Browser admission starvation** | 11,111 `GATE_SATURATED`; 83% render sites 0 pages; avg 0.25 pages; only 214 COMPLETE; 64/h, 72/h emergency, 2 slots, 90s wait; `MAX_BROWSER_RUNTIME_CONCURRENCY=2` hard code cap; 63,941 creator-website rows never rendered; 73,040-row one-pass at 64/h = ~47 days; host 4 cores/7.8 GB, app+browser ~1–1.3 GB per slot; V4 GATE sample 0 invites / 5 sites (2 zero-page, 3 bounded) | **CONFIRMED** | P0/P1 | New |
| **GAP-30** | **Rendered control filter and click budget** | 153,560 controls enumerated; 120,429 **hint-rejected (78.4%)**; 46,864 evidence controls; 1,632 clicked (3.5%); 19,754 skipped; 1,551 failed | **CONFIRMED** | P1 | New |
| **GAP-31** | **Asset URLs consume crawl budget** | 2,937 unsupported-content observations across 1,613 sites; most are images/CSS/JS (image/avif 482, png 122, JS 29, CSS 67); static average 3.7 pages/site, so wasted slots are material | **CONFIRMED** | P2 | New |
| **GAP-32** | **Build identity not wired** | `/api/version` `commitSha:"unknown"` despite `SOURCE_COMMIT`; deployed revision only discoverable from image tag | **CONFIRMED** | P3 (observability) | New |

---

## 6. Measured benchmark results

### 6.1 Static fixture matrix (production code, no browser)

| Case | Expected | Result | Status / ceiling |
|---|---|---|---|
| Invite at depth 2 | found | **found** | — |
| Invite at depth 3 | found | **missed** | `depth-limit` |
| Invite on 12th queued link | found | **found** | — |
| Invite on 13th queued link | found | **missed** | `queue-cap` |
| Same-origin unhinted link | found | **found** | — |
| Cross-origin unhinted link | found | **missed** | — |
| `linktr.ee` weak anchor | found | **found** | — |
| `stan.store` weak anchor | found | **missed** | — |
| `bit.ly` weak anchor | found | **missed** | — |
| `target="_blank"` static hub | found | **found** | static ignores target |
| English "Join community" cross-origin | found | **found** | — |
| All supported non-English languages (de/fr/nl/da/no/sv/ar/zh/ga/lb) + es/pt/it/ja | found | **all missed**, except accidental French `Rejoindre` | — |
| French "Rejoindre" | found | **found** | accidental substring `join` |
| XHTML, no render | found | **missed** | `UNSUPPORTED_CONTENT_TYPE` |
| XHTML, trading-likely + render | found | **found** | render rescue |
| 403 body contains invite | found | **missed** | no body extraction |
| PDF contains invite | found | **missed** | unsupported content type |
| Tag-split text | found | **missed** | raw HTML scan |
| Double-encoded text | found | **missed** | one decode pass |
| `meta refresh` | found | **found** | static control |
| `formaction` | found | **found** | static control |
| literal `location.href` | found | **found** | static control |
| same-origin iframe | found | **found** | — |
| same-origin iframe (static) | found | **found** | — |
| same-origin iframe (rendered only) | found | **missed** | `CONTEXT_UNREACHABLE` |
| cross-origin iframe (static) | found | **missed** | `INSPECTED_NO_MATCH` (false clean) |
| cross-origin iframe (rendered only) | found | **missed** | `CONTEXT_UNREACHABLE` |
| redirect to invite | found | **found** | — |
| redirect to 403 invite | found | **missed** | partial, not found |

### 6.2 Real-browser cross-origin matrix (production image, disposable container)

| Scenario | `crossOriginEnqueue` | Found? | Complete? | Result |
|---|---:|---|---|---|
| same-tab anchor | false | **yes** | no (`cross-origin-disallowed:1`) | click fallback reaches hub |
| new-tab anchor (`target=_blank`) | false | **no** | no | **GAP-04** |
| same-tab anchor | true | **yes** | yes | enqueued hub |
| new-tab anchor | true | **yes** | yes | enqueued hub |
| `window.open` popup | false | **no** | no | **GAP-04** |
| `window.open` popup | true | **no** | no | **GAP-04 not fixed by flag** |
| JS `location.href` same-tab | false | **yes** | yes | click navigates |
| JS `location.href` same-tab | true | **yes** | yes | click navigates |

### 6.3 Render-gate fixtures (real production code)

| Scenario | Rendered calls | Codes retained | Status |
|---|---:|---|---|
| creator-owned static invite + second rendered invite | **0** | `STATICONE` only | FOUND (second lost) |
| third-party static invite + second rendered invite | 1 | `STATICONE`, `RENDEREDTWO` | FOUND (both) |
| non-trading JS-only | **0** | none | `INSPECTED_NO_MATCH` |
| trading JS-only | 1 | `RENDEREDTWO` | FOUND |

### 6.4 YouTube public-surface probe (`youtubei.js`, no API key)

| Surface | Access | Sample result |
|---|---|---|
| Pinned comment | **public** | live creator-owned invite `wjXSpHeJCm`; `is_pinned:true`, `author_is_channel_owner:true`; production `PINNED_COMMENT=0` |
| Non-pinned comments | **public** | 186 comments across 10 channels; 1 live creator-owned invite, 1 expired |
| Community posts | **public, paginated** | 123 posts across 10 channels; 3 codes, all invalid/expired; links to Discord application pages observed |
| Older videos/descriptions | **public, paginated** | 77 descriptions (videos 11–30) across 4 channels; 5 codes, **2 live** (`EYNYBGfhgq`, `P8Cu44TSce`), 3 expired |
| Playlists | **public** | 2–14 per channel; `getPlaylist` accessible; sampled descriptions empty |
| Live chat | live-only, ephemeral | not a historical/backlog surface |

Live new invites from YouTube surfaces, absent from the production registry:
`wjXSpHeJCm` (creator pinned/top comment), `EYNYBGfhgq`, `P8Cu44TSce`
(older descriptions, third-party promo inviter). This is measured incremental
recall, not an estimate.

### 6.5 Production aggregates (read-only)

| Metric | Value |
|---|---:|
| `site_inspections` | ~17,974 (live table; counts drift) |
| static `FOUND` with no `rendered_covered` | 1,349 |
| `FOUND` with **no rendered attempt** | 242 (170 TRADING_CONFIRMED) |
| `INSPECTED_NO_MATCH` | 1,253 (1,174 rendered-covered, 79 static) |
| `ACQUISITION_FAILED` | 8,180 |
| `PARTIALLY_INSPECTED` | 5,642 |
| `REDIRECTED` | 1,482 |
| rendered-covered site inspections | 1,423 (7.9%) |
| `GATE_SATURATED` | 11,111 (5,821 failed, 4,363 partial, 927 found) |
| render sites inspecting 0 pages | 83% (13,292 / 15,945) |
| average pages / clicks / scrolls per render | 0.25 / 0.53 / 1.71 |
| `coverageReason=COMPLETE` | 214 |
| `total-timeout` rendered ceilings | 969 |
| controls enumerated / hint-rejected | 153,560 / 120,429 (78.4%) |
| evidence controls clicked / skipped / failed | 1,632 / 19,754 / 1,551 |
| website URLs (TRADING_CONFIRMED) | 72,530 (8,947 browser-executed, 12.3%) |
| static ceilings: queue-cap / depth-limit / exploration-limit | 4,479 / 1,202 / 245 |
| drop counts: depth / exploration / admission / hint / cross-origin / queue | 1,009,186 / 942,532 / 888,448 / 538,854 / 241,298 / 213,082 |
| no-match sites with static cross-origin drops | 815 |
| hub sites: linktr.ee / whop / patreon / beacons | 1,107 / 925 / 474 / 104 |
| content types: PDF / RSS / text XML / app XML / atom | 292 / 355 / 100 / 83 / 45 |
| `discord_candidates` / registry | 6,171 / 6,118 |
| source surfaces: websites / video desc / links / socials / about / pinned | 2,550 / 2,121 / 1,086 / 410 / 6 / **0** |
| channels: total / TRADING_CONFIRMED / UNCERTAIN / NEEDS_REVIEW / NON_TRADING | 42,047 / 17,982 / 20,008 / 3,889 / 168 |

Country exposure (channels): US 7,432; UK 1,456; Germany 1,337; France 1,286;
Canada 825; UAE 640; Australia 467; Singapore 297; Netherlands 297; Switzerland
250; Sweden 227; Belgium 141; New Zealand 110; Norway 110; Denmark 101;
Ireland 83; Luxembourg 17.

---

## 7. Placement coverage matrix (measured)

Legend: **Y** covered; **Y\*** conditional/flag-gated; **P** partial/bounded;
**N** not covered; **H** hard limit.

| Invite placement | Static | Rendered | Measured verdict |
|---|---|---|---|
| Bio / About | Y | — | Y |
| Channel external links | Y | — | Y |
| Pinned comment | N | — | **N (GAP-28)** |
| Non-pinned comments | N | N | **N (GAP-13)** |
| Video descriptions (newest 10) | Y | — | Y |
| Older videos/descriptions | N | — | **N (GAP-13) — 2 live codes found** |
| Community posts | N | N | **N (GAP-13) — public, 0 live in sample** |
| Playlists | N | — | N (accessible; sample empty) |
| Live chat | N | N | H (ephemeral) |
| Creator website HTML | Y | Y | Y |
| Creator JS-only site | N | Y\* | P (GAP-10) |
| Same-origin iframe / srcdoc | Y | P | Y (static); rendered `CONTEXT_UNREACHABLE` |
| Cross-origin iframe | N | P | **N (GAP-01)**; static false clean, rendered truthful partial |
| Open shadow DOM | — | Y | Y |
| Closed shadow DOM | — | N | H (GAP-20) |
| XHR/API JSON | N | N | **N (GAP-02)** |
| External JS/CSS bundle | N | N | **N (GAP-03)** |
| Same-tab cross-origin anchor | Y | Y | Y |
| New-tab cross-origin anchor | Y (static) | **N** | **N (GAP-04)** |
| `window.open` popup | — | **N** | **N (GAP-04, even flag on)** |
| JS same-tab navigation | — | Y | Y |
| Link hubs (6 allowlisted) | Y | Y | Y |
| Unknown/new hubs | N | N | **N (GAP-07)** |
| Generic shorteners (weak anchor) | N | N | **N (GAP-08)** |
| Redirect-to-invite, target reachable | Y | Y | Y |
| Redirect-to-invite, target 403 | N | N | **N (GAP-16)** |
| Invite in 403 body | N | N | **N (GAP-16)** |
| Images/QR/canvas | N | N | H (GAP-19) |
| PDF | N | N | **N (GAP-18) — 292 sites** |
| RSS/XML/Atom | N | N | **N (GAP-18) — 583 sites** |
| XHTML | N | Y\* | P (GAP-17) |
| Login/paywall/members-only | H | H | H (surfaced) |
| Anti-bot/Cloudflare | H | P | H/P (surfaced) |
| Discord server page/widget | Y | — | Y |
| Disboard/dsc.gg/me/io | Y\* | Y\* | P (needs fetch) |
| Tag-fragmented text | N | N | **N (GAP-14)** |
| Base64/ROT13/double-encoded | N | N | **N (GAP-15)** |
| English CTA | Y | Y | Y |
| All supported non-English CTAs | N | N | **N (GAP-23)** |
| Reserved-code vanity | **N** | **N** | **N (GAP-21)** |

---

## 8. What 90+ would actually require

These are investigation conclusions, not approved changes.

1. **Replace the render capacity model.** 64 renders/hour and 2 browser slots
   cannot cover 72,530 website URLs, 90,556 URL-work rows, or 11,111 saturated
   sites. A coverage-target model needs many more concurrent browser workers,
   a much higher governor, and/or distributed rendering. This is the largest
   single lever.
2. **Remove or raise the static depth/queue ceilings.** Depth 3+ and >12 queued
   pages are needed; 1M depth drops and 213k queue drops are direct evidence.
   Prefer a yield-based frontier/stopping arbiter over hard caps, and enable
   sitemap/profiler/structured navigation (currently all off).
3. **Cover cross-origin new tabs and popups.** Enabling `crossOriginEnqueue`
   fixes anchors but **not** `window.open`. Cross-origin popups need their own
   inspect/enqueue path, with a real page budget rather than the current drop.
4. **Make navigation multilingual for every supported country.** A per-language
   lexicon for join/community/members/links/access plus path hints; English
   substring matching is not coverage. All supported non-English languages
   failed; only accidental French `Rejoindre` passed.
5. **Read the YouTube surfaces that actually yield invites.** Pinned comment
   fetcher, non-pinned comments (first pages/replies), older uploads via uploads
   playlist pagination, Community posts via public browse. Use comments/pinned
   before spending 100-unit `search.list` calls; keep all invites, not one.
6. **Fix extraction false negatives.** Remove/validate the 16 valid reserved
   codes; case-preserving claim with collision validation; tag-rejoin; base64/
   ROT13/double-encoding; redirect `Location`/non-2xx body scanning.
7. **Parse accessible document types.** PDF, RSS/XML/Atom, XHTML; don't reject
   `application/xhtml+xml` on 2xx while accepting it in the 404 probe.
8. **Stop spending crawl slots on assets.** 1,000+ image/CSS/JS site
   inspections are unsupported-content noise; tighten admission so they don't
   crowd community pages.
9. **Do not treat “not clean” as success.** The current E2E acceptance gate
   requires only `assertNotClean` for new-tab popups, cross-origin hubs off,
   closed shadow, budgets, etc. Comprehensive discovery requires asserting
   **found where publicly discoverable**, not merely “partial.”
10. **Wire build identity.** `/api/version` must report the deployed commit;
    otherwise every future audit starts with an unknown baseline.

---

## 9. Hard limits / genuine platform restrictions

| Item | Technical reason | Coverage impact |
|---|---|---|
| Login/paywall/members-only | No public credential; content gated | Unavoidable; current code correctly reports unconfirmed absence |
| Closed shadow DOM | Browser API intentionally hides root | Unavoidable without page cooperation; counted/reported |
| Anti-bot/Cloudflare | Server-side blocking | External; rendered may pass on some sites |
| Images/QR/canvas | No OCR/QR decoder | Solvable with OCR/QR tooling, but cost/benefit |
| Live chat | Only available during a live stream; ephemeral | Not a historical/backlog surface |
| Deleted/expired invites | Discord-side expiry | Cannot be recovered; validation correctly rejects |

Not platform limits (should be treated as gaps): PDF, RSS/XML, XHTML, reserved
codes, tag-split text, base64, new-tab/popup, pinned comments, comments, older
videos, depth/queue, capacity governor, multilingual hints.

---

## 10. Verification gates — status

| ID | Question | Status | Result |
|---|---|---|---|
| V1 | Deployed revision | **RESOLVED** | `1bf93568` (was `6aaf66e5` → `4f592c02`); schema 210; crawler files identical |
| V2 | Ladder/frontier flags | **RESOLVED** | both absent → false; profiler also false |
| V3 | Runtime `crossOriginEnqueue`/overrides | **RESOLVED** | off; no production wrapper; one app container |
| V4 | Measured recall by placement | **EXPANDED, STILL LIMITED** | static/cross-origin/YouTube + real render samples complete; GATE 0/5; larger sample still advisable |
| V5 | Case sensitivity / reserved paths | **RESOLVED** | random codes case-sensitive, vanities insensitive; 16/26 reserved codes valid |
| V6 | Cross-origin same-tab/new-tab | **RESOLVED** | same-tab found; new-tab off missed; popup on/off missed |
| V7 | `robots.txt` enforcement | **RESOLVED** | profiler records only; crawler does not gate |
| V8 | Alternate crawler variants | **RESOLVED** | one app container, one image, one inspector path |

### 10.1 Residual uncertainty (do not read the benchmark as a population estimate)

- The fixture matrix is deterministic and exhaustive for the cases listed, but
  it is not a random 100-channel ground-truth sample.
- The live first-invite and creatorLikelyTrading samples are small (3 URLs each);
  the mechanisms are proven, the real-world marginal yield is not yet powered.
- YouTube surface yield varies by channel; Community posts produced 0 live
  invites in the 123-post sample, while comments/older descriptions produced 3.
- Invite liveness changes; expired/unknown codes were observed and are recorded
  as such, not as false positives.
- Production redeployed during the review; re-run the production aggregates
  after the next deploy if the decision is delayed.
- The largest unresolved quantity is **how many currently unrendered/unreached
  pages contain a publicly accessible invite**. The production telemetry proves
  the reachability loss; only a larger labelled sample can size the invite yield.

---

## 11. Pre-implementation priority hypothesis (unapproved)

Order is expected recall per unit of architectural change and measured yield.
It changed after V4: YouTube has the strongest measured incremental yield;
capacity remains the largest structural blocker; first-invite/GATE global yield
is lower than the mechanism alone suggested.

1. **GAP-13 + GAP-28 — YouTube comments/pinned/Community/older** (strongest
   measured yield: 3 global new live/10 targeted; 3/90 random; 6/100 total;
   pinned dead).
2. **GAP-29 — browser capacity architecture** (largest structural loss: 11,111
   saturated; 63,941 unrendered; 64/h; hard 2-slot cap; 47-day pass; real render
   sample 0/19 global new).
3. **GAP-05 + GAP-09 — static depth/queue and off-by-default
   frontier/sitemap/profiler** (depth-3/13th-link misses; ~1M depth drops).
4. **GAP-04 — new-tab anchors and JS popups** (popup not fixed by flag).
5. **GAP-23 — multilingual navigation for all supported countries** (all 10
   supported non-English languages failed).
6. **GAP-21 + GAP-22 — reserved-code and case-preserving identity** (16/26
   valid; mechanism confirmed).
7. **GAP-30 — control hint filter/click budget** (78% skipped).
8. **GAP-01/02/03 — frames, XHR/JSON, external JS** (structural).
9. **GAP-14/15/16 — tag/base64/redirect/non-2xx extraction** (fixture misses).
10. **GAP-17/18 — XHTML; PDF/RSS** (XHTML cheap; PDF/RSS measured 0/24).
11. **GAP-07/08 — hub/shortener allowlists** (low measured prevalence).
12. **GAP-10/11 — render gates** (mechanism confirmed; global yield 0/5 and
    0/11; creator-level completeness only).
13. **GAP-31/32 — asset hygiene and build identity** (budget and observability).

No item is approved. See §14 for proposed dispositions. Do not implement from
this document.

### 11.1 Decision log (to be completed at review close)

| ID | Decision | Rationale | Date | By |
|---|---|---|---|---|
| — | — | — | — | — |

Allowed decisions: `IMPLEMENT`, `DEFER`, `REJECT`, `ACCEPT AS LIMIT`, `NOT REPRODUCIBLE`.

---

## 12. Change log

| Date | Change | By |
|---|---|---|
| 2026-11-26 | Register opened; 27 gaps; Gemini reconciliation; baseline parity check | Pass 1 |
| 2026-11-26 | Production re-baselined to `4f592c02`/schema 209; flags resolved; static/cross-origin/YouTube matrices; 5 new gaps (28–32); scores revised; V1–V8 updated | Pass 2 |
| 2026-11-26 | V4 expanded real-creator benchmark; production re-baselined to `1bf93568`/schema 210; capacity/workload model; random YouTube and render samples; proposed dispositions | Pass 3 |

---

## 13. V4 expanded real-creator benchmark (Pass 3)

### 13.1 What was sampled

| Sample | Population | Size | Method |
|---|---|---|---|
| A. First-invite suppression | TRADING_CONFIRMED static-FOUND sites with no render | 11 sites | production browser image, baseline + expanded budgets |
| B. GATE_SATURATED | never-rendered capacity-blocked sites | 5 sites | production browser image, baseline budget |
| C. CreatorLikelyTrading no-match | UNCERTAIN/NEEDS_REVIEW static no-match/no-render | 7 selected; 3 rendered | production browser image, baseline + expanded |
| YouTube targeted | channels with recorded invites | 10 channels | Innertube public surfaces |
| YouTube random | 56 low-coverage + 34 zero-invite channels (two waves) | 90 channels | Innertube public surfaces |
| RSS/XML | unsupported feed/content URLs | 12 | live fetch + regex |
| PDF | unsupported PDF URLs | 12 | `strings` + regex (no PDF text tool installed) |

The browser runs used the production image (`1bf93568`), real Chromium, the
production crawler, `crossOriginEnqueue` baseline off / expanded on, and the
governor disabled **only inside the disposable container** to measure yield.
The host is 4 cores/7.8 GB; a one-slot, 1.5-CPU, 2 GB container was used.

The three C sites rendered with the gate bypassed produced **0 invites** (2
bounded, 1 complete). Together with the 5 GATE sites and 11 first-invite sites,
the real render sample is **0 globally new live invites across 19 sites**. This
does not prove the unexamined population is empty; it shows that capacity,
first-invite, and gate fixes need a larger yield sample and should not be sold
on mechanism alone.

### 13.2 Real render results (A/C)

| Site | Mode | Codes | New-to-channel | Globally new live |
|---|---|---|---|---|
| binaryteach.com | baseline/expanded | `xFKjsXKFzT` | 0 | 0 |
| thecryptocornerterminal.com | baseline | `a8kmFkEnA9` (expired) | 0 | 0 |
| thecryptocornerterminal.com | expanded | `a8kmFkEnA9`, `MWucq2Qbnn` | 1 | **0** (`MWucq2Qbnn` already registry-owned) |
| tradersuni.co | baseline/expanded | `tsSV725v3y` | 0 | 0 |
| thortradecopier.com | baseline/expanded | `thortradecopier` (404) | 1 | 0 |
| traderspathway.com | baseline/expanded | `vZwW7xsC9m`, `jyEybDMd` | 0 | 0 |
| 920trading.com | baseline/expanded | `AjjCGjPDNu`, `920trading` | 0 | 0 |
| mattygtrading.com | baseline | `xS6gtcyW7X`, `YxE64nN9` | 0 | 0 |
| shayz.world | baseline/expanded | `aCmMXXzbb9` | 0 | 0 |
| tapewise.app | baseline/expanded | `p3XfmzYxAJ` | 0 | 0 |
| nextlevelfunded.com | baseline/expanded | `nextlevelfunded`, `PJ5bbG9zZs` (live), `xwR7v6tB3B` (expired) | 3 | **0** (both live codes registry-owned) |
| forexive.com | baseline | `624u67Y2Az` | 0 | 0 |

**Measured result:** across 11 static-FOUND sites, **0 globally new live
invites**; 2 sites exposed 3 live codes already owned by other channels. The
first-invite suppression mechanism is real, but the global-yield sample is 0/11.
Expanded rendering found one extra live code (`MWucq2Qbnn`) that baseline missed;
that code is a duplicate-owner invite. Creator-level completeness is affected;
global coverage is not, in this sample.

### 13.3 YouTube real yield

| Sample | Channels | Posts | Comments | Older desc | Globally new live | Conclusion |
|---|---:|---:|---:|---:|---:|---|
| Targeted (recorded invites) | 10 | 123 | 186 | 77 | **3** (`wjXSpHeJCm` pinned/creator, `EYNYBGfhgq`, `P8Cu44TSce` older) | high yield in already-invite-bearing creators |
| Random low/zero, wave 1 | 30 | 230 | 268 | 269 | **1** (`9WATnrdpzP`, Community post, live) | 3.3% channel-level yield |
| Random low/zero, wave 2 | 60 | 210 | 176 | 171 | **2** (`bnp4TagEhz`, `monad`, Community posts, live) | 3.3% channel-level yield |
| Random total | 90 | 440 | 444 | 440 | **3** | 3.3% live-new channel-level yield |
| Targeted + random | 100 | 563 | 630 | 517 | **6** | 6% live-new across this 100-channel sample |
| Random comments | 90 | — | 444 | — | 0 | comments yielded none in random sample |
| Random older descriptions | 90 | — | — | 440 | 0 | older descriptions yielded none in random sample |

The random Community-post hit is a real creator invite, absent from the
registry. The targeted sample shows what the surfaces can yield when the
creator is already known to use Discord; it is not a population estimate.

### 13.4 Content-type and extraction yield

| Surface | Sample | Codes found | Live | Conclusion |
|---|---:|---:|---:|---|
| RSS/XML/Atom | 12 | 0 | 0 | no measured yield |
| PDF | 12 | 0 | 0 | no measured yield; PDF text tool absent, compressed PDFs may hide text |
| Reserved-code fixture | 26 codes | 16 valid | — | fix is correctness, not volume |
| Tag/base64/double-encode | fixtures | missed | — | fix is correctness |
| XHTML | fixture | missed static; found when rendered | — | render can rescue; static gate is the issue |

### 13.5 Capacity and workload model

| Metric | Value |
|---|---:|
| Creator-website URL rows | 73,040 |
| Browser-executed | 9,099 |
| Never browser-executed | 63,941 |
| `GATE_SATURATED` site inspections | 11,111 |
| Current nominal render ceiling | 64/h (72/h emergency) |
| Browser slots | 2, hard-capped in code (`MAX_BROWSER_RUNTIME_CONCURRENCY=2`) |
| One-pass 73,040 URL workload at 64/h | ~47 days |
| One-pass 90,556 URL rows at 64/h | ~59 days |
| 30-day refresh requirement | ~101–126/h |
| 14-day refresh requirement | ~216–269/h |
| 7-day refresh requirement | ~432–539/h |
| Daily refresh requirement | ~3,022–3,773/h |
| Measured baseline render time | ~11–112s; ~55s typical |
| Measured expanded render time | ~16–166s; ~100s typical |
| Browser memory observed | ~1.0–1.3 GB per active crawler; Crawlee warned at 512–768 MB |
| Host | 4 cores, 7.8 GB RAM; app ~1.2 GB; DB bursty; cannot support >2–3 browser slots safely |

**Architecture implication:** the current process cannot reach the workload by
raising the env var. `MAX_BROWSER_RUNTIME_CONCURRENCY=2` is a code constant, and
the host has no memory/CPU headroom. A dedicated browser worker pool/service is
required for weekly or better refresh; monthly refresh needs at least ~3
expanded workers, weekly ~12, daily ~32–48.

### 13.6 V4 conclusions

1. **Capacity is a real, structural blocker**, not a tuning issue.
2. **First-invite suppression is confirmed but low global yield** (0/11 live
   new globally; 3 duplicate-owner codes). It matters for creator completeness,
   not as the main path to new global invites.
3. **YouTube is the highest measured incremental yield** (3/10 targeted, 3/90
   random = 3.3%; 6/100 total), with pinned, top comments, Community posts, and
   older descriptions all public.
4. **RSS/PDF measured yield is 0/24**; do not prioritize without a larger sample.
5. **Reserved-code and extraction fixes are correctness wins**, not large volume
   gains; still worth doing.
6. **The real render sample is 0 globally new live invites across 19 sites**
   (11 first-invite + 5 GATE + 3 creatorLikelyTrading). Capacity, first-invite,
   and gate fixes remove proven structural losses, but this sample does not
   support attributing a large new-invite yield to them. Pair them with the
   yield-bearing YouTube and navigation work.

### 13.7 GATE_SATURATED sample result

Five `GATE_SATURATED` creator-like sites were rendered in a one-slot disposable
container:

| Site | Pages | Result | Coverage |
|---|---:|---|---|
| aurabotofficial.com | 1 | no invite | BOUNDED |
| habibofficial.com | 0 | no invite | UNKNOWN |
| supercharting.com | 3 | no invite | BOUNDED |
| collectiveshift.net | 1 | no invite | CONTEXT_UNREACHABLE |
| cryptoaccountants.live | 0 | no invite | UNKNOWN |

**Measured GATE yield: 0 live invites / 5 sites.** Two sites inspected zero
pages even with the governor disabled, and the other three were bounded. This is
a small sample; it shows that capacity was not the only limiter, and that
rendering a previously saturated site does not guarantee an invite. The 11,111
sites remain structurally unexamined, and a larger sample is required before
attributing a global yield to capacity.

---

## 14. Proposed dispositions (not approved)

| ID | Proposed disposition | Rationale |
|---|---|---|
| GAP-01 | **Implement** | iframe content unread; static false clean; frame scanning is core |
| GAP-02 | **Implement** | XHR/JSON payloads can hold invites; add response capture |
| GAP-03 | **Implement** | external bundles/runtime strings; browser response/JS capture |
| GAP-04 | **Implement** | new-tab and popup misses; measured matrix |
| GAP-05 | **Implement** | depth/queue boundaries measured; 1M drops |
| GAP-06 | **Defer** | after capacity; use adaptive budgets, not fixed low caps |
| GAP-07 | **Implement (P2)** | hub allowlist/expansion; low but cheap |
| GAP-08 | **Implement (P2)** | shortener resolution; weak-anchor misses |
| GAP-09 | **Implement** | profiler/frontier/sitemap off; enable with canary |
| GAP-10 | **Implement (P3)** | gate mechanism real; measured yield low; evidence-based gate |
| GAP-11 | **Implement (P2)** | always render after FOUND; global yield 0/11 but creator completeness |
| GAP-12 | **Defer** | low-value area/object/rel-me |
| GAP-13 | **Implement** | highest measured incremental yield |
| GAP-14 | **Implement (P2)** | tag-split fixture miss; cheap normalizer |
| GAP-15 | **Implement (P2)** | base64/double-encode fixture miss; cheap normalizer |
| GAP-16 | **Implement (P2)** | redirect/403 body misses |
| GAP-17 | **Implement (P2)** | XHTML inconsistency; cheap |
| GAP-18 | **Defer** | 0/24 measured yield; revisit with larger sample; PDF parser separate |
| GAP-19 | **Out of scope** | OCR/QR cost; no evidence of high yield |
| GAP-20 | **Out of scope** | platform boundary; truthfully surfaced |
| GAP-21 | **Implement (P2)** | 16/26 valid codes; correctness |
| GAP-22 | **Implement (P3)** | case-preserving claim/collision validation; 0 observed but correctness |
| GAP-23 | **Implement** | all supported non-English languages fail; core coverage |
| GAP-24 | **Defer (P3)** | narrow public-surface shapes; low |
| GAP-25 | **Accept as limit** | 2 MB bound is surfaced, not silent |
| GAP-26 | **Defer/measure** | settle timing unproven; add test first |
| GAP-27 | **Implement compliance prerequisite** | robots enforcement before scaling; not a recall gain |
| GAP-28 | **Implement** | pinned surface dead; live creator invite missed |
| GAP-29 | **Implement (P0)** | capacity architecture; dominant blocker |
| GAP-30 | **Implement (P1)** | 78% controls skipped; structural/multilingual exploration |
| GAP-31 | **Implement (P2)** | assets waste static budget |
| GAP-32 | **Implement (P1 observability)** | build identity unknown; required for verification |

---

## Appendix A — Citation index (crawler code identical at `6aaf66e5`/`4f592c02`/`1bf93568`)

| Topic | File:line |
|---|---|
| Render defaults | `server/browserCommunityFallback.ts:413-421` |
| `crossOriginEnqueue` declaration/gate | `server/browserCommunityFallback.ts:71, 5607` |
| Cross-origin anchor click fallback | `server/browserCommunityFallback.ts:2256-2294` |
| Popup classification / cross-origin drop | `server/browserCommunityFallback.ts:5840-5925` |
| Main-frame-only response scan | `server/browserCommunityFallback.ts:1937-1964` |
| Frame count only | `server/browserCommunityFallback.ts:2136-2180` |
| Main-frame `page.content()` | `server/browserCommunityFallback.ts:5003` |
| Open-shadow text join | `server/browserCommunityFallback.ts:2046-2105` |
| Closed-shadow count only | `server/browserCommunityFallback.ts:1691-1716` |
| 64-control window | `server/browserCommunityFallback.ts:3041` |
| Static full-page scan | `server/inspector.ts:769` |
| Static queue/depth caps | `server/inspector.ts:887, 924` |
| Static iframe caps | `server/inspector.ts:1489-1492` |
| Video description cap | `server/inspector.ts:1484` |
| Content-type rejection | `server/inspector.ts:345-346, 542` |
| 404 probe accepts XHTML/XML | `server/inspector.ts:461-490` |
| 401/403 body read only for markers | `server/inspector.ts:456-490` |
| Render gate / multi-invite skip | `server/inspector.ts:2484`; `server/acquisitionLadder.ts:84-89` |
| Ladder/frontier flags | `server/inspector.ts:1850, 1869`; `server/acquisitionLadder.ts:58-62`; `server/frontierManager.ts:101-105` |
| Render escalation predicate | `server/browserCommunityFallback.ts:6527-6535` |
| Hub allowlist | `server/destinationPolicy.ts:17-24` |
| Cross-origin host/page budget | `server/destinationPolicy.ts:236-237` |
| Reserved list / canonical identity | `server/discordCandidates.ts:33, 35` |
| Obfuscation decode | `server/discordCandidates.ts:93-110` |
| Invite extraction regexes | `server/discordCandidates.ts:282-306` |
| Static control parser | `server/staticControlTargets.ts:9-12, 133-210` |
| Dynamic target attributes | `server/crawlerExtraction.ts:50-73` |
| Discord public surfaces | `server/discordPublicSurface.ts:1-60, 356-470` |
| Redirect hop cap | `server/siteProfiler.ts:679` |
| Response cap | `server/crawlResponseBounds.ts:21` |
| Pinned comment type / no producer | `server/youtube.ts:157`; `server/queueManager.ts:4190`; production `PINNED_COMMENT=0` |
| Shortener recognition | `server/acquisitionRelevance.ts:124, 296-297` |

---

**Review status:** open. No implementation until §10 gates and §11 decisions are
explicitly approved.
