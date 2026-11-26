# Crawler Coverage Remediation — Implementation Status (Phase 0/1)

**Status:** IMPLEMENTATION IN PROGRESS — code/test verification; **not yet deployed**
**Date:** 2026-11-26
**Branch:** `feat/crawler-coverage-remediation` (rebased onto production `f0aa55b3`; review baseline was `1bf93568`)
**References:** gap register and remediation plan in the same directory

---

## 1. Implemented in this batch

| Area | Change | Files |
|---|---|---|
| Build identity | `SOURCE_COMMIT` is now the preferred commit source (Coolify), ahead of Railway/CI variables; `/api/version` can identify the deployed image | `server/buildInfo.ts`, `server/buildInfo.test.ts` |
| Reserved codes | Removed the 16 codes confirmed live by Discord (`store`, `home`, `about`, `contact`, `support`, `channels`, `download`, `api`, `widget`, `terms`, `privacy`, `before`, `after`, `next`, `index`, `template`); kept a narrow structural deny for application routes | `server/discordCandidates.ts`, `server/discordReservedCodes.test.ts` |
| Obfuscation | Bounded Base64, ROT13, double-percent, `\u002e`, `&period;`, `discord dot gg`, and bounded tag-fragment rejoin; decoded candidates marked `OBFUSCATED_NATIVE` | `server/discordCandidates.ts`, `server/discordObfuscationDecoding.test.ts` |
| Case collisions | Added deterministic collision detection/logging; current registry/merge collapse is pinned as a documented limitation until a schema-level case-preserving claim is approved | `server/discordCandidates.ts`, `server/queueManager.ts`, `server/discordInviteCaseCollisions.test.ts` |
| XHTML/XML/RSS | 2xx `application/xhtml+xml`, `application/xml`, `text/xml`, `+xml`, JSON and plain text are readable; binary/PDF still rejected | `server/inspector.ts`, `server/crawlContentTypeCoverage.test.ts` |
| Redirect/failure invites | Scans redirect final URLs and readable 401/403/404 bodies for invite evidence before recording failure | `server/inspector.ts`, `server/crawlFailureInvite.test.ts` |
| Multilingual lexicon | Central 17-country / supported-language lexicon for strong/weak community terms, wired into static navigation, destination policy, relevance, and rendered control matching | `server/multilingualCommunityLexicon.ts`, tests; `server/inspector.ts`, `destinationPolicy.ts`, `communitySurfacePolicy.ts`, `acquisitionRelevance.ts`, `browserCommunityFallback.ts` |
| Asset hygiene | Image/font/audio/video/CSS/JS/octet-stream responses do not consume the static page/exploration budget; counted as `asset-content-type` | `server/inspector.ts`, `server/crawlerTelemetry.ts`, `server/crawlContentTypeCoverage.test.ts` |
| Robots | Cached RFC 9309 policy: explicit Disallow enforced, Crawl-delay bounded to 30s, 4xx/403/429/5xx/unreachable/malformed treated as UNKNOWN/allow; disabled by default, enabled by `CRAWLER_ROBOTS_ENFORCEMENT=true` | `server/robotsCrawlPolicy.ts`, tests; `server/inspector.ts` |
| Static expansion | Configurable `CRAWLER_MAX_DEPTH`, `CRAWLER_QUEUE_CAP`, `CRAWLER_PAGE_CAP`; defaults 2/12/12; depth-3 canary test; frontier 5% deterministic canary (`CRAWLER_FRONTIER_CANARY_BASIS_POINTS`) | `server/crawlerExplorationLimits.ts`, `server/inspector.ts`, tests |
| YouTube surfaces | New bounded collector: pinned/top comments, Community posts, older descriptions, playlists; 60s overall deadline; candidate merge; deterministic 5% canary; only TRADING_CONFIRMED zero-invite channels, setting-gated | `server/youtubeSurfaceCandidates.ts`, `server/queueManager.ts`, tests |
| V4 evidence | YouTube sample expanded to 100 creators: **6 global new live invites** (3/10 targeted, 3/90 random = 3.3%); render sample remains 0/19 global new; GATE 0/5; PDF/RSS 0/24 | register §13 |

---

## 2. Tests and review

| Check | Result |
|---|---|
| TypeScript (`npm run lint`) | **pass** |
| Targeted extraction/navigation/YouTube/robots/validation tests | **pass** (runs expanded as review findings were fixed) |
| Browser/rendered/queue source-contract tests | **158/158 pass** |
| Multilingual/lexicon tests | **pass** |
| Crawler exploration/robots/content/YouTube | **pass** |
| Full suite, final rebased run | 5,729 tests: **5,409 pass, 63 fail**, 257 skipped. No modified crawler/extraction/YouTube/robots test is in the failure set; the 63 are pre-existing/environmental legacy DB/source-text failures (quarantine, query lifecycle, release audits, `viteConfig`) |
| Failure-set comparison vs `origin/main` `f0aa55b3` | Every final failure name reproduces on the unmodified baseline in targeted runs (48 baseline-file failures + 13 in the six missed files + 3 in `scopePromotedDiscovery`); no branch-only failure. The two `youtubeInnertubeProvider` timing failures seen under full-suite load pass when run alone (44/44) |
| Targeted rebased review suite | **231/231 pass** across extraction, reserved codes, validation, obfuscation, collisions, multilingual, robots, exploration, content types, failure bodies, YouTube, rendered enqueue and queue source contracts |

### Review bot findings fixed before merge

- **Viewer comments were becoming creator-owned evidence.** Comments now carry
  author ownership and real video IDs; viewer comments use `YOUTUBE_COMMENTS`
  and cannot earn creator-description ownership points. The same rule applies
  to a pinned comment authored by a viewer.
- **Robots-disallowed seeds still escalated to browser.** `ROBOTS_DISALLOWED`
  is now a static terminal barrier, excluded from external-block escalation,
  and checked before same-origin iframe fetches.
- **Robots query rules were ignored.** The evaluator now receives pathname +
  query string.
- **Child 404 bodies lost invites.** Child 404/410 bodies are read under a
  bounded extraction scan without becoming terminal-root evidence.
- **Case collision detector ran after merge.** It now inspects retained raw
  observations as well as native codes.
- **Paid-community fallback was unreachable.** `premium platform` / `paid
  server` again qualifies through the platform/server context.
- **Validation still rejected the newly admitted codes.** `discordValidator`
  now imports the same structural route set as extraction; `store`, `channels`,
  `support`, `template` and the other 12 live-valid codes reach the Discord API
  instead of failing as `INVALID_LOCATOR` before any request.
- **Redirects bypassed robots.** Redirect targets are now gated before contact;
  a target blocked by Disallow or by the per-crawl Crawl-delay budget is
  recorded as `ROBOTS_DISALLOWED` and is never parsed for invite codes.
- **Disallowed children consumed destination budget.** Robots is checked before
  `destinationBudget.reserve`, so a policy skip cannot starve an allowed page.
- **Crawl-delay could stall an inspection.** Pacing is per origin, not before
  every request, and bounded to 10s per crawl; skipped URLs are counted as
  `robots-delay-budget` and keep coverage incomplete.
- **Child assets could exceed the fetch cap.** Asset fetches now have their own
  page-cap budget, so they still do not consume document slots but cannot grow
  total child fetches without bound.
- **Ordinary substrings and markup produced false community/invite evidence.**
  Latin lexicon terms now require token boundaries while keeping common
  inflections; generic access terms moved to weak; `club` is weak while
  `trading club` stays strong; tag-fragment rejoin accepts only inline
  formatting tags. Hyphenated paths are normalized before matching.
- **YouTube pagination fetched an extra page.** Video and Community loops count
  the first page and stop at the cap. Timed-out Innertube promises are guarded
  against unhandled rejection, and client initialization is bounded.
- **A failed fetch with invite evidence still reported failure.** It now records
  `FOUND`, is non-retryable, and does not trigger a render/retry for the same
  bytes.
- **Frontier canary keyed on the raw seed.** It now buckets by canonical site
  identity so scheme/www/path variants of one site receive one treatment.

### Review corrections made during this batch

- Fixed recursive `callTimeout()` introduced by a perl substitution in the YouTube collector; added an overall deadline test.
- Fixed ROT13 marker check (must test the source for `qvfpbeq`, not the rotated output).
- Narrowed rendered control hints after the full suite showed `resources` changing click-skip semantics.
- Fixed the static-exploration source assertion after making the page cap configurable.
- Added a bounded YouTube canary so enabling the setting cannot run on every zero-invite channel at once.

---

## 3. Discord public-surface reconciliation

| Surface | Status |
|---|---|
| `discord.gg/<code>`, `discord.com/invite/<code>`, `discordapp.com/invite`, `discord.app/invite` | **Covered** by extraction and live validation |
| `dsc.gg`, `discord.me`, `discord.io` | **Covered as unresolved redirect locators**; follow-up fetch resolves them |
| `discord.com/servers/<slug-id>` | **Already implemented** in `discordPublicSurface.ts`; server-rendered page scan |
| `discord.com/widget?id=<guildId>` | **Already implemented**; public widget JSON `instant_invite` |
| `disboard.org/server/<id>` | **Covered as a directory locator**; page crawl / extraction |
| `discord.com/events/...` | **Deferred**; event pages are not a terminal invite surface and do not carry a canonical invite code by themselves |
| Discord server discovery categories / other app routes | **Deferred**; no evidence they expose terminal public invites beyond the two implemented shapes |

No silent omission: the two server/widget shapes are implemented today; event
and arbitrary app routes are explicitly deferred, not treated as covered.

## 4. Deliberately deferred / not implemented

| Item | Reason |
|---|---|
| Dedicated browser service / 16 vCPU provision | Per approved execution order; no infrastructure spend yet |
| Case-preserving registry schema | P3; 0 observed collisions in 6,171 candidates; detection/logging implemented; schema change requires separate migration review |
| PDF parsing / OCR / closed shadow | Deferred/out of scope unless new measured evidence |
| Site-profiler/ladder 5% canary | Frontier 5% canary implemented; profiler/ladder still controlled by existing flags |
| Full 100-site browser V4 | Requires browser infrastructure; YouTube 100 + render 19 + fixtures are the current evidence |
| Cross-process robots pacing | Crawl-delay is coordinated per crawl/process, not across every worker process; robots enforcement remains canary-gated |
| True cancellation of timed-out YouTube calls | Innertube has no generic abort surface here; late rejections are contained, but an abandoned request may still finish at the network layer |
| Production deployment | Not yet; code is on the branch |

---

## 5. Deployment status

Production advanced during implementation to `f0aa55b3` (Gemini route rotation;
schema 210; crawler files unchanged). The branch was rebased onto it. No
production code or config was changed by this work yet. `/api/version` will
report `SOURCE_COMMIT` **after** this branch is deployed; until then the
deployed image still reports `commitSha:"unknown"`.

---

## 6. Next verification after merge

1. Run the full suite on the merge commit; triage any remaining failures.
2. Deploy Phase 0/1 with all new behavior flags off by default.
3. Verify `/api/version` reports the deployed merge commit after `f0aa55b3`.
4. Enable YouTube surface canary at 5% (`youtube_surface_expansion_enabled=true`,
   `youtube_surface_expansion_basis_points=500`) and measure live-new yield.
5. Enable `CRAWLER_ROBOTS_ENFORCEMENT=true` in canary and verify explicit
   Disallow/Crawl-delay behavior plus no loss of 403/unreachable sites.
6. Enable static depth/queue canary (`CRAWLER_MAX_DEPTH=3`,
   `CRAWLER_QUEUE_CAP=24`, `CRAWLER_PAGE_CAP=24`) and measure page yield/429s.
7. Do not provision the browser service until the remaining implementation and
   benchmark are complete and the infrastructure comparison is approved.
