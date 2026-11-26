# Crawler Invite-Discovery Remediation Plan — Evidence-Based Architecture and Rollout

**Status:** PROPOSED — **no implementation, deployment, or production configuration change is authorized**
**Date:** 2026-11-26
**Evidence baseline:** `docs/crawler-invite-coverage-gap-register-20261126.md` (32 gaps, V4 pass 3)
**Production at review:** Coolify `main` `1bf93568`, schema 210 (redeployed twice during the review)
**Objective:** the fullest practical discovery of publicly accessible Discord invites,
including multiple invites per creator and all supported countries/languages.

---

## 1. Decision summary

The evidence does **not** support a series of small limit increases. It supports
four structural changes plus a set of cheap correctness fixes.

### 1.1 Must implement first

| Order | Workstream | Why |
|---|---|---|
| 1 | **YouTube surface acquisition** | strongest measured yield: 6 globally new live invites across 100 channels (3/10 targeted, 3/90 random); pinned comments are dead code; cheap to start |
| 2 | **Dedicated browser rendering service** | largest structural loss: 11,111 `GATE_SATURATED`, 63,941 creator-website rows never rendered, 64/h/2 slots, 47-day pass; measured render yield is 0/19, so pair with yield-bearing work |
| 3 | **Static navigation v2** | depth 3 and 13th queued link measured as missed; ~1.0M depth drops; profiler/frontier/sitemap all off |
| 4 | **Cross-origin new-tab and popup inspection** | same-tab works, new-tab OFF misses, `window.open` misses even with the flag ON |
| 5 | **Multilingual navigation for all supported countries** | all 10 supported non-English languages failed the CTA fixture |

### 1.2 Implement with the first wave (cheap, correctness)

- Remove/validate the 16 valid reserved codes.
- Case-preserving registry claim + collision validation.
- Pinned-comment fetcher; top comments; older uploads; Community posts.
- Tag-fragment rejoin; base64/double-encoding; redirect `Location`/non-2xx body scan.
- XHTML content type; asset URL admission.
- Build identity and V4 benchmark harness.

### 1.3 Defer / accept / out of scope

| Item | Disposition | Reason |
|---|---|---|
| First-invite suppression (GAP-11) | **Implement P2** | real mechanism, 170 sites; V4 global yield **0/11** live new; 3 duplicate-owner codes; creator-level completeness matters |
| `creatorLikelyTrading` gate (GAP-10) | **Implement P3** | 7 measured no-match sites; live sample 0; low yield |
| PDF/docs (GAP-18) | **Defer** | 0 codes in 12 PDFs; 0 in 12 RSS/XML; PDF text tool absent; revisit with larger sample |
| New hubs/shorteners (GAP-07/08) | **Implement P2** | linktr.ee works; stan.store/bit.ly weak-anchor miss; low prevalence |
| Rendered fixed caps (GAP-06) | **Defer** | after capacity; use adaptive budgets; expanded sample used 1–9 pages |
| Closed shadow (GAP-20) | **Out of scope** | platform boundary; already truthfully surfaced |
| OCR/QR (GAP-19) | **Out of scope** | cost; no measured yield |
| Login/paywall/anti-bot | **Accept as limit** | inaccessible by design/external |
| 2 MB response cap (GAP-25) | **Accept** | bounded and surfaced as truncated/partial |
| `robots.txt` (GAP-27) | **Compliance prerequisite** | before scaling; not a recall gain |

No item is approved by this document.

---

## 2. Evidence in one page

| Finding | Measured value | Source |
|---|---|---|
| Production sites inspected | ~17,974 | production DB |
| Rendered-covered | 1,423 (7.9%) | production DB |
| `GATE_SATURATED` | 11,111 sites | production DB |
| Render sites with 0 pages | 13,292 / 15,945 (83%) | production DB |
| `coverageReason=COMPLETE` | 214 sites | production DB |
| Creator-website URL rows | 73,040 | production DB |
| Never browser-executed | 63,941 | production DB |
| Website rows executed | 9,099 (12.5%) | production DB |
| Current render ceiling | 64/h, 72/h emergency, 2 slots | production config + code |
| One-pass 73,040 rows at 64/h | ~47 days | calculation |
| Static depth drops / queue drops | 1,009,186 / 213,082 | production telemetry |
| Depth 2/3 boundary | found / **missed** | fixture |
| Queue 12/13 boundary | found / **missed** | fixture |
| Controls hint-rejected | 120,429 / 153,560 (78.4%) | production telemetry |
| Evidence controls clicked | 1,632 / 46,864 (3.5%) | production telemetry |
| Cross-origin new-tab OFF | **missed** | real browser |
| Cross-origin popup ON | **missed** | real browser |
| Non-English supported languages | **all failed** | fixture |
| Reserved codes valid | 16 / 26 | live Discord API |
| YouTube targeted global new | 3 live / 10 channels | live Innertube |
| YouTube random global new | 3 live / 90 channels (3.3%) | live Innertube |
| YouTube total | **6 live / 100 channels** | live Innertube |
| First-invite global new | 0 live / 11 sites | real render sample |
| GATE_SATURATED real render | 0 live / 5 sites (2 zero-page, 3 bounded) | real render sample |
| CreatorLikelyTrading no-match render | 0 live / 3 sites | real render sample |
| Real render total (A+B+C) | **0 globally new live / 19 sites** | real render sample |
| PDF/RSS measured yield | 0 / 24 | live fetch |

---

## 3. Target architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Control plane (existing app, Postgres)                           │
│  - channel/site/URL work ledger + leases                           │
│  - extraction/validation/ownership/registry                       │
│  - coverage metrics + build identity                              │
└───────────────┬───────────────────────┬──────────────────────────┘
                │                       │
   ┌────────────▼───────────┐   ┌───────▼──────────────────────────┐
   │ Static crawl workers   │   │ YouTube acquisition service      │
   │  - HTTP fetch/parse    │   │  - pinned/top comments           │
   │  - sitemap/frontier    │   │  - Community posts               │
   │  - multilingual links  │   │  - older uploads/playlists       │
   │  - per-host politeness │   │  - API quota + Innertube fallback│
   └────────────┬───────────┘   └───────┬──────────────────────────┘
                │                       │
   ┌────────────▼───────────────────────▼──────────────────────────┐
   │ Dedicated browser rendering service (separate nodes)           │
   │  - N Chromium workers, 1 page/worker, per-host 1               │
   │  - queue claims (Postgres/Redis), heartbeat, retries           │
   │  - frames, XHR/JSON, popups, new tabs, controls, shadow DOM    │
   │  - SSRF/egress guard, robots, rate limits                      │
   └────────────┬───────────────────────────────────────────────────┘
                │
   ┌────────────▼───────────────────────────────────────────────────┐
   │ Extraction & validation                                        │
   │  - no reserved-code rejection                                  │
   │  - case-preserving claim + collision validation                │
   │  - tag rejoin, base64/ROT13, redirect/non-2xx, XHTML           │
   │  - live Discord validation + ownership                         │
   └────────────────────────────────────────────────────────────────┘
```

### 3.1 Why a separate browser service

- `MAX_BROWSER_RUNTIME_CONCURRENCY = 2` is a **code constant**; raising the env
  var does nothing.
- The production host has 4 cores/7.8 GB; app + DB + one browser already use
  ~3.4 GB and 2.5+ cores; a second slot is possible, not 8–16.
- Browser memory measured ~1.0–1.3 GB per active crawler; 8 workers need
  8–12 GB; 16 need 16–24 GB.
- The browser tier must scale independently of the API/DB; otherwise one crawl
  burst starves search/admission.
- A separate service can enforce per-host politeness, egress/IP policy, queues,
  and autoscaling without touching the app process.

### 3.2 Control plane

Keep the existing app/DB for:
- work ledger and leases;
- extraction/validation/ownership;
- registry claims;
- coverage metrics.

Do **not** let browser workers write arbitrary rows directly. Workers claim a
job, crawl, and return a bounded result; the control plane performs candidate
admission, dedupe, and registry claims. This preserves the existing
case-preserving/validation boundary and prevents duplicate owner races.

### 3.3 Static crawl workers

- HTTP-only workers, 32–64 concurrency, per-host 1–2, robots-aware.
- Queue-driven; no fixed depth-2/queue-12 cap.
- Site profiler/sitemap/JSON-LD enabled (currently all off).
- Frontier/stopping by yield and coverage, not arbitrary page counts.
- Multilingual hint lexicon per supported country/language.
- Hubs/shorteners resolved with a bounded redirect chain.
- Assets rejected before queueing (content-type/extension), so they do not
  consume community-page slots.
- Conservative only where necessary: per-host rate, SSRF, robots, loops.

### 3.4 Browser rendering service

- Dedicated deployment; 8–16 workers baseline, autoscale to 32+ for daily
  refresh; 16–32 GB RAM, 8–16 vCPU per node; one Chromium per worker.
- Each job: seed URL, surface, lane, priority, budget, attempt, lease.
- Page budget adaptive: normal 20 pages/12 clicks/10 scrolls/120 s; expanded for
  high-value seeds; no hard 6/4/5 cap for discovery.
- Inspect **all frames** (same- and cross-origin) where browser access permits;
  mark `CONTEXT_UNREACHABLE` only when truly inaccessible.
- Capture document + XHR/JSON/text responses; bounded body size; scan for
  invites, community links, and nested URLs.
- Capture new-tab/popup destinations; inspect content in a controlled page; do
  not drop cross-origin popups.
- Open shadow DOM + declarative shadow roots; closed roots counted.
- Structural control enumeration: all anchors/buttons/role controls; multilingual
  labels; inspect hrefs without clicking when possible; click only disclosures,
  popups, and safe actions. No destructive form submissions.
- Always render a static-FOUND site at least once (first-invite suppression
  removed), subject to capacity and dedupe.
- Per-host concurrency 1, global worker concurrency N; robots, backoff, 429.

### 3.5 YouTube acquisition service

- Pinned comment: `commentThreads.list` (or Innertube) with `is_pinned` /
  `author_is_channel_owner`; pass to the existing inspector.
- Top comments: first 1–2 pages, sorted top/newest; creator comments prioritized.
- Older uploads: uploads playlist pagination, not a 100-unit `search.list` per
  10 videos; scan descriptions for videos 11–N.
- Community posts: public Innertube `browse` community tab, paginated; no
  official Data API equivalent.
- Playlists: playlist descriptions/items; sample showed accessible but empty.
- Live chat: live-only, ephemeral; monitor active streams only if approved.
- Dedupe by code; validate live; preserve ownership/provenance.

### 3.6 Extraction and validation

- **Remove the reserved list** or validate every code against Discord; 16/26
  were valid (`store`, `home`, `about`, `contact`, `support`, etc.).
- Preserve case for random codes; case-insensitive only for vanity codes where
  Discord is case-insensitive. On a case-fold collision, validate both codes
  and admit distinct live invites rather than discarding one.
- Rejoin tag-fragmented text; strip/normalize HTML safely.
- Decode base64/ROT13/percent/double-encoded forms; bounded.
- Scan redirect `Location` and non-2xx bodies (401/403/404) for invites.
- Accept `application/xhtml+xml` on 2xx; parse RSS/XML/Atom when text; PDF only
  with a safe parser and after a yield sample.
- Preserve raw evidence/checksums.

### 3.7 Multilingual navigation

- Per-language lexicons for the 17 supported countries / 10 non-English languages:
  join, community, members, access, private, group, signals, links, chat, etc.
- Language detection on page/anchor text; do not rely on English substrings.
- Same-origin remains navigable regardless of label; cross-origin requires
  language-aware evidence.
- Store lexicon version and per-language coverage telemetry.

### 3.8 Coverage observability

- Build identity from `SOURCE_COMMIT` in `/api/version`.
- Per-surface/per-placement recall: static, rendered, YouTube, frames, XHR,
  popups, comments, posts, older videos.
- Global-new vs duplicate-owner vs expired vs invalid.
- Gate wait, zero-page, pages/render, clicks, timeouts, host 429.
- V4 harness in CI with fixtures + real-creator sample; E2E must assert **found**
  for publicly discoverable placements, not merely `assertNotClean`.

---

## 4. Capacity model and sizing

### 4.1 Workload

| Item | Value |
|---|---:|
| Creator-website URL rows | 73,040 |
| Never browser-executed | 63,941 |
| Executed | 9,099 |
| Site inspections | ~17,974 |
| `GATE_SATURATED` | 11,111 |
| Static pages/site | avg 3.7, p95 13 |
| Rendered pages/site today | avg 0.25, p95 1 (saturated) |
| Measured render time | baseline ~11–112 s (~55 s); expanded ~16–166 s (~100 s) |
| Browser memory | ~1.0–1.3 GB/active crawler |

### 4.2 Throughput requirements

| Refresh target | Website rows/day | Renders/hour (1 render = 1 URL) |
|---|---:|---:|
| 30 days | ~2,435 | ~101 |
| 14 days | ~5,217 | ~217 |
| 7 days | ~10,434 | ~435 |
| Daily | ~73,040 | ~3,044 |
| 90,556 total rows, 30 days | ~3,019 | ~126 |
| 90,556 total rows, 7 days | ~12,937 | ~539 |

At the current 64/h, a single pass of 73,040 rows takes **~47 days**; the
90,556-row ledger takes **~59 days**.

### 4.3 Sizing

| Target | Workers at ~100 s/render | RAM at 1.3 GB/worker | CPU guidance |
|---|---:|---:|---|
| 100–150/h (monthly) | 3–5 | 4–8 GB | 4–6 vCPU |
| 400–550/h (weekly) | 12–16 | 16–24 GB | 12–16 vCPU |
| 800–1,000/h | 24–28 | 32–40 GB | 24–32 vCPU |
| 3,000/h (daily) | 84+ | 110+ GB | 64+ vCPU / distributed |

**Recommendation:** start with a dedicated **12–16 worker** browser service on
**16 vCPU / 32 GB** (or 3× 8 vCPU/16 GB nodes with 4 workers each), capable of
~430–580 expanded renders/hour. This supports weekly refresh and clears the
63,941-row backlog in ~5–6 days after cutover. Autoscale to 24–32 workers for
daily/backfill bursts. Do not attempt this on the current 4-core/7.8 GB host.

### 4.4 Queue and database

- Use a durable job queue (Postgres `FOR UPDATE SKIP LOCKED` or Redis) with:
  URL, surface, lane, priority, attempts, lease, heartbeat, budget, result.
- Workers return bounded results; control plane validates/claims.
- Index `(state, next_eligible_at)`, `(channel_id, normalized_url, surface)`,
  `(lease_token)`, `(created_at)`.
- Target 500/h ≈ 0.14 claims/s, well within Postgres; result writes are batched.
- Keep browser workers off the app's DB connection pool; separate role/limits.
- Consider a read replica for metrics only if DB CPU contention persists.

### 4.5 Why not simply remove limits

Removing the governor without capacity would:
- overload the 4-core host and starve API/admission/DB;
- increase timeouts and zero-page runs;
- increase host/domain blocking and duplicate work;
- risk OOM (browser ~1.1–1.3 GB; host already at 3.4 GB used).

Scale the browser tier first, then raise per-job budgets and control exploration.

---

## 5. Workstreams

### WS1 — Dedicated browser capacity (GAP-29, GAP-06)

**Evidence:** 11,111 saturated sites; 83% zero pages; 63,941 unrendered website
rows; 64/h; 2-slot hard code cap; 47-day pass; host 4 cores/7.8 GB. V4 rendered
5 saturated sites with the governor disabled: **0 live invites, 2 zero-page, 3
bounded**. Across the full real render sample (A+B+C) the measured global-new
live yield is **0/19**. Capacity alone does not guarantee an invite; it removes
a proven structural loss and must be paired with the yield-bearing YouTube and
navigation work.

**Solution:** dedicated browser service; 12–16 workers baseline; autoscale to
24–32; remove hard 2-slot cap/global governor; per-host concurrency 1; queue;
adaptive budgets; isolate app/DB.

**Expected coverage:** removes the saturation loss; 430–580 expanded renders/h;
clears the 63,941 backlog in ~5–6 days; enables weekly refresh. Direct invite
yield must be measured; V4 found 0 globally new live in 11 static-FOUND sites
and 0 live in 5 GATE_SATURATED sites. Capacity is necessary to eliminate the
structural loss, but is not by itself a guarantee of new invites.

**Resources:** 16 vCPU/32 GB node (or 3× 8/16 nodes with 4 workers each),
Playwright image, queue, monitoring, egress proxy; ~1.3 GB/worker.

**Dependencies:** queue/indexes, SSRF/robots, control-plane result API.

**Risks:** host overload, OOM, anti-bot, duplicate work; mitigate with isolation,
per-host caps, backoff, canary.

**Verification:** zero-page % < 5; gate wait p95 < 60 s; pages/render p95 ≥ 6;
throughput ≥ 400/h; crash rate < 1%; live/new invite metrics.

### WS2 — Static navigation v2 (GAP-05, GAP-09, GAP-07, GAP-08, GAP-31)

**Evidence:** depth 3 and 13th queue link missed; ~1.0M depth drops; 213k queue
drops; profiler/sitemap/frontier off; hubs/shorteners misses; 1,613 asset sites.

**Solution:** enable site profiler/sitemap/structured navigation; remove hard
depth-2/queue-12; frontier/stopping by yield; multilingual hints; hub/shortener
resolution; asset admission; per-host rate.

**Expected coverage:** reaches depth 3+ and >12 pages; recovers the dropped
population. Invite yield is unmeasured; add a pre/post BFS on a representative
sample before full rollout.

**Resources:** 32–64 HTTP workers, 16 vCPU/16 GB; per-host politeness; queue.

**Dependencies:** queue, robots, multilingual lexicon, content-type admission.

**Risks:** request amplification (static avg 3.7 pages/site; depth 4/queue 100
could 5–10×), crawler traps, host blocking; mitigate with per-host caps, URL
normalization, yield-based stop, canary.

**Verification:** depth-3 fixture found; queue-13 fixture found; no increase in
429/5xx beyond threshold; pages/site and find rate measured.

### WS3 — YouTube surfaces (GAP-13, GAP-28)

**Evidence:** 6 global new live/100 channels total: targeted 3/10; random 3/90
(3.3%). Pinned comment dead; 440 posts/444 comments/440 older descriptions in
the random sample; random comments/older yielded 0 live, Community posts yielded
3 live. Targeted creators yielded comments/pinned/older hits.

**Solution:** pinned/top comments, Community posts, older uploads, playlists;
case-preserving codes; creator-owned provenance; dedupe/validate.

**Expected coverage:** 3.3% random channel-level new (3/90); ~600 new invites
across 18,229 TRADING_CONFIRMED channels as a rough extrapolation (sample
limited); targeted creators higher. This is the strongest measured incremental
surface.

**Resources:** Data API quota (comments/pinned 1 unit; avoid 100-unit search per
10), Innertube fallback, queue, rate limits.

**Dependencies:** extraction/validation, registry, capacity for follow-up site
crawls if comments link to sites.

**Risks:** quota/ToS, comments disabled, noise, ownership; mitigate official API
where possible, bounded pages, creator-author priority, validation.

**Verification:** pinned fixture; top-comment fixture; older-video fixture;
random sample live-new rate; no duplicate registry claim errors.

### WS4 — Cross-origin, new-tab, popup, frames, XHR/JS (GAP-04, GAP-01, GAP-02, GAP-03)

**Evidence:** same-tab OFF found; new-tab OFF missed; popup ON/OFF missed; static
cross-origin iframe false clean; rendered iframes `CONTEXT_UNREACHABLE`; 815
no-match sites with cross-origin drops; 241k drops.

**Solution:** enqueue new-tab targets; open popups in a controlled page and scan
content; frame-tree scan; response listener for XHR/JSON/document; bounded
JS/text scan; cross-origin policy with per-host budgets; mark unread contexts
partial, never clean.

**Expected coverage:** removes the new-tab/popup/frame blind spots; yield
unmeasured (structural). Measure by pre/post fixtures + real sites.

**Resources:** browser service capacity; frame/response memory bounds; egress.

**Dependencies:** WS1 capacity; SSRF; content-type.

**Risks:** memory (frames/JSON), hostile pages, cross-origin policy, data volume;
mitigate bounds, per-host caps, response size caps.

**Verification:** new-tab OFF/ON fixtures; popup ON fixture must find; frame
fixtures; XHR fixture; no false clean.

### WS5 — Extraction correctness (GAP-14, GAP-15, GAP-16, GAP-17, GAP-21, GAP-22)

**Evidence:** 16/26 reserved valid; tag/base64/double/redirect/403/XHTML missed;
case-fold merge collapses; 0 observed collisions.

**Solution:** remove/validate reserved; case-preserving claim with collision
validation; tag rejoin; base64/ROT13/double decode; redirect/non-2xx body;
XHTML; tests.

**Expected coverage:** correctness; reserved likely low volume; tag/base64 low;
redirect/403/XHTML cheap. No large volume claim.

**Resources:** minimal.

**Dependencies:** validation/registry.

**Risks:** false positives; validate live before serving.

**Verification:** unit fixtures + live API; reserved fixture must find; case pair
must keep distinct live codes.

### WS6 — Multilingual navigation (GAP-23)

**Evidence:** all 10 supported non-English languages failed; 12/13 test phrases
missed; 4,489+ channels in non-English-majority countries.

**Solution:** per-language lexicon + language detection; path/anchor evidence;
no English substring reliance.

**Expected coverage:** structural; no live yield yet. Measure on a 20-site
non-English sample before/after.

**Resources:** lexicon maintenance, tests.

**Dependencies:** WS2 static navigation, WS1 if rendered.

**Risks:** false positives, language detection errors; confidence thresholds.

**Verification:** per-language fixture matrix; 20-site non-English sample.

### WS7 — Rendered controls/interaction (GAP-30, GAP-06)

**Evidence:** 120,429/153,560 hint-rejected; 1,632/46,864 evidence clicks;
19,754 skipped; expanded sample up to 9 pages.

**Solution:** structural enumeration; multilingual labels; inspect hrefs/links
without clicking; click disclosures/popups only; adaptive action budget; no
destructive forms; per-page safe-action policy.

**Expected coverage:** unmeasured; likely recovers hidden menus/popups; avoid
clicking everything (cost/risk).

**Resources:** browser capacity; action timing.

**Dependencies:** WS1, WS4.

**Risks:** destructive actions, timeouts, host blocking; safe policy, canary.

**Verification:** unlabeled/hidden fixtures; click budget; no destructive action;
found rate.

### WS8 — Documents and content types (GAP-18; GAP-17 in WS5)

**Evidence:** PDF 292 sites, RSS/XML ~583; V4 0/24 codes; XHTML 2 sites.

**Solution:** XHTML now; RSS/XML text parse; PDF only with a sandboxed parser
after a 100+ sample; docs (docx/xlsx) optional.

**Expected coverage:** measured 0/24; defer PDF/docs; RSS cheap.

**Resources:** parser sandbox, size caps.

**Dependencies:** extraction.

**Risks:** parser vulnerabilities, compressed PDFs; sandbox/caps.

**Verification:** 100+ PDF/RSS sample; found/live; parser fuzz.

### WS9 — Asset hygiene (GAP-31)

**Evidence:** 2,937 unsupported obs/1,613 sites; images/CSS/JS; static avg 3.7
pages/site.

**Solution:** content-type/extension admission before queue; never spend a
community page slot on image/CSS/JS; redirects still followed.

**Expected coverage:** frees static budget; indirect.

**Resources:** minimal.

**Verification:** asset fixture rejected; unsupported obs drop; no lost community
pages.

### WS10 — Observability/build identity (GAP-32)

**Evidence:** `/api/version` commitSha unknown; 3 redeploys during review.

**Solution:** wire `SOURCE_COMMIT`/build time; coverage metrics; V4 harness.

**Expected coverage:** measurement, not coverage.

**Resources:** minimal.

**Verification:** version matches image; metrics dashboard.

---

## 6. Implementation order and dependencies

| Phase | Scope | Depends on | Duration guide |
|---|---|---|---|
| 0 | Build identity, metrics, queue/indexes, V4 harness, robots policy | — | 1–2 weeks |
| 1 | Extraction correctness (WS5), YouTube (WS3), asset hygiene (WS9) | Phase 0 | 2–3 weeks |
| 2 | Static navigation v2 (WS2), multilingual (WS6) | Phase 0/1; queue | 3–4 weeks |
| 3 | Dedicated browser service (WS1) with 8–12 workers, canary | Phase 0; infrastructure | 4–6 weeks |
| 4 | Rendered coverage (WS4, WS7), remove first-invite/gate suppression | Phase 3 | 4–6 weeks |
| 5 | Backfill/reprocess 73k URLs, capacity tuning, PDF/RSS decision | Phase 3/4 | ongoing |

**Critical path:** browser service (Phase 3) must precede broad rendered
coverage, controls, frames, and backfill. YouTube and extraction can ship
earlier and produce measured value while capacity is built.

**Do not** raise static depth/queue and enable frontier/sitemap without per-host
rate limits and a queue; otherwise the added requests can starve the browser
tier and DB.

**Do not** remove the browser governor before the dedicated service is live and
canaried; otherwise the host will OOM/timeout.

---

## 7. Verification and acceptance

### 7.1 Benchmark

- Extend V4 to ≥100 real creator sites, stratified by:
  country/language, static outcome, render state, first-invite, hub/shortener,
  YouTube surface.
- Run baseline vs candidate on the same URLs; validate every new code live;
  classify global-new / duplicate-owner / expired / invalid.
- Report per-placement recall, precision, duplicate rate, live rate.

### 7.2 Tests

- Convert E2E false-clean scenarios to **found** assertions where public:
  new-tab, popup, cross-origin hub, frame, comments/pinned, multilingual.
- Add fixtures for reserved codes, case collision, tag-split, base64, redirect
  403, XHTML, PDF/RSS (if in scope), asset rejection.
- Add a regression test that `INSPECTED_NO_MATCH` requires every discovered
  context to be examined or explicitly partial.

### 7.3 Production metrics

| Metric | Target |
|---|---|
| Gate wait p95 | < 60 s |
| Zero-page render rate | < 5% |
| Pages/render p95 | ≥ 6 (normal), ≥ 15 (expanded) |
| Render throughput | ≥ 400/h baseline, ≥ 800/h peak |
| Host 429/5xx | within baseline, no sustained increase |
| New global live invites/day | measured, not assumed |
| Duplicate-owner rate | tracked, no unexplained rise |
| Coverage by surface/country | reported weekly |

### 7.4 Rollout

- Canary by lane/country: 5% → 25% → 100%.
- Separate browser service; feature flags for frames/XHR/popups/controls.
- Rollback: disable new service/phase flag; keep static/YouTube changes.
- No production config changes without explicit approval.

---

## 8. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Browser OOM/host overload | High if scaled on current host | High | dedicated node, 1.3 GB/worker, autoscale, memory caps |
| DB contention | Medium | High | queue isolation, indexes, batched writes, separate role |
| Anti-bot/429 | High | Medium | per-host 1, backoff, robots, residential/egress policy |
| Crawler traps/depth explosion | High with depth increase | High | URL normalization, per-host caps, yield stop, canary |
| Destructive control clicks | Medium | High | link extraction first, safe-action allowlist, no forms |
| YouTube quota/ToS | Medium | Medium | official API, bounded pages, Innertube fallback |
| Duplicate/case claims | Low | Medium | case-preserving collision validation, live validation |
| PDF parser security | Low | High | sandbox, size caps, defer until sampled |
| Scope creep | High | Medium | phase gates, explicit dispositions |

---

## 9. Approval decisions requested

1. Approve the **V4 benchmark expansion** to ≥100 real creators before Phase 1?
2. Approve **Phase 0/1** (build identity, extraction, YouTube, asset hygiene)?
3. Approve a **dedicated browser service** budget (16 vCPU/32 GB baseline,
   autoscale) for Phase 3?
4. Approve **static depth/queue/frontier** canary in Phase 2?
5. Approve **multilingual lexicon** scope for all 17 countries?
6. Approve **robots compliance** as a prerequisite to scaling?
7. Approve **deferring PDF/docs/OCR/closed shadow** unless new evidence?
8. Approve the **phase order and rollback gates**?

No implementation begins until these are explicitly approved.

---

## Appendix A — Gap-to-workstream map

| Gap | Workstream | Proposed |
|---|---|---|
| GAP-01/02/03/04 | WS4 | Implement |
| GAP-05/07/08/09/31 | WS2/WS9 | Implement |
| GAP-06 | WS1/WS7 | Defer/adaptive |
| GAP-10/11 | WS1/WS7 | Implement P2/P3 |
| GAP-12 | — | Defer |
| GAP-13/28 | WS3 | Implement |
| GAP-14/15/16/17/21/22 | WS5 | Implement |
| GAP-18 | WS8 | Defer |
| GAP-19/20 | — | Out of scope |
| GAP-23 | WS6 | Implement |
| GAP-24/25/26/27 | — | Defer/accept/compliance |
| GAP-29 | WS1 | Implement P0 |
| GAP-30 | WS7 | Implement |
| GAP-32 | WS10 | Implement |

---

**Status:** proposed for review. No code, deployment, or production configuration
change is authorized by this document.
