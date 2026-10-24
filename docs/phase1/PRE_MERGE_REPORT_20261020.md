# Phase 1 verification and pre-merge report — 2026-10-24

Status: **STOPPED FOR EXPLICIT APPROVAL.** This session has not merged,
deployed, applied a production migration, changed a flag/setting, activated
enforcement, resumed a queue, or run a probe. PR #531 was already merged by an
external actor; this report records that fact and does not attempt to undo it.

This version supersedes the 2026-10-21 draft and is updated in the existing
`feat/youtube-key-hard-cap` / PR #533 workstream. #546 is stacked on #533 and
#545 is independent; no separate docs-only PR was opened.

## 1. Verdict

- **PR #531** merged externally at `2026-10-20T23:37:42Z`; GitHub reports merge
  commit `b1aafabf506c5c86856ec2e9f87e50591854c69b`. Its net diff is **106
  files, +14,595/−358** from base `82e60e7`.
- **PR #533** is open against `main`; code/test head `8c0e4eb` plus this docs
  amendment, default OFF. It is not merged, deployed, or enabled.
- **PR #546** is open and **stacked on #533**; code head `9be594f` plus this
  docs amendment. It adds the independent probe-origin allocation; default OFF,
  not deployed, not activated.
- **PR #545** is open against `main`; head `8f16150`. It adds the default-OFF
  adaptive creator-derived pilot and the predeclared 14-day plan; no live data.
- **Probe activation is blocked by the InnerTube policy and missing approval,
  not by a zero-official-unit requirement.** Option 2 is adopted: probe-origin
  official work may spend official quota, capped at 10,000 units/Pacific day by
  #546 and at 9,000/key/day by #533 when enforcement is on. No production probe
  date is currently defensible.
- **No deployment date is set.** Any future deployment is default OFF and
  requires the explicit approvals in section 9.

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
· base `main` · branch `feat/youtube-key-hard-cap` · code/test head `8c0e4eb`
· default OFF · no new migration in #533 itself (the probe/adaptive stack adds
154–156).

### Review rounds and heads

1. **Round 1** — the initial review found dispatch-day, bounded-wait, sweep,
   error-preservation, no-item accounting, and stale-test issues. Fixes landed
   at `c39b965`.
2. **Round 2** — the re-review at `c39b965` produced additional findings
   (literal-`true` parsing, cold-settings handling, post-spend refetch, and an
   old test assertion). Fixes landed at `3954440`; test-only Pacific-day fixes
   landed at `8283bcd` and `ac32978`.
3. **Round 3 (Qodo)** — findings 1, 2, and 4 were fixed at `8683a11`; finding
   3 is a small behavior fix included there; findings 5/6 are this docs
   amendment; finding 7 is accepted conservative behavior (below).
4. **Round 4 (Greptile)** — two P1s were fixed at `8c0e4eb`: the settings read
   is now deadline-bounded and fails closed, and featured-channel inspection
   now has bounded key failover instead of relying on scheduler replay.

### CI and local evidence

At `8c0e4eb`, `npm run lint` is clean and the focused quota/scheduler/
settlement suite is **64/64 pass** locally. The broader local 310-test batch had
282 pass, 23 skip, and 5 failures; all 5 are pre-existing at `7be108a`
(confirmed by stashing the changes): three `quotaRecovery`, one
`youtubeLiveProviderDispatch`, and one `youtubeProviderShadowQuality`. They are
not introduced by this PR.

PostgreSQL tests are CI-only on this host (the local server attempt was
abandoned); the dedicated-URL CI run is the database proof. **The final CI run
at the docs head is recorded in the PR checks and the consolidated report.**
Every code workflow was green before this docs amendment; **PR Agent review**
fails only on Gemini `API_KEY_INVALID` (tooling), not on a code finding, and is
not claimed as passing.

### Findings fixed in this PR

- **Qodo 1 — malformed successful responses held capacity.** Accounting now
  runs before parsing in locator resolution, channel-first, channel-uploads,
  channel, enrichment-playlists, and enrichment-video-details. A malformed 2xx
  still settles its reservation instead of leaving a lease until reset and
  rotating keys.
- **Qodo 2 — mixed shadow/enforced writers used separate locks.** Both modes
  now use one `youtube-key-cap:<day>:<fingerprint>` advisory namespace, so an
  enforced projection sees a concurrent shadow lease. PostgreSQL tests cover
  deterministic mixed contention and concurrent mixed-mode admission.
- **Qodo 3 — a capped optional follow-up discarded paid results.** The
  100-unit recent-video search snippets are preserved when the optional
  1-unit video-details call is cap-rejected or fails; accounting failures still
  surface.
- **Qodo 4 — 429 retries exhausted capacity.** A 429 that carries a live
  reservation is tagged and surfaced once instead of replaying the dispatch
  closure; plain 429s keep the bounded scheduler retry budget.
- **Greptile P1 — a stalled settings read held the queue.** The enforcement
  settings read now has a 2 s deadline and fails closed; a never-resolving
  reader rejects with `YouTubeKeyCapUnavailableError` instead of holding the
  dispatch callback.
- **Greptile P1 — featured-channel inspection had no key failover.** The
  single-key call now loops over available keys with bounded attempts,
  provider-failure recording, quota-exhaustion accounting, and all-provider
  cooldown handling; healthy spare keys are used before the source fails.
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
- **Qodo 7: a timed-out/ambiguous dispatch keeps its lease.** Accepted by
  design. YouTube may count a request that never returned a response, so
  releasing the lease could over-admit. The lease expires at the Pacific
  reset; this is conservative under-admission, not over-spend.

## 4. Thread 77 — resolved by option-2 allocation

**Conclusion: the zero-official-unit requirement is withdrawn. Probe-origin
official work is allowed only through the #546 reservation fence.**

The old blocker was real: `defaultIngestChannel` delegates to
`processChannelThroughPipeline`, which can call `channels.list` and enqueue
`ENRICH_CHANNEL` jobs that later call the ordinary `youtubeFetch` path. The
probe ledger's `units: 0` covers only the InnerTube retrieval page, so it was
never a total-spend guarantee.

Option 2 replaces that requirement with a durable, capped, accounted path:

- `quota_origin` (migration 154) is carried from probe discovery onto channels
  and jobs, so a queued enrichment/recovery retains `PROBE` provenance.
- Before every official dispatch, `youtubeFetch` resolves the origin and calls
  `reserveProbeQuota`; a missing/disabled/malformed allocation fails closed.
- The reservation takes the shared `youtube-key-cap:<day>:<fingerprint>` lock
  and the global `youtube-probe-quota:<day>` lock, checks the 10,000-unit
  bucket and (when #533 enforcement is on) the 9,000/key projection, and
  inserts one `allocation='PROBE'` lease.
- Settlement removes that lease and increments `youtube_probe_quota_usage` in
  the same transaction as the official charge. A retry/recovery reserves
  independently; a concurrent job cannot overrun either control.
- Direct hydration, queued enrichment, retries, recovery, and key failover all
  use this path. A 429 carrying either a probe or key-cap reservation is not
  replayed by the scheduler.

Verification covers: the source-order lock test, the idempotent/retry and
exactly-once settlement PostgreSQL tests, the 20-way bucket concurrency test,
the mixed probe/enforced per-key contention test, and the existing #533
mixed-mode tests. See [PROBE_QUOTA_ALLOCATION_20261024.md](PROBE_QUOTA_ALLOCATION_20261024.md).

This does **not** authorize a probe. The InnerTube policy, explicit activation,
and the canary gates still apply.

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
  permission. Downstream official calls are covered by the #546 reservation
  fence, not by the retrieval ledger.
- No probe start date is defensible under current policy, regardless of the
  code sequence below. A policy/route decision must precede activation.

## 7. Conditional sequence (no dates promised)

All steps are conditional. They are not approvals and do not authorize a merge,
deployment, migration, flag change, or probe.

| Step | Track A — integration / hard cap | Track B — probe / pilot | Gate |
| --- | --- | --- | --- |
| 1 | Merge #533 at `8c0e4eb`+docs, then #546 at `9be594f`+docs; deploy **default OFF** | Keep probes disabled | Explicit merge/deploy approval |
| 2 | Apply 154/155/156 through the normal runner; verify settings absent and no behavior change | Confirm policy/route decision | Migration/deploy approval; production migration state check |
| 3 | Verify absent/false setting, shadow-only behavior, rollback path | Confirm the 10,000-unit probe allocation, fail-closed absent state, and cap enforcement procedure | Post-deploy verification |
| 4 | Choose enforcement timing; run the shadow drain (lease TTL/provider timeout, preferably a full Pacific day) before enabling #533 | No probe until written authorization and explicit activation | Separate enforcement approval |
| 5 | Enable `youtube_key_daily_cap_enforced=true` only after the drain; monitor `YOUTUBE_KEY_CAP_*` | First probe only after activation; 10/day maximum | Separate activation approvals |
| 6 | Soak/rollback checkpoint | 30th probe + persistence/qualification audit | Canary decision rule |
| 7 | — | 72-hour observation if configured | Deadline is config-only, not code-enforced |

**Resolution:** no calendar date is currently defensible. The prior 24 October
and 26 October references were hypothetical and are withdrawn. The sequence
above starts only after explicit approval; even then, probe activation requires
the separate InnerTube/policy gate.

## 8. First qualified creator — conditional forecast

Definition: a **persisted, verified, net-new** creator attributable to the
probe: `TRADING_CONFIRMED` and quality score **≥55**, with
`persisted !== false` and `wasKnown === false` (or `isNew === true`). Raw
returned channels, staged candidates, or review-only rows do not count.

Measured paid-search baselines (996 runs, 173,300 units, 2026-10-02 → 10-18):
**41.9 qualified / 1,000 units** across all runs; **29.1 qualified / 1,000
units** for paid YouTube search only. These are **not convertible** to a
per-probe rate: a probe retrieval page is unbilled, and its delegated official
work is capped separately. The historical free-InnerTube aggregate is not a
per-probe denominator. There is no observed probe-stage yield baseline.

Expected **official units per qualified creator** under option 2:

- paid-search comparator: **≈34 units** (1,000 / 29.1);
- probe stage 1: **2 units per ingested channel**, ≈40 units per 20-channel
  probe;
- at the 5% canary bar (1 qualified creator / 20 probes): **≈800 units per
  qualified creator**, range **≈400–1,200** at 3.3–10%;
- stage-2 enrichment can add up to 101 units per enriched channel and must be
  reported separately. See
  [PROBE_QUOTA_ALLOCATION_20261024.md](PROBE_QUOTA_ALLOCATION_20261024.md).

Planning scenarios below assume independent probes with a constant probability
`p` of at least one persisted qualified net-new creator per probe, and 30
probes:

| Per-probe yield `p` | Expected creators / 30 | Probability of zero / 30 | Probability of ≥1 / 30 |
| --- | ---: | ---: | ---: |
| 1 in 30 (3.3%) | 1.0 | 36.2% | 63.8% |
| 1 in 20 (5%) | 1.5 | 21.5% | 78.5% |
| 1 in 10 (10%) | 3.0 | 4.2% | 95.8% |

At 10 probes/day, the first creator could appear on activation day 0. At
`p=5%`, the 50% point is about 14 probes (activation day 1); at `p=10%`, about
7 probes (day 0); at `p=3.3%`, about 21 probes (day 2). These are scenario
medians, not promises or dates.

**Defensible estimate:** 1–3 creators over a 30-probe tranche, with a 64–96%
chance of at least one for `p=3.3–10%`; **low confidence**, because no probe
yield has been observed and the InnerTube policy/activation gates are not
closed. Do not report a point estimate as observed yield.

## 9. Gates still closed and required approvals

No merge, deployment, production migration apply, app-settings/flag change,
enforcement activation, queue unpause/resume, or probe has been performed by
this session. Remaining gates:

1. Explicit approval to merge #533 at `8c0e4eb`+docs, then #546 at
   `9be594f`+docs; #546 must not merge independently. #545 follows separately.
2. Explicit approval to deploy, with a verified rollback path and normal-runner
   migration apply; production migration state is currently unverified.
3. Verify migrations 154/155/156 are additive and that absent settings produce
   no probe reservation, adaptive proposal, or enforcement.
4. Separate approval to activate `youtube_key_daily_cap_enforced=true`, after
   the shadow drain in
   [PROBE_QUOTA_ALLOCATION_20261024.md](PROBE_QUOTA_ALLOCATION_20261024.md).
5. Written InnerTube/provider authorization, or an approved official-route
   replacement, before any probe.
6. Explicit probe activation approval, `youtube_probe_official_quota_enabled`
   + a valid 10,000-unit cap, and a configured observation deadline.
7. Explicit adaptive pilot approval, including
   `frontier_allocation_enabled=true` and the four-country eligible scope; the
   14-day read is predeclared in
   [ADAPTIVE_DISCOVERY_PILOT_20261024.md](ADAPTIVE_DISCOVERY_PILOT_20261024.md).

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
