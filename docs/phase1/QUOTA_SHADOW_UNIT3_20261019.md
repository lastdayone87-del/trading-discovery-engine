# Unit 3 — 9,000-unit/key/day quota cap (shadow evidence + default-OFF enforcement)

Date: 2026-10-19 (updated 2026-10-24) · `origin/main` head `13a151b`;
hard-cap PR [#533](https://github.com/lastdayone87-del/trading-discovery-engine/pull/533)
code/test head `c7fae59` (rebased on current main).
Current evidence runs: shadow [40062160087](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40062160087);
rotation [40062163280](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40062163280).
Historical evidence: shadow [39500041358](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39500041358);
hard cap [39597625145](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39597625145).

Status: the migration-148 shadow implementation is historical evidence. The
hard-cap implementation on `feat/youtube-key-hard-cap` is **implemented but
default OFF, not deployed and not enabled**. Key configuration changes and any
change to official API traffic remain gated on explicit operator approval.
PR #530 was merged into `phase1-hardening` at `6267ba1` by an external actor;
#531 and #532 merged on 2026-10-20. The hard-cap branch is rebased on current
main and includes migrations 149–153. This session did not perform those
merges.

## What shipped

| Artifact | Purpose |
| --- | --- |
| `server/db/migrations/148_youtube_key_cap_shadow.sql` | `youtube_key_cap_shadow_leases` + `youtube_key_cap_shadow_events` (observational; no `app_settings` row, absent flag = OFF) |
| `server/db/migrations/151_youtube_key_cap_shadow_settled.sql` | Inert settlement tombstones from the merged #530 work; fences late shadow observations. No hard-cap table. |
| `server/quotaKeyCapShadow.ts` | Config, projection, classification, locking, dedupe, sweeps, savepoint settlement; default-OFF hard reservation/settlement |
| `server/youtube.ts` (~line 438) | Dispatch hook: in-flight lease + projection observation for the dispatched key |
| `server/dbCore.ts` (`incrementQuota`) | Settlement hook: releases one matching lease exactly once |
| `server/quotaKeyCapShadow.test.ts` | 29 unit tests (shadow, enforcement, and settlement cases) |
| `server/quotaKeyCapShadow.postgres.test.ts` | PostgreSQL suite (dedicated-DB gated) |
| `scripts/quota_shadow_replay.ts` | Offline 3-day CSV replay |
| `.github/workflows/phase1-quota-shadow-tests.yml` | CI: tsc + unit tests + postgres:17 full lineage |

## Inertness guarantees (verified)

- **OFF by default.** `youtube_key_cap_shadow_enabled` absent or non-`true`
  disables everything; settings are cached 30 s and read failures fail closed.
- **Does not delay provider dispatch.** The hook starts the observation
  fire-and-forget; it does not await settings, pool acquisition, the advisory
  lock or the insert. A saturated pool or slow database can therefore leave a
  late/no-op observation, but it cannot delay or fail the YouTube request. The
  background write still uses a per-key/day advisory lock bounded by
  `lock_timeout` (100 ms default); on timeout it is skipped
  (`lockSkipped=true`, no lease, no event).
- **Never alters traffic or key state.** No dispatch, retry, pool, quota-row or
  key-configuration code path is modified. Events are pure inserts. A late
  lease is observational and expires by its TTL (120 s default); it cannot
  block or reject traffic.
- **Settlement cannot poison official accounting.** The lease release runs in a
  savepoint inside the charge transaction; any shadow error rolls back to the
  savepoint and is swallowed. Duplicate charges are never double-released
  (the settle path is skipped when the idempotency guard already saw the op).
- **No production migration applied.** Prod remains at migration 145; queues
  untouched; no probe/discovery traffic.

## Boundary semantics

`projected + request <= 9000` is admitted. `8999 + 1 = 9000` admitted;
`9000 + 1 = 9001` blocked. Classification: crossing from below =
`WOULD_DEFER`, projected at/over the cap = `WOULD_REJECT`. Verified by unit and
PostgreSQL tests.

## Counted quantity

`projected = settled usage (youtube_key_quota_usage.units_used for the day/key)
+ unexpired in-flight leases`. Leases are unique per `(quota_day, operation_id)`
(duplicate accounting impossible), carry a TTL (default 120 s), are excluded
from projections once expired, and are swept on first use after a restart and
at most once per minute. The projection excludes the current operation's own
lease so an idempotent replay cannot count itself. Settlement is best-effort
and removes one matching lease; a lease written after settlement (because the
dispatch hook is fire-and-forget) remains observational until its TTL expires.

Events are retained for **30 days** (created-at index); an enabled process
sweeps older rows at most once every six hours. Disabled shadow mode writes no
rows and runs no sweeps.

## Test evidence

- Final head `c7fae59`, CI run
  [40062160087](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40062160087):
  `npx tsc --noEmit` clean; unit job **53/53 pass** (29 quota cap + 9 dbCore
  quota + 15 probe executor) and PostgreSQL job **23/23 pass**, 0 skipped.
- Rotation run
  [40062163280](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40062163280):
  **71/71 pass**, 0 skipped.
- Historical initial migration-148 evidence: 12/12 unit locally; 8/8
  PostgreSQL (run
  [39325618390](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39325618390)).
- Focused local suites on `c7fae59`: 34/34 dispatch/scheduler/settlement tests
  pass. Four unrelated failures reproduce on the untouched tree
  (`quotaPolicy` allocation/rollover/shared-capacity cases and one
  `youtubeProviderShadowQuality` Latin-script case); they are pre-existing.
- Rollback proof fix: the 146/147 workflow now excludes migration 148
  (`pre_state_max_version` regression on `c0d8318`), green on `b62c45a`/`ef7b4c0`.

## Three-day replay (2026-10-16 → 2026-10-18, America/Los_Angeles)

Source: `quota_calls_1016_1018.csv` (22,301 rows; 15,477 SUCCESS replayed).
Artifacts: `/tmp/opencode/evidence/quota_shadow_replay_20261019.{json,md}`.
Hard-enforcement semantics: blocked calls are not counted as executed.

| day | keys | allowed | would-defer | would-reject | settled units |
| --- | --- | --- | --- | --- | --- |
| 2026-10-16 | 12 | 3,456 | 104 | 1,826 | 108,000 |
| 2026-10-17 | 12 | 3,834 | 165 | 355 | 107,784 |
| 2026-10-18 | 24 | 5,062 | 118 | 557 | 163,660 |

- Totals with in-flight leases: 12,352 allowed / 387 would-defer / 2,738
  would-reject. **Settled-only projection is identical** because observed
  traffic was serialized per key (peak concurrent in-flight = 1); the lease
  mechanism's protective value is proven by the synthetic concurrency tests.
- Real-data boundary behavior: high-cost search calls (100 units) near the cap
  appear as `WOULD_DEFER`; keys that exhausted their 9,000 units show
  `WOULD_REJECT` for subsequent calls.
- Accounting gaps/assumptions: 6,824 non-SUCCESS rows excluded (6,541
  RATE_LIMITED, 281 PERMANENT_ERROR, 2 TRANSIENT_ERROR); 11 duplicate
  `request_id` rows; `reserved_cost = actual_cost` for all rows; max latency
  9,073 ms (well below the 120 s lease TTL); charges without an observed
  dispatch or with extra quota callbacks cannot release a lease (they are
  conservative: over-lease until TTL expiry, never undercount).

## Known limitations

- Advisory-lock timeout skips are the only accounted observation gap; zero
  skips were observed in CI (20-way contention at 3 s budget).
- Replay models SUCCESS rows only; failures were excluded rather than modeled
  as expiring reservations.
- The shadow does not retroactively detect past-cap usage; it only records
  projections at dispatch time.

## Accidental-commit coordination status

Stray commit `4dc893d` ("test(discovery): rollback proof for migrations
146/147", duplicate files) is the local HEAD of the sibling worktree
`/root/projects/trading-discovery-engine` on `feat/discovery-integrity-p1-p4`.
It was never pushed: `origin/feat/discovery-integrity-p1-p4` remains `73d714f`.
Authoritative copies of the content live on `phase1-hardening` (`b0c207f`,
`c0d8318`). No reset was performed because that worktree is in active use by a
sibling session and this unit must not modify that branch; when the session is
idle, dropping it is a single `git reset --hard 73d714f` (or `git stash` first
if it holds uncommitted work). No impact on this unit or the upcoming PR.

## Production state

Unchanged: migration 145, discovery flags absent, no probe rows, queues as
snapshotted. Migration 148 is not applied to production.

## Post-rebase verification (Unit 4, 2026-10-19)

Rebased onto `origin/main` `82e60e7`; all 15 commits replayed with identical
patches (`git range-diff` =). Migrations 146/147/148 remain unique and follow
main's 145.

- CI on `ee5d172` — quota shadow workflow **success**: unit job (tsc clean +
  12/12 unit tests) and postgres job (8/8, full lineage via `runMigrations`):
  https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39330317693
- Local relevant suite batch on the rebased tree: 315 tests, 303 pass, 3 fail,
  9 skipped; the 3 failures are the pre-existing `quotaRecovery.test.ts` trio
  that fail identically on pristine `origin/main` (5/8 pass baseline).
- Rollback proof 146/147 re-verified on the rebased tree (pre-state 145, zero
  drift): https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39330317684

## Hard-cap enforcement (default OFF) — implementation on `feat/youtube-key-hard-cap`

Date: 2026-10-21 (updated 2026-10-24) · Branch `feat/youtube-key-hard-cap`
code/test head `c7fae59`, based on current main `13a151b` (merged #530, #531,
#532) · Status: **implemented, disabled by default, not deployed, not
enabled.** Production remains unchanged and no migration has been applied to
it.

### Design

- **Setting:** `youtube_key_daily_cap_enforced`, default **false**. The setting
  is read through `resolveKeyCapEnforcement()`; only the literal string `true`
  enables the cap. Successful absent/false reads keep the existing shadow-only
  path; a settings-read failure is fail-closed, not evidence of OFF. No
  `app_settings` row is created by code or migration.
- **Reused storage:** the existing migration 148
  `youtube_key_cap_shadow_leases` table, plus migration 151's inert
  `youtube_key_cap_shadow_settled` tombstones inherited from the merged #530
  work. **The hard-cap change adds no new table and no new migration.** The
  unique `(quota_day, operation_id)` key is the idempotency authority.
  Enforced leases expire at the next Pacific midnight; optional lease/event
  sweeps are **not** run on the enforced admission path. Expired leases never
  count, and the shadow path keeps its own bounded cleanup.
- **Reservation point:** `youtubeFetch()` reserves after the final dispatched
  provider key is selected and before the official HTTP request. One stable
  `cap:${operation}:${uuid}` identity is generated per dispatch and reused for
  the lease and response settlement.
- **Transaction:** one short transaction per dispatch with
  `pg_advisory_xact_lock(hashtext('youtube-key-cap:<day>:<fingerprint>'))`
  and `SET LOCAL lock_timeout = '5000ms'`. Shadow and enforced writers share
  this one namespace so a mixed-mode rollout cannot project past a concurrent
  lease. The projection is
  `youtube_key_quota_usage.units_used + SUM(unexpired leases)` for that
  key/day. A lease is inserted only when `projected + units <= 9000`; the
  admission boundary is exactly 9,000 (8,999 + 1 admitted, 9,000 + 1 denied).
- **Settlement:** a reservation context
  `{mode:'enforce'|'shadow', operationId, quotaDay, keyFingerprint, units}` is attached
  to the `Response` via the existing WeakMap. `accountYouTubeQuotaResponse()`
  passes it to `incrementQuota()`, which settles the exact lease (day +
  operation + key) in the **same transaction** as the official charge. With a
  context, the per-key usage row and lease use the dispatch day, so a call
  admitted before Pacific midnight remains in that quota day when it settles
  after midnight. The single-row `quota_tracker` aggregate remains on the
  current Pacific day; a late prior-day settlement therefore cannot rewind
  `last_reset` or zero current-day usage. Legacy
  `incrementQuota(units, key, operationId)` callers still work. Enforced
  settlement rejects a charged unit count that differs from the reserved units.
- **Shadow compatibility:** the shadow still records its lease/event when
  enforcement is OFF. Dispatch remains fire-and-forget: it does not await
  settings, pool acquisition or the write before the provider request. The
  completed observation is joined for at most 500 ms; a cancelled/late write is
  fenced by the migration-151 tombstone. Shadow settlement uses the exact
  operation identity when present. Because the shadow settlement hook still
  uses the completion day, a cross-midnight call can leave the prior-day lease
  until its 120 s TTL; that is observational only. Enforced reservation is
  synchronous and uses the dispatch day, so enforced settlement is exact.
  `settleShadowLease()` also retains the legacy unit-matched form for callers
  without an operation id.
- **Failed calls:** enforced reservations are **not released** on a non-OK
  response, fetch failure or timeout. The outcome is ambiguous and may already
  have consumed provider quota, so the lease remains until the Pacific day
  reset; this is conservative and can under-admit, but cannot overrun the cap.
  A reservation refused **before dispatch** (the Pacific day changed between
  reservation and dispatch, or the caller aborted) is different: nothing was
  sent, so the exact lease is released through the settlement path instead of
  holding capacity until reset. Shadow reservations are observational and may
  release on failure because their TTL bounds the effect. Successful responses
  settle the exact lease; if accounting fails, the lease stays in place.
- **Post-accounting parse failures:** featured-channel and playlist loops
  account a successful provider response exactly once. If body parsing then
  fails, the error is rethrown instead of failing over to another key, so one
  job cannot be charged for two provider requests.

### Fail-closed semantics (only when enabled)

When `youtube_key_daily_cap_enforced=true`, each of these aborts the official
request instead of bypassing the cap:

- settings read failure on a cold/unknown cache or while cached ON
  (`YouTubeKeyCapUnavailableError`; a successfully observed OFF cache keeps the
  legacy shadow-only path)
- pool/connect/transaction failure (`YouTubeKeyCapUnavailableError`)
- advisory-lock timeout / DB error (`YouTubeKeyCapUnavailableError`)
- capacity exhaustion (`YouTubeKeyCapExceededError`)
- settlement failure inside the official charge transaction (typed error,
  charge rolled back; the lease remains)
- reservation units differing from the official charge (typed error)

Both errors carry `code`, `rotateKey=true`, `markSuspension=false` and
`providerFailureRecorded=true`. `recordProviderFailure()` ignores cap errors, so
callers can rotate to another key for the acquisition without suspending or
quarantining the exhausted key. When the setting is false, all shadow failures
remain swallowed and no enforcement code path runs.

### UTC / Pacific evidence

The quota day and reset are the existing `America/Los_Angeles` helpers:
`getYouTubeQuotaDay()` (dispatch lease day) and `getYouTubeQuotaDayStartAt()`
(rollover boundary). Tests pin real instants:

- spring-forward: `2026-03-09T06:59:59Z` = `2026-03-08 23:59:59 PDT`
  (`2026-03-08`), `2026-03-09T07:00:00Z` = `2026-03-09 00:00:00 PDT`
  (`2026-03-09`);
- fall-back: `2026-11-02T07:59:59Z` = `2026-11-01 23:59:59 PST`
  (`2026-11-01`), `2026-11-02T08:00:00Z` = `2026-11-02 00:00:00 PST`
  (`2026-11-02`).

Seeding the old day at 9,000 denies, while the first post-midnight dispatch
admits against a fresh day. No UTC-midnight truncation is used.

### Tests

Unit (`server/quotaKeyCapShadow.test.ts`, mock clients): parsing/defaults,
disabled zero-query no-op, typed fail-closed lock/DB/connect/settings errors,
9,000/9,001 boundary, duplicate operation id (same units idempotent,
changed units rejected), exact context settlement (enforce fatal, shadow
savepoint-swallowed), exact lease release and shadow-settlement compatibility.

PostgreSQL (`server/quotaKeyCapShadow.postgres.test.ts` plus
`server/discovery/probeLedger.postgres.test.ts`, dedicated
`QUOTA_SHADOW_TEST_DATABASE_URL`): boundary 9,000/9,001; 20 concurrent same-key
reservations with exactly 10 admitted; two independent keys; in-flight lease
counting; expired lease exclusion; exact settlement of only the matching
day/operation/key; duplicate operation id (same units idempotent, changed units
rejected); settlement failure leaving the conservative lease; Pacific midnight
+ both DST rollovers; restart with a new pool observing persisted leases; and
two probe-budget concurrency cases.

CI results for final code/test head `c7fae59`:

- quota shadow run [40062160087](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40062160087):
  `npx tsc --noEmit` clean; **53/53 unit** (29 quota cap + 9 dbCore quota +
  15 probe executor) and **23/23 PostgreSQL**, 0 skipped; **76/76 total**.
- rotation run [40062163280](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/40062163280):
  **71/71 pass**, 0 skipped.
- Historical `ac32978` evidence: 51/51 unit and 21/21 PostgreSQL (run
  [39597625145](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39597625145)),
  rotation 69/69 (run
  [39597631538](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39597631538)).
  The 3954440 run initially exposed two time-dependent PostgreSQL cases that
  used wall-clock `now` against fixed-day rows. The test-only fix at `ac32978`
  pins the dispatch/tombstone instant; the rerun is green. No production-code
  behavior changed in that test fix.
- Local PostgreSQL was not available on this host; the postgres:17 CI service
  is the database proof. No enforcement claim is made from shadow observations,
  and this run did not enable or deploy the feature.

### Review disposition through 2026-10-24

Fixed at `3954440`/`8283bcd`/`ac32978`: literal-`true` parsing, cold/stale
settings fail-closed behavior, post-spend accounting failures stopping key
failover, the stale `youtubeKeyHealth.test.ts` assertion, removal of the
enforced-path sweep, and the Pacific-day test freeze.

Fixed at `8683a11` (Qodo round):

- **Malformed successful responses:** accounting now precedes parsing in every
  official response path, so a 2xx body that fails validation still settles.
- **Mixed shadow/enforced locking:** both writers share
  `youtube-key-cap:<day>:<fingerprint>`. PostgreSQL tests cover deterministic
  contention and concurrent mixed-mode admission.
- **Optional follow-up:** a cap-rejected `video-details` call no longer
  discards the already-paid 100-unit search snippets.
- **Bounded 429 retries:** a 429 carrying a live reservation is tagged and
  surfaced once; the scheduler no longer replays the closure and reserves the
  full cost on every attempt.

Fixed at `8c0e4eb` (Greptile round):

- **Stalled settings read:** `resolveKeyCapEnforcement` now races the read
  against a 2 s deadline and fails closed, so a settings-query stall cannot pin
  the dispatch queue past the provider abort.
- **Featured-channel failover:** `fetchYouTubeFeaturedChannels` now loops over
  available keys with bounded attempts and failure accounting instead of using
  one key and relying on scheduler replay, which reserved-429 suppression
  removed.

Documented rather than changed:

- cold settings failure is intentionally fail-closed (a settings outage is not
  evidence of OFF);
- the dispatch path performs one bounded settings read per 30s cache window
  before spending provider units;
- the added dispatch-day accounting check remains a source-contract test, while
  the PostgreSQL suite executes settlement/rollback/restart/midnight cases;
- an ambiguous **post-dispatch** failure (non-OK response, fetch error or
  timeout) may leave a conservative lease until Pacific midnight
  (under-admission, never over-spend).

### Round-3 review disposition (`c7fae59`)

Fixed:

- featured-channel and playlist loops no longer refetch after a successful
  response was already accounted and then failed body parsing, so one job
  cannot spend two provider requests;
- a reservation refused before dispatch (Pacific-day mismatch) and a lease
  admitted before a caller abort are released through the exact tombstone
  path instead of holding capacity until the day reset.

Documented rather than changed:

- the bounded settings read fails closed at its deadline, but the underlying
  PostgreSQL query cannot be cancelled by that deadline. Dispatch is released
  on time; the query finishes in the background. This is a framework
  limitation, not evidence of a successful OFF read;
- the source-contract scheduler assertion was updated to the current
  `youtubeRequestScheduler.run(()=>{` shape; it remains a structural check, not
  a behavioral substitute for the runtime suite.

### Rollout gates (all required before enabling)

1. Migrations 146–155 (including the reused 148 leases, 151 tombstones,
   154 origin, and 155 probe allocation) applied by the normal deploy migration
   runner; no manual DDL.
2. CI postgres suite green against postgres:17 with the dedicated URL.
3. Sustained shadow evidence reviewed: `WOULD_DEFER`/`WOULD_REJECT` rates,
   lock timeouts, day-reset recovery, and key headroom per quota group.
4. **Drain:** run shadow mode for at least the lease TTL (120 s) plus the
   provider timeout, and preferably one full Pacific day, before switching.
   Avoid mixed cached-OFF/enforced traffic during the switch; the shared lock
   makes mixed modes safe, but the drain removes observational ambiguity.
5. Explicit operator approval to set `youtube_key_daily_cap_enforced=true`.
6. Canary enablement per environment, then monitor `YOUTUBE_KEY_CAP_EXCEEDED`
   and `YOUTUBE_KEY_CAP_UNAVAILABLE` rates and provider rotation behavior.
7. Rollback is immediate: set the setting to `false` (or delete the row). The
   legacy shadow path resumes; already-created enforced leases remain until the
   Pacific day reset (conservative). The enforced admission path has no sweep;
   expired leases are excluded from the projection.

This document does **not** claim the setting is enabled, the feature is
deployed, or enforcement is active.
