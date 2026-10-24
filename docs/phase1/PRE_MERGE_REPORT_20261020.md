# Phase 1 verification and pre-merge report — 2026-10-21

Status: **STOPPED FOR EXPLICIT APPROVAL.** This session has not merged,
deployed, applied a production migration, changed a flag/setting, activated
enforcement, resumed a queue, or run a probe. PR #531 was already merged by an
external actor; this report records that fact and does not attempt to undo it.

This version supersedes the 2026-10-20 draft and is updated in the existing
`feat/youtube-key-hard-cap` / PR #533 workstream. No separate docs-only PR was
opened.

## 1. Verdict

- **PR #531** merged externally at `2026-10-20T23:37:42Z`; GitHub reports merge
  commit `b1aafabf506c5c86856ec2e9f87e50591854c69b`. Its net diff is **106
  files, +14,595/−358** from base `82e60e7`.
- **PR #533** is open against `main` at `b1aafab`, code head `ac32978`, default
  OFF. It is not merged, deployed, or enabled.
- **Probe activation is blocked** by Thread 77 (no structural zero-official-unit
  guarantee) and by the InnerTube policy (production use not authorized). No
  production probe date is currently defensible.
- **24 October is not a deployment date.** It was only the hypothetical end of
  a 72-hour observation if a pilot had started on 21 October. No pilot started.
- **26 October is the earliest conditional integration/pilot-stack deployment
  date** (default OFF), not an activation date. The earliest conditional probe
  activation is **27 October**, and only after every gate below is satisfied.

## 2. PR #531 merge, exact scope, and compatibility

### Merge and net diff

| Item | Value |
| --- | --- |
| PR | [#531](https://github.com/lastdayone87-del/trading-discovery-engine/pull/531) |
| Base | `82e60e715294d459a34e3bd763d5630bf52827c8` |
| Merge commit | `b1aafabf506c5c86856ec2e9f87e50591854c69b` |
| Merged at | `2026-10-20T23:37:42Z` |
| Net diff | **106 files, +14,595 / −358** |

### How the 106 files were assembled

The merge contains four workstreams. These are segments, not independent
ownership claims; **23 file paths appear in more than one segment** (19 in
exactly two, 4 in three), so the segment counts do not sum to the net total.

| Segment | Files | Diff | Exclusive files | Meaning |
| --- | ---: | ---: | ---: | --- |
| Phase 1 work before #530 (`82e60e7..f5aaf1d`) | 48 | +8,026 / −26 | 29 | Phase 1 evidence/probe/shadow foundation |
| #530 (`f5aaf1d..6267ba1`) | 66 | +6,127 / −365 | 53 | Discovery-integrity P1–P4; migrations 149–152 |
| #531 work after #530 (`6267ba1..866e32d`) | 15 | +327 / −97 | 1 | Review fixes, probe/documentation updates |
| #532 (`866e32d..b1aafab`) | 4 | +363 / −118 | 0 | Final-click coverage follow-up |

**Inherited/out-of-scope content in the #531 merge:** all **66 #530 files** and
all **4 #532 files**. Of the #530 files, 53 have no later #531/#532 edit; those
are the clearest out-of-scope inherited files and are listed in Appendix A. The
four #532 files are `server/acquisitionV2Contracts.test.ts`,
`server/browserCommunityFallback.ts`, `server/crawlerEnqueuePolicy.test.ts`, and
`server/renderedInteractionCoverage.test.ts`; each also appears in an earlier
segment, so there is no #532-only path. Appendix B lists the 15 post-#530 #531
files.

### Compatibility

- #530 added migrations **149–152**; #531 added **146–148**. Migration numbers
  **141–152 are unique**, with no duplicate version or ordering conflict.
- #532 adds no migration. The four #532 files merge cleanly onto the #531 tree.
- No file-level conflict remains. The merge is already in `main`; this session
  did not reopen, revert, or modify #530/#532.
- **Production migration state is unverified.** There is no production access
  in this session, so claims about which migrations are applied are not made.
  Any future deployment must use the normal migration runner, not manual DDL.
- **Review state:** #531's Greptile Review is **SUCCESS**. Its PR Agent check
  failed only on Gemini `API_KEY_INVALID`; that is infrastructure, not a code
  finding.

## 3. PR #533 review, tests, and dispositions

PR: [#533](https://github.com/lastdayone87-del/trading-discovery-engine/pull/533)
· base `b1aafab` · branch `feat/youtube-key-hard-cap` · code head `ac32978` ·
default OFF · no new migration.

### Review rounds and heads

1. **Round 1** — the initial review found dispatch-day, bounded-wait, sweep,
   error-preservation, no-item accounting, and stale-test issues. Fixes landed
   at `c39b965`.
2. **Round 2** — the re-review at `c39b965` produced additional findings
   (literal-`true` parsing, cold-settings handling, post-spend refetch, and an
   old test assertion). Fixes landed at `3954440`; test-only Pacific-day fixes
   landed at `8283bcd` and `ac32978`.
3. **No third feature/review round was requested.** `ac32978` is the
   stabilization head. Any further bot comment is triaged as a disposition, not
   as a new design round.

### CI and local evidence

| Head | Evidence | Result |
| --- | --- | --- |
| `c39b965` | quota shadow run [39536992512](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39536992512) | **51/51 unit + 21/21 PostgreSQL**, 0 skipped |
| `c39b965` | rotation run [39536998343](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39536998343) | **69/69 pass**, 0 skipped |
| `3954440` | local `tsc` + 5 focused files | **103/103 pass**; tsc clean |
| `3954440` | quota shadow CI | unit green; PostgreSQL exposed two time-dependent tests (see below) |
| `ac32978` | quota shadow run [39597625145](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39597625145) | **51/51 unit + 21/21 PostgreSQL**, 0 skipped; **72/72 total** |
| `ac32978` | rotation run [39597631538](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39597631538) | **69/69 pass**, 0 skipped |

At `c39b965`, every PR check was green except **PR Agent review**. Its log
shows Gemini `API_KEY_INVALID`; that is an infrastructure failure, not a code
finding. It is not claimed as passing.

At `3954440`, PostgreSQL reported 19/21 because two tests used wall-clock
`now` while their seed rows were pinned to `2026-10-20`. The CI run crossed the
Pacific day boundary. `8283bcd` froze `now: fixedNow` in the dispatch calls;
`ac32978` also evaluated the settlement tombstone at that frozen instant. These
are test-only corrections, not production-code changes. The final rerun is
72/72 unit+PostgreSQL and 69/69 rotation, with 0 skipped.

### Findings fixed in this PR

- Pacific-midnight reservation is fail-closed on a day change.
- Enforced admission no longer performs optional lease/event sweeps; DB
  connection and statement waits are bounded.
- Cap exhaustion and cap-unavailable errors retain their type and code through
  the dispatch catch.
- Search/recent-video/playlist/country-metadata loops now stop before key
  failover when a successful provider response cannot be accounted; the
  accounting wrapper surfaces one typed `YouTubeQuotaAccountingError` preserving
  the cause.
- Enforcement is enabled only by the literal setting value `true`; case and
  whitespace variants remain OFF.
- Cold/stale settings-read failures fail closed; successful absent/false reads
  preserve the legacy shadow path.
- The stale `youtubeKeyHealth.test.ts` source assertion was updated to the new
  reservation-aware accounting call.
- PostgreSQL cap cases now pin their accounting instant so they cannot cross a
  Pacific day mid-suite.

### Disputed or accepted findings (documented, not silently fixed)

- **Graphite: cold settings failure should fail open to preserve OFF traffic.**
  Not adopted. A settings-read failure is not evidence that enforcement is OFF.
  Fail-open would let an enabled cap silently disappear after a restart or DB
  outage. The chosen tradeoff is fail-closed, at the cost of blocking official
  calls during a settings-store outage. Successful absent/false reads do not
  block and remain legacy-shadow behavior. This is an activation-gate
  requirement, not a claim that OFF deployment has zero new failure modes.
- **Greptile: the enforced sweep was unbounded.** Fixed by removing it from the
  admission path; shadow cleanup remains in the shadow path.
- **Greptile: accounting tests only inspect source text.** The PostgreSQL suite
  executes settlement, duplicate operation, rollback, restart, and midnight
  cases, but the added dispatch-day check is still a source-contract test rather
  than a full `incrementQuota` integration test. Accepted as a P2 test-depth
  gap; the behavior is covered by the PostgreSQL settlement suite.
- **CodeAnt: abort during reservation can leave a conservative lease.** Accepted
  as a rare under-admission, not an over-spend. The lease expires at the next
  Pacific midnight; no official request is sent after the abort. A dedicated
  cancellation path is a follow-up, not a merge blocker.
- **Greptile P2: expired enforced rows may accumulate.** No admission sweep is
  run. `settleKeyCapReservation` deletes expired leases and tombstones inside a
  successful settlement transaction, and expired rows are excluded from every
  projection. A failed-only traffic period can leave expired rows until the
  next successful settlement or normal maintenance; this is a storage
  follow-up, not a cap-correctness issue.
- **Graphite: cache-miss dispatch awaits the settings read.** Accepted: one
  bounded read per 30-second cache window is required to know whether a hard
  cap applies before spending provider units. The shadow path remains
  fire-and-forget.

## 4. Thread 77 — zero-unit probe versus the 9,000-unit cap

**Conclusion: Thread 77 remains an activation blocker. Zero official API units
are not structurally guaranteed.**

The code path is:

1. `server/discovery/probeExecutor.ts:152-164` — `defaultIngestChannel`
   dynamically imports and calls `processChannelThroughPipeline(...)`.
2. `server/ingestionPipeline.ts:268` — if country or subscriber evidence is
   missing, the pipeline calls `fetchYouTubeChannelCountryMetadata(...)`, which
   reaches official `channels.list` through `youtubeFetch`.
3. `server/ingestionPipeline.ts:749-756` — the same pipeline can schedule or
   enqueue `ENRICH_CHANNEL` jobs. Those jobs later execute official calls
   through the normal YouTube path.
4. `server/youtube.ts:480-497` (hard-cap branch) — reservation happens only if
   `youtube_key_daily_cap_enforced` resolves to `true`; otherwise the path is
   shadow-only. Even when enabled, the reservation enforces a **9,000-unit
   per-key/day ceiling**, not a zero-unit budget.
5. `server/discovery/probeExecutor.ts:461-465, 478-489` — the probe result
   hard-codes `units: 0`; that field covers the InnerTube retrieval page only.
6. `server/discovery/probeLedger.ts:685-687` — the `allowOfficial` setting
   rejects only route `youtube-data-api`. It does not fence downstream official
   hydration/enrichment, which uses the ordinary pipeline.
7. `server/discovery/probeGateSafety.test.ts:57-68` — the “no official API”
   test checks only direct imports/network clients in the two probe modules. It
   explicitly permits the delegated `processChannelThroughPipeline` at
   `:72-75`; it does not follow transitive imports or queued jobs.

Therefore a probe can record `units: 0` while the delegated pipeline spends
official units. The hard cap limits the maximum spend when enabled; it does not
make the probe zero-spend, and it is default OFF. The required safeguard is a
durable probe-origin “official quota forbidden” fence propagated through
ingestion and queued jobs, fail-closed before every `youtubeFetch`; or a
retrieval/staging-only ingestion path. No such fence is implemented.

## 5. Reported 119 failures versus current `main`

The prior full-suite run reported **119 failure lines** across 3,386 tests. The
119 lines collapse to **59 unique test names** (the output repeats names in its
failing-test summary; one aggregate line is `failing tests:`).

A fresh full `npm test` at current `main` (`b1aafab`) crashed with libuv
`errno == EINTR`/`SIGABRT` and produced no complete summary. To keep the
comparison stable, this session reran the **exact 37 files that produced the
119 failure lines**, one file at a time with `--test-concurrency=1`, at
`b1aafab`:

- **217 pass, 57 fail, 0 skipped, 0 timeouts.**
- **57 unique failing test names.**
- All 57 are a subset of the prior 59 unique names; **no new failure** was
  introduced by current `main`.
- The two prior-only names were not reproduced: “recovery predicate admits
  historical raw provider-cooling terminal messages and is cycle-bounded”
  (`server/operationalEnrichmentRecoveryBounded.test.ts`, now 7/7) and “static
  exploration bound is 12 with destination-budget drop accounting”
  (`server/crawlerEnqueuePolicy.test.ts`, now 21/21).
- The crash is disclosed as a limitation: this is a targeted comparison of the
  reported failure set, not a completed full-suite baseline. It does not support
  a claim that the full suite is green.

Conclusion: the reported failures are pre-existing and order/environment
sensitive. They are not evidence against #531 or #533, but they remain a broad
existing baseline and must not be reported as a clean full-suite result.

## 6. InnerTube policy position

Status: **production use is NOT authorized.** The bounded verification tranche
used **10 of 30** approved requests; **10/10 returned a usable result**. That
proves reachability and response shape only. The repository has no written
provider permission, commercial agreement, legal opinion, or operator-approved
risk acceptance for production InnerTube use. See
`docs/phase1/INNERTUBE_POLICY_POSITION_20261020.md`.

Consequences:

- No production probe or product InnerTube traffic is authorized.
- The probe ledger’s official-route gate is not a substitute for provider
  permission, and it does not cover Thread 77’s downstream official calls.
- No probe start date is defensible under current policy, regardless of the
  code schedule below. A policy/route decision must precede activation.

## 7. Dated parallel schedule — resolving 24 October versus 26 October

All dates are conditional. They are not approvals and do not authorize a merge,
deployment, migration, flag change, or probe.

| Date (UTC) | Track A — integration / hard cap | Track B — probe / pilot | Gate |
| --- | --- | --- | --- |
| **2026-10-21** | Final stabilization head `ac32978`; record CI; no merge | Thread 77 fence design; policy review; no probe | This report; explicit operator decision |
| **2026-10-22** | If approved: merge #533 and deploy **default OFF**; apply migrations only through the normal runner | Confirm authorized route or keep probes disabled | Merge/deploy approval; production migration status check |
| **2026-10-23** | Verify absent/false setting, shadow-only behavior, rollback path | Implement/review the official-quota fence; no probe | Post-deploy verification |
| **2026-10-24** | **No deployment event.** This is only the hypothetical 72-hour observation endpoint for a 21 October start, which did not occur | No probe | No gate can open on this date |
| **2026-10-25** | Buffer / rollback checkpoint | Policy/fence completion only | No automatic action |
| **2026-10-26** | **Earliest conditional integration/pilot-stack deployment** (default OFF; no enforcement) | No activation | All code, migration, rollback, and approval gates |
| **2026-10-27** | Soak/verification | **Earliest conditional probe activation**; first probe, 10/day maximum | Thread 77 fence + written policy/route authorization + explicit activation approval |
| **2026-10-29** | — | 30th probe; canary data complete at 10/day | Persistence/qualification audit |
| **2026-10-30 07:00Z** | — | 72-hour observation ends if the pilot started 27 October 07:00Z | Observation window is not code-enforced |

**Resolution:** 24 October is not a deployment date; it is a void hypothetical
observation endpoint. 26 October is the earliest conditional deployment of the
pilot stack with flags OFF, not a pilot start. 27 October is the earliest
conditional activation, and only if the policy and Thread 77 gates are actually
closed. Under current policy, even 27 October is not authorized.

## 8. First qualified creator — conditional forecast

Definition: a **persisted, verified, net-new** creator attributable to the
probe: `TRADING_CONFIRMED` and quality score **≥55**, with
`persisted !== false` and `wasKnown === false` (or `isNew === true`). Raw
returned channels, staged candidates, or review-only rows do not count.

Measured paid-search baselines (996 runs, 173,300 units, 2026-10-02 → 10-18):
**41.9 qualified / 1,000 units** across all runs; **29.1 qualified / 1,000
units** for paid YouTube search only. These are **not convertible** to a
per-probe rate: a probe is one InnerTube page of up to 20 channels at zero
official units, not a 100-unit search call. The historical free-InnerTube
aggregate is not a per-probe denominator. There is no observed probe-stage
yield baseline.

Planning scenarios below assume independent probes with a constant probability
`p` of at least one persisted qualified net-new creator per probe, and 30
probes:

| Per-probe yield `p` | Expected creators / 30 | Probability of zero / 30 | Probability of ≥1 / 30 |
| --- | ---: | ---: | ---: |
| 1 in 30 (3.3%) | 1.0 | 36.2% | 63.8% |
| 1 in 20 (5%) | 1.5 | 21.5% | 78.5% |
| 1 in 10 (10%) | 3.0 | 4.2% | 95.8% |

If activation occurred on 27 October at 10 probes/day, the technical earliest
first creator is **27 October** (the first probe). At `p=5%`, the 50% point is
about 14 probes, during **28 October**; at `p=10%`, about 7 probes, on
**27 October**; at `p=3.3%`, about 21 probes, on **29 October**. These are
scenario medians, not promises.

**Defensible estimate:** 1–3 creators over a 30-probe tranche, with a 64–96%
chance of at least one for `p=3.3–10%`; **low confidence**, because no probe
yield has been observed and the InnerTube policy/Thread 77 gates are not
closed. Do not report a point estimate as observed yield.

## 9. Gates still closed and required approvals

No merge, deployment, production migration apply, app-settings/flag change,
enforcement activation, queue unpause/resume, or probe has been performed by
this session. Remaining gates:

1. Explicit approval to merge #533 (code + this report) at `ac32978`/this docs
   head.
2. Explicit approval to deploy, with a verified rollback path and normal-runner
   migration apply; production migration state is currently unverified.
3. Separate approval to activate `youtube_key_daily_cap_enforced=true`.
4. A structural Thread 77 fence plus tests proving no probe-origin official
   spend can bypass it.
5. Written InnerTube/provider authorization, or an approved official-route
   replacement, before any probe.
6. Explicit pilot activation approval and a configured observation deadline.

## Appendix A — 53 #530-only inherited files in the #531 merge

```
.github/workflows/corpus-claim-budget-pg.yml
.github/workflows/recent-discord-invites.yml
scripts/reconcileLegacyDiscordRecovery.ts
server.ts
server/acquisitionEfficiency.test.ts
server/candidateLifecycleIntegrity.test.ts
server/channelMasterDiscordRecovery.postgres.test.ts
server/channelMasterDiscordRecovery.test.ts
server/communityIntent.ts
server/communityIntentPersistence.postgres.test.ts
server/communityRetryClickOffsets.postgres.test.ts
server/communityRetryExecutedEvidence.test.ts
server/communityRetryPolicy.test.ts
server/communityRetryPolicy.ts
server/communitySurfacePolicy.ts
server/countryClaimOrdering.test.ts
server/crawlerTelemetry.ts
server/dashboardCommunityIntentRendering.test.ts
server/db/migrations/149_discovery_integrity_state.sql
server/db/migrations/150_site_inspection_pending_claims.sql
server/db/migrations/151_youtube_key_cap_shadow_settled.sql
server/db/migrations/152_discord_candidate_first_validated.sql
server/destinationPolicy.ts
server/destinationSelection.test.ts
server/discordCandidates.ts
server/discordExtractionIntegrity.test.ts
server/discordInviteRegistry.postgres.test.ts
server/discordInviteRegistry.test.ts
server/discoveryDepthRegression.test.ts
server/discoveryIntegrityMigration.test.ts
server/discoveryStateVisibility.ts
server/inspector.ts
server/liveCountryRejectionProjection.test.ts
server/lowAudienceDashboardVisibility.test.ts
server/paidCommunityIntent.test.ts
server/recentDiscordInvites.postgres.test.ts
server/recentDiscordInvites.test.ts
server/siteInspectionCache.postgres.test.ts
server/siteInspectionCache.test.ts
server/siteInspectionCache.ts
server/siteInspectionDedup.test.ts
server/youtubeKeyHealth.test.ts
server/youtubeRequestScheduler.test.ts
src/App.tsx
src/channelListingQuery.test.ts
src/channelListingQuery.ts
src/components/Navbar.tsx
src/components/ResultsTable.tsx
src/components/communityIntentDisplay.ts
src/discordInviteView.ts
src/types/index.ts
src/utils/relativeTime.test.ts
src/utils/relativeTime.ts
```

## Appendix B — 15 post-#530 #531 files

```
docs/phase1/PILOT_LIMITS_AND_CANARY_20261020.md
docs/phase1/PRE_MERGE_REPORT_20261020.md
docs/phase1/QUOTA_SHADOW_UNIT3_20261019.md
docs/phase1/README.md
docs/phase1/ROLLBACK_TEST_20261019.md
scripts/quota_shadow_replay.ts
server/browserCommunityFallback.ts
server/discovery/probeExecutor.test.ts
server/discovery/probeExecutor.ts
server/ingestionPipeline.ts
server/operationalEnrichmentRecovery.test.ts
server/operationalEnrichmentRecovery.ts
server/quotaKeyCapShadow.test.ts
server/quotaKeyCapShadow.ts
server/renderedInteractionCoverage.test.ts
```
