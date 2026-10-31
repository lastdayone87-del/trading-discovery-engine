# Website navigation, acquisition reliability, end-to-end invite recall, and intelligent browser exploration

**Investigation report — 2026-10-27 (UTC)**

**Status:** Read-only investigation and reporting. No code, schema, settings, flags, queue, concurrency, budget, migration, cleanup, or deployment changes were made. PR #557 remains untouched and on hold. PR #558 was not expanded by this workstream.

**Code basis:** PR #558 head `64b114f` (`fix/invite-extraction-remediation-20261027`), base `cd25da8`; the only delta from `6af84a9` is the first-control rotation exception described in §4.1/§9. Deployed application commit `1a902b181d592ff333f4b8415f8d603e916fc0da` where production behavior is referenced.

**Evidence sources:**
- Source trace of the static and rendered acquisition paths at `64b114f`.
- Prior read-only production snapshots from 2026-10-27T11:00–11:20Z (7-day windows unless stated) and 2026-10-25 discovery measurements.
- `INVITE_EXTRACTION_COMPLETENESS_AUDIT_20261027.md` — 50 format cases, 74 crawl cases, D1–D11/L1–L9/A1–A7 findings.
- `INVITE_EXTRACTION_CONSOLIDATED_REPORT_20261027.md` — approved remediation findings and acquisition/recovery evidence.
- `CRAWLER_DISCOVERY_INVESTIGATION_20261025.md` — prior navigation/discovery investigation.
- PR #558 targeted, browser, TypeScript, and full-suite runs.

**Production access:** evidence was read through the corrected Coolify read-only path documented in `docs/production-infrastructure.md` (PR #564). The session was verified with `transaction_read_only=on` and `default_transaction_read_only=on` before any query. No credential values, connection details, or raw page content are included in this report. The GitHub `forensic-read-only-db.yml` workflow and its Railway secret are not the production access path and are excluded from this workstream.

**Non-claim:** This report does not claim universal invite recall. The controlled matrices demonstrate documented behavior on synthetic/injected-transport fixtures. They do not estimate real-world recall, and they do not substitute for a labeled production sample.

---

## 0. Bottom line

1. **Literal and main-document recall is broad; bounded navigation recall is not.** The crawler reliably finds invites in raw HTML, anchors, scripts/JSON, meta/JSON-LD, iframe `src`/`srcdoc` literals, redirect chains, and ordinary same-origin child pages within its bounds. The controlled matrix produced 0 unexpected misses and 0 false positives across 50 format cases and 74 crawl cases, but 31 of the 74 crawl cases were expected-not-found ceilings. That is evidence of correct bounded behavior, not universal completeness.

2. **Acquisition and capacity are the dominant measured losses, not the invite regex.** In the prior 7-day creator snapshot, `ACQUISITION_FAILED` was 5,981 of 7,931 observations (75.4%), versus `FOUND` 326 (4.1%). Rendered crawling was saturated on 1,550 of 2,265 attempts (68.4%). The largest recall lever is converting failed/partial acquisitions into inspected pages, not widening the invite pattern.

3. **Several navigation gaps are confirmed in code, not merely suspected.** The most important are:
   - **Generic hamburger/menu controls are filtered out before they are ever clicked.** Rendered control enumeration applies `COMMUNITY_HINTS` to control text, href, and `aria-label`; that pattern has no `menu`, `navigation`, `hamburger`, `resources`, or `support` term. A button labeled “Menu” is never a click target, even though its revealed panel may contain the invite.
   - **Icon-only controls that expose only a `title` attribute are invisible to the filter.** The control text includes `innerText`, `href`, and `aria-label`, but not `title`, `aria-labelledby`, child-image `alt`, or `data-*` labels.
   - **Nested menus need every level to match a hint and to fit the 4-click budget.** A generic first-level menu stops the chain before the invite-bearing leaf is reached.
   - **Popups/new tabs are not inspected.** A `window.open(...)` or `target="_blank"` control that reveals a wrapper page is not traversed; only a literal invite URL in the retained control text survives.
   - **Iframes, `object`/`embed`, form actions, and meta-refresh child documents are not traversed.** Literal URLs in their markup are still found by the raw-HTML scan.
   - **Runtime shadow-root content is not serialized by top-document extraction.** Open shadow controls may be clickable, but their text is not part of `page.content()`.
   - **Static navigation ignores `<base href>`.** Relative anchors on base-href pages are resolved against the final URL, so the child page is never fetched.
   - **Rendered link enqueue is same-hostname only.** Cross-origin destinations are reachable only through a click; they are not enqueued through the destination policy.
   - **Weak cross-origin links can produce a clean `INSPECTED_NO_MATCH`.** The policy drop is counted as `cross-origin-disallowed`, but it does not set a coverage ceiling, so the outcome can read as “no invite found” even though a candidate was deliberately not followed.
   - **Scroll-cap exhaustion is not marked incomplete.** A page still growing at 5 scrolls can resolve clean, although more content was never examined.
   - **Non-2xx bodies, XHTML/XML, and UTF-16/32 are not extracted.** 401/403 bodies are read only for block markers; 404/410 bodies only for a terminal-not-found probe; XHTML/XML are rejected at the 2xx gate; UTF-16/32 are decoded as UTF-8.

4. **“No link found” and “navigation not fully inspected” are not consistently distinguished.** Bounded ceilings (`queue-cap`, `depth-limit`, `exploration-limit`, `response-cap`, rendered saturation, interaction gap) are generally partial/retryable. But policy-excluded cross-origin links, hint-rejected rendered links, generic menu controls, popup/frame content, and scroll-cap exhaustion can still resolve as clean absence. That is a truthfulness problem as well as a recall problem.

5. **The rendered tier is a bounded, hint-filtered click pass, not an exploration planner.** It has no navigation graph, no goal inference, no multi-step menu state, no popup/frame planning, no adaptive budget, and only limited failure recovery. Deterministic fixes should come first; a separate design proposal is warranted for goal-directed exploration, not an ad-hoc expansion of PR #558.

6. **Recommended sequence:** measure and classify first (P0), then deterministic navigation coverage fixes (P1), then acquisition-reliability work (P2), then a separate exploration-architecture design (P3), with reporting truthfulness (P4) throughout. None of this is implemented in PR #558, and none should start without explicit approval.

---

## 1. Method, evidence grades, and limits

### 1.1 Evidence grades used below

| Grade | Meaning |
|---|---|
| **Confirmed (code)** | The behavior is directly traceable in source at `64b114f`, and a unit/fixture test or a deterministic matrix case exercises it. |
| **Confirmed (code + test)** | The behavior is traceable and covered by a repository regression or a controlled fixture. |
| **Observed (production)** | Measured in a read-only production snapshot; not re-queried in this session. |
| **Partial** | The behavior exists but is conditional, bounded, or only works for some placements. |
| **Unmeasured** | No reliable prevalence or ground-truth recall measurement exists. |

### 1.2 What was verified

- Static and rendered source paths, including control enumeration, click planning, navigation scoring, admission, extraction, validation, persistence, projection, and telemetry.
- PR #558 targeted suite (7 files) at `64b114f`: 151 tests, 149 pass, 2 fail — the two known baseline failures.
- PR #558 browser/retry suite in CI: 149/149 pass on `64b114f`.
- Full suite at `64b114f`: 3,860 tests, 3,663 pass, 54 fail, 143 skipped. The failing-name set is exactly the baseline `cd25da8` set (54 names; diff empty).
- TypeScript `npx tsc --noEmit` passes at `64b114f`.
- CI at `64b114f`: 21 `verify` jobs, 2 `unit`, 3 `pg-tests`, bootstrap, postgres, and browser community fallback all pass; Greptile Review succeeds. `PR Agent review` fails externally on an invalid Gemini API key, not on branch code.

### 1.3 What was not verified

- No current production DB access in this session (`DATABASE_URL` unset). Production numbers are the last verified read-only snapshot, not live state.
- No labeled real-world recall sample. The 50/50 and 74/74 matrices are synthetic/injected-transport fixtures.
- Local Playwright cannot execute (`Unsupported platform: android`); CI Chromium is the browser execution environment.
- No page-byte archive for failed acquisitions, so some failure causes cannot be re-adjudicated without re-crawling.
- No independent ground truth for whether a given creator actually has a Discord invite.

### 1.4 Baseline discrepancy (must be reported, not smoothed over)

The implementation-phase instruction referred to “two known pre-existing failures.” That is true only for the **targeted 7-file suite**, where exactly two named tests fail:

- `duplicate ownership provenance stores only the owner channel id, never the invite code or assignment`
- `dashboard count, active filter, recent-confirmed filter, and selected candidate stay consistent`

The **full suite** baseline has **54 failures**, not 2. At `cd25da8`: 3,637 pass / 54 fail. At `64b114f`: 3,663 pass / 54 fail / 143 skipped, with an identical failing-name set. PR #558 introduces no new full-suite failure, but the “two failures” framing is inaccurate for the full suite. The final PR report must state both counts and the scope difference; otherwise the release evidence is misleading.

---

## 2. End-to-end pipeline map

The path is best understood as two acquisition tiers sharing one extraction/admission/validation spine.

```
Channel data / creator links
        │
        ▼
[0] Seed selection and normalization
    website links, social profiles, root vs deep path, redirects
        │
        ▼
[1] Static acquisition (fetchExternalPage)
    DNS/SSRF guard → redirects (manual, per-hop) → status/content-type gate
    → bounded body (10s, response cap)
        │
        ├── failure → ACQUISITION_FAILED observation → retry policy
        ▼
[2] Static extraction
    URL + raw HTML: anchors, dynamic attrs, JSON-LD/meta/scripts,
    iframe src/srcdoc literals, wrappers, obfuscation decode
        │
        ▼
[3] Static navigation
    same-origin: all eligible, score/queue/diversity
    cross-origin: known host, strong evidence, structured nomination
    bounds: 12 queue, depth 2, 12 pages, 3 hosts × 2 pages
        │
        ├── FOUND → candidates
        ├── clean no-match → maybe rendered
        └── partial/failed → rendered gate
        ▼
[4] Rendered escalation gate
    staticOutcome != FOUND AND creatorLikelyTrading
    AND surface != OTHER
        │
        ▼
[5] Rendered acquisition (Crawlee/Chromium)
    6 pages, 5 scrolls/page, 4 clicks/page, 64-control window,
    60s total, 15s navigation, route guards, host backoff, session rotation
        │
        ▼
[6] Rendered extraction and interaction
    page.content() before/after scroll/click; retain URL+HTML
    control enumeration (hint-filtered); click loop; enqueueLinks(same-hostname)
        │
        ▼
[7] Navigation/revealed content
    same-hostname enqueue + COMMUNITY_HINTS URL filter
    cross-host anchors clicked; popups/frames/shadow roots not traversed
        │
        ▼
[8] Candidate normalization, dedupe, ownership
    extractDiscordCandidates, decodeInviteObfuscation, mergeDiscordCandidates,
    ownership inference, candidate admission
        │
        ▼
[9] Validation and persistence
    Discord validation (liveness/relevance), candidate selection,
    upsert with last-known-good retention (A1), audit retention
        │
        ▼
[10] Projection and reporting
    serving status, relevance, candidate selection, dashboard,
    acquisition telemetry, outcome classification
```

### 2.1 Stage detail and bounds

| Stage | Implementation | Bounds / policy | Failure/telemetry |
|---|---|---|---|
| **0. Seed selection** | Channel website/social links; `normalizeExternalUrl`; `assessCrawlAdmission`; root vs deep path; redirects | Shared admission; no root ascent by design; social/profile hosts eligible | `NON_PUBLIC_ADDRESS`, `DOTLESS_HOST`, `ASSET_HOST`, `RESOURCE_EXTENSION`, `NON_PAGE_PATH`, `MALFORMED_URL` |
| **1. Static acquisition** | `fetchExternalPage`; `fetchProfilerUrl`; pinned external fetch; DNS/SSRF guard; manual redirects | 10s fetch, response cap, max redirect hops; content types `text/html`, `json`, `plain` for 2xx; 401/403 body for block markers; seed 404/410 body probe | `SSRF_BLOCKED`, `INVALID_REDIRECT`, `REDIRECT_LOOP`, `REDIRECT_LIMIT`, `NETWORK_FAILURE`, `TIMEOUT`, `HTTP_ERROR`, `RATE_LIMIT`, `TRANSIENT_HTTP`, `UNSUPPORTED_CONTENT_TYPE` |
| **2. Static extraction** | `extractDiscordCandidates` on `finalUrl + html`; anchors; `extractDynamicTargetValues`; JSON-LD/meta/script raw scan; iframe `src`/`srcdoc` literals; wrappers; `decodeInviteObfuscation` | Raw HTML, not visibility-aware; non-2xx bodies not scanned; XHTML/XML rejected at gate; UTF-8 default decoder | `discordRegexAttempts`, candidate observations; no per-format miss telemetry |
| **3. Static navigation** | `shouldFollowDestination`; `communityNavigationScore`; `selectDiverseNavigationQueue`; `createDestinationBudget` | 12 queue, 12 explored, depth ≤2, 3 cross-origin hosts × 2 pages; same-origin always eligible; cross-origin needs known host/strong evidence/structured nomination; weak generic cross-origin dropped | `queue-cap`, `depth-limit`, `exploration-limit`, `destination-budget`, `cross-origin-disallowed`, `admission-rejected`, `duplicate` |
| **4. Rendered gate** | `shouldEscalateToRenderedFallback` | Requires `creatorLikelyTrading`; `surface != OTHER`; any static outcome except `FOUND` | Gate not admitted → no rendered work; no telemetry for “would have escalated but classification said no” |
| **5. Rendered acquisition** | Crawlee/Playwright; isolated queue; browser runtime lease; route guards; host backoff; session rotation | 6 pages, 5 scrolls/page, 4 clicks/page, 64-control evaluation window, 60s total, 15s navigation, 2s click timeout | `RENDERED_FALLBACK_SATURATED`, `NO_PAGE_PROCESSED`, `RENDERED_TIMEOUT`, `REQUIRED_UNVISITED_BUDGET_GAP`, `RENDERED_INTERACTION_GAP`, request failures, blocked/rate-limited/transient counts |
| **6. Rendered extraction/interaction** | `page.content()` before/after scroll/click; `retain(url,url)` + `retain(html,url)`; `enumerateRenderedControlNodes`; `runRenderedClickLoop`; `planRevealedRenderedClickTargets` | Control text = `innerText + href + aria-label`; `RENDERED_CONTROL_SELECTOR` = `a,button,[role=button],[role=tab],summary,[aria-expanded=false]`; 64 window; 4 clicks; failed-control rotation stop; first-control anti-freeze | `evidenceControlsTotal/Clicked/Failed/Skipped/Uncertified/OffsetAdvance`; click failure kinds; drop reasons |
| **7. Navigation/revealed content** | `enqueueLinks({strategy:'same-hostname'})`; `admitEnqueueRequest`; `discoverRequiredSeedLinks`; shared evidence registry | Same-hostname enqueue; `COMMUNITY_HINTS` on URL only; cross-host anchors clicked; popups/frames/shadow roots not traversed; required set = seed + same-host hint links | `hint-rejected`, `admission-rejected`, `already-visited`, `control-slice`, `REQUIRED_UNVISITED_BUDGET_GAP` |
| **8. Normalization/dedupe/ownership** | `extractDiscordCandidates`; `decodeInviteObfuscation`; `mergeDiscordCandidates`; `inferDiscordOwnership`; candidate admission | Native code boundary, reserved codes, canonical invite ID, observation merge, ownership score | Candidate observations, ownership reasons; no per-format recall telemetry |
| **9. Validation/persistence** | Discord validator; candidate selection; `upsertChannel` with A1 guard; audit retention; last-verified SQL | Serving status vs relevance; last-known-good retention; explicit cleanup only with `allowDiscordClear` | A1 population/audit; upsert guard; last-verified timestamp; revalidation-uncertain UI flag |
| **10. Projection/reporting** | `discordProjection`; dashboard filters; acquisition reliability metrics; telemetry JSON | Serving `discord_status`, `discord_relevance_status`, candidate selection; UI labels retained-uncertain | Outcome mix, failure classes, drop reasons, ceilings, candidate counts; no ground-truth recall |

### 2.2 Where the two tiers diverge

The static tier is **URL/HTML-first**: it sees all raw anchors and embedded markup, follows same-origin links broadly, and applies an evidence-based cross-origin policy. The rendered tier is **control-first**: it sees runtime DOM and can click, but only controls that match a community hint, and it enqueues only same-hostname URLs. This asymmetry explains several gaps:

- A footer link is visible to static extraction even if it is below the fold, because raw HTML is scanned.
- A hamburger menu is invisible to static extraction if its links are JS-inserted, and invisible to rendered interaction if the control label is generic.
- A cross-origin destination is followable by static navigation when the anchor text is strong, but rendered navigation will not enqueue it; it must be clicked.
- A runtime popup is invisible to both tiers unless the invite URL is literal in the control text.

---

## 3. Capability matrix

Legend: **Yes** = supported and exercised; **Partial** = conditional/bounded; **No** = not supported; **?** = code path exists but production prevalence/ground truth unmeasured.

| Placement / capability | Static DOM | Static hidden/embedded | Rendered DOM | Rendered interaction | Navigation follow | Classification/telemetry |
|---|---|---|---|---|---|---|
| Literal invite in main HTML | Yes | Yes (raw HTML) | Yes | n/a | n/a | `FOUND` |
| Anchor `href` to invite | Yes | Yes | Yes | Yes (retained before click) | Yes | `FOUND` |
| Same-origin child page | Yes | n/a | Yes | Yes | Yes (queue/depth) | `FOUND` / partial on cap |
| Cross-origin strong/known link | Yes | n/a | Yes | Yes (click) | Yes (static policy; rendered click only) | `FOUND` / partial on budget |
| Cross-origin weak/generic link | No (policy drop) | n/a | Partial (click only) | Partial | No (static) | **Can be clean no-match** |
| JS-inserted same-host anchor | No | Partial (script literals) | Yes | Yes if URL hint or clicked | Partial (URL hint only) | Partial |
| JS-inserted cross-host anchor | No | Partial (script literals) | Yes | Yes if control hint | Click only | Partial |
| Generic hamburger / “Menu” | No | No | **No** (hint filter) | **No** | No | **Clean no-match possible** |
| Icon-only, `aria-label="Community"` | No | No | Yes | Yes | n/a | Yes |
| Icon-only, `aria-label="Menu"` / `title="Menu"` | No | No | **No** | **No** | No | **Clean no-match possible** |
| Icon-only, `title` only | No | No | **No** (title not read) | **No** | No | **Clean no-match possible** |
| Dropdown / nested menu | No | Partial (literal links) | Partial | Partial (each level must match hint + budget) | Partial | Partial |
| Tabs / accordion / `summary` | No | Partial | Yes | Yes if label matches | Partial | Partial |
| Footer / secondary / About / Contact | Yes (same-origin) | Yes | Partial | Partial (hint/URL) | Yes, subject to queue/score | Partial |
| Resources / Support page | Yes (same-origin) | Yes | **No** (URL hint lacks terms; control hint lacks terms) | **No** | Static yes; rendered no | **Can be clean no-match** |
| Pagination | Yes | Yes | Yes | Partial | Bounded (depth 2/queue 12/pages 6) | Partial |
| Lazy loading / scroll | n/a | Partial (raw HTML) | Yes | Yes (5 scrolls) | n/a | **Scroll cap not incomplete** |
| Overlay / modal | No | Partial (raw HTML) | Yes | Partial (click; overlay interception) | n/a | Partial |
| Same-tab click navigation | n/a | n/a | Yes | Yes | Yes (in-place inspect) | Yes |
| New tab / popup | n/a | Partial (literal URL) | **No** | **No** | No | **Clean no-match possible** |
| Redirect chain | Yes | n/a | Yes | n/a | Yes (manual/per-hop SSRF) | Yes; `REDIRECT_LIMIT` retryable waste |
| iframe `src`/`srcdoc` literal | Yes | Yes | Partial (main-frame serialization) | n/a | No child traversal | Partial |
| iframe child runtime | No | No | **No** | **No** | No | **Clean no-match possible** |
| `object` / `embed` child | No | Partial (literal URL) | No | No | No | Partial |
| Form `action` / `formaction` | No | Partial (literal URL) | No | No | No | Partial |
| Meta-refresh child | No | Partial (literal URL) | Partial (browser may follow) | n/a | No explicit static follow | Partial |
| Shadow DOM literal in script | Yes | Yes | Partial | Partial | n/a | Partial |
| Shadow DOM runtime content | No | No | **No** (`page.content()`) | Partial (controls may click) | No | **Clean no-match possible** |
| `<base href>` relative anchors | **No** (ignores base) | No | Yes (anchor `.href`) | Yes | Static no; rendered yes | **Clean no-match possible** |
| Relative URLs (no base) | Yes | Yes | Yes | Yes | Yes | Yes |
| `<area>` / SVG anchors | Yes (raw HTML) | Yes | Partial (selector `a`; SVG fixture) | Partial | Partial | Partial |
| Plain-text shortener at seed | Yes | n/a | n/a | n/a | Yes | Yes |
| Plain-text shortener on child page | **No** (page-level wrapper not resolved) | No | Partial (if literal in content) | Partial | No | **Clean no-match possible** |
| XHTML/XML 200 | No | No | No | No | No | `UNSUPPORTED_CONTENT_TYPE` |
| Non-2xx body invite | No | No | No | No | No | `ACQUISITION_FAILED` / terminal |
| UTF-16/32 HTML | No (UTF-8 decode) | No | No | No | No | Miss/garble |
| Common `[dot]` / `%2D` | Yes | Yes | Yes | Yes | n/a | Yes |
| `%2e`, `&period;`, `\u002e`, unbracketed dot | No | No | No | No | No | `INSPECTED_NO_MATCH` |
| Split tags / split JS concatenation | No | No | Partial (runtime may assemble) | Partial | No | Partial |
| Duplicate candidates | n/a | n/a | n/a | n/a | n/a | Merged by canonical ID |
| Duplicate/repeated controls | n/a | n/a | Yes (unique markers) | Yes (rotation) | n/a | Counts/telemetry |
| 64+ controls | n/a | n/a | Yes (full pool) | Yes (rotation; PR #558) | n/a | `evidenceControlsTotal/Skipped` |
| SSRF / non-public destination | Yes | n/a | Yes | n/a | Yes (pre-fetch and redirect) | `SSRF_BLOCKED` |
| Asset/resource/malformed URL | Yes (admission) | n/a | Yes | n/a | Rejected | Reason codes |
| Documents (PDF/XML/feed) | Eligible at admission | No extraction | No | No | Fetch, then content-type reject | `UNSUPPORTED_CONTENT_TYPE` |
| Shorteners / link hubs | Yes (known hosts) | Yes | Yes | Yes | Yes (budget) | Partial |
| Social profiles | Yes | Yes | Yes | Yes | Yes (surface/budget) | Partial; 403/404 issues |
| Invite hosts (`discord.gg`, `discord.com`) | Yes | Yes | Yes | Yes | Yes | Yes |

**Key matrix conclusion:** the crawler is strong on *content already present in the main document or reachable by an ordinary anchor*. It is weak on *navigation that requires a generic control, a new document context, or a second interaction*. Those weaknesses are structural, not regex-level.

---

## 4. Confirmed, partial, and unmeasured gaps

### 4.1 Navigation discovery

#### N1. Generic hamburger/menu controls are filtered out before clicking — confirmed, high priority

**Behavior.** `enumerateRenderedControlNodes` builds control text as:

```text
innerText + href + aria-label
```

and filters the matched control set with `COMMUNITY_HINTS`:

```text
discord|community|join|chat|member|membership|vip|group|private|
trading.?room|links?|social|contact|about|whop|skool|circle|
patreon|premium|paid|subscribe|signals?|mentor|access
```

There is no `menu`, `navigation`, `nav`, `hamburger`, `resources`, `support`, `more`, `explore`, or `company` term. A hamburger button labeled “Menu” therefore never enters the click plan. If its panel contains the only invite link, the rendered tier never sees it. Static extraction also cannot help when the links are JS-inserted.

**Why it matters.** The user explicitly warned not to assume community keywords are required on menu controls. This is the clearest confirmed navigation false-negative source: the control that reveals the invite is generic, while the invite leaf is not.

**Evidence.** Code trace at `server/browserCommunityFallback.ts` (`COMMUNITY_HINTS`, `enumerateRenderedControlNodes`, `partitionRenderedClickTargets`). The controlled matrix does not include a generic hamburger case; this gap is code-confirmed and production prevalence is unmeasured.

**Classification.** A page with only a generic hamburger can resolve as `INSPECTED_NO_MATCH` even though the navigation surface was never inspected. That is a false-clean risk, not merely a bounded-coverage partial.

#### N2. Icon-only labels beyond `aria-label` are invisible — confirmed, medium-high

**Behavior.** The control text includes `aria-label` but not:
- `title`
- `aria-labelledby` referenced text
- child `<img alt>`
- `data-label` / `data-tooltip`
- `value`
- visually hidden text that is not in `innerText` (some CSS-hidden patterns)

An icon-only button with `title="Menu"` or an SVG with `<title>Menu</title>` is not matched. An icon-only button with `aria-label="Community"` is matched.

**Impact.** Common accessible-menu implementations use `title` or `aria-labelledby` rather than `aria-label`; those menus are skipped.

#### N3. Nested/dropdown menus require every level to match and fit the click budget — confirmed/partial

**Behavior.** The click loop re-enumerates after each click, which is the right primitive for multi-step menus. But:
- Each newly revealed control must itself match `COMMUNITY_HINTS`.
- The per-page click cap is 4.
- The 64-control evaluation window rotates across retries, but a nested chain may need two or three clicks before the invite leaf appears.
- A generic first-level “Menu” stops the chain at step zero (N1).
- A first-level “Community” that opens a submenu of generic items (“Servers”, “Groups”, “Links”) may match the first level but not the leaves.

**Impact.** Nested menus are partially supported, not generally supported. A retry can eventually reach leaves only if the intermediate controls match hints and survive the window/rotation.

#### N4. Footer/secondary/About/Contact/Resources pages — partial

**Static tier.** All same-origin anchors are eligible regardless of label, so footer/About/Contact/Resources links are followed if they survive scoring and the 12-item queue. They compete with higher-scoring “discord/community/join” links and pagination. `selectDiverseNavigationQueue` reserves one slot only when the selected top 12 are all the same URL template; it does not guarantee a footer/About slot.

**Rendered tier.** `enqueueLinks` filters on the URL with `COMMUNITY_HINTS`; `about`, `contact`, `links`, and `social` are included, but `resources` and `support` are not. A control labeled “Resources” is not clicked because the control filter also lacks `resources`; a same-host `/resources` URL is not enqueued. A footer “Resources” page with the invite is therefore missed by the rendered tier, and by the static tier only if the static queue reaches it.

**Classification.** Static same-origin navigation is the safety net. If the static tier is clean and the rendered tier is the only tier that could reach the page, the result can be a false clean.

#### N5. JS-inserted links and non-anchor controls — partial

**Behavior.** `RENDERED_CONTROL_SELECTOR` is:

```text
a,button,[role="button"],[role="tab"],summary,[aria-expanded="false"]
```

It does not include:
- `[role="menuitem"]`
- `[role="link"]`
- `[aria-haspopup]` without `role=button`
- clickable `div`/`span` with `onclick`
- `<label>`-driven controls
- `<details>` without `summary` (browser default may still work)
- map areas in rendered mode

JS-inserted anchors are found by the post-click/post-scroll `enqueueLinks` only if their URL matches `COMMUNITY_HINTS`; otherwise they must be clicked as controls and match the control filter.

**Impact.** A menu built from `role="menuitem"` or clickable divs is not enumerated. This is a common pattern in custom navigation.

#### N6. Popups/new tabs are not inspected — confirmed, medium

**Behavior.** There is no `page.on('popup')`, `context.pages()`, or `waitForEvent('popup')` content inspection. A context-wide route covers popup *requests* for redirect enforcement, not extraction. `target="_blank"` cross-host anchors are clicked (cross-host anchors are not skippable), but the resulting popup content is not read.

**What survives.** `attemptRenderedControlClick` retains the control's text and `href` before clicking. A literal `https://discord.gg/...` in the href is captured. A wrapper URL (`linktr.ee/...`, `beacons.ai/...`) is retained as a candidate locator but not resolved by the popup path. If the wrapper is a known host and the static tier saw the anchor, static navigation may follow it; if the link is JS-inserted and only the rendered click exposes it, the wrapper is lost.

#### N7. Iframes, `object`/`embed`, forms, meta-refresh child documents — confirmed, medium-low

**Behavior.** Static extraction scans raw HTML, so literal invite URLs inside `iframe src`, `srcdoc`, `object data`, `embed src`, `form action`, `formaction`, and meta-refresh `url=` are found. But child documents are not fetched or rendered as separate documents, and there is no frame traversal in the rendered tier. A runtime-constructed iframe (`srcdoc` built by JS, or a child document that contains the invite) is not scanned.

**Matrix evidence.** `root-iframe-child`, `root-object-child`, `root-embed-child`, `root-iframe-cross-child` → `INSPECTED_NO_MATCH` / `PARTIALLY_INSPECTED`; literal `iframe src`/`srcdoc` cases were found.

#### N8. Runtime shadow DOM — confirmed, medium-low

**Behavior.** Playwright CSS locators pierce open shadow roots, so controls inside open shadow roots can be enumerated and clicked. But `page.content()` returns the main document serialization, not shadow-root content. An invite rendered as text inside a shadow root is not retained unless it is also present in script source or an attribute.

**Evidence.** Firefox probe: `topHasShadow=false`, `shadowRootHasShadow=true`; literal shadow markup in script source can be found statically (`root-shadow-js` FOUND), runtime shadow-concat is partial.

#### N9. Static `<base href>` — confirmed, medium-low

**Behavior.** `inspectPage` resolves anchors with `new URL(href, current.finalUrl)` and never reads `<base href>`. `discoverRequiredSeedLinks` also resolves against `seedUrl`. The rendered tier uses `HTMLAnchorElement.href`, which honors `<base>`.

**Impact.** A page with `<base href="/community/">` and `<a href="join">` fetches `/join` instead of `/community/join`. The invite page is never scanned. The rendered tier may recover it if the page is rendered, but the rendered gate requires `creatorLikelyTrading` and may not run.

#### N10. Rendered cross-origin enqueue is same-hostname only — confirmed, medium

**Behavior.** Both rendered `enqueueLinks` calls use `{strategy: 'same-hostname'}`. A cross-origin anchor is not enqueued. It is clicked only if it matches the control hint and fits the click budget. The static tier has a cross-origin destination policy, but the rendered tier does not reuse it for enqueue.

**Impact.** A JS-inserted cross-origin link to a link hub or community platform is reachable only by clicking the exact control. If the control is generic, duplicated, or beyond the 4-click budget, the destination is lost even though the static policy would have admitted it.

#### N11. Weak cross-origin drops can be classified clean — confirmed, medium

**Behavior.** `shouldFollowDestination` returns `no-community-evidence` for a weak generic cross-origin link (e.g., “Resources” → another host). `inspectPage` counts `cross-origin-disallowed` but does not set `seedCeiling`. The seed outcome is therefore `INSPECTED_NO_MATCH` if no other gap exists.

**Impact.** The crawler deliberately did not follow a candidate, yet reports clean absence. This violates the “no link found vs navigation not fully inspected” distinction. It is a policy decision, not necessarily a bug, but it must be surfaced as a coverage limitation (or the policy must be reconsidered for generic navigation labels on the same creator-owned host family).

#### N12. Scroll-cap exhaustion is not marked incomplete — confirmed, low-medium

**Behavior.** The rendered loop scrolls up to `maxScrollsPerPage` (5), inspecting after each. If the page is still growing at the cap, the loop ends without setting `interactionGap`, a ceiling, or an incomplete flag. `resolveRenderedCompletionState` considers timeouts, unresolved failures, page-budget cutoff, and interaction gap — not scroll-cap exhaustion.

**Impact.** An infinite-scroll/lazy-loaded page can resolve clean after 5 scrolls although more content was never examined. Prior production snapshot: 5 observations at `scrollsUsed=5`/7d; low prevalence, but the classification is wrong when it occurs.

#### N13. Pagination, depth, queue, destination budgets — confirmed bounded; classification mostly partial

**Static:** 12 queue, 12 explored, depth ≤2, 3 cross-origin hosts × 2 pages. `queue-cap`, `depth-limit`, `exploration-limit`, and `response-cap` set `seedCeiling` and produce `PARTIALLY_INSPECTED`/`STATIC_BUDGET_GAP` (retryable) when no invite is found. `destination-budget` sets `exploration-limit`.

**Rendered:** 6 pages, 60s, 4 clicks/page, 64-control window. Page-budget cutoff and interaction gap are incomplete; saturation is capacity; required unvisited is a gap.

**Gap:** The bounds are truthful in most cases, but the *yield* of relaxing them is unmeasured. Prior production data shows queue-cap 10,423 observations, total-timeout 4,888, depth-limit 3,975, exploration-limit 347, response-cap 188 (7d). Those are coverage ceilings, not proof that the unvisited pages contain invites.

#### N14. Redirects and same-tab/new-tab navigation — partial

**Static:** redirects are followed manually with per-hop SSRF checks; final page content is scanned. `REDIRECT_LIMIT` is marked retryable, so repeated attempts can burn budget on a chain that will never complete within the hop cap. `REDIRECT_LOOP` is non-retryable.

**Rendered:** same-tab navigation after a click is inspected in place; new-tab/popup is not (N6). A click that navigates away can also remove the original page's remaining controls; the code captures anchors before clicks and re-enqueues after, but the click budget is consumed.

#### N15. Deduplication and repeated controls — mostly fixed, residual query variants

**Candidates:** `mergeDiscordCandidates` dedupes by canonical invite ID and merges observations; ownership is inferred on the merged candidate.

**Visits:** `normalizeVisitUrl` lowercases host, trims trailing slash, preserves query; `visited`/`sharedVisited`/`alreadyVisitedSet` use it. Query-parameter variants, tracking parameters, and equivalent paths can still be fetched separately. This wastes budget but is not a direct recall loss.

**Controls:** PR #558 assigns unique `data-oc-control` markers and rotates the full pool; duplicate existing markers are made unique. Repeated controls across pages are not globally deduped, but the per-page marker scheme prevents collisions.

#### N16. Relative URLs — supported except `<base>`

Relative anchors, `srcset`, `data-src`, and dynamic attributes resolve against the current/final URL. The only confirmed relative-URL gap is `<base href>` (N9). Protocol-relative URLs resolve as cross-origin; the destination policy then applies.

---

### 4.2 Acquisition reliability

#### A1. Failure taxonomy and measured mix

The acquisition path classifies failures at several layers. A single observation can carry a status, a failure class, a stage, and retry metadata. The following is the best available 7-day snapshot; counts are observations, not distinct seeds, and windows/surfaces differ, so they should not be summed into one total.

| Dimension | Observed mix | Interpretation |
|---|---|---|
| **HTTP status (bad responses)** | 404: 2,175 (65.0%); 403: 749 (22.4%); 406: 297 (8.9%); 400: 52; 429: 48; 401: 18; 410: 17 | 404 dominates; 403 is the main bot-block class; 406 is concentrated on link hubs |
| **Failure class (7d)** | `HTTP_ERROR` 36,308; `RENDERED_FALLBACK_SATURATED` 13,043 creator + 4,533 social; `STATIC_BUDGET_GAP` 7,869; `NO_PAGE_PROCESSED` 1,761 creator + 3,670 social; `REQUIRED_UNVISITED_BUDGET_GAP` 3,386; `RENDERED_TIMEOUT` 1,517; `RENDERED_INTERACTION_GAP` 1,445 | Capacity and bounded coverage dominate; raw HTTP errors are the largest single class |
| **Content type** | 501 `UNSUPPORTED_CONTENT_TYPE`/7d; 213 page-like | Most are assets/PDF/ICS; some may be legitimate pages (XHTML/XML) |
| **Non-page noise** | 1,022 observations (12.9% of 7,950), 451 sites, 376 channels; 309 pending jobs | Malformed 449, file-extension 321, CDN/proxy 246 (overlapping) |
| **Creator outcome** | `ACQUISITION_FAILED` 5,981 (75.4%); `PARTIALLY_INSPECTED` 1,061 (13.4%); `INSPECTED_NO_MATCH` 563 (7.1%); `FOUND` 326 (4.1%) | Failure is the norm; extraction is not the bottleneck |
| **Rendered** | 2,265 attempts; 1,550 saturated (68.4%); 63 `FOUND` | Rendered capacity is the binding constraint |
| **Retry backlog** | 1,534 due pending; 3 workers at 97.7% utilization; p50 48.5h, max 453.5h | Capacity-bound, not claim starvation |
| **Attempt accounting** | 1,171 `jobs.attempts=0`; 646 have prior `job_attempts`; 525 genuinely never attempted | `jobs.attempts` alone is unreliable for “never attempted” |

#### A2. Non-page/malformed noise — filter implemented in PR #558, residual remains

The new admission filter rejects file extensions, template tokens, CDN/proxy artifacts, and malformed paths while preserving legitimate page slugs (`/files/document.pdf`, `/window.html`, `/let-s-trade-community`, `/function/community`, `/projects/three.js/community`, `/topics/vue.js/discord`). This removes 1,022 observations and 309 pending jobs in the prior snapshot, freeing capacity.

**Residual:** not all noise is URL-classifiable. Examples include quoted script fragments, CSS selectors, and URLs that are syntactically valid but semantically not pages. These need host/pattern classification or extraction-side provenance checks, not a broader regex.

#### A3. 403 is often bot-blocked, not dead — host-aware rendered escalation

403 had 1,063 bad URLs, 108 later `FOUND` (10.2%), 314 same-channel successes (29.5%). Rendered attempts produced most first recoveries (78 vs 29 static). `docs.whop.com` had 64 static 403s and 0 rendered attempts. A blanket “retry 403 with rendered” is not justified: 403 is a mix of real bot-blocked seeds and asset/CDN/social noise. Host-level evidence is required.

#### A4. 404 is mostly dead — root re-seed is a hypothesis, not a proven lever

404 had 3,237 bad URLs, 61 later `FOUND` (1.9%), 369 same-channel successes (11.4%); static was the more common first recovery (43 vs 19). 525 sites had a 404 and no clean/found outcome. Of the 404-only sites, 283 had a 200 root — the sizing basis for P2.3 below — and 76 had a 404 root. Root observation was unavailable for the remaining sites. The root-status counts come from a separate root-observation query and are not a partition of the 525-site outcome count, so they must not be summed with it. Root re-seed/sitemap probing is plausible but unproven; current 404-only conversion is 0 by construction.

#### A5. 406 is concentrated and recoverable — `linktr.ee` page-level retry

406 had 215 bad URLs, 63 later `FOUND` (29.3%), 63 same-channel successes (29.3%); 50 of 63 first recoveries were rendered; p50 22.1h. 297 observations on 3 hosts, overwhelmingly `linktr.ee`; 109/297 were image-like. A page-level 406 retry for link hubs plus an image filter is justified; a blanket 406 retry is not.

#### A6. Rendered saturation is the main capacity loss

2,265 rendered attempts, 1,550 saturated (68.4%), 63 `FOUND`. Saturation is explicit browser-gate capacity, not a browser defect. It is retryable/attempt-free capacity policy, but the queue is already at 97.7% utilization. More extraction or more clicks cannot recover invites from runs that never get a browser slot.

#### A7. Long attempts and lease re-dating distort the backlog

The prior snapshot found 1,534 due jobs, 3 workers at 97.7% utilization, true p50 48.5h, max 453.5h. `jobs.attempts` is unreliable; `job_attempts` shows 646 of 1,171 zero-column jobs have prior attempts. Long-running attempts (32% of >30m attempts complete) consume worker time. A long-attempt cap and queue re-dating are investigation/documentation items; they are not extraction fixes and require separate approval.

#### A8. Content-type and charset gaps

- **XHTML/XML 200:** `fetchExternalPage` accepts only `text/html`, `json`, `plain`; `application/xhtml+xml` and `application/xml` are `UNSUPPORTED_CONTENT_TYPE`, despite the `Accept` header advertising them. D5 ≈38 observations/7d; low prevalence.
- **UTF-16/32:** `readBoundedBody` uses a default `TextDecoder` (UTF-8), ignoring `Content-Type` charset and `<meta charset>`. UTF-16/32 pages break. Unmeasured.
- **Non-2xx bodies:** 401/403 bodies are read only for block markers; 404/410 bodies only for a seed terminal probe; 429/5xx bodies are not read. D6: 11 body-confirmed 404s/7d; low prevalence but a confirmed false negative when the invite is in an error page.

#### A9. Shared admission boundary validation — protects the right things, with residual gaps

The boundary is generic and pre-scoring. It rejects:
- non-http(s) schemes
- empty/dotless hosts
- non-public IP literals
- page-asset infrastructure hosts
- resource extensions (`.js`, images, media, archives, binaries)
- non-page path prefixes (`/images/`, `/icons/`, etc.)
- malformed paths (template tokens, script fragments, control characters)

It deliberately preserves:
- dotted public hosts of any kind, including unfamiliar/affiliate hosts
- documents/feeds (`pdf`, `rss`, `xml`) at admission
- social/profile hosts (`instagram.com`, `x.com`, `patreon.com`)
- invite hosts (`discord.gg`, `discord.com`, `discordapp.com`, `discord.app`)
- shorteners/link hubs (`bit.ly`, `linktr.ee`, `beacons.ai`, `dsc.gg`, `discord.me`, `discord.io`, `disboard.org`)
- legitimate dotted path slugs (`/projects/three.js/community`, `/topics/vue.js/discord`)
- `/files/document.pdf`, `/window.html`, `/let-s-trade-community`, `/function/community`

| Boundary case | Admission | Actual acquisition | Residual risk |
|---|---|---|---|
| `/files/document.pdf` | Eligible | Fetch, then `UNSUPPORTED_CONTENT_TYPE` | Document not scanned for invites |
| `/window.html` | Eligible | HTML scan | None |
| `/let-s-trade-community` | Eligible | HTML scan | None |
| `/function/community` | Eligible | HTML scan | None |
| `/projects/three.js/community` | Eligible | HTML scan | None |
| `/topics/vue.js/discord` | Eligible | HTML scan | None |
| `discord.gg/abc` | Eligible | Direct invite / redirect | None |
| `bit.ly/xyz` | Eligible | Redirect chain | Hop cap; retryable `REDIRECT_LIMIT` |
| `linktr.ee/user` | Eligible | Known host; rendered/static | 406; image noise |
| `instagram.com/user` | Eligible | Social profile | 403/404; rendered failures |
| `x.com/user` | Eligible | Social profile | 403/404; JS-heavy |
| `cdn.discordapp.com/...` | Rejected (asset host) | Not fetched | Correct (asset) |
| `example.com/image.png` | Rejected (resource) | Not fetched | Correct |
| `example.com/images/community` | Rejected (non-page prefix) | Not fetched | Low-risk false rejection |
| `example.com/community.js` | Rejected (resource) | Not fetched | Low-risk false rejection |
| `example.com.` (trailing dot) | Eligible after host strip | Fetch | URL identity/origin edge |
| `example.com:443/community` | Eligible | Fetch | Default-port normalization |
| `example.com//community` | Eligible | Fetch | Server may 404; double-slash edge |
| `discord.gg/%2Dabc` | Eligible | `%2D` fixed | Other encoded letters remain |
| `dsc.gg/abc` plain text | Eligible at admission | Page-level wrapper not resolved | Confirmed gap |
| `application/xhtml+xml` | Eligible | `UNSUPPORTED_CONTENT_TYPE` | Confirmed gap |
| `application/xml` feed | Eligible | `UNSUPPORTED_CONTENT_TYPE` | Confirmed gap |
| UTF-16 HTML | Eligible | UTF-8 decode | Confirmed gap |
| 403 body with invite | Eligible | Body read only for block markers | Confirmed gap |
| 404 body with invite | Eligible | Body probe only, not scanned | Confirmed gap |

**Conclusion:** the boundary is not a domain blacklist and does not obviously discard legitimate creator pages, shorteners, redirects, social profiles, or invite hosts. Its residual failures are mostly downstream of admission (content-type gate, body suppression, charset), not the admission decision itself.

#### A10. Residual causes filtering cannot solve

- DNS failure/timeout and connection/TLS failures.
- 404 dead sites and 403 WAF/bot walls.
- 429 rate limits and `Retry-After` clamping.
- Rendered saturation and worker capacity.
- JS-only pages that need the rendered tier.
- Popup/iframe/shadow content that needs a document-context traversal.
- Auth/paywall content (must not be bypassed).
- Long-running attempts and queue scheduling distortion.
- Sites that are simply not about the creator or have no invite.

These require retry policy, capacity, or navigation architecture changes, not URL filtering.

---

### 4.3 End-to-end recall: loss taxonomy by stage

This table is the core “where can an invite be lost?” inventory. “Falsely presented” means the system reports a clean absence or a confirmed serving invite when the underlying evidence does not support that claim.

| Stage | Loss / misclassification mode | Mechanism | Evidence | Current mitigation | Proposed deterministic test |
|---|---|---|---|---|---|
| **0. Seed selection** | Lost | Deep seed has no invite; root has one; no root ascent | Prior 1/12 root-ascent sample; one redundant case | None by design | Root-vs-deep fixture; assert explicit partial when root not inspected |
| **0. Seed selection** | Misclassified | Trailing dot, explicit port, double slash, encoded host/path | D7 edge probe; 0/2,264 edge-form locators | `%2D` fixed; admission strips trailing dot | URL edge matrix with expected fetch identity |
| **1. Static acquisition** | Lost | DNS/timeout/403/404/406/429/5xx; content-type gate; response cap | 57,808 failed observations; 403/404/406 recovery table | Retry policy; host-aware preparation; rendered escalation | Failure-class fixture per status; assert retryable/terminal |
| **1. Static acquisition** | Misclassified | 404/403 body contains invite but is not scanned; XHTML/XML rejected; UTF-16 decoded as UTF-8 | D5/D6/D10; 501 unsupported content types | None | Body/charset/content-type fixtures; assert candidate or explicit gap |
| **2. Static extraction** | Lost | Obfuscation (`%2e`, `&period;`, `\u002e`, unbracketed dot, split tags/JS); plain-text wrappers; runtime JS | 50-format matrix; 6 obfuscation negatives; 4 runtime negatives | `%2D` only; common `[dot]` | Format matrix as CI regression; wrapper resolution fixture |
| **2. Static extraction** | Discarded | Cross-origin weak link; `shouldFollowDestination` drop | Matrix `cross-origin-weak` clean no-match | Policy; no ceiling | Assert `PARTIALLY_INSPECTED`/coverage-excluded, not clean |
| **3. Static navigation** | Lost | Queue cap 12; depth 2; 12 pages; 3 hosts × 2 pages; score competition; footer/About/Resources crowded out | Matrix queue-cap/depth/exploration; production ceilings | Partial/retryable when ceiling set | Assert partial + reason; labeled sample for yield |
| **3. Static navigation** | Lost | `<base href>` ignored; iframe/object/embed/form/meta-refresh child; JS-inserted non-anchor | D3; matrix 7 child-document gaps | Raw HTML literal scan; rendered tier sometimes | Base-href fixture; child-document fixture; assert no clean absence |
| **4. Rendered gate** | Lost | `creatorLikelyTrading` false; surface `OTHER`; no rendered escalation | Gate code; no telemetry for rejected escalation | None | Gate decision fixture; assert explicit “rendered not admitted” coverage |
| **5. Rendered acquisition** | Lost | Saturation; 6 pages; 60s; navigation timeout; browser launch failure | 68.4% saturation; failure classes | Retry/capacity policy | Saturation fixture; assert capacity class, not clean |
| **6. Rendered extraction** | Lost | `page.content()` misses shadow roots; iframe child; popup; scroll cap | Code; Firefox probe; 5 scroll observations | Scroll inspect; open-shadow controls | Shadow/frame/popup/scroll fixtures |
| **7. Rendered interaction** | Lost | Generic menu/icon-only title; nested levels; `role=menuitem`/clickable div; 4-click budget; 64-window rotation | N1–N5; PR #558 fixed 64-window/failed-control (with first-control anti-freeze) | 64-window rotation; failed-control stop; first-control progress | Hamburger/icon/nested/role fixtures |
| **7. Rendered interaction** | Discarded | Cross-host click navigates away; popup not inspected; control fails | N6; click failure taxonomy | Retain text+href; failure accounting | New-tab/popup fixture; assert wrapper resolution |
| **8. Normalization/dedupe** | Lost | Regex boundary/reserved code; wrapper not resolved; case collisions | Matrix format cases; 0 case collisions | `extractDiscordCandidates`; merge | Format matrix; wrapper resolution; mixed-case identity |
| **8. Normalization/dedupe** | Misclassified | Third-party/uncertain ownership selected or presented as creator-owned | Ownership inference; candidate rank | Ownership score; candidate selection | Ownership fixture; dashboard truthfulness |
| **9. Validation/persistence** | Overwritten | Ambiguous `SUCCEEDED` clears serving invite; later terminal-invalid candidate replaces | A1: 124 channels; 114 ambiguous success | A1 retention; upsert guard; last-known-good | A1 projection/upsert regressions |
| **9. Validation/persistence** | Falsely presented | `discord_status` serving with `discord_relevance_status=UNCERTAIN`; UI must label last-known-good | A1 UI flag; last-verified SQL | UI “previously verified · currently uncertain” | Dashboard fixture; assert label and counts |
| **9. Validation/persistence** | Discarded | Audit cleanup clears retained `UNCERTAIN`; explicit cleanup bypass | A1 audit exemption; `allowDiscordClear` | Retention predicate; audit exemption | Cleanup fixture; assert retained rows survive |
| **10. Projection/reporting** | Misclassified | Clean `INSPECTED_NO_MATCH` after policy-excluded navigation; scroll cap; hint-rejected controls | N1/N11/N12; outcome code | Partial for most ceilings | Coverage-reason telemetry; assert no false clean |
| **10. Projection/reporting** | Falsely presented | Candidate count/non-validated candidates hidden; one candidate shown as only option | Dashboard code; candidate count not displayed | None | Dashboard fixture; assert candidate count/status |
| **10. Projection/reporting** | Unmeasured | No ground-truth recall; synthetic matrices only | 50/74 matrix; no labeled sample | None | Stratified labeled sample with CIs |

**Key distinction:** a `FOUND` result is strong evidence that at least one invite was retained; it is not evidence that *all* invites were found. A clean `INSPECTED_NO_MATCH` is only as strong as the coverage certificate behind it. The system should never present “no invite” when a navigation surface was policy-excluded, hint-filtered, scroll-capped, or contextually unreachable.

---

### 4.4 Intelligent browser exploration assessment

**Current architecture.** The rendered tier is a bounded crawler with a fixed hint filter, DOM-order control enumeration, a rotating 64-control window, 4 clicks/page, 5 scrolls/page, 6 pages, 60s total, and same-hostname enqueue. It is not a planner:
- No navigation graph or state model.
- No goal inference (“find community/invite”).
- No control semantics beyond tag/role and text hints.
- No multi-step menu state beyond re-enumeration after each click.
- No popup/frame/shadow document planning.
- No adaptive budget allocation by expected yield.
- No learning from prior control success/failure beyond durable offset rotation.
- No alternative action when a click fails (e.g., use href, keyboard, force, scroll into view).
- No cross-page control dedupe beyond per-page markers.
- No explicit “navigation coverage” certificate for policy-excluded/hint-rejected/context-unreachable surfaces.

**Interaction effectiveness.** Good for:
- same-tab anchors and buttons with community-hint text
- tabs, summaries, `aria-expanded=false` disclosures
- 64+ controls after PR #558 rotation
- failed-control retry stop, with first-control anti-freeze
- page content before/after scroll/click

Weak for:
- generic hamburger/menu
- icon-only `title`/`aria-labelledby`
- nested menus with generic intermediate labels
- `role=menuitem`/clickable divs
- popups/new tabs
- iframes/child documents
- runtime shadow roots
- overlays that intercept clicks
- cross-origin enqueue

**Efficiency/recall trade-off.** The current bounds are reasonable for cost control, but they are not optimized for recall per unit cost. A planner could:
- prioritize navigation controls (menu, footer, About/Contact/Resources, tabs) over decorative buttons
- expand a menu once and reuse its revealed links across pages
- capture popups and frames as documents
- stop when marginal invite yield is zero
- allocate more clicks to pages with many navigation controls and fewer to pages with none
- dedupe controls by accessible name + href + destination

**Does the architecture need a separate design proposal?** **Yes, for goal-directed exploration.** The deterministic fixes in P1 should not wait for it, but a planner that changes control selection, document contexts, and budget allocation is a separate architecture with its own safety and evaluation requirements. It should be designed and canaried separately, not folded into PR #558 or a narrow navigation patch.

**Proposed design outline (for the separate proposal, not implementation now):**
1. **Observation model:** DOM + accessibility tree + frame tree + open shadow roots + network log + popup pages.
2. **Navigation graph:** nodes = document/state; edges = controls/links; annotate semantic role (menu, tab, accordion, dialog, external, invite), accessible name, href, expected destination, cost, confidence.
3. **Policy:** bounded best-first search with evidence score, structural navigation prior, dedupe, and a stop rule based on marginal yield; no keyword-only gate for structural navigation controls.
4. **Execution:** same-tab, popup, frame, shadow; click → href → keyboard → force fallback; overlay dismissal; settle/wait policy.
5. **Safety:** shared admission/SSRF on every document context; no auth/paywall bypass; bounded per-seed cost; no cross-origin blanket crawl.
6. **Evaluation:** offline replay fixtures, labeled sample, canary; metrics = recall by placement, false-clean rate, cost per found invite, p50/p95 latency, saturation, retry conversion.
7. **Rollout:** default-off, canary, rollback, no concurrency/budget increase without separate approval.

---

## 5. Prioritized recommendations

Nothing below is implemented in PR #558. Priorities reflect recall impact, evidence strength, cost, and risk. “Approval” means explicit approval for a separate change, not approval of this report alone.

| Priority | Recommendation | Evidence | Expected impact | Cost/risk | Dependency |
|---|---|---|---|---|---|
| **P0.1** | Build a stratified labeled sample (200–500 creator sites) and measure stage-by-stage recall with confidence intervals | No ground truth; synthetic matrices only | Converts code-level gaps into weighted recall estimates; prevents over-fixing low-prevalence issues | Read-only data collection + manual labeling; sample selection bias risk | Approval for data collection |
| **P0.2** | Persist navigation-coverage telemetry: pre-filter control total, hint-rejected controls, menu-like controls, popup/frame presence, base-href use, scroll-cap exhaustion, policy-excluded navigation, rendered-gate rejection | Current `evidenceControlsTotal` counts only hint-matched controls; no pre-filter denominator | Makes “not fully inspected” measurable; supports canary metrics | Low; additive telemetry | P0.1 or separate instrumentation PR |
| **P0.3** | Classify acquisition failures by root cause × host × content type × stage × retry history; publish a weekly report | 57,808 failed observations; host recovery classes 1.6%/25.1%/58.4% | Targets retry capacity at recoverable hosts; stops wasting attempts on dead/noise | Read-only queries; no behavior change | Existing telemetry |
| **P0.4** | Reconcile full-suite baseline (54 failures) vs targeted baseline (2) in release reporting | Full suite 54 failures at `cd25da8` and `64b114f`, identical names | Prevents false release claims | Documentation only | None |
| **P1.1** | Generic navigation control discovery: treat menu/navigation/hamburger/`aria-haspopup`/`role=menuitem` controls as structural navigation, not community-keyword controls; expand and inspect revealed content | N1/N3/N5 | Recovers invites behind generic menus; directly addresses user’s acceptance case | Medium; must stay bounded and avoid clicking every control | P0.2 telemetry; separate PR |
| **P1.2** | Icon-only label extraction: `title`, `aria-labelledby`, child `alt`, `data-label`, visually hidden text | N2 | Recovers accessible icon menus | Low-medium | P1.1 |
| **P1.3** | Popup/new-tab capture and inspection: `context.pages()`/`page.on('popup')`, bounded, same admission/SSRF | N6 | Recovers wrapper/invite pages opened in new tabs | Medium; popup lifecycle/cleanup risk | P1.1 |
| **P1.4** | Frame and shadow traversal: same-origin frames, allowed cross-origin frames with admission, open shadow roots; document closed-root limits | N7/N8 | Recovers child-document/shadow invites | Medium-high; frame explosion/SSRF risk | P1.1; separate design review |
| **P1.5** | Static `<base href>` resolution in anchor and required-set discovery | N9 | Fixes relative-link false negatives | Low | Separate PR |
| **P1.6** | Rendered cross-origin enqueue through the destination policy, not blanket same-hostname | N10 | Recovers JS-inserted link-hub/community destinations | Medium; must preserve admission/budget | P1.1 |
| **P1.7** | Coverage truthfulness: policy-excluded, hint-rejected, scroll-capped, popup/frame-unreachable → `PARTIALLY_INSPECTED`/coverage reason, never clean absence | N11/N12; outcome code | Eliminates false-clean claims; improves retry targeting | Low-medium; may increase partial rate | P0.2 |
| **P1.8** | Non-2xx/XHTML/XML/charset/plain-text wrapper extraction: bounded, safe, evidence-preserving | A8; D5/D6/D10; plain-text wrapper gap | Recovers error-page/feed/encoded invites | Medium; parser/security risk | Separate PR; tests |
| **P1.9** | `REDIRECT_LIMIT` non-retryable or higher hop cap for retry; document redirect-loop behavior | A9; retry waste | Stops wasted attempts | Low | Retry policy review |
| **P2.1** | Host-aware retry policy: prioritize recoverable hosts (58.4%), cap low-recovery hosts (1.6%), classify `no_class` first | A3/A5; host classes | Improves retry yield per worker-hour | Medium; canary | P0.3; separate approval |
| **P2.2** | 403 rendered escalation for high-value hosts; `linktr.ee` 406 page-level retry + image filter | A3/A5 | Recovers bot-blocked/link-hub pages | Medium; host-specific | Canary |
| **P2.3** | 404 root re-seed/sitemap probe experiment | A4; 283 404-only sites with 200 root | Hypothesis only; may recover root-only invites | Medium; must be tested | P0.1/P0.3 |
| **P2.4** | Long-attempt cap and queue re-dating investigation | A7; 32% of >30m attempts complete | Frees worker time; reduces backlog distortion | Medium; scheduling risk | Separate approval |
| **P2.5** | Rendered capacity/concurrency change | A6; 68.4% saturation | Throughput gain | High risk; separate approval | Canary; not this workstream |
| **P3.1** | Separate intelligent exploration design proposal | §4.4 | Goal-directed recall per unit cost | Design + canary; high complexity | P0/P1 evidence |
| **P4.1** | Dashboard candidate visibility: candidate count, non-validated candidates, ownership/uncertain labels, last-known-good wording | A1 UI; candidate count absent | Prevents false presentation; operator trust | Low-medium | Product approval |
| **P4.2** | Reporting filters: distinguish `ACTIVE`/serving vs `UNCERTAIN`/revalidation-uncertain in counts and “recent confirmed” | A1; UI flag exists but counts may not | Prevents inflated confirmed counts | Low-medium | Product approval |

### 5.1 Recommended sequence

1. **Approve this report and the measurement plan.** Do not start P1/P2 implementation.
2. **P0 measurement** (telemetry + labeled sample + failure classification + baseline reconciliation). No behavior change.
3. **P1 deterministic navigation coverage** as one or more small PRs, starting with generic menu/icon labels and coverage truthfulness; then popups/frames/shadow, base href, cross-origin enqueue, non-2xx/charset.
4. **P2 acquisition reliability** as canaried changes, one lever at a time; no concurrency/budget increase without separate approval.
5. **P3 exploration design** after P1/P2 data; separate design proposal and canary.
6. **P4 reporting truthfulness** in parallel with P1 where product approves.

### 5.2 Explicit non-goals

- No universal recall claim from synthetic fixtures.
- No blanket cross-origin crawl or removal of admission.
- No regex-only expansion for every exotic obfuscation.
- No CAPTCHA/WAF evasion, auth/paywall bypass, or private-content crawling.
- No queue/schema/settings/migration/concurrency/budget changes in this workstream.
- No production cleanup/purge.
- No changes to PR #557.
- No expansion of PR #558 beyond its current remediation scope.

---

## 6. Measurement gaps and proposed measurement plan

### 6.1 Gaps

1. **No labeled ground truth.** We do not know, for a representative sample, whether an invite exists and where. Synthetic matrices cannot estimate recall.
2. **Control telemetry is post-filter.** `evidenceControlsTotal` counts controls that matched `COMMUNITY_HINTS`, not all controls. A generic menu is invisible in the denominator, so the system cannot report “we skipped 12 menu controls.”
3. **No navigation-coverage certificate.** Policy-excluded cross-origin links, hint-rejected rendered links, popup/frame content, and scroll-cap exhaustion are not consistently represented as coverage reasons.
4. **No stage-level recall attribution.** A `FOUND` result does not say whether it came from seed HTML, a child page, rendered scroll, a click, a popup, or a redirect.
5. **No page-byte archive for failed acquisitions.** Some failures cannot be re-adjudicated without re-crawling.
6. **`site_inspections.observations` is latest-state only.** URL-level history relies on `external_acquisition_observations`.
7. **`jobs.attempts` is unreliable** for “never attempted”; `job_attempts` is the better source.
8. **No host-level recovery model in production.** The snapshot shows 1.6%/25.1%/58.4% recovery classes, but retry policy is not host-aware yet.
9. **No cost-per-found-invite metric.** We know saturation and backlog, not yield per worker-hour or per browser-minute.
10. **No false-clean metric.** We do not measure how often a clean `INSPECTED_NO_MATCH` had an unexamined navigation surface.

### 6.2 Proposed measurement plan

**A. Labeled sample (P0.1).**
- 200–500 creator sites, stratified by acquisition class (FOUND, clean no-match, partial, 403/404/406, rendered/static), disjoint strata, sample-weighted recall.
- Manual labeling: does an invite exist? Where? Which navigation path reveals it?
- Measure recall by stage, mode, placement, and host class; report confidence intervals (±7.3 points at the prior proposed sample size, subject to final design).
- Do not start without approval.

**B. Navigation telemetry (P0.2).**
Add counts (no selectors/text):
- `controlsEnumeratedTotal` (pre-filter)
- `controlsHintRejected`
- `controlsStructuralNavigation` (menu/nav/hamburger/aria-haspopup)
- `popupCount`, `frameCount`, `shadowRootCount`
- `baseHrefPresent`
- `scrollCapReachedStillGrowing`
- `navigationPolicyExcluded` by reason
- `renderedGateRejected` by reason
- `coverageReason` enum: `COMPLETE`, `BOUNDED`, `POLICY_EXCLUDED`, `CONTEXT_UNREACHABLE`, `UNKNOWN`

**C. Acquisition classification (P0.3).**
Weekly report by:
- root cause: DNS, connect/TLS, timeout, HTTP status, redirect, content type, body cap, SSRF, browser launch, saturation, page budget, required gap, interaction gap, parse/isolation
- pattern: root/deep/query/asset/template/malformed
- host: creator, shortener, social, invite, platform, CDN, broker
- content type: HTML, XHTML, XML, JSON, plain, PDF, image, binary, empty
- stage: seed, static fetch, static parse, static nav, rendered gate, rendered fetch, rendered parse, rendered interaction, validation, persistence
- retry history: attempts, prior classes, recovery rate, time since first/last, lease re-dating
- actionability: filter, retry same mode, escalate rendered, host backoff, root re-seed, terminal, manual review

**D. Deterministic end-to-end harness (P1 acceptance).**
- Real Chromium in CI (local Termux cannot run Playwright).
- Fixtures for every acceptance case in §7.
- Assertions on outcome, coverage reason, candidate code, and telemetry — not source-text regex.
- Run against both static-only and rendered paths where applicable.
- Include negative controls: SSRF, private IP, non-http, asset, malformed, cross-origin weak, duplicate, inaccessible.
- Keep synthetic fixtures labeled as behavior tests, not recall estimates.

**E. Success metrics.**
- Recall by placement/stage with CI.
- False-clean rate (clean no-match with an unexamined navigation surface).
- Partial rate and retry conversion.
- Rendered-only yield.
- Cost per found invite (worker-minute, browser-minute).
- p50/p95 acquisition latency.
- Saturation and backlog age.
- No increase in SSRF/admission violations.

---

## 7. Proposed implementation plan and acceptance criteria (after approval)

### 7.1 Phases

**Phase 0 — Approve and freeze.**
- Review this report.
- Approve or reject P0/P1/P2/P3 scope.
- Keep PR #558 frozen except for reviewer-blocking fixes.
- Keep PR #557 untouched.

**Phase 1 — Measurement (no behavior change).**
- Navigation telemetry.
- Labeled sample (if approved).
- Failure classification report.
- Baseline reconciliation (54 vs 2).
- Success metrics dashboard.

**Phase 2 — Deterministic navigation coverage (separate PRs).**
- P1.1 generic menu/navigation controls.
- P1.2 icon-only labels.
- P1.3 popup/new-tab capture.
- P1.4 frames/shadow roots.
- P1.5 `<base href>`.
- P1.6 rendered cross-origin enqueue via destination policy.
- P1.7 coverage truthfulness.
- P1.8 non-2xx/XHTML/XML/charset/plain-text wrappers.
- P1.9 redirect-limit retryability.

**Phase 3 — Acquisition reliability (canary, separate approval).**
- Host-aware retry.
- 403 rendered escalation for selected hosts.
- `linktr.ee` 406 page retry + image filter.
- 404 root re-seed experiment.
- Long-attempt cap / queue re-dating investigation.
- No concurrency/budget increase without separate approval.

**Phase 4 — Intelligent exploration design (separate proposal).**
- Observation model, navigation graph, policy, execution, safety, evaluation, rollout.
- Default-off canary.

**Phase 5 — Reporting/product truthfulness.**
- Candidate count/status.
- Last-known-good/uncertain labels.
- Confirmed-count filters.
- Coverage reason in operator UI.

### 7.2 Acceptance criteria

The following are the minimum end-to-end tests for any future navigation PR. They should run in CI Chromium and assert behavior, not source text.

**Navigation discovery**
1. **Generic hamburger:** a page with a button labeled only “Menu” (no community keyword) opens a panel containing `discord.gg/<code>`; the crawl returns `FOUND` with the code, or an explicit `PARTIALLY_INSPECTED`/coverage reason if the panel is unreachable. It must not return a clean `INSPECTED_NO_MATCH`.
2. **Icon-only labeled menu:** an icon-only control with `aria-label="Menu"` or `title="Menu"` (and no visible text) reveals the invite; the crawl finds it.
3. **Nested/JS menu:** a two-level menu with generic labels (e.g., “Menu” → “Connect” → “Discord”) reveals the invite; the crawl performs the bounded multi-step expansion and finds it.
4. **Footer/secondary nav:** an invite on a footer “Resources” page, reachable only through a footer link, is found within the static/rendered bounds; if the bound is hit, the outcome is `PARTIALLY_INSPECTED` with a reason, not clean.
5. **Navigation/redirect to invite page:** a same-tab link or redirect chain to a page containing the invite is followed and found; popup/new-tab variants are captured and inspected.
6. **Iframe/shadow/base:** an invite in a same-origin iframe child, an open shadow root, and a `<base href>`-relative page is found; closed shadow roots are documented as out of scope, not silently clean.

**Interaction coverage**
7. **64-control boundary:** a 70-control page exposes control 65 after retry rotation; a 64-control page wraps without inventing overflow; the offset advances by minimum page progress and stops at a failed control; a failure at the first attempted control advances past the attempted window instead of freezing the rotation.
8. **Duplicates/repeated controls:** duplicate `data-oc-control` markers are made unique; repeated controls are not double-counted; no control is skipped because of marker collision.
9. **Failed interaction:** if a control fails, the durable offset stops before it; the next retry attempts it; the outcome is not certified complete.
10. **Inaccessible controls:** disabled/hidden/detached/overlay-intercepted controls are bounded, classified, and do not loop; the run is partial/retryable if they could hide the invite.
11. **Bounded execution:** page, click, scroll, time, and control-window caps are respected; every cap that leaves content unexamined produces a coverage reason; no infinite loop or unbounded popup/frame expansion.

**Safety/admission**
12. **SSRF:** private IP, loopback, link-local, metadata, non-http, and redirect-to-private destinations are blocked before fetch; no regression.
13. **Admission:** legitimate pages/documents/shorteners/redirects/social profiles/invite hosts are preserved; asset/resource/malformed URLs are rejected with reason codes; no false rejection of the protected slug cases.
14. **Cross-origin:** a weak generic cross-origin link is either followed under the evidence policy or reported as policy-excluded/partial; it is never a clean absence without a coverage reason.
15. **Non-2xx/charset:** a 403/404 body containing an invite, an XHTML 200, and a UTF-16 page are either scanned correctly or reported as unsupported/partial; they are not silently clean.

**Recall evidence**
16. **Labeled sample:** a stratified sample shows recall improvement with confidence intervals; no universal recall claim is made from synthetic fixtures.
17. **No false clean:** every clean `INSPECTED_NO_MATCH` in the test suite has a complete coverage certificate (no policy-excluded, hint-rejected, scroll-capped, popup/frame-unreachable, or failed-control gap).
18. **No false FOUND:** a third-party/uncertain candidate is not presented as creator-owned without ownership evidence; last-known-good retention is labeled as previously verified/currently uncertain.

**Engineering**
19. TypeScript `npx tsc --noEmit` passes.
20. Targeted navigation/browser tests pass.
21. Full suite introduces no new failures versus the actual baseline (54 failures at `cd25da8`); report both full-suite and targeted counts.
22. No production settings/flags/schemas/queues/concurrency/budgets/migrations/deployments changed without separate approval.

---

## 8. Out-of-scope proposals and rejected directions

| Proposal | Why out of scope / rejected |
|---|---|
| “Universal recall” claim from 50/50 and 74/74 matrices | Synthetic/injected-transport fixtures demonstrate documented behavior, not real-world recall. |
| Regex-only expansion for every obfuscation form | Low measured prevalence; high false-positive/maintenance risk; format matrix already covers common forms. |
| Blanket cross-origin crawl / removing destination policy | Safety and budget risk; weak generic links would open arbitrary hosts. |
| Blanket “retry everything” | 404 recovery is 1.9%; 403/406 are host-specific; blanket retry wastes capacity. |
| Concurrency/budget increase in this workstream | Requires separate capacity approval and canary; not an extraction fix. |
| Queue/schema/settings/migration changes | Separate operational workstream; no production changes authorized. |
| Production cleanup/purge of noise records | Separate approval; read-only investigation only. |
| PR #557 changes | Explicitly on hold and untouched. |
| CAPTCHA/WAF evasion, auth/paywall bypass, private-content crawling | Not authorized; safety/product policy. |
| LLM-driven browsing as a first step | Unnecessary for the confirmed deterministic gaps; adds cost/variance/safety risk. A deterministic navigation graph should come first. |
| Dashboard redesign beyond candidate visibility/truthfulness | Product scope; report only recommends truthfulness fixes. |

---

## 9. PR #558 status (separate workstream)

This section is included because the investigation ran in parallel with PR #558; it is not part of the navigation implementation proposal.

**Head:** `64b114f` on `fix/invite-extraction-remediation-20261027`; base `main`, stacked on CDL v2; mergeable, no approval.

**Implemented remediation (summary):**
- A1 retention/projection/upsert guard/last-verified UI.
- D1 full control enumeration, durable rotation, 64-control evaluation window, all-navigable certificate, anchor-aware offset advancement, telemetry, 70/64-control fixtures.
- Non-page/malformed URL admission filter with reason codes.
- `%2D` decoding with host-boundary/malformed-input regressions.
- SVG anchor href safety, duplicate marker uniqueness, browser fixture plain-JS fix, label trimming.
- Failed-control rotation stop, catch-path control-certificate publication (`6af84a9`), and first-control anti-freeze (`64b114f`).

**Verification:**
- Targeted 7-file suite at `64b114f`: 151 tests, 149 pass, 2 fail (the two known targeted baseline failures).
- Browser/retry CI job at `64b114f`: 149/149 pass.
- `npx tsc --noEmit`: pass at `64b114f`.
- Full suite at `64b114f`: 3,860 tests, 3,663 pass, 54 fail, 143 skipped; failing-name set identical to baseline `cd25da8` (54 names, diff empty).
- CI at `64b114f`: 21 `verify`, 2 `unit`, 3 `pg-tests`, bootstrap, postgres, and browser community fallback pass; Greptile Review succeeds. `PR Agent review` fails externally on an invalid Gemini API key, not branch code.

**Reviewer status:**
- Qodo old findings #1–#5 resolved; new failed-control and catch-telemetry findings fixed in `6af84a9` with regressions and replies.
- Greptile first-control freeze finding fixed in `64b114f` with a regression: a failure at position zero advances past the attempted window instead of pinning every retry to the same controls; failures later in the window still stop at the failed control.
- CodeAnt nitpicks addressed in `e64f7cd`; Greptile check passes on `6af84a9` and `64b114f`; baz-reviewer marked the first-control thread addressed.
- Remaining Qodo country/discovery totals, CodeAnt nitpicks 3–8, and Greptile queue/autonomous/query-planner/native-vocabulary findings are pre-existing/stacked CDL v2 or out of scope; reply with reasoning, do not expand this PR.

**Release caveats:**
- PR #558 targets `main` but is stacked on CDL v2, so its diff includes CDL v2 changes. It must be retargeted or explicitly approved before release.
- No merge/deploy without explicit approval.
- No production cleanup of noise records has been performed; proposed cleanup requires separate approval.
- PR #557 remains on hold and untouched.

**Decision requested:** approve or reject merge/deploy of PR #558 independently of the navigation investigation. The navigation report does not authorize implementation.

---

## 10. Appendix: source and evidence index

### 10.1 Primary source references (at `64b114f`)

- `server/inspector.ts` — static acquisition, extraction, navigation scoring/queue, rendered gate/outcome classification.
- `server/browserCommunityFallback.ts` — rendered crawl, control enumeration, click loop, rotation, telemetry, gate.
- `server/communitySurfacePolicy.ts` — shared admission boundary, asset/non-page/malformed filters.
- `server/destinationPolicy.ts` — destination evidence, cross-origin budget, diversity.
- `server/crawlerExtraction.ts` — dynamic target extraction, embedded markup.
- `server/discordCandidates.ts` — invite extraction, obfuscation decode, merge, ownership.
- `server/discordProjection.ts` — retention/projection/selection.
- `server/dbCore.ts` — persistence, A1 upsert guard, last-verified SQL.
- `server/queueManager.ts` — inspection/validation flow, retry scheduling, final upsert.
- `server/communityRetryPolicy.ts` — retry eligibility, permanent failure classes, attempt-free capacity.
- `server/renderedInteractionCoverage.test.ts` — control window, navigable-only, offset, failed-control regressions.
- `server/discordStateProjectionPreservation.test.ts` — A1 serving/retained-uncertain regressions.
- `server/candidateLifecycleIntegrity.test.ts` — retry-offset progress, uncertified blocking, duplicate same-seed regressions.
- `server/crawlAdmissionGate.test.ts` — admission/dynamic-attribute/asset regressions.
- `server/crawlerTelemetry.ts` — telemetry types/sanitizer.

### 10.2 Evidence documents

- `/tmp/opencode/INVITE_EXTRACTION_COMPLETENESS_AUDIT_20261027.md` — D1–D11/L1–L9/A1–A7, 50-format/74-crawl matrix.
- `/tmp/opencode/INVITE_EXTRACTION_CONSOLIDATED_REPORT_20261027.md` — approved remediation findings, production acquisition/recovery evidence.
- `/tmp/opencode/CRAWLER_DISCOVERY_INVESTIGATION_20261025.md` — prior discovery investigation and production per-seed yield.
- `/tmp/opencode/INVITE_EXTRACTION_AUDIT_FINAL_DECISION_20261027.md` — prior decision layer/backlog.
- `/tmp/opencode/evidence/audit/FRESH_PROD_EVIDENCE_20261027.md` — production metrics/query appendix.
- `/tmp/opencode/invite_extraction_matrix_20261027.ts` / `.json` — 50 format + 74 crawl synthetic matrix.
- `/tmp/opencode/firefox_behavior_probe.cjs` / `.json` — iframe/shadow/meta/JS behavior probe.
- `/tmp/opencode/discord_url_edge_probe_20261027.txt` — URL edge probe.

### 10.3 Snapshot quick reference (2026-10-27T11:20Z)

| Metric | Value |
|---|---:|
| Creator observations (7d) | 7,931 |
| `ACQUISITION_FAILED` | 5,981 (75.4%) |
| `PARTIALLY_INSPECTED` | 1,061 (13.4%) |
| `INSPECTED_NO_MATCH` | 563 (7.1%) |
| `FOUND` | 326 (4.1%) |
| Rendered attempts | 2,265 |
| Rendered saturated | 1,550 (68.4%) |
| Rendered `FOUND` | 63 |
| Channels | 9,809 |
| Serving invites | 959 |
| `FAILED` channels | 1,832 |
| Pending retry jobs | 1,534 |
| Due retry jobs | 1,534 |
| Locked retry jobs | 0 |
| Genuinely never attempted | 525 |
| True backlog p50 / max | 48.5h / 453.5h |
| A1 channels | 124 |

### 10.4 Glossary

- **Clean no-match:** `INSPECTED_NO_MATCH` with no coverage gap.
- **Partial:** `PARTIALLY_INSPECTED` with real page evidence but incomplete coverage.
- **Coverage reason:** why navigation/content was not fully examined (bounded, policy-excluded, context-unreachable, failed interaction, unknown).
- **Structural navigation:** a control whose purpose is to reveal navigation (menu, hamburger, nav, tabs, accordion), independent of community keywords.
- **Context-unreachable:** content in a popup, frame, closed shadow root, or other document context the crawler does not inspect.
- **False clean:** a clean absence reported despite an unexamined navigation surface.
- **Last-known-good:** a previously validated serving invite retained after an ambiguous revalidation, labeled uncertain.
