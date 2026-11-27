# Crawler Coverage Remediation — Implementation Status (Phase 0/1)

**Status:** DEPLOYED — PR #707 live on production at `54f93d1f`; follow-up monitoring in progress
**Date:** 2026-11-27 (updated)
**Branch:** `main` (PR #707 merged; production deployment 2026-11-27T14:31Z)
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
| Redirect/failure invites | Scans redirect final URLs and readable 401/403/404/410 bodies. The bounded seed 404/410 probe supplies terminal evidence only when the body is readable, complete, and free of links/community content; otherwise the seed stays render-eligible. Child failure bodies are limited to community-scored targets. | `server/inspector.ts`, `server/crawlFailureInvite.test.ts` |
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
| Full suite, final rebased run | 5,748 tests: **5,428 pass, 63 fail**, 257 skipped. No modified crawler/extraction/YouTube/robots test is in the failure set; the 63 are pre-existing/environmental legacy DB/source-text failures (quarantine, query lifecycle, release audits, `viteConfig`) |
| Failure-set comparison vs `origin/main` `f0aa55b3` | Every final failure name reproduces on the unmodified baseline in targeted runs (48 names from the baseline file set, including the file-level `viteConfig` entry, plus 13 from six missed files and 3 from `scopePromotedDiscovery`); no branch-only failure. The 63 test failures plus the file-level entry account for the 64-name comparison. The two `youtubeInnertubeProvider` timing failures seen under full-suite load pass when run alone (44/44) |
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
- **A failed seed fetch with invite evidence still reported failure.** The root
  observation now records `FOUND`, is non-retryable, and does not trigger a
  render/retry for the same bytes. Child failure observations keep their HTTP
  status; their bodies are scanned only for community-scored targets.
- **Frontier canary keyed on the raw seed.** It now buckets by canonical site
  identity so scheme/www/path variants of one site receive one treatment.

### Final review-loop hardening

- Robots pacing is shared per origin across concurrent crawls, charges queue
  time and wait time to a per-crawl budget, records the actual request-start
  time, and releases destination slots when pacing skips a URL.
- Rendered document/fetch/XHR requests consult the same robots policy. A
  deterministic Disallow keeps coverage incomplete but non-retryable; only a
  pacing-budget skip contributes retryability.
- Community URL evidence uses decoded hostname + pathname, never query or
  fragment text; IDN hosts are converted back from punycode. Ambiguous host
  labels (`circle`, `join`, `signal`) require path/anchor evidence.
- Playlist item text is not creator-owned evidence; only the playlist
  description is. Creator-authored comments are prioritized before the cap.
- Child robots rejection is checked before destination reservation, and
  pacing-rejected URLs are marked visited so later pages cannot re-enqueue
  them.
- Base64 accepts UTF-8 printable payloads; inline `<br />`/closing-tag
  fragments are rejoined; duplicate robots groups are merged.
- Final bot review state: all review threads resolved; no unresolved findings
  at commit `549af000`.

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
| Production deployment | Complete for PR #707 (`54f93d1f`), deployed 2026-11-27T14:31Z; depth-3 remains deliberately off |

---

## 5. Deployment status

Production runs merge commit `54f93d1f` (PR #707, static ownership guard) as of
2026-11-27T14:31Z. The image built successfully and the app container was
replaced; the previous production commit was `dea6b834`.

Active production settings:

- `CRAWLER_MAX_DEPTH=2`, `CRAWLER_QUEUE_CAP=12`, `CRAWLER_PAGE_CAP=12`
- `CRAWLER_ROBOTS_ENFORCEMENT=true`
- `youtube_surface_expansion_enabled=true`,
  `youtube_surface_expansion_basis_points=500` (5%)
- Depth-3 / 24-page static expansion remains **off**.

### PR #707 ownership guard

- Static website claims require `CREATOR_OWNED` or a known community/link hub.
  Viewer comments and curated playlist items are ignored when classifying the
  provenance, so a docs page plus a viewer comment cannot bypass the guard.
- External reference pages cannot hop to unrelated external hosts. Apex/www,
  HTTP/HTTPS, and port redirects stay first-party; a creator-authored `/join`
  redirect may hand off to a separate community domain, but after the crawl
  leaves the creator site only same-site or evidenced-community targets are
  followed.
- Orphan recovery defers rows without provenance and rows whose static
  ownership cannot be proved. Deferred rows are paged past with a bounded,
  deterministic scan; the claim batch is capped by unique codes.
- Rendered cross-origin planning/clicking receives the original seed context,
  and merged pre-click candidates are classified against the document that
  produced them.
- The deployed deferral event name is
  `discord_unowned_surface_candidates_deferred`; the transient
  `discord_unowned_candidates_deferred` rename was never shipped.

### Production false-positive cleanup

After PR #707 was approved, the interim production window was audited again.
The earlier cleanup removed 15 docs/wiki/reference claims. The final cleanup
removed **37 false candidate rows**, **37 registry rows**, and cleared
**16 channels** whose serving or candidate pointer referenced those rows.

- Clear removals included Play Store app pages, Wikipedia, DeepL, PlanetPython,
  open-webui, Polymer/Inco project docs, Base/Jupiter/Hyperliquid/Titan project
  invites, Pump.fun/Pastel/Telegram project invites, MyForexFunds, CWallet,
  PerpTools, mfatraders, and unrelated link-hub/privacy-page invites.
- Preserved genuine creator evidence, including YinYang Algorithms
  (`ccEHem37FB`, direct TradingView/YouTube evidence), Whiteboard Crypto
  (`hvMQp4qcM6`, repeated video descriptions), Alex Morrison (`MYaCsKrDev`,
  linked Stockminds site), Novig, Tailored Trading (`2U33H3yM4F` direct link;
  FlowMatrix is linked from the channel), Daily Market School, Quant Trading
  Pro, Hourglass Trader, FudStop, YoungBuffett, TGFX Academy, and the Donald
  King Google Form titled "Free Discord Community".
- The remaining recent static claims were reviewed and are brand-owned,
  creator-controlled, known-hub, or creator-linked. No docs/wiki/app-store
  false claims remain in the recent set.

### Initial post-deploy observation

Measured from production PostgreSQL candidate/registry counts and the app
container logs, from 2026-11-27T14:31Z through 15:00Z:

- 0 new `discord_candidates` rows and 0 new registry claims.
- 0 new docs/wiki/reference false claims.
- No `youtube_surface_expansion_failed` events and no fatal/OOM events.
- Rendered fallback logged a memory-pressure warning at about 2.0 GB, roughly
  103% of the container's 1.985 GB limit; the process stayed up, but this
  remains the main capacity constraint.
- No net-new validated Discord invite was measured in this short window. The
  guard is deliberately deferring unowned static rows; genuine yield must be
  measured over a longer window before changing static depth or YouTube
  canary size.

## 6. Next verification

1. Continue monitoring `discord_unowned_surface_candidates_deferred`, new
   static claims, and genuine invite yield over a longer production window.
2. Keep robots enforcement on and static bounds at **2/12/12**.
3. Keep YouTube surface expansion at **5%** until reliability, quota usage, and
   new-validated-invite yield justify an increase.
4. Consider a controlled depth-3 canary only after a clean multi-hour window
   with no docs/wiki/reference claims and measurable genuine static yield.
5. A dedicated browser service remains blocked on infrastructure/spending
   approval; the observed ~2 GB rendered-fallback pressure supports that need.
