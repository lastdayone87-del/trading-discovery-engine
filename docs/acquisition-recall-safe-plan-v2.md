# Production Acquisition Pipeline — Read-Only Investigation & Recall-Safe Implementation Plan (PLAN-ONLY)

> **PLAN-ONLY PR. No implementation. No production change.**
> No code, files (other than this doc), commits (other than this doc), pushes (other than this doc branch),
> deploys, production DB writes, Railway config, worker concurrency, queues/jobs, requeues, deletes, triggers,
> or restarts were made during the investigation. Local `data/*.db` files were probed read-only and found
> unreadable (`database disk image is malformed`); production DB was not touched.
> Investigation was read-only source analysis plus read-only runtime probes
> (`node --import tsx -e` calling pure extraction/normalization/scoring functions).
> Base: `origin/main` at time of writing; branch contains only this document.
> Prior doc `docs/community-acquisition-forensics-and-plan.md` (HEAD `41e806b` on another branch) is
> **superseded for implementation purposes** because its `≤4 URL slice` and generic dot-rule violate
> the recall constraints defined here. See §7 and §15.

## 0. Required concise table

| Problem | Root Cause | Proposed Fix | Files / Functions | Risk | Evidence |
|---|---|---|---|---|---|
| A. Step 4 `PARTIAL` / `ERROR` on auxiliary URLs | No URL cap, but Step 4 aggregate (`websiteOutcomes`) counts `required:false` static failures; every static non-`FOUND` for trading creators escalates to 60s Playwright; rendered obs forced `required:true`; child-budget exhaustion ignored | Priority-ordered sequential crawl, static-first, rendered escalation only for high tiers/evidence, `required:true` only for primary creator surfaces, auxiliary `required:false` + 0 Playwright, per-URL isolation + `NOT_ATTEMPTED` / `INACCESSIBLE` logging, no silent discard | `server/inspector.ts:185,188,191,193`, `crawlExternalLinks:115-143`, `server/browserCommunityFallback.ts:143,275-276,307-316`, `server/communitySurfacePolicy.ts:67-102` | Low if `Z=0` proven; else recall loss. No-cap design has no truncation risk | `websiteOutcomes=...filter(surface==='CREATOR_WEBSITES')` has no `required` filter; rendered push uses `required:true`; `shouldEscalate(...INSPECTED_NO_MATCH...)=>true`; live probes admit `https://g/`, `t.me/*`, `binance.com/ref` |
| A2. Partial crawl misrepresented as clean | Static final obs always `INSPECTED_NO_MATCH` when no invite even if `budgetExhausted=true`; aggregation ignores `telemetry.budgetExhausted` | `budgetExhausted=true` => per-seed `PARTIALLY_INSPECTED`, propagate to Step 4; add `INACCESSIBLE` / `NOT_ATTEMPTED` to `ExternalAcquisitionStatus` | `server/inspector.ts:138-141,143`, `server/crawlerTelemetry.ts:50,55-66` | Low; strictly more truthful | Line 141 pushes `INSPECTED_NO_MATCH` unconditionally; `budgetExhausted` lives only in telemetry |
| Malformed `https://g/` + truncated / broken | `extractEmbeddedUrls` regex matches `//g/` (`crawlerExtraction.ts:23`); `normalizeExternalUrl` accepts any `new URL()` incl. dotless `g` (`inspector.ts:32-51`); extraction blocklist covers only google-family + asset ext | Do NOT hard-reject yet. Quarantine: cheap static attempt (fails fast on DNS), 0 Playwright for dotless, mark `INACCESSIBLE required:false`, log. Hard-reject only after prod golden query proves `Z=0` | `server/crawlerExtraction.ts:21-31`, `server/inspector.ts:32-70` | Prior dot-rule = Medium-High (unproven `Z`). Quarantine = Low | Live: `normalizeExternalUrl('https://g/')=>{url:'https://g/',kind:'WEBSITE'}`; `extract=>['https://g/','https://t.me/x','https://binance.com/ref']` |
| Telegram / WhatsApp drain | `socialHosts` is only twitter/x/ig/tiktok/fb (`inspector.ts:30`); `t.me/wa.me/chat.whatsapp.com` => `kind:WEBSITE` + full static + rendered path; only child-permalink filter exists | New `MESSAGING_PREVIEW` kind; static Cheerio preview (`t.me/s/...`) by default, extract `discord.gg` statically, escalate only on bridge evidence; 0 default launches | `server/inspector.ts:30,48,185-188`, `server/browserCommunityFallback.ts:76-93` | Low if static path preserves recall; blind blacklist = High (forbidden) | Live: `t.me=>WEBSITE`, `chat.whatsapp.com=>WEBSITE`; no `t.me` FOUND test exists |
| B. Stale retry metadata | `dbCore.ts:366-379` unconstrained `(SELECT ... ORDER BY created_at DESC LIMIT 1)` with no `scan_status` / `validation_status` guard; `communityRecovery.ts:214-219` `<2` guard ignores v2 COMPLETED; ±5min window misses recovery outside window | Projection guard (display only when `scan FAILED/FAILED_PERMANENT AND validation RETRY_PENDING AND job PENDING/PROCESSING`) + widen reconciler to v2 + window fix. Projection first | `server/dbCore.ts:366-379,387-460`, `server/communityRecovery.ts:168-233,293-433`, `src/components/ResultsTable.tsx:335-346,525-529,551` | Low; display guard, no schema/DDL | SQL verified verbatim; UI renders `Retry-window attempts` whenever `validation RETRY_PENDING` regardless of job status |
| C. Community labeled `UPSTREAM` | `retryReasonForFailureClass` defaults non-browser to `UPSTREAM` (`communityRetryPolicy.ts:86-90`); 4 hardcodes: recovery callback (`queueManager.ts:162`), validation-429 (`894`), enqueue default (`956`), catch-all (`939`) | Surface-aware `retryReasonForFailureClass(failureClass,surface)`: `YOUTUBE_ABOUT/RECENT_VIDEO_DESCRIPTIONS=>UPSTREAM`, websites/social/validation=>`COMMUNITY`, browser crash=>`BROWSER_RUNTIME` | `server/communityRetryPolicy.ts:86-94,140-155`, `server/queueManager.ts:162,894,939,953-962` | Low; enum partition only | All 5 paths traced; inspection-path directive itself is correct (`COMMUNITY`), callers overwrite |
| Dashboard lies | `Not discovered` from `discord_discovery_status` even when `ACQUISITION_FAILED/PARTIALLY_INSPECTED`; retry banner from durable job payload even when `COMPLETED` | Truth matrix: `INACCESSIBLE=>Website acquisition incomplete (UNCERTAIN)`; `NOT_ATTEMPTED=>Not yet inspected`; `INSPECTED_NO_MATCH=>Clean inspection`; hide stale retry unless active | `src/components/ResultsTable.tsx:480,514-519,523-529,551`, `server/queueManager.ts:896-932` | Low; React render only | Backend sets `UNCERTAIN` on failure (`queueManager.ts:902`); UI can still show `Not discovered` |

---

## 1. Executive diagnosis

1. **Step 4 poisoning, not budget size.** There is no per-channel URL cap and no global crawl budget.
   `rankCommunitySurfaces` only reorders (verified by code comment + test `ranking is prioritization only`).
   The failure is requirement attribution: static observations are `required:false`, rendered observations are
   forced `required:true`, but Step 4 aggregation (`websiteOutcomes`) ignores `required` entirely. One
   affiliate / broker / malformed / messaging URL that fails static escalates to Playwright (because
   `creatorLikelyTrading===true` escalates even `INSPECTED_NO_MATCH`), fails rendered
   (`requestsFailed>0` or 60s timeout, e.g. on `https://g/`), yields `ACQUISITION_FAILED required:true`,
   forcing Step 4 `PARTIAL` / `ERROR` plus `communityAcquisitionRetryDirective` plus a
   `RETRY_COMMUNITY_ACQUISITION` job even when the primary creator domain was clean.
2. **Stale projection, not stale execution.** Jobs correctly reach `COMPLETED`; `listChannelsPage` keeps
   projecting the newest job row forever.
3. **False upstream attribution.** The inspection directive is correct, but every fallback path defaults to `UPSTREAM`.
4. **Missing states.** `ExternalAcquisitionStatus = FOUND | INSPECTED_NO_MATCH | PARTIALLY_INSPECTED | ACQUISITION_FAILED`
   has no `INACCESSIBLE` / `NOT_ATTEMPTED`. `budgetExhausted` and `complete=false` live only in telemetry.
5. **Browser runtime is out of scope** and was not redesigned.

Primary objective preserved: maximize Discord discovery recall while minimizing wasted crawl/render resources,
never sacrificing legitimate paths because a URL looks inconvenient. Video-description URLs remain eligible (§3).

## 2. Exact Step 4 execution trace

`Channel inspection → bio/About → channel external links → recent video descriptions → URL extraction →`
`normalization → dedup → classification → scoring/ranking → Step 4 queue → static → rendered fallback →`
`per-URL result → Step 4 aggregate → observation persistence → retry directive → retry job →`
`Channels projection → dashboard`:

1. **Bio/About + links + video-desc acquisition** — `runChannelInspection` (`server/inspector.ts:166-172`):
   live About refresh if `forceLiveFetch || creatorLikelyTrading || links==0 || bio<20`; authoritative
   YouTube-API video descriptions (newest first, `descriptionsToInspect = videoDescs.slice(0,5)`, line 183);
   scrape fallback with attempted/acquired counters. Failures push
   `YOUTUBE_ABOUT / RECENT_VIDEO_DESCRIPTIONS required:true ACQUISITION_FAILED`, but
   `isCommunityRetryableObservation` excludes those surfaces (`server/communityRetryPolicy.ts:132-138`) and
   `isDiscordCommunityAcquisitionSurface` excludes them (`server/communitySurfacePolicy.ts:159-161`), so they
   never create community retries. Correct.
2. **Extraction** — `extractExternalUrlsFromText` (`server/inspector.ts:57-70`): `decodeEmbeddedMarkup` +
   `extractEmbeddedUrls` + trailing-strip + blocklist (youtube/google/ggpht/gstatic/doubleclick/syndication/
   schema/w3/googleapis/googlevideo/ytimg + asset ext). Video-desc URLs explicitly retained via
   `addExternalUrls(d, VIDEO_N_DESCRIPTION)` (line 183). §3 preserved today.
3. **Normalization** — `normalizeExternalUrl` (`server/inspector.ts:32-51`): youtube-redirect decode (2x),
   protocol check, drop youtube/youtu.be + direct discord hosts (direct invites handled in Steps 1-3, not Step 4),
   strip hash + utm/fbclid/gclid/ref/feature, lowercase host, `SOCIAL` iff in 6-host set else `WEBSITE`.
   Admits dotless, `t.me`, `wa.me`, brokers, news. Verified live via `node --import tsx -e`.
4. **Dedup + classification + scoring** — `uniqueUrls Map` + `rankCommunitySurfaces(filter(kind))`
   (`server/inspector.ts:185`): exact dedup on normalized string, `contextMatches` OR-merge, stable sort by
   `scoreCommunitySurface` (`server/communitySurfacePolicy.ts:67-95`: context+120, CHANNEL_LINKS+65, ABOUT+50,
   VIDEO_DESC+10, community-hint+70, hub+60, platform+55, generic-custom+20, affiliate-75, broker-45).
   No filtering. Live probe: `linktr.ee 195 > creator 85 > g/ 30 == t.me 30 > binance -110`.
5. **Step 4 queue (website) + Step 5 (social)** — sequential `for...of await` (`server/inspector.ts:188,191`):
   `crawlExternalLinks([item.url], ..., 'CREATOR_WEBSITES', false, wrapperUrl)`. No concurrency, no per-channel
   cap, no total deadline. One slow URL delays but does not skip later URLs (no `throw`; per-seed `continue`).
6. **Static crawl** — `crawlExternalLinks` (`server/inspector.ts:115-146`): direct-invite-in-URL check → `FOUND`;
   else `fetchExternalPage` (10s Abort, lines 72/92, `depth>2` guard): non-ok → `ACQUISITION_FAILED`
   (`RATE_LIMIT` / `TRANSIENT_HTTP` / `HTTP_ERROR`, retryable on 429/5xx), bad content-type →
   `UNSUPPORTED_CONTENT_TYPE retryable:false`, abort/network → `TIMEOUT` / `NETWORK_FAILURE retryable:true`.
   Root HTML → `inspectPage`: cheerio `a[href]` + `extractDynamicTargetValues`, same-origin or
   `CROSS_DOMAIN_COMMUNITY_HOSTS` only, `communityNavigationScore`, queue `slice(0,12)`, BFS `explored<8`,
   `depth<=2`, `budgetExhausted=true` on overflow (lines 138-139). Final per-seed obs `FOUND` / `INSPECTED_NO_MATCH`
   (HTTP 200). Per-call aggregate:
   `found ? FOUND : failed&&inspected ? PARTIALLY_INSPECTED : failed ? ACQUISITION_FAILED : INSPECTED_NO_MATCH` (line 143).
7. **Rendered fallback** — iff `creatorLikelyTrading && (outcome != 'FOUND' || !hasCreatorOwned)` then
   `shouldEscalateToRenderedFallback({staticOutcome, creatorLikelyTrading:true})`
   (`server/browserCommunityFallback.ts:307-316`: `FOUND=>false`, else trading + `CREATOR_WEBSITES/SOCIAL_PROFILES`
   => `true` for all three non-FOUND outcomes). `crawlRenderedCommunitySurface` (lines 143-304): gate
   `concurrency 1, maxPending 8` (lines 135-138), `maxPages 6, scrolls 5, clicks 4, retries 3, rotations 4,
   nav 15s, total 60s` (lines 56-64), PlaywrightCrawler aborts image/media/font, `errorHandler` counts
   `requestsFailed` + backoff, scrolls/clicks community-hint controls + `enqueueLinks same-hostname` filtered by
   `shouldEnqueueRenderedCommunityLink` (telegram-permalink excluded). `incomplete = timedOut || requestsFailed>0`
   (lines 275-276); `complete=!incomplete`, `retryable=incomplete`. Saturated/exception → `complete:false retryable:true`.
8. **Per-URL result** — rendered candidates → `FOUND`, else `complete ? INSPECTED_NO_MATCH : ACQUISITION_FAILED`
   with `required:true`, `failureClass = complete ? undefined : (failureClass || RENDERED_ACQUISITION_INCOMPLETE)`.
9. **Step 4 aggregate** — `websiteOutcomes = effectiveAcquisitionOutcomes(filter surface CREATOR_WEBSITES)`
   (no `required` filter), `failedCount/inspectedCount` → `FOUND` if any candidate else
   `failed ? (inspected ? PARTIAL : ERROR) : NOT_FOUND`, `SKIPPED` if zero URLs. Same for social Step 5.
10. **Overall + retry directive** — `required = effectiveAcquisitionOutcomes(filter required)`,
    `communityRequired = filter isDiscordCommunityAcquisitionSurface`
    (`CHANNEL_EXTERNAL_LINKS / CREATOR_WEBSITES / SOCIAL_PROFILES`), `failed/inspected` →
    `PARTIALLY_INSPECTED / ACQUISITION_FAILED / INSPECTED_NO_MATCH`, or `FOUND` if any candidate (line 193);
    `communityAcquisitionRetryDirective(communityRequired)` (`server/communityRetryPolicy.ts:140-155`).
11. **Observation persistence → retry job** — `server/queueManager.ts:896-917` (failure → `UNCERTAIN` /
    `RETRY_PENDING` or `FAILED_OPERATIONAL`, `scan FAILED`, enqueue), `:953-962`
    (`RETRY_COMMUNITY_ACQUISITION`, `idempotencyKey channelId`, `priority 15`, `maxAttempts 5`).
    Validation path `:885-895`, catch path `:934-945`.
12. **Projection → dashboard** — `server/dbCore.ts:366-379` lateral `LIMIT 1` → `rowToChannel` →
    `src/components/ResultsTable.tsx:335-346,525-529,551`.

## 3. Exact PARTIAL / ERROR / state semantics

Current (verified):

- `FOUND`: invite in URL / page HTML / anchor / dynamic target / rendered DOM.
- `INSPECTED_NO_MATCH`: HTTP 200 root + explored subs parsed, 0 invites (line 141); or rendered `complete:true`, 0 invites.
- `ACQUISITION_FAILED`: HTTP !ok / timeout / network / unsupported-type / rendered `complete:false`.
- `PARTIALLY_INSPECTED` (per-call): `failed && inspected` among that call's observations (line 143).
  Step 4 `PARTIAL`: same among `websiteOutcomes`. Overall `PARTIALLY_INSPECTED`: same among `communityRequired`.
- `ERROR` (Step 4 display): `failed && !inspected`. Overall `ACQUISITION_FAILED`: same among required.
- `budgetExhausted`: static child overflow (`explored>=8` or `depth>2`); rendered `!complete` (`server/crawlerTelemetry.ts:50`).
- `complete=false`: `timedOut || requestsFailed>0` or saturated/exception. Route-aborted image/media/font do not
  hit `errorHandler`; only failed navigations/requests count.
- No `INACCESSIBLE` / `NOT_ATTEMPTED` emitted today.

Proposed state machine (plan-only):

- `FOUND`: candidate extracted + attributed. Terminal success.
- `INSPECTED_NO_MATCH` (strict): HTTP success, main DOM parsed, 0 invites, `budgetExhausted==false`, `complete==true`.
  Only this may project `NOT_FOUND / COMPLETED`.
- `INACCESSIBLE` (new): DNS / timeout / 5xx / unsupported-type / rendered `complete:false`. Never `NOT_FOUND`;
  projects `UNCERTAIN` + `RETRY_PENDING` or `FAILED_OPERATIONAL`.
- `NOT_ATTEMPTED` (new): discovered but never fetched (deadline abort, quarantine without fetch). Audit-logged,
  never `INSPECTED_NO_MATCH`.
- `PARTIAL`: required set has ≥1 `INSPECTED_NO_MATCH` + ≥1 `INACCESSIBLE` / `ACQUISITION_FAILED`.
- `ERROR`: all required failed/inaccessible, zero inspected.

Rules: `INACCESSIBLE ≠ INSPECTED_NO_MATCH`; `NOT_ATTEMPTED ≠ INSPECTED_NO_MATCH`;
`budgetExhausted==true → PARTIALLY_INSPECTED` minimum; browser/nav failure → `INACCESSIBLE`, never absence.

## 4. URL extraction / normalization findings

- `https://g/`: `extractEmbeddedUrls` regex `/(?:(?:https?:)?\/\/)[^\s"'<>\)\\]+/gi` (`server/crawlerExtraction.ts:23`)
  matches `//g/` fragments; `//` → `https://` (line 27); `new URL('https://g/')` succeeds (WHATWG single-label);
  `normalizeExternalUrl` admits as `WEBSITE`; extraction blocklist does not filter. DNS fails → static
  `NETWORK_FAILURE retryable:true` → rendered 60s Playwright → `ACQUISITION_FAILED required:true` → Step 4 poison + retry job.
- Same admission for truncated / broken / broker / news / affiliate (except asset-ext filtered at extraction,
  but not for direct `channelLinks` via `normalizeExternalUrl`).
- Do NOT ship a generic dot-rule. `Z` unknown (see §7). Ship quarantine instead (§11 Phase A).

## 5. Crawl-budget and continuation findings

1. URLs per channel: unbounded (deduped count). 2. No hard per-channel cap. 3. Limits are per-seed static
   (1 root + ≤8 subs, ≤12 queued, depth ≤2) + per-seed rendered (6 pages, 60s) + 10s fetch + gate 1/8.
   4. Sequential `for...of await`, not concurrent. 5. No global crawl budget. 6. No per-channel budget.
   7. Per-URL static ≈9 fetches × 10s. 8. Per-URL rendered 60s total, 15s nav. 9. Max pages: static 9, rendered 6.
   10. Timeouts: 10s static, 15s nav, 60s rendered total. 11. Retries/rotations (3/4) consume same page/time budget.
   12. Yes — one slow URL linearly delays Step 4. 13. Failure pushes obs, loop continues. 14. No — later URLs still
   attempted. 15. Timeout stops only that fetch/seed. 16. No silent skip today — but a worker/job timeout outside
   Step 4 would leave remaining URLs with zero obs (silent gap, not `NOT_ATTEMPTED`). 17. No independent per-URL
   retry within a run; retry is whole-channel `RETRY_COMMUNITY_ACQUISITION`. 18. Yes — static non-FOUND escalates
   when trading. 19. Yes — rendered consumes 60s + gate slot per seed. 20-27. See §3. 28. Inaccessible stays
   `ACQUISITION_FAILED` at obs level (not mislabeled clean), but child-overflow IS mislabeled clean (see 30).
   29. No `NOT_ATTEMPTED` exists, so no mislabel — but child-overflow is hidden. 30. Yes — `budgetExhausted`
   ignored in final obs. 31. No — browser failure → `ACQUISITION_FAILED` → `UNCERTAIN`, never `NOT_FOUND` at backend.
   32. Scoring only reorders today. 33. Low-value consumes after high-value (ordered but not skipped) — waste,
   not starvation. 34-38. Yes: malformed, reference/news, asset (via direct-link path), broken/truncated, messaging
   all enter the `WEBSITE` path.

Fix direction (§8 compliant): keep no-cap + ordering; add tiered depth (high tiers full static + conditional
rendered; low tiers static-only 5s, 0 Playwright, `required:false`); per-URL try/catch + continue;
`NOT_ATTEMPTED` logging on deadline abort; `budgetExhausted → PARTIAL`.

## 6. Telegram / WhatsApp findings

- Enter as `WEBSITE` (verified live: `t.me`, `chat.whatsapp.com` → `WEBSITE`), static 10s fetch of `t.me/channel`
  (JS-heavy preview, often 0 invites statically) → `INSPECTED_NO_MATCH` → escalates to 60s Playwright clicking
  `tg://` dead-ends → waste + potential `ACQUISITION_FAILED required:true`.
- No in-repo evidence of historical `FOUND` via `t.me / wa.me` (recall tests cover `instagram`, `linktr.ee`,
  `creator.example`, `dsc.gg`, direct `discord.gg` only; `browserCommunityFallback.test.ts` only asserts permalink
  filtering). Any restrictive policy therefore has unknown `Z` — blind blacklist forbidden.
- Recall-safe policy: `MESSAGING_PREVIEW` kind; `https://t.me/s/{channel}` static Cheerio first;
  regex `discord.gg | discord.com/invite | dsc.gg` + bridge keywords; `FOUND` statically if present; escalate iff
  keyword/bridge evidence; else `INSPECTED_NO_MATCH required:false`, 0 launches. Same for `wa.me / chat.whatsapp.com`.
  Log seed + preview URL for audit.

## 7. Historical golden-set recall analysis (`Z = 0` required)

Covered by `server/discordDiscoveryRecall.test.ts` + `server/communityAcquisitionSemantics.test.ts`: bio/about direct,
channel-link direct + `dsc.gg` alternative resolution, video-desc direct (incl. newest-authoritative priority),
link-hub static (`linktr.ee → discord.gg`), creator domain, social bio (instagram → rendered), static 500 failure,
mixed success/failure, all-fail, all-clean, `COMPLETED` + recovery projection guard, partial community/upstream mapping.

Missing: production `FOUND` URL list; video-desc link-hub/creator `FOUND` via Step 4 (only direct-desc regex tested);
telegram/whatsapp `FOUND`; `https://g/` / truncated rejection proof; rendered timeout / inaccessible / unattempted /
mixed / all-fail Step 4 display; `COMPLETED` retry → recovery end-to-end with real job rows.

Local DB unreadable (`malformed`); production DB not queried (correctly untouched). Prior counts
(704 / 100614 / 681 / 537 / 696 / 530) appear only in that markdown — no reproducing script/query artifact —
so treat as unverified claims, not a golden set. Do NOT fabricate.

- `X` = all valid bio/link/desc/hub/creator/social/messaging URLs with production `FOUND`.
- `Y` = would-become-`NOT_ATTEMPTED`. `Z` = incorrectly excluded. Required invariant: `Z = 0`.
- **No exclusion / normalization / priority / budget / rendered / messaging / malformed policy in this plan is
  certified `Z=0` today.** All are marked `NEEDS-PROD-VERIFY`.

Read-only production queries required before implementation (run only with explicit approval/access):

```sql
-- FOUND surfaces
SELECT provenance->>'surface', requested_url, COUNT(*)
FROM external_acquisition_observations WHERE outcome='FOUND' GROUP BY 1,2 ORDER BY 1;
-- video-desc FOUND
SELECT requested_url, provenance FROM external_acquisition_observations
WHERE outcome='FOUND' AND provenance->>'surface'='RECENT_VIDEO_DESCRIPTIONS';
-- messaging dependence
SELECT requested_url, final_url, provenance FROM external_acquisition_observations
WHERE outcome='FOUND'
AND (requested_url ILIKE '%t.me%' OR requested_url ILIKE '%telegram%'
 OR requested_url ILIKE '%whatsapp%' OR requested_url ILIKE '%wa.me%');
-- dotless / truncated among FOUND
SELECT requested_url FROM external_acquisition_observations
WHERE outcome='FOUND' AND requested_url ~ '^https?://[^./]+/?$';
-- retry staleness sample
SELECT c.channel_id, c.scan_status, c.discord_validation_status, j.status,
       j.payload->>'retryReason', j.created_at
FROM channels c JOIN jobs j ON j.payload->>'channelId'=c.channel_id
AND j.type='RETRY_COMMUNITY_ACQUISITION'
WHERE j.created_at=(SELECT MAX(created_at) FROM jobs
 WHERE type='RETRY_COMMUNITY_ACQUISITION' AND payload->>'channelId'=c.channel_id) LIMIT 1000;
```

If any proposed rule excludes a production `FOUND` URL → `Z>0` → STOP, report URL + surface + excluding rule +
correction.

## 7A. Production verification results (read-only, 2026-09-03, PLAN-ONLY update for PR #434)

> No implementation, no production writes, no queue/concurrency changes, no deploys.
> Methods were read-only: source reads, `node --import tsx -e` pure-function probes,
> `node --import tsx --test` local suites, and read-only filesystem/env checks.
> Implementation gate verdict is at the end of this section.

### 7A.1 Production access actually available from this terminal

- `DATABASE_URL`: **absent** (`python3 -c "DATABASE_URL in os.environ" => False`). No `.env` file exists
  (only `.env.example`, which documents `DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"`).
  `server/dbCore.ts:85-101` throws without `DATABASE_URL` and disables the SQL.js fallback, so `getDb()`
  cannot connect from here. **No production read query was possible; none was attempted beyond this check.**
- CLIs: `railway` not installed, `psql`/`pg_isready` not installed, `rg` not installed. No Railway-injected
  Postgres vars in `env` (only generic container vars). GitHub `gh auth status` is logged in, but no production
  forensic dump exists in issues (#228, #214 unrelated) or PRs (#433 is the prior plan doc, not data).
- Local `data/test.db`, `data/trading_engine.db`, `data/trading_engine.backup.db`: all report
  `database disk image is malformed` on read-only open. `about_channel.html` (1.6 MB) is a single saved YouTube
  page, not a golden dataset. `server/fixtures/youtube-channel-sections/` contains only
  `empty-sections.json` / `multiple-channels.json`. No `external_acquisition_observations` / `jobs` dump,
  CSV, or JSONL with production FOUND URLs exists anywhere in-repo (searched `server/`, `tests/`, `docs/`,
  `scripts/`, root; only synthetic test codes found).
- Prior counts (704 / 100614 / 681 / 537 / 696 / 530) appear only in PR #433's markdown on branch
  `docs/community-acquisition-forensics-and-plan`. No reproducing query, script output, or artifact exists
  in-repo. They are therefore **unverified claims**, not a golden dataset, and were NOT used as evidence here.
- Consequence: the **production** FOUND golden set could not be established from this terminal because
  read-only production access does not already exist here. What is established below is the complete
  **verifiable in-repo FOUND golden set** (synthetic, explicitly labeled, no fabrication), plus executable
  read-only production queries that must run where access exists before any exclusion rule ships.
  Any rule whose production `Z` remains unknown is marked `NOT IMPLEMENTATION-READY`; the implementation gate
  for those rules stays closed.

### 7A.2 Verifiable in-repo FOUND golden set (synthetic, read-only, no fabrication)

Built from `server/discordDiscoveryRecall.test.ts`, `server/communityAcquisitionSemantics.test.ts`,
`server/discordMultiCandidateOwnership.test.ts`, `server/discoveryDepthRegression.test.ts`,
`server/browserCommunityFallback.test.ts`, `server/discordDiscoveryRetention.test.ts`,
`server/inspectionRetentionReviewRouting.test.ts`, executed locally:
`discordDiscoveryRecall + communitySurfacePolicy + browserCommunityFallback` = 27/27 pass;
`communityAcquisitionSemantics + communityRetryPolicy + communityRecovery` = 52/52 pass.
`grep -rhoE discord.gg/dsc.gg` across `server/ + tests/` = **40 unique synthetic invite strings**
(e.g. `about-room`, `recent-room`, `dynamic-room`, `social-room`, `native-room`, `partner-room`,
`creator-room`, `RealTradingRoom`, `8i7rSxaaW6`, `bioCode99`, `vidCode77`; full list in verification logs,
all test codes, zero production invites). The **acquisition-relevant golden subset** (seed URL actually
crawled/inspected with `foundInvite != null`, or direct Step 1-3 FOUND) is 11 entries:

| # | Seed / source text (must remain reachable) | FOUND code(s) | Surface | Category | Test evidence |
|---|---|---|---|---|---|
| G1 | `https://creator.example/` | `dynamic-room` via `https://linktr.ee/trading-community` | `CREATOR_WEBSITES` (static) | Creator-owned / channel-provided website | `discordDiscoveryRecall.test.ts:116-134` |
| G2 | `https://linktr.ee/trading-community` (dynamic target) | `dynamic-room` | `CREATOR_WEBSITES` (static anchor + data-url) | Link hub | Same test, `<div data-url="https://linktr.ee/trading-community">` + `<a href="https://discord.gg/dynamic-room">` |
| G3 | `https://instagram.com/exampletrader` | `social-room` (rendered) | `SOCIAL_PROFILES` (static no-match → rendered FOUND) | Social / channel-provided | `discordDiscoveryRecall.test.ts:72-100` |
| G4 | `https://creator.test` | `creator-room` + `partner-room` | `CREATOR_WEBSITES` (static) | Creator-owned | `discordMultiCandidateOwnership.test.ts:13-20` |
| G5 | `https://broker.test/referral/creator` (source URL carrying `https://discord.gg/partner`) | `partner` | `CREATOR_WEBSITES` | Broker-pattern URL — **proves broker/affiliate-pattern URLs cannot be excluded** | `discordMultiCandidateOwnership.test.ts:32-33` |
| G6 | `https://dsc.gg/vanity-room` | `native-room` (resolved) | `CHANNEL_EXTERNAL_LINKS` (alternative redirect) | Channel-provided / vanity | `communityAcquisitionSemantics.test.ts:127` |
| G7 | `https://linktr.ee/example` (inside video description) | seed must remain attempted (hub) | `CREATOR_WEBSITES` seed from `RECENT_VIDEO_DESCRIPTIONS` | Video-desc hub | `discordDiscoveryRecall.test.ts:59` (`... https://discord.gg/recent-room https://linktr.ee/example`) |
| G8 | `https://beacons.ai/trader` | seed must remain attempted (hub) | `CREATOR_WEBSITES` | Link hub | `communitySurfacePolicy.test.ts:22` + ranking |
| D1 | Bio `... join https://discord.gg/about-room` | `about-room` | `YOUTUBE_ABOUT` (Step 1, direct, no Step 4 crawl) | Bio / About | `discordDiscoveryRecall.test.ts:34`, `communityAcquisitionSemantics.test.ts:105` |
| D2 | Video desc `... https://discord.gg/recent-room` | `recent-room` | `RECENT_VIDEO_DESCRIPTIONS` (Step 3, direct) | Video description (direct) | `discordDiscoveryRecall.test.ts:59`, `communityAcquisitionSemantics.test.ts:99` |
| D3 | Channel link `https://discord.gg/link-room` | `link-room` | `CHANNEL_EXTERNAL_LINKS` (Step 2, direct) | Channel-provided link | `communityAcquisitionSemantics.test.ts:106` |

Live pure-function probes (this session) confirm all 8 Step-4 seeds extract (`extractEmbeddedUrls`) and
normalize today: creator/link-hub/beacons/instagram/creator.test/broker.test/`t.me`/`wa.me`/`https://g/`/`dsc.gg`
all admitted (`kind WEBSITE`, except instagram `SOCIAL`); direct `https://discord.gg/about-room` normalizes to
`null` **by design** (handled in Steps 1-3, still FOUND — null here is not exclusion).

Requested breakdowns (verifiable in-repo; production equivalents still require §7 queries):

- **Total historical FOUND URLs**: production total = **unknown from this terminal** (no access, see §7A.1).
  Verifiable in-repo total = **11 acquisition golden entries** (8 Step-4 seeds + 3 direct), drawn from 40 unique
  synthetic invite strings. Nothing was invented; all codes above are literal test strings.
- **FOUND by surface**: `YOUTUBE_ABOUT` ≥1 (`about-room`), `RECENT_VIDEO_DESCRIPTIONS` ≥1 (`recent-room`),
  `CHANNEL_EXTERNAL_LINKS` ≥2 (`link-room`, `native-room` via `dsc.gg`), `CREATOR_WEBSITES` ≥5
  (`dynamic-room` ×2 paths, `creator-room`, `partner-room`, `partner` via broker URL), `SOCIAL_PROFILES` ≥1
  (`social-room` via rendered). `DISCORD_VALIDATION` has no acquisition FOUND (validation-only codes excluded).
- **Video-description FOUND**: direct `recent-room` (Step 3 regex) plus hub seed `linktr.ee/example` co-occurring
  in the same newest-authoritative description (`recentVideoDescriptionsLoader` test). Multi-surface retention
  (`stale` + `active`, `same-room` in bio + video) proves descriptions are additive, never truncated beyond newest 5.
  Video-desc eligibility must stay.
- **Creator-owned / channel-provided / link-hub FOUND**: `creator.example/` + `creator.test` (creator-owned),
  `instagram.com/exampletrader` + `dsc.gg/vanity-room` (channel-provided), `linktr.ee/*` + `beacons.ai/*`
  (link hubs, static anchor + `data-href`/`data-url` paths, incl. protocol-relative `//linktr.ee/trader&club`
  decoding test). All must remain attempted.
- **Telegram/WhatsApp FOUND dependencies**: **0 in-repo** (`t.me` appears only in
  `browserCommunityFallback.test.ts:17-26` permalink-eligibility assertions, zero `foundInvite`; `whatsapp`/`wa.me`
  appear nowhere in tests). Production dependence = **unknown** (requires messaging query in §7). Therefore no
  hard-blacklist evidence exists; see revised policy below.
- **Malformed / dotless / truncated FOUND**: **0 in-repo** (`https://g/` appears nowhere in `server/*.test.ts`;
  truncation test only covers long `discord.gg` codes, which are retained not truncated). Production presence =
  **unknown** (requires dotless query in §7). Therefore no hard-reject evidence exists; quarantine only.

### 7A.3 X / Y / Z per proposed rule (X = still attempted, Y = NOT_ATTEMPTED, Z = wrongly excluded; gate Z = 0)

Evaluated by executing the actual functions (`normalizeExternalUrl`, `extractEmbeddedUrls`,
`scoreCommunitySurface`/`rankCommunitySurfaces`, `shouldEscalateToRenderedFallback`,
`isTelegramPostPermalink`/`shouldEnqueueRenderedCommunityLink`) against the §7A.2 golden set.
`Z` has two columns: in-repo (proven here) and production (unknown unless stated).

| Rule | X (in-repo 11) | Y | Z in-repo | Z prod | Verdict |
|---|---|---|---|---|---|
| Rank-only ordering (current `rankCommunitySurfaces`, no discard) | 11 | 0 | **0** (20→20 length preserved; `ranking is prioritization only` test passes) | 0 by construction (no discard) | **SAFE** |
| Direct-discord `normalize=>null` (Steps 1-3 handle, Step 4 skips) | 11 (3 direct FOUND via Steps 1-3, 8 seeds via Step 4) | 0 | **0** | 0 by design | **SAFE** |
| Existing asset-ext extraction filter (`png/jpg/...` in `extractExternalUrlsFromText`) | 11 (no golden seed has asset ext) | 0 | **0** | Unknown (needs asset-among-FOUND query) | **SAFE only as-is**; any extension of the list needs prod proof |
| Dot-rule hard-reject (`hostname must contain dot`, prior `isValidPublicWebUrl`) | 11 (all golden hosts have dots; only `https://g/` lacks one and it is not FOUND in-repo) | 0 in-repo | **0 in-repo** | **UNKNOWN** | **NOT IMPLEMENTATION-READY as hard-reject**. Ship **quarantine** instead (cheap static attempt, 0 Playwright for dotless, `INACCESSIBLE required:false`, log): quarantine X=11 Y=0 Z=0 in-repo and recall-safe by construction |
| `Slice websiteUrls to ≤4` (prior plan) | 4 of 8 seeds in 20-URL probe | 4 | **4 — GATE FAIL** | Fail | **REJECTED. DO NOT SHIP.** Affected: `https://instagram.com/exampletrader` (social-room), `https://creator.test` (creator/partner-room), `https://broker.test/referral/creator` (partner), `https://dsc.gg/vanity-room` (native-room) — all FOUND, all outside top-4 (`top4 = linktr.ee/example, linktr.ee/trading-community, beacons.ai/trader, creator.example/`). Cause: hub/channel-source boost outranks social/broker/affiliate-demoted URLs. Correction: no slice; priority + tiered depth + continuation (Phase A revised) |
| Broker-host exclusion / affiliate-pattern exclusion | ≤10 | ≥1 | **≥1 — GATE FAIL** (`broker.test/referral/creator → partner` matches affiliate pattern `/referral/` → score -45; `binance.com/.../CPA` scores -110 but same class) | Fail | **REJECTED. DO NOT SHIP.** Affected: `https://broker.test/referral/creator` (FOUND `partner`). Correction: demote (score) but still attempt static-only, `required:false`, 0 Playwright |
| Messaging hard-blacklist (exclude `t.me/wa.me/chat.whatsapp.com`) | 11 (no messaging FOUND in-repo) | 0 in-repo | **0 in-repo** | **UNKNOWN** | **NOT IMPLEMENTATION-READY. DO NOT SHIP as blacklist.** Ship lightweight-static + evidence escalation instead (below) |
| Messaging lightweight-static + evidence escalation (revised §7A.4) | 11 | 0 | **0** (still attempts every messaging seed statically; rendered only on evidence) | Unknown but recall-safe by construction (attempt preserved) | **PREFERRED** (pending prod messaging query for tuning, not for safety) |
| Rendered restriction to high tiers + evidence (social/hub/creator still escalate; low-tier/aux static-only, 0 Playwright) | 11 (`INSPECTED_NO_MATCH/PARTIAL/ACQUISITION_FAILED → escalate=true` for trading creators preserved for `CREATOR_WEBSITES/SOCIAL_PROFILES`; `FOUND → false` avoids waste; instagram no-match still escalates to `social-room`) | 0 | **0** | Unknown (needs rendered-among-FOUND query) | **SAFE subject to keeping social + hub + creator + contextMatch in high tier**; low-tier static-only must keep `required:false` so failures cannot poison Step 4 |
| `budgetExhausted → PARTIALLY_INSPECTED`, `INACCESSIBLE`/`NOT_ATTEMPTED` states, `required:true` only for primary surfaces, per-URL try/catch + continue | 11 (no discard) | 0 (only newly logged, never newly skipped) | **0** | 0 by construction | **SAFE** |
| Stale-projection guard, surface-aware reason, dashboard truth matrix | n/a (no URL discard) | 0 | **0** | 0 | **SAFE** (no recall impact) |

Implementation gate: **Z = 0 required. `Slice ≤4`, broker/affiliate exclusion FAIL even in-repo — removed from the
plan and must not ship.** Dot hard-reject and messaging blacklist have in-repo Z = 0 but production Z = UNKNOWN —
they are **not approved**; the quarantine / lightweight alternatives above are the plan of record. No rule with
production-unknown Z may become a hard-reject/blacklist without running §7 queries where access exists and
documenting Z = 0 with the affected-URL list (empty) attached.

### 7A.4 Revised Telegram / WhatsApp policy (evidence-bound, no blind blacklist)

1. **No default expensive rendered crawling for messaging.** `t.me/*`, `telegram.me/*`, `wa.me/*`,
   `chat.whatsapp.com/*` (plus `telegram.dog` mirrors, pending golden check) classify as `MESSAGING_PREVIEW`,
   never `WEBSITE`. Default path is **lightweight static only**: fetch the public preview
   (`https://t.me/s/{channel}` preferred, fallback `https://t.me/{channel}`; WhatsApp invite preview URL),
   5-10s timeout, Cheerio parse of bio/description/pinned text + anchors, `extractDiscordCandidates` statically.
   **Zero Playwright launches on this path.** Rationale: in-repo evidence shows messaging seeds admitted as
   `WEBSITE` today and escalated (waste proven); zero in-repo FOUND via messaging means a blacklist would have
   in-repo Z = 0 but production Z unknown, so the recall-safe choice under uncertainty is static-attempt, not discard.
2. **Lightweight/static inspection where appropriate.** Static success with `discord.gg/discord.com/invite/dsc.gg`
   → `FOUND` (no escalation needed). Static clean with no signals → `INSPECTED_NO_MATCH required:false`
   (cannot poison Step 4, cannot create retry). Static inaccessible (DNS/timeout/non-HTML) → `INACCESSIBLE
   required:false`. All seeds logged with preview URL for audit.
3. **No blind hard-blacklist.** Explicitly forbidden unless the production messaging-among-FOUND query returns zero
   rows **and** the empty affected-URL list is attached to this plan as an approved exception. That evidence does
   not exist today (production query not runnable from here), so blacklisting is not part of the plan.
4. **Escalation path retained on evidence.** Escalate a messaging seed to the bounded rendered fallback (same 60s
   budget accounting as other seeds) **iff** static preview contains bridge evidence: literal `discord` keyword,
   `discord.gg` obfuscation, `join/community/chat/vip/members` co-located with an outbound bridge widget/link,
   or a same-host community-link control matching `COMMUNITY_HINTS`. Telegram post permalinks (`t.me/.../123`,
   `t.me/s/.../123`) remain excluded as *child* crawl targets (`isTelegramPostPermalink` /
   `shouldEnqueueRenderedCommunityLink` behavior preserved) but an explicitly supplied permalink seed is still
   statically attempted, never silently dropped (`NOT_ATTEMPTED` logged only if a worker deadline forces abort).
5. **Why recall is preserved.** Every messaging seed is still attempted (statically); any server-rendered Discord
   invite in the preview is captured without Playwright; JS-hidden invites still have the evidence-gated rendered
   path. In-repo Z = 0; production tuning (evidence keywords, mirror list) requires the messaging query in §7
   but safety does not depend on it.

### 7A.5 What must run where production access exists (read-only, before any hard-reject)

```sql
-- 1. FOUND by surface (establishes X baseline)
SELECT COALESCE(provenance->>'surface','UNKNOWN') AS surface, COUNT(*) AS found_obs,
       COUNT(DISTINCT requested_url) AS found_urls
FROM external_acquisition_observations WHERE outcome='FOUND' GROUP BY 1 ORDER BY 1;
-- 2. Video-desc FOUND (protects §3)
SELECT requested_url, provenance, observed_at FROM external_acquisition_observations
WHERE outcome='FOUND' AND provenance->>'surface'='RECENT_VIDEO_DESCRIPTIONS' ORDER BY observed_at DESC LIMIT 500;
-- 3. Hub / creator / channel-provided FOUND
SELECT requested_url, provenance FROM external_acquisition_observations WHERE outcome='FOUND'
AND (requested_url ILIKE '%linktr.ee%' OR requested_url ILIKE '%beacons.ai%' OR requested_url ILIKE '%bio.link%'
 OR requested_url ILIKE '%solo.to%' OR requested_url ILIKE '%whop.com%' OR requested_url ILIKE '%skool.com%')
ORDER BY requested_url LIMIT 500;
-- 4. Messaging dependence (gates blacklist; expected unknown until run)
SELECT requested_url, final_url, provenance, observed_at FROM external_acquisition_observations
WHERE outcome='FOUND' AND (requested_url ILIKE '%t.me%' OR requested_url ILIKE '%telegram%'
OR requested_url ILIKE '%whatsapp%' OR requested_url ILIKE '%wa.me%') LIMIT 500;
-- 5. Dotless / malformed among FOUND (gates dot-rule)
SELECT requested_url, provenance FROM external_acquisition_observations
WHERE outcome='FOUND' AND requested_url ~ '^https?://[^./]+/?($|\\?)' LIMIT 500;
-- 6. Asset / broker / affiliate among FOUND (gates quality filters)
SELECT requested_url, provenance FROM external_acquisition_observations WHERE outcome='FOUND'
AND (requested_url ~* '\\.(png|jpg|jpeg|gif|webp|svg|css|js|wasm|ico|woff2?|ttf|eot|mp4|mp3|pdf|zip)(\\?|$)'
OR requested_url ILIKE '%binance%' OR requested_url ILIKE '%coinbase%' OR requested_url ILIKE '%kraken%'
OR requested_url ILIKE '%bybit%' OR requested_url ILIKE '%etoro%' OR requested_url ~* '/(ref(erral)?|affiliate|promo|coupon)(/|\\?|$)') LIMIT 500;
-- 7. Staleness sample (Problems B/C context)
SELECT c.channel_id, c.scan_status, c.discord_validation_status, j.status AS job_status,
       j.payload->>'retryReason' AS retry_reason, j.created_at
FROM channels c JOIN jobs j ON j.payload->>'channelId'=c.channel_id AND j.type='RETRY_COMMUNITY_ACQUISITION'
WHERE j.created_at=(SELECT MAX(created_at) FROM jobs WHERE type='RETRY_COMMUNITY_ACQUISITION'
AND payload->>'channelId'=c.channel_id) ORDER BY j.created_at DESC LIMIT 1000;
```

Attach result tables + `Z` recomputation to this section before approving any hard-reject. Until then the
quarantine / lightweight / no-slice policies above are the plan of record, and the implementation gate for
exclusion rules remains closed — which is the recall-safe outcome the user required.

## 8. Stale retry metadata root cause

Authoritative source should be `channels.scan_status + discord_validation_status + live PENDING job`, not durable
job payload. Today `listChannelsPage` (`server/dbCore.ts:366-379`, 14x lateral `ORDER BY created_at DESC LIMIT 1`)
projects the newest job unconditionally. `reconcileLegacyCommunityRetryOwnership`
(`server/communityRecovery.ts:168-233`) only touches `retryLifecycleVersion < 2 AND retryReason <> COMMUNITY AND
(PENDING or narrow COMPLETED)` — v2 `COMPLETED` on recovered channels never reconciled. The ±5min window
(`observed_at BETWEEN last_checked ± 5min`; `server/communityRecovery.ts:182-183,198-199`,
`server/dbCore.ts:438-439`) means recovery hours/days later looks like "no current failure" but the reconciler
never runs for that row while projection still shows the old `retryReason / attempts`.

Safest sequence (combination, projection first): (B1) projection guard in `dbCore.ts` (display
`community_retry_job_*` only when `scan IN (FAILED, FAILED_PERMANENT) AND validation = RETRY_PENDING AND job IN
(PENDING, PROCESSING)`, else `NULL`); (B2) widen reconciler to v2 `COMPLETED` + recovered
(`scan COMPLETED AND validation COMPLETED`) → null reconciliation fields, no channel mutation; (B3) replace ±5min
with `observed_at > last recovery OR last_checked`, keeping 5min only as tie-breaker. No schema change, no history rewrite.

## 9. UPSTREAM vs COMMUNITY classification root cause

- `communityAcquisitionRetryDirective` (correct): `COMMUNITY` for community surfaces, `BROWSER` for runtime,
  YouTube surfaces excluded (`server/communityRetryPolicy.ts:132-155`).
- Leak paths (verified): `server/queueManager.ts:162` recovery hardcode `UPSTREAM`; `:894` validation-429 hardcode
  `UPSTREAM` (Discord API 429 is community/validation, not YouTube); `:956` `directive?.retryReason || UPSTREAM`
  default; `:939` `retryReasonFromError → retryReasonForFailureClass → UPSTREAM` for any non-browser code
  (website timeouts, `ECONNRESET`, etc.). Stale projection then preserves the wrong reason.
- Surface-aware model (plan-only):

```ts
surfaceAwareRetryReason(surface, failureClass) {
  if (isBrowserRuntimeFailureClass(failureClass)) return BROWSER_RUNTIME_UNAVAILABLE;
  if (surface === 'YOUTUBE_ABOUT' || surface === 'RECENT_VIDEO_DESCRIPTIONS')
    return UPSTREAM_REQUIRED_ACQUISITION_FAILURE;
  return COMMUNITY_REQUIRED_ACQUISITION_FAILURE;
}
```

Apply at all 4 call sites; change `retryReasonForFailureClass(failureClass)` to `(failureClass, surface)`;
validation-429 → `COMMUNITY`; recovery → derive from current obs surface, default `COMMUNITY`.

## 10. Dashboard semantic problems

- `src/components/ResultsTable.tsx:514-519`: `discord_discovery_status NOT_DISCOVERED → 'Not discovered'` even when
  `ACQUISITION_FAILED / PARTIALLY_INSPECTED`. Must gate: if `scan FAILED` + (`validation RETRY_PENDING` /
  `FAILED_OPERATIONAL`) → `'Website acquisition incomplete'` / `'Discovered · validation failed'` only with locator.
- `:525-529,551`: retry banner + `RETRY DUE / QUEUED` from job row without checking active state. Must require
  `scan FAILED` + `validation RETRY_PENDING` + `job PENDING/PROCESSING`; `COMPLETED` jobs → hidden, show `COMPLETED`.
- Add explicit `PARTIAL` (`Mixed coverage — N inspected, M unavailable`) and `ERROR`
  (`Acquisition failed — absence not confirmed`); never `Clean inspection · no community found` unless strict
  `INSPECTED_NO_MATCH` with `budgetExhausted==false`.

## 11. Proposed phased implementation plan (recall-safe, no arbitrary caps)

Order justified: coverage/state first (later fixes would otherwise misclassify), then attribution, then projection,
then messaging, then UI. A `≤4` slice is explicitly rejected.

- **Phase A — Extraction / normalization quarantine + Step 4 semantics + continuation (no cap).**
  Add `MESSAGING_PREVIEW` kind (no blacklist); quarantine dotless/truncated/asset via static-only `required:false` +
  0 Playwright (no hard reject); add `INACCESSIBLE` / `NOT_ATTEMPTED`; `budgetExhausted → PARTIALLY_INSPECTED`;
  `required:true` only for `CHANNEL_EXTERNAL_LINKS` + primary creator domain (`CHANNEL_LINKS` / `ABOUT` source) +
  high-confidence hub with `contextMatch`; auxiliary `required:false`; per-URL try/catch + continue; tiered inspection
  (T1 direct → extract; T2 hub/platform/creator → static + conditional rendered; T3 social → static + conditional;
  T4 messaging → preview-only; T5 video-desc generic → static-only; T6 affiliate/broker → static-only 5s).
  Video-desc eligibility untouched.
- **Phase B — Surface-aware classification.** Fix 4 `UPSTREAM` paths + signature change. No scheduling change.
- **Phase C — Stale projection / reconciliation.** `dbCore` guard first, then reconciler widening + window fix. No DDL.
- **Phase D — Telegram / WhatsApp lightweight policy.** Static preview + evidence escalation, behind Phase A kinds.
- **Phase E — Dashboard truth matrix.** Render-only.

Each phase ships only after its golden-set `Z=0` check (§7 queries + §12 suites).

Recommended order stands (A → B → C → D → E); do not run C before A or real failures get hidden.

## 12. Test plan (21 suites, `Z=0` gate)

Map to existing files + new prod-query gate: 1-5 recall (bio / link / desc / hub / creator — extend
`server/discordDiscoveryRecall.test.ts` with production `FOUND` URLs); 6-7 messaging static + escalation
(`server/browserCommunityFallback.test.ts`); 8-9 malformed / truncated / asset quarantine (new; must prove `Z=0`
via §7 query before any hard-reject); 10-13 static 500 / rendered incomplete / timeout-transient /
inaccessible → `UNCERTAIN`; 14 no-cap + `NOT_ATTEMPTED` logging (assert `rankCommunitySurfaces` length preserved +
20-URL channel all attempted or logged); 15-18 mixed → `PARTIAL`, all-fail → `ERROR` + directive, all-clean →
`NOT_FOUND` no directive, success → `FOUND`; 19 `COMPLETED` + recovery hides retry
(`server/channelMasterDiscordRecovery.test.ts`); 20-21 community vs upstream mapping
(`server/communityRetryPolicy.test.ts`). Plus `npm test && npm run lint` per phase. Any `Z>0` blocks ship.

## 13. Rollback strategy

No DDL, no payload schema break, no queue/config change. Each phase is pure logic/render guard → single `git revert`.
Projection guard rollback is instant (display only). Reconciler widening must be idempotent + `status PENDING` guard.
No data backfill needed.

## 14. Files expected to change (implementation, after approval only)

`server/crawlerExtraction.ts` (quarantine helpers, no hard dot-reject); `server/communitySurfacePolicy.ts`
(tiers + `MESSAGING_PREVIEW`, rank-only preserved); `server/inspector.ts` (kinds, `required` tagging,
`INACCESSIBLE` / `NOT_ATTEMPTED`, continuation); `server/browserCommunityFallback.ts` (evidence-gated escalation,
no runtime redesign); `server/crawlerTelemetry.ts` (budget semantics); `server/communityRetryPolicy.ts` +
`server/queueManager.ts` (surface-aware reason); `server/communityRecovery.ts` + `server/dbCore.ts`
(guard + widen); `src/components/ResultsTable.tsx` (truth matrix); tests listed in §12.

## 15. Explicit uncertainties

1. Production `FOUND` dependence on `t.me / wa.me` / dotless / truncated — unknown (no prod query run here);
   policies marked `NEEDS-PROD-VERIFY`.
2. Prior forensic counts (704 / 100614 / 681 / 537 / 696 / 530) — unverified, no reproducing artifact; re-run §7 queries.
3. Worker-level timeout killing long 20-URL runs — no explicit Step 4 deadline found; needs
   production job-duration telemetry (`getCrawlerReliabilityMetrics`, `server/dbCore.ts:133`).
4. Subresource vs navigation failure split for `complete=false` — route-aborted assets excluded, blocked navigations
   included; needs Playwright log sampling.
5. Non-standard ports / mirror domains (`:8080`, `telegram.dog`) — `new URL` handles ports; mirrors should map to
   `MESSAGING_PREVIEW`, pending golden check.
6. `RENDERED_FALLBACK_SATURATED` frequency under concurrency 1 — needs prod gate telemetry before any tuning
   (do not change concurrency per constraints).
7. Local `data/*.db` unreadable here (`malformed`); production Postgres observations table assumed from code
   (`external_acquisition_observations`, `jobs`, `job_attempts`, `channels`) but live row counts not verified.

---

## Appendix — verification performed (read-only)

Initial investigation plus 2026-09-03 production-verification update (both read-only, no prod writes):

- `server/inspector.ts:12-193`, `server/crawlerExtraction.ts:1-63`, `server/communitySurfacePolicy.ts:1-161`,
  `server/communityRetryPolicy.ts:1-162`, `server/browserCommunityFallback.ts:1-316`,
  `server/renderedCrawlerPolicy.ts:1-50`, `server/crawlerTelemetry.ts:1-89`, `server/communityRecovery.ts:1-433`,
  `server/queueManager.ts:155-163,210-212,666-669,821-932,934-962`, `server/dbCore.ts:356-460`,
  `src/components/ResultsTable.tsx:335-351,480,514-533,551-564`,
  `server/discordDiscoveryRecall.test.ts`, `server/communityAcquisitionSemantics.test.ts`,
  `server/communitySurfacePolicy.test.ts`, `server/browserCommunityFallback.test.ts`.
- Live pure-function probes: `extractEmbeddedUrls`, `normalizeExternalUrl('https://g/' | 'https://t.me/...' |
  'https://chat.whatsapp.com/...')`, `extractExternalUrlsFromText`, `scoreCommunitySurface` / `rankCommunitySurfaces`.
- `git log / status / diff`, `ls docs/ scripts/ data/`, read-only `sqlite3` probe (failed with `malformed`, no writes).
