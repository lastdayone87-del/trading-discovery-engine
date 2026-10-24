# Probe-origin official quota allocation (option 2) — 2026-10-24

PR: [#546](https://github.com/lastdayone87-del/trading-discovery-engine/pull/546)
(stacked on [#533](https://github.com/lastdayone87-del/trading-discovery-engine/pull/533))
· Status: **default OFF, not deployed, not activated, migrations 154/155 not
applied to production.**

## Decision

Probe-origin work **may spend official YouTube quota**. It is not required to
be zero-official-unit. Instead, every official call attributable to a probe
must reserve from an independent, durable probe bucket before dispatch and
settle that reservation in the same transaction as the official charge.

This replaces the earlier "zero official units" rule. The InnerTube retrieval
page itself remains unbilled and is still recorded as `units=0`; that ledger
field is a retrieval fact, **not** a total-spend claim. Delegated hydration,
queued enrichment, retries, recovery, and any other official path are capped
and accounted.

## Exact allocation

| Setting | Default | Rule |
| --- | --- | --- |
| `youtube_probe_official_quota_enabled` | absent/false | Only the exact string `true` enables probe-origin official spend. Absent, false, malformed, or unreadable settings fail closed. |
| `youtube_probe_daily_cap_units` | 0 (disabled) | Integer, `100 <= cap <= min(10% of effective daily budget, 20,000)`. Requested production value: **10,000**. |

At the current effective budget of 35 keys × 10,000 = **350,000 units/Pacific
day**, 10,000 is **2.86%** of the budget and **3.17%** of #533's 315,000-unit
hard-cap ceiling (35 × 9,000). The validation maximum at this budget is
20,000. If the effective budget is small enough that its 10% share is below
100 units, the allocation cannot be enabled at all (fail closed) rather than
granting the 100-unit floor.

The bucket is per **Pacific day**, the same day boundary as #533. It is not a
per-key bucket and it is not shared with ordinary enrichment. When #533
enforcement is ON, a probe lease also counts toward that key's 9,000-unit
projection; both controls are checked before a single lease is inserted, so the
same units are not double-counted.

## Atomicity and coverage

Admission holds two advisory locks in one transaction:

1. the shared `youtube-key-cap:<day>:<fingerprint>` lock used by #533's shadow
   and enforced writers; then
2. the global `youtube-probe-quota:<day>` bucket lock.

The key lock is required even while #533 enforcement is OFF: probe leases live
in `youtube_key_cap_shadow_leases` with `allocation='PROBE'`, and a concurrent
shadow/enforced projection must see them. The global lock serializes the 10,000
bucket across all keys and workers. The lease is inserted only if the probe
projection and, when enforced, the key projection both admit it. A duplicate
operation ID is idempotent for the same key/units and rejected for a different
key/units.

Settlement removes the lease and increments `youtube_probe_quota_usage` in the
**same transaction** as `incrementQuota`. A crash cannot lose or double-count a
charge. A reservation is released only when dispatch provably did not happen
(e.g. admission or pre-dispatch failure); an ambiguous fetch/HTTP failure keeps
the lease until the Pacific reset, which can under-admit but cannot overspend.

### Path coverage

| Path | Fence |
| --- | --- |
| Direct probe discover / hydration | `youtubeFetch` reserves before the official request when the origin is probe |
| Queued enrichment | Durable `quota_origin` provenance is carried on channels/jobs (migration 154); the job's `youtubeFetch` reserves from the probe bucket |
| Retries | Every retry is a new dispatch and must reserve again; a retry does not reuse a released or settled lease |
| Recovery after restart | Origin is durable in the database; a recovered job still resolves as probe and reserves |
| Concurrent jobs | Shared key lock + global bucket lock + unique `(quota_day, operation_id)`; concurrent reservations cannot overrun either control |
| Key failover | Each dispatched key reserves; the reservation is attached to that response and settles with it |
| Non-probe work | No probe reservation; uses the ordinary path, so probe spend cannot starve it and ordinary spend cannot consume the probe bucket |
| Playlist / relationship canaries | These payloads are not channel-keyed, so they resolve as NORMAL and keep their own adapter budgets. They are not probe-origin; a probe-origin variant must carry an explicit `quotaOrigin: 'PROBE'` hint. |

`isProbeOfficialYouTubeQuotaOrigin()` is resolved from durable provenance, not
from a process-local flag. A probe discovery is **not** human-reviewed or
promoted solely because of its origin; the existing qualification, persistence,
and review gates are unchanged. Existing enrichment is not starved: the probe
bucket is additive and isolated, and the only shared limit is #533's per-key
9,000 cap, which applies to all spend equally.

### Shared-budget admission for operational rechecks

The probe bucket is a **sub-cap inside the shared 350,000-unit daily budget**,
not an additive reserve above it. Every official probe call still increments
`quota_tracker.units_used` and the per-key usage row, so the probe bucket can
only be spent while the shared budget has headroom.

The operational recheck workers (post-approval/force-rescan, false-negative
recovery, country-boundary recovery) and direct manual rechecks reserve from
the ordinary shared budget before they run. `tryReserveQuota` deliberately
treats allocation percentages as scheduling preferences, not hard partitions:
it refuses only when `actual_used + reserved_total + units` exceeds the shared
daily budget. A probe-origin recheck therefore cannot bypass the shared-budget
gate, but ordinary work cannot consume the probe bucket's separate 10,000-unit
counter either.

Two consequences are intentional:

- When the shared daily budget is exhausted, probe-origin rechecks wait for the
  Pacific reset instead of spending past the configured total. This is
  fail-closed (under-admission, never over-spend), not a probe-policy defect.
- The recheck reservation is sized for the worst-case key failover
  (`101 × key-pool size`), so in the last few thousand units of the shared
  budget it can refuse a probe call that would itself have fit. That is a
  conservative admission granularity; it clears at reset and cannot overspend.

Reserving the probe cap out of ordinary admission (subtracting it from the
ordinary daily budget) would let probe work keep headroom without exceeding the
shared total. That is a separate allocation-policy decision and is **not**
enabled or implied by this PR.

## Absent-settings behavior and migration additivity

- With both probe settings absent, `resolveProbeQuotaConfig()` returns disabled;
  `youtubeFetch` makes **no probe reservation, no probe lease, and no probe
  usage write**. Probe-origin official calls fail closed instead of spending
  uncapped.
- Migration **154** adds durable `quota_origin` provenance; migration **155**
  adds the probe usage table and the `allocation` column/default on the lease
  table. Both are additive and do not insert settings, backfill spend, or
  change existing rows' behavior. Migration 155 requires 148/151's lease table;
  it does not replace it.
- Applying 154/155 with settings absent changes no runtime behavior. #546
  cannot merge before #533; the combined migrations are 154/155 on top of the
  already-merged 146–153 lineage.
- With settings absent, known non-channel canary jobs (`INSPECT_PLAYLIST`,
  `RELATIONSHIP_CANARY_EXPANSION`) still resolve as NORMAL and run under their
  existing adapter controls. A review-found regression that failed them as
  `UNKNOWN` before their handlers ran was fixed at `c29ccc8` and covered by a
  regression test. Genuinely unknown or malformed provenance still fails
  closed before provider work.
- A provenance read failure is retryable (`QUOTA_ORIGIN_UNAVAILABLE`) and
  spends nothing. Terminal `UNKNOWN` is thrown inside the dispatcher's handler
  `try`, so the normal job-attempt transition and job-specific cleanup run
  while no provider request can occur. Probe refusals are rethrown by every
  provider loop instead of being hidden by key failover or a fallback
  `UNAVAILABLE` metadata result.
- A featured-canary source may exist only in `creator_outcome_records` /
  `entity_bindings`; `INSPECT_FEATURED_CHANNELS` treats a missing `channels`
  row as NORMAL (its adapter controls still apply) while an existing PROBE row
  remains sticky and a malformed persisted marker still fails closed.

## Rebase and evidence (2026-10-24)

#546 was rebased onto #533's final head `0633929`. Its earlier duplicate of
#533's refused-lease/refetch fix (`bf44342`) was reconciled commit by commit.
The rebased tree is identical to pre-rebase `9d36e29` for every code and test
file; only the two #533-owned docs (`README.md`,
`QUOTA_SHADOW_UNIT3_20261019.md`) differ, because their final #533 versions are
kept. The reconciliation therefore changes no runtime behavior.

At reviewed code/test head `318cf68`: `npx tsc --noEmit` is clean; the focused
quota subset is **79/79 pass** locally, the discovery/retrieval batch is
**26/26**, the terminology contracts are **97/97**, and the broader
quota/maintenance/contract batch is **156/156 pass**. PostgreSQL is CI-only on
this host (no local server); the postgres:17 run applies the full migration
lineage including 154/155. Phase 1 quota shadow
[40100592990](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40100592990)
passed **79/79 unit** and **31/31 PostgreSQL**, 0 skipped. The corpus PostgreSQL
run
[40100597868](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40100597868)
ran the new channel-upsert regression **3/3**, 0 skipped. The autonomous
retrieval safety run
[40100597891](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40100597891)
passed **32/32** and the discovery-depth run
[40100597898](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40100597898)
passed **14/14**. All other code workflows at `318cf68` are green; PR Agent
remains red only on Gemini `API_KEY_INVALID`. No enforcement, probe, or
adaptive settings were changed.

## Post-review hardening (2026-10-24)

The independent review findings were re-validated against the branch and the
confirmed ones were fixed in code:

- **Pipeline provenance read failure** now throws retryable
  `QuotaOriginUnavailableError` instead of returning terminal `UNKNOWN`; a
  malformed persisted marker remains a real `UNKNOWN` verdict.
- **Scheduler provenance is captured at enqueue time** and restored exactly at
  dispatch. The shared queue drain no longer lets a PROBE drain charge NORMAL
  work to the probe bucket (or the reverse). Exact restoration is confined to
  the queue boundary; ordinary nested calls keep sticky PROBE semantics.
- **Probe policy refusals short-circuit the scheduler.** `executeProviderCall`
  wraps messages containing “quota” as `RATE_LIMIT`; the scheduler now walks
  the cause chain and rejects probe-control errors without runtime-rate-limit
  pacing, adaptive interval changes, or replay of the admission check.
- **Probe settlement is exactly-once across lease expiry and sweeping.** A
  provider response that settles after its 120 s lease was swept still records
  usage once; the claim is a row in the existing 7-day accounting idempotency
  table, committed with the official charge and the usage increment.
- **`isProbeQuotaControlError` no longer matches bare
  `QUOTA_ALLOCATION_EXHAUSTED`**, which also identifies the pre-existing
  ordinary allocation error. Probe-specific markers remain the discriminator.
- **Small budgets cannot exceed the 10% share.** If 10% of the effective daily
  budget is below the 100-unit minimum, enabling the allocation fails closed
  as unavailable instead of raising the maximum to 100.
- **Manual recheck** now establishes the channel's persisted provenance before
  its first official enrichment call (`channel.quota_origin === 'PROBE'`).
- **Pre-dispatch abort** releases the exact enforced lease and the exact probe
  lease instead of leaving admitted capacity until the Pacific reset.
- **Durable provenance is insert-only.** `writeChannelUpsert` preserves
  `channels.quota_origin` in its `ON CONFLICT` clause. A probe run that
  rediscovers an established NORMAL channel no longer rewrites it to PROBE and
  strands later enrichment/recovery on the probe bucket; a probe-created INSERT
  still starts PROBE, and PROBE is never downgraded. Migration 154's column is
  `NOT NULL DEFAULT 'NORMAL'`, so the preserved value cannot be NULL.
- **Probe refusals are contained per channel in NORMAL batches.** Search,
  manual-search, playlist, and featured workers previously let one sticky-PROBE
  channel refused by its own allocation abort the whole page. They now log the
  deferral and continue with the remaining channels; probe-origin jobs still
  propagate the refusal so the queue can defer them to the Pacific reset.
  Nomination rows remain; funnel observations/sightings are skipped for the
  deferred channel.
- **Contained deferrals leave a channel-specific retry.** Returning null alone
  lost the observation until a later manual/search sighting. Each contained
  refusal now enqueues one low-priority, PROBE-origin discovery-replay job per
  channel and Pacific day, scheduled at the refusal's retry time.
  `ENRICH_CHANNEL` is only the queue carrier: the handler replays the original
  discovery pipeline before the enrichment-only eligibility gate, so rows that
  discovery may revisit (UNCERTAIN country evidence or an aged machine
  NON_TRADING decision) are not silently completed as ineligible. The
  idempotency key collapses repeated sightings, and a scheduling failure is
  logged without aborting the page. While the allocation stays disabled that
  job follows the documented attempt-free daily deferral; it does not consume
  ordinary quota or attempts.
- **Deferred results no longer make normal pagination stop.** Autonomous pages
  keep the actual provider `rawResultCount` for reporting, but duplicate math
  subtracts results that were never evaluated. A page containing only deferred
  results is treated as inconclusive, not low-yield, so it continues until a
  real page/creator ceiling instead of consuming the consecutive-low-yield
  budget. The page is persisted with a `DEFERRED_ONLY` reason code, and the
  continuation-state rebuild treats it as transparent: it neither extends nor
  resets the low-yield streak. Manual-search pages use the same exclusion
  through `manualSearchContinuationMetrics`, so operator-driven pagination also
  reaches its real ceiling instead of scoring deferred channels as country
  misses or duplicates.
- **Probe reservations cannot hide an enforcement enable.** While the per-key
  enforcement cache holds OFF, `reserveProbeQuota` re-reads the setting before
  skipping the 9,000-unit projection. Ordinary dispatch keeps the bounded
  cache, and a read failure still fails closed.

Not changed: the daily requeue when the probe allocation is disabled remains
the intended fail-closed drain behavior; changing it requires a bounded-retry
decision. The ≥120 s shadow drain plus provider timeout is still the activation
precondition for mixed cached-OFF/enforced traffic.

**Audited and not changed (Qodo, `server/queueManager.ts:2860`).** The finding
says probe recovery stalls because workers require an ordinary ENRICHMENT
reservation. `tryReserveQuota` does not enforce an ENRICHMENT sub-budget; it
gates on the shared daily budget, and every probe call also increments the
shared tracker. Skipping that gate for probe jobs would allow total spend above
the configured budget. The observed wait is conservative under-admission that
clears at the Pacific reset. See "Shared-budget admission for operational
rechecks" above. Reserving probe headroom out of ordinary admission is a
separate policy decision, not a review fix.

## Enforcement switch-on and shadow drain

The #533 hard cap and the #546 probe cap are independent. To turn on the
**hard cap** safely after this stack is deployed default-OFF:

1. Confirm migrations 148/151/154/155 are applied by the normal runner, and
   confirm `youtube_key_daily_cap_enforced` is absent/false.
2. Let shadow mode run for at least one full drain window: the lease TTL
   (120 s) plus the provider timeout, and preferably one full Pacific day, so
   no in-flight shadow observation can be mistaken for an enforced lease.
3. Avoid mixed cached-OFF/enforced traffic during the switch. The shared
   key/day lock makes mixed modes safe, but the drain removes the observational
   ambiguity entirely.
4. Set `youtube_key_daily_cap_enforced=true`; verify the first reservations
   settle and that no key exceeds 9,000 projected units.
5. Roll back by setting the value to `false` (or deleting the row). Existing
   leases remain until reset but are excluded once expired; the shadow path
   resumes.

To turn on the **probe allocation**, after 154/155 are applied and before any
probe-origin official work: set `youtube_probe_official_quota_enabled=true` and
`youtube_probe_daily_cap_units=10000`, then verify `getProbeQuotaStatus()`
reports the expected day, cap, and zero usage. Absent or malformed values must
deny. Probe activation itself still requires the separate InnerTube/policy and
operator approvals; this setting only caps spend after those approvals.

## Expected official units per qualified creator

- Paid-search baseline (996 runs, 173,300 units, 2026-10-02 → 10-18): **29.1
  qualified creators / 1,000 units**, or **≈34 official units per qualified
  creator** for paid search alone. This is a measured comparator, not a probe
  yield.
- Probe-origin stage-1 hydration costs **2 units per ingested channel**
  (`channels.list` 1 + uploads `playlistItems.list` 1), plus up to 1 unit for
  country metadata. At 20 channels/probe that is **≈40 units per probe**.
- At the canary yield bar of 1 qualified creator per 20 probes (5%), the
  expected stage-1 cost is **≈800 official units per qualified creator**
  (40 / 0.05); at 3.3–10% the planning range is **≈400–1,200**.
- Stage-2 enrichment can add **up to 101 units per enriched channel** (100-unit
  playlist search + 1-unit video details). The 10,000/day probe bucket leaves
  room for roughly 90 such channels after stage-1 hydration at 20 probes/day,
  but stage-2 must be monitored because it dominates the bucket.
