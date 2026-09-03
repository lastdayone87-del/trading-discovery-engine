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
