# P0.3 — Acquisition-failure classification and retry history

**Snapshot:** 2026-10-27T19:39:36Z (UTC). Latest observation in the snapshot: 2026-10-27T19:36:20Z.
**Window:** trailing 7 days unless stated.
**Production:** Coolify application `7zp5h5tz4dkjteaag4phxyme`, environment `production`, source commit `1a902b181d592ff333f4b8415f8d603e916fc0da`.
**Access:** existing Coolify SSH path, local tunnel `127.0.0.1:55432 -> 10.0.1.5:5432`, role `muse_readonly`. The session was verified with `transaction_read_only=on` and `default_transaction_read_only=on` immediately before the queries.
**Read-only proof:** every statement ran inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`; the SQL file contains only `SELECT` statements. No writes, settings, flags, migrations, queues, concurrency, cleanup, or deployment changes were made.
**Evidence files:**
- `p0_3_acquisition_classification_20261027.sql` — reproducible query script.
- `p0_3_acquisition_classification_20261027.out` — raw output.
- `COOLIFY_ACCESS_VERIFICATION_20261027.md` — access and read-only verification.

> **Access correction:** production is Coolify, not Railway. The GitHub `forensic-read-only-db.yml` workflow and its Railway secret are not the production access path and were not used for this report.

---

## 1. What this report measures

This is an **observation-level classification**, not a labeled recall estimate.

- `external_acquisition_observations` is append-only per fetched URL. A single creator site can contribute many rows (root, child pages, links, assets, malformed template URLs), so absolute counts are not site counts.
- `site_inspections` is latest-state per site. It is reported separately where site-level interpretation matters.
- `outcome = ACQUISITION_FAILED` means the URL was not successfully inspected. `PARTIALLY_INSPECTED` means inspection happened but a named ceiling left coverage incomplete. `INSPECTED_NO_MATCH` is a clean inspected absence; this report tests whether that label is truthful, not whether an invite actually exists.
- Host recovery is a channel-level approximation: a channel is counted as recovered for a host if it has a later `FOUND` observation on that host after an earlier failure. It is not a controlled retry experiment.
- No labeled ground truth exists yet (P0.1). These numbers prioritize engineering work; they do not estimate true recall.

---

## 2. Executive findings

1. **Creator-surface acquisition is still dominated by failure, but the site-level picture is more balanced than the URL-level one.** URL-level creator observations: 120,670 total; 82,106 `ACQUISITION_FAILED` (68.0%), 16,206 `PARTIALLY_INSPECTED` (13.4%), 7,903 `FOUND` (6.5%), 14,455 clean no-match (12.0%). Site-level rows updated in the window: 2,651 total; 1,019 failed (38.4%), 1,054 partial (39.8%), 313 found (11.8%), 45 clean (1.7%), 220 redirected (8.3%).
2. **Static HTTP failure is the largest single bucket.** 61,648 URL observations are static-fetch failures (51.1% of all creator observations). HTTP 404 accounts for 34,833 of the status-bearing failures, 403 for 14,011, 406 for 1,512, and 429 for 1,199.
3. **Rendered capacity is the second-largest bucket.** 18,319 observations are `RENDERED_FALLBACK_SATURATED` (15.2% of all creator observations); 18,315 of the 32,232 rendered observations have `zeroPageReason = GATE_SATURATED` (56.8%). This is a capacity/gate problem, not a navigation-pattern problem.
4. **Rendered clicking is expensive and mostly unsuccessful.** 46,128 clicks started; 18,310 succeeded (39.7%) and 27,861 failed (60.4%). The failure detail is dominated by `overlay_intercepted` (18,397; 67.7% of detailed failures) and `timeout` (7,130; 26.2%). `target_closed` is 1,617 (5.9%).
5. **Hint filtering is the dominant navigation loss, but it is also the current safety valve.** `hint-rejected` accounts for 1,951,969 rendered drop events; `control-slice` 250,029; `admission-rejected` 49,937. The hint filter is why generic menus are invisible; the slice/rotation work in PR #558 addresses the second-order loss.
6. **Host recovery is highly uneven.** High-recovery hosts include `bitunix.com` (95.7%), `fundednext.com` (93.3%), `tradeify.co` (82.6%), `lucidtrading.com` (42.9%), `linktr.ee` (39.7%), and `apextraderfunding.com` (32.9%). Low/zero-recovery hosts include `whop.com` (8.2%), `skool.com` (3.3%), `patreon.com` (0%), `linkedin.com` (0%), `instagram.com` (0%), `twitter.com` (0%), `docs.whop.com` (0%), and `img-v2-prod.whop.com` (0%). This is direct evidence for host-aware retry (P2.1), not a blanket retry increase.
7. **The retry queue is not starving for due work; it is starving for claims.** 1,599 retry jobs are pending, all 1,599 are due (`run_after <= now()`), all are unlocked, and 1,223 (76.5%) have zero attempts. 812 are `COMMUNITY_REQUIRED_ACQUISITION_FAILURE` and 787 are `BROWSER_RUNTIME_UNAVAILABLE`. In the last 7 days, retry-job attempts were 2,743 failed and 405 completed (87.1% failure). This is a queue/claim/worker-capacity investigation (P2.4/P2.5), not a reason to raise concurrency blindly.
8. **Non-page content is a real but bounded recovery opportunity.** `UNSUPPORTED_CONTENT_TYPE` is 5,830 observations (4.8%). The largest types are image/avif (1,615), PDF (1,284), RSS (663), JavaScript (531), XML (356 + 304), PNG (214), JPEG (195), markdown (135), CSS (124), fonts (100), and XHTML (5). Some are correctly rejected assets; RSS/XML/XHTML/markdown/plain-text wrappers are candidates for bounded extraction (P1.8).
9. **Asset and template filtering has a favorable observed trade-off.** Asset-pattern URLs contribute 1,541 failures and 6 found observations; template/malformed URLs contribute 2,857 failures and 0 found. The #558 admission filter targets this class. The six asset-pattern finds should be reviewed as possible false positives before claiming the filter is lossless.
10. **The current telemetry cannot answer “how much navigation did we skip?”** Production has no pre-filter control denominator, no hint-rejected count in the persisted telemetry (it is only a drop counter), no structural-navigation count, no popup/frame/shadow counts, no base-href flag, and no coverage-reason certificate. P0.2 is required before P1.1/P1.7 can be measured.

---

## 3. Outcome and stage tables

### 3.1 URL-level creator observations (7 days)

| Outcome | Failure class | Observations |
|---|---:|---:|
| ACQUISITION_FAILED | HTTP_ERROR | 51,725 |
| ACQUISITION_FAILED | RENDERED_FALLBACK_SATURATED | 18,319 |
| INSPECTED_NO_MATCH | (none) | 14,455 |
| PARTIALLY_INSPECTED | STATIC_BUDGET_GAP | 10,714 |
| FOUND | (none) | 5,935 |
| ACQUISITION_FAILED | UNSUPPORTED_CONTENT_TYPE | 5,830 |
| PARTIALLY_INSPECTED | REQUIRED_UNVISITED_BUDGET_GAP | 2,698 |
| ACQUISITION_FAILED | NO_PAGE_PROCESSED | 1,788 |
| PARTIALLY_INSPECTED | RENDERED_INTERACTION_GAP | 1,392 |
| ACQUISITION_FAILED | TRANSIENT_HTTP | 1,310 |
| ACQUISITION_FAILED | RATE_LIMIT | 1,199 |
| PARTIALLY_INSPECTED | RENDERED_TIMEOUT | 995 |
| FOUND | REQUIRED_UNVISITED_BUDGET_GAP | 958 |
| ACQUISITION_FAILED | NETWORK_FAILURE | 941 |
| FOUND | RENDERED_INTERACTION_GAP | 607 |
| ACQUISITION_FAILED | TIMEOUT | 477 |
| FOUND | RENDERED_TIMEOUT | 401 |
| ACQUISITION_FAILED | RENDERED_TIMEOUT | 351 |
| PARTIALLY_INSPECTED | LOGIN_WALL | 156 |
| PARTIALLY_INSPECTED | PAYWALL_WALL | 150 |
| ACQUISITION_FAILED | PERMANENT_ACCESS_BLOCK | 91 |
| PARTIALLY_INSPECTED | (none) | 71 |
| ACQUISITION_FAILED | REDIRECT_LOOP | 58 |
| PARTIALLY_INSPECTED | RENDERED_PARTIAL_COVERAGE | 30 |
| ACQUISITION_FAILED | SSRF_BLOCKED | 17 |
| FOUND | RENDERED_PARTIAL_COVERAGE | 2 |

Totals: **120,670 observations**; 82,106 failed (68.0%), 16,206 partial (13.4%), 7,903 found (6.5%), 14,455 clean no-match (12.0%).

### 3.2 Site-level latest state (7 days)

| Outcome | Sites |
|---|---:|
| ACQUISITION_FAILED | 1,019 (38.4%) |
| PARTIALLY_INSPECTED | 1,054 (39.8%) |
| FOUND | 313 (11.8%) |
| INSPECTED_NO_MATCH | 45 (1.7%) |
| REDIRECTED | 220 (8.3%) |
| **Total** | **2,651** |

The site-level clean rate is only 1.7%. That is consistent with the earlier finding that most sites end in a bounded/partial or failed state, and it makes “clean absence” a weak signal for retry suppression.

### 3.3 Stage attribution

| Stage | ACQUISITION_FAILED | PARTIALLY_INSPECTED | FOUND | INSPECTED_NO_MATCH |
|---|---:|---:|---:|---:|
| static-fetch | 61,648 | 306 | 0 | 0 |
| static-navigation | 0 | 13,412 | 958 | 0 |
| static-parse | 1,788 | 0 | 0 | 0 |
| rendered-gate | 18,319 | 0 | 0 | 0 |
| rendered-fetch | 351 | 995 | 401 | 0 |
| rendered-interaction | 0 | 1,422 | 609 | 0 |
| other/none | 0 | 71 | 5,935 | 14,455 |

The table shows where work is lost: static fetch (51.1% of all observations), rendered gate (15.2%), static navigation (12.0% partial), and rendered interaction (1.2% partial + 0.5% found-with-gap). It also shows that `FOUND` can coexist with a named coverage gap; a found invite does not prove complete navigation coverage.

### 3.4 URL pattern

| Pattern | ACQUISITION_FAILED | PARTIALLY_INSPECTED | FOUND | INSPECTED_NO_MATCH |
|---|---:|---:|---:|---:|
| deep | 60,257 | 10,566 | 3,865 | 9,721 |
| query | 10,683 | 2,898 | 2,897 | 1,863 |
| root | 6,768 | 2,741 | 1,135 | 2,870 |
| asset | 1,541 | 1 | 6 | 1 |
| template/malformed | 2,857 | 0 | 0 | 0 |

Deep/query/root pages are the recall surface. Asset/template rows are 4,398 failed observations (3.6% of the total) with 6 found; they are primarily admission-filter candidates, not extraction targets.

---

## 4. Host classification and recovery

### 4.1 Top hosts by observation volume

| Host | Observations | Found | Failed | Partial | Clean | Found % | Top failure |
|---|---:|---:|---:|---:|---:|---:|---|
| whop.com | 4,977 | 109 | 2,417 | 1,849 | 602 | 2.2 | RENDERED_FALLBACK_SATURATED |
| takeprofittrader.com | 4,897 | 0 | 4,215 | 160 | 522 | 0.0 | HTTP_ERROR |
| tradeify.co | 4,329 | 944 | 3,385 | 0 | 0 | 21.8 | HTTP_ERROR |
| apextraderfunding.com | 3,124 | 285 | 2,699 | 16 | 124 | 9.1 | HTTP_ERROR |
| tradingview.com | 2,812 | 75 | 1,730 | 941 | 66 | 2.7 | HTTP_ERROR |
| bit.ly | 2,649 | 691 | 941 | 599 | 418 | 26.1 | RENDERED_FALLBACK_SATURATED |
| t.me | 2,408 | 12 | 12 | 0 | 2,384 | 0.5 | RENDERED_FALLBACK_SATURATED |
| linktr.ee | 2,336 | 453 | 1,875 | 7 | 1 | 19.4 | HTTP_ERROR |
| go.pbtrading.io | 1,615 | 0 | 1,381 | 91 | 143 | 0.0 | HTTP_ERROR |
| go.abtrading.net | 1,449 | 0 | 1,229 | 47 | 173 | 0.0 | HTTP_ERROR |
| go.eliteoptions.net | 1,442 | 0 | 1,218 | 76 | 148 | 0.0 | HTTP_ERROR |
| lucidtrading.com | 1,374 | 167 | 1,207 | 0 | 0 | 12.2 | HTTP_ERROR |
| blueguardian.com | 1,205 | 185 | 1,020 | 0 | 0 | 15.4 | HTTP_ERROR |
| volfix.net | 1,142 | 0 | 940 | 202 | 0 | 0.0 | HTTP_ERROR |
| img-v2-prod.whop.com | 1,139 | 0 | 1,139 | 0 | 0 | 0.0 | UNSUPPORTED_CONTENT_TYPE |
| ttrades.com | 1,127 | 86 | 1,035 | 0 | 6 | 7.6 | TRANSIENT_HTTP |
| rdf.realdealfutures.com | 1,117 | 201 | 473 | 128 | 315 | 18.0 | RENDERED_FALLBACK_SATURATED |
| deepcharts.com | 1,107 | 0 | 990 | 115 | 2 | 0.0 | HTTP_ERROR |
| atas.net | 1,038 | 198 | 834 | 5 | 1 | 19.1 | HTTP_ERROR |
| fundednext.com | 975 | 104 | 871 | 0 | 0 | 10.7 | HTTP_ERROR |
| my.deepcharts.com | 951 | 0 | 477 | 341 | 133 | 0.0 | HTTP_ERROR |
| refer.tradezella.com | 827 | 211 | 456 | 138 | 22 | 25.5 | RENDERED_FALLBACK_SATURATED |
| linkedin.com | 814 | 0 | 506 | 307 | 1 | 0.0 | RENDERED_FALLBACK_SATURATED |
| dailyforex.com | 811 | 0 | 714 | 97 | 0 | 0.0 | HTTP_ERROR |
| myfundedfutures.com | 757 | 415 | 263 | 0 | 79 | 54.8 | RENDERED_FALLBACK_SATURATED |
| nfa.futures.org | 708 | 0 | 708 | 0 | 0 | 0.0 | UNSUPPORTED_CONTENT_TYPE |
| app.alpha-futures.com | 688 | 0 | 229 | 342 | 117 | 0.0 | RENDERED_FALLBACK_SATURATED |
| market-journal.com | 667 | 0 | 402 | 231 | 34 | 0.0 | HTTP_ERROR |
| jlawstock.com | 658 | 0 | 444 | 75 | 139 | 0.0 | HTTP_ERROR |
| ninjatrader.com | 630 | 0 | 421 | 209 | 0 | 0.0 | HTTP_ERROR |

### 4.2 Channel-level host recovery after an earlier failure

| Host | Failed channels | Recovered | Clean no-match later | Recovery % |
|---|---:|---:|---:|---:|
| linktr.ee | 194 | 77 | 0 | 39.7 |
| whop.com | 146 | 12 | 44 | 8.2 |
| img-v2-prod.whop.com | 146 | 0 | 0 | 0.0 |
| bit.ly | 108 | 20 | 43 | 18.5 |
| tradingview.com | 105 | 18 | 5 | 17.1 |
| docs.whop.com | 101 | 0 | 0 | 0.0 |
| apextraderfunding.com | 85 | 28 | 1 | 32.9 |
| linkedin.com | 83 | 0 | 1 | 0.0 |
| tradeify.co | 69 | 57 | 0 | 82.6 |
| nfa.futures.org | 60 | 0 | 0 | 0.0 |
| patreon.com | 50 | 0 | 0 | 0.0 |
| lucidtrading.com | 49 | 21 | 0 | 42.9 |
| instagram.com | 35 | 0 | 0 | 0.0 |
| app.alpha-futures.com | 33 | 0 | 15 | 0.0 |
| drive.google.com | 31 | 0 | 2 | 0.0 |
| tinyurl.com | 30 | 7 | 7 | 23.3 |
| fundednext.com | 30 | 28 | 0 | 93.3 |
| skool.com | 30 | 1 | 4 | 3.3 |
| takeprofittrader.com | 29 | 0 | 25 | 0.0 |
| calendly.com | 27 | 0 | 23 | 0.0 |
| twitter.com | 27 | 0 | 0 | 0.0 |
| amzn.to | 25 | 0 | 15 | 0.0 |
| twitch.tv | 24 | 3 | 2 | 12.5 |
| bitunix.com | 23 | 22 | 0 | 95.7 |
| forms.gle | 23 | 0 | 7 | 0.0 |

**Interpretation:** recovery is host-dependent, not uniform. A host-aware policy should prioritize hosts with demonstrated recovery and avoid burning attempts on hosts with zero recovery and no clean-later evidence. This is a hypothesis for P2.1 and requires a canary; it is not implemented here.

---

## 5. Content type and HTTP status

### 5.1 HTTP status for status-bearing acquisition failures

| Status | Observations |
|---:|---:|
| 404 | 34,833 |
| 403 | 14,011 |
| 406 | 1,512 |
| 429 | 1,199 |
| 400 | 1,054 |
| 500 | 982 |
| 401 | 199 |
| 999 | 143 |
| 405 | 95 |
| 603 | 81 |
| 503 | 59 |
| 410 | 50 |
| 409 | 31 |
| 502 | 21 |
| 402 | 13 |
| other | 33 |

404 dominates. Some of these are genuinely dead child URLs; some are malformed/template URLs. The pattern table separates the latter. 403/406/429 are access/rate classes and are candidates for host-specific handling, not blanket retries.

### 5.2 Unsupported content types

| Content type | Observations |
|---|---:|
| image/avif | 1,615 |
| application/pdf | 1,284 |
| application/rss+xml | 663 |
| application/javascript | 531 |
| text/xml | 356 |
| application/xml | 304 |
| image/png | 214 |
| image/jpeg | 195 |
| text/markdown | 135 |
| text/css | 124 |
| font/otf | 100 |
| application/octet-stream | 73 |
| unknown | 69 |
| application/opensearchdescription+xml | 31 |
| application/force-download | 21 |
| image/x-icon | 18 |
| application/atom+xml | 17 |
| text/csv | 15 |
| text/javascript | 14 |
| text/calendar | 12 |
| application/xhtml+xml | 5 |

Images, PDFs, CSS, fonts, and JavaScript are mostly correct rejections. RSS/Atom/XML/XHTML/markdown/plain-text wrappers are the bounded extraction candidates for P1.8. The current code rejects XHTML/XML at the 2xx gate; that is a confirmed gap, but the observed volume is modest.

---

## 6. Rendered interaction telemetry

Snapshot of rendered creator observations:

| Metric | Value |
|---|---:|
| Rendered observations | 32,232 |
| With at least one inspected page | 11,774 (36.5%) |
| Pages inspected | 19,615 |
| Requests started | 19,608 |
| Requests failed | 11,853 |
| Blocked requests | 68,343 |
| Clicks started | 46,128 |
| Clicks succeeded | 18,310 (39.7%) |
| Clicks failed | 27,861 (60.4%) |
| Navigation timeouts | 4,115 |
| Budget exhausted | 4,794 |
| Host backoffs applied | 0 |

### 6.1 Click failure detail

| Failure kind | Count | Share of detailed failures |
|---|---:|---:|
| overlay_intercepted | 18,397 | 67.7% |
| timeout | 7,130 | 26.2% |
| target_closed | 1,617 | 5.9% |
| other | 43 | 0.2% |

Overlay interception and timeout are the dominant click failures. This is evidence for P1.1/P1.3/P1.4 work that expands navigation surfaces, but it also warns that adding more click targets without handling overlays/timeouts will mostly add failed clicks. The click budget is already 60% wasted.

### 6.2 Rendered drop reasons

| Drop reason | Count |
|---|---:|
| hint-rejected | 1,951,969 |
| control-slice | 250,029 |
| admission-rejected | 49,937 |
| already-visited | 4,873 |
| queue-exhausted | 4,526 |

`hint-rejected` is the largest navigation loss by an order of magnitude. This is the direct measurement behind P1.1: generic menu/navigation controls are filtered before they can be clicked. `control-slice` is the second-order loss addressed by #558's full-pool rotation; it remains large because the evaluation window is bounded.

### 6.3 Rendered ceilings and zero-page reasons

| Ceiling | Observations |
|---|---:|
| total-timeout | 4,794 |
| (none) | 27,438 |

| Zero-page reason | Observations |
|---|---:|
| GATE_SATURATED | 18,319 |
| (none) | 12,273 |
| PRE_HANDLER_REQUEST_FAILURE | 1,617 |
| HANDLER_ENTERED_NO_PAGES | 23 |

`GATE_SATURATED` is the capacity signal. It is not a navigation bug, and it should not be “fixed” by increasing concurrency in this workstream.

### 6.4 Scrolls used

| scrollsUsed | Observations |
|---:|---:|
| 1 | 6,841 |
| 2 | 2,232 |
| 3 | 1,295 |
| 4 | 509 |
| 5 | 333 |
| 6 | 246 |
| 7 | 92 |
| 8 | 52 |
| 9 | 10 |
| 10 | 10 |
| 11 | 112 |
| 12 | 7 |
| 14 | 2 |
| 16 | 1 |
| 17 | 1 |

`scrollsUsed` is a total counter across the rendered pass, not a per-page cap proof. The current telemetry cannot distinguish “stopped because the page stopped growing” from “stopped at the cap while still growing.” P0.2 must add `scrollCapReachedStillGrowing`; P1.7 must turn cap exhaustion into a coverage reason.

---

## 7. Retry history and queue state

### 7.1 `RETRY_COMMUNITY_ACQUISITION` jobs

| Status | Jobs | Zero attempts | 1–2 attempts | 3+ attempts | Avg attempts | Due |
|---|---:|---:|---:|---:|---:|---:|
| PENDING | 1,599 | 1,223 | 281 | 95 | 0.4 | 1,599 |
| COMPLETED | 930 | 0 | 877 | 53 | 1.2 | 930 |
| FAILED | 412 | 0 | 2 | 410 | 5.0 | 412 |
| PROCESSING | 3 | 0 | 3 | 0 | 1.3 | 3 |

### 7.2 Pending retry reasons

| Retry reason | Pending | Zero attempts | Unlocked | Due |
|---|---:|---:|---:|---:|
| COMMUNITY_REQUIRED_ACQUISITION_FAILURE | 812 | 592 | 812 | 812 |
| BROWSER_RUNTIME_UNAVAILABLE | 787 | 631 | 787 | 787 |

### 7.3 Attempt outcomes (last 7 days)

| Attempt status | Attempts | With error |
|---|---:|---:|
| FAILED | 2,743 | 2,743 |
| COMPLETED | 405 | 0 |
| PROCESSING | 3 | 0 |

**Finding:** 1,223 due, unlocked, zero-attempt retry jobs is a claim/scheduling problem. It is not explained by `run_after` being in the future and not explained by job locks. The two retry reasons split almost evenly, so both the community-required path and the browser-runtime path are affected. This should be investigated as P2.4 (queue claiming, worker availability, and re-dating) before any concurrency or budget increase. The 87.1% attempt failure rate also argues against simply increasing retry volume.

---

## 8. Sample frame for manual review

A 20-row sample of recent failed creator observations, with URLs and detail sanitized, is in the raw output under `## sample_failed_observations`. It shows the expected mix:

- dead child pages and 404 template artifacts on creator domains,
- 403 access blocks on course/platform hosts,
- rendered saturation on short links and course hosts,
- image/AVIF content rejections on CDN hosts.

This is a **sample frame**, not a labeled sample. It is suitable for selecting P0.1 cases and for checking whether a proposed filter would drop a legitimate page. It is not sufficient to estimate recall.

---

## 9. Actionability matrix

| Failure class / signal | Action | Phase | Constraint |
|---|---|---|---|
| `RENDERED_FALLBACK_SATURATED` / `GATE_SATURATED` | Capacity/queue investigation; host-aware scheduling | P2.4/P2.5 | No concurrency change without separate approval |
| Static 404 with template/malformed pattern | Admission filter; verify no legitimate page loss | #558 / P1.8 | Already partly implemented in #558 |
| Static 404 on dead child URLs | Root re-seed/sitemap probe hypothesis; do not blanket retry | P2.3 | Experiment only |
| 403/406/429 | Host-specific escalation/backoff; page-level retry for link hubs | P2.2 | Canary; no WAF evasion |
| RSS/Atom/XML/XHTML/markdown/plain text | Bounded content-type extraction | P1.8 | Parser safety tests |
| `RENDERED_INTERACTION_GAP` | Coverage reason + retry targeting | P1.7 | Must not label clean |
| `hint-rejected` | Structural navigation discovery (menu/nav/hamburger) | P1.1 | Bounded; no click-everything |
| `control-slice` | Full-pool rotation (already in #558) | #558 | Review/merge dependency |
| Overlay/timeout click failures | Overlay dismissal, popup/frame handling, click timeout policy | P1.3/P1.4 | Medium risk; security review |
| Zero-attempt pending retries | Claim/worker investigation | P2.4 | No production change in this workstream |
| `UNSUPPORTED_CONTENT_TYPE` image/PDF/CSS/font | Keep rejected; ensure admission filter catches them | #558 | Check 6 asset-pattern finds |
| `REDIRECT_LOOP` | Non-retryable or bounded hop-cap decision | P1.9 | Retry policy review |

---

## 10. Limits and next steps

- **No labeled ground truth.** These are production classifications, not recall estimates. P0.1 remains the only way to estimate stage-by-stage recall with confidence intervals.
- **Observation-level volume is not site-level prevalence.** The URL-level table is dominated by child/asset fetches. Use the site-level table for prevalence and the URL-level table for work/cost.
- **Host recovery is observational.** It can be confounded by site quality, retry timing, and changes in the crawler. P2.1 must be canaried.
- **The current deployed code lacks P0.2 fields.** The rendered telemetry in this report is the pre-P0.2 schema. P0.2 will add pre-filter totals, hint-rejected counts, structural navigation, popup/frame/shadow presence, base-href, scroll-cap growth, policy exclusions, rendered-gate reasons, and a coverage reason.
- **No production changes were made.** The next implementation step is P0.2 telemetry, followed by P1.1/P1.2/P1.7 on a stacked branch, then the independent P1.5/P1.9 fixes. P2 remains preparation/design until canary approval.

**Reproduce:** `source /root/.pg_prod_ro` and run the SQL file through the verified Coolify tunnel. Do not use the Railway workflow.
