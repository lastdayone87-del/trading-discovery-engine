# Unit 3 — 9,000-unit/key/day quota cap, shadow mode only

Date: 2026-10-19 (updated 2026-10-20) · Branch: `phase1-hardening` · Implementation SHA: `f3e5f43`
(round-1 review fixes; CI green run:
https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39481878389)

Scope: observational shadow accounting for a projected per-key YouTube daily
cap of **9,000 units**. Hard enforcement, key configuration changes and any
change to official API traffic remain gated on explicit operator approval.

## What shipped

| Artifact | Purpose |
| --- | --- |
| `server/db/migrations/148_youtube_key_cap_shadow.sql` | `youtube_key_cap_shadow_leases` + `youtube_key_cap_shadow_events` (observational; no `app_settings` row, absent flag = OFF) |
| `server/quotaKeyCapShadow.ts` | Config, projection, classification, locking, dedupe, sweeps, savepoint settlement |
| `server/youtube.ts` (~line 438) | Dispatch hook: in-flight lease + projection observation for the dispatched key |
| `server/dbCore.ts` (`incrementQuota`) | Settlement hook: releases one matching lease exactly once |
| `server/quotaKeyCapShadow.test.ts` | 14 shadow unit tests |
| `server/quotaKeyCapShadow.postgres.test.ts` | 8 PostgreSQL shadow cases (dedicated-DB gated) |
| `server/discovery/probeLedger.postgres.test.ts` | 2 PostgreSQL probe-budget concurrency cases |
| `scripts/quota_shadow_replay.ts` | Offline 3-day CSV replay |
| `.github/workflows/phase1-quota-shadow-tests.yml` | CI: tsc + quota/probe unit tests + postgres:17 full lineage |

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
lease so an idempotent replay cannot count itself. In this shadow-only branch,
settlement is best-effort and matches by day/key/units; a cross-midnight or
equal-cost ambiguity can therefore leave a lease until its TTL expires, and a
lease written after settlement (fire-and-forget dispatch) is observational
until the TTL. The separate hard-cap branch carries the exact operation
identity and dispatch day, so enforced settlement is exact.

Events are retained for **30 days** (created-at index); an enabled process
sweeps older rows at most once every six hours. Disabled shadow mode writes no
rows and runs no sweeps.

## Test evidence

- Unit (CI, `server/quotaKeyCapShadow.test.ts` + `server/discovery/probeExecutor.test.ts`):
  **28/28 pass, 0 skipped**; `npx tsc --noEmit` clean.
- PostgreSQL (CI postgres:17, full migration lineage via `runMigrations.ts`,
  includes 148): **10/10 pass, 0 skipped** — 8 shadow cases (boundary, defer,
  duplicate accounting, 20-way concurrency, stale-lease sweep + restart,
  settlement) and 2 probe-budget cases (different candidates on one day, and
  different days against the absolute total cap).
  Run https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39481878389.
- Rollback proof at `f3e5f43`: **pass**, pre-state 145, zero schema/constraint
  drift (run https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39481878050).
- All other workflows at `f3e5f43` are green. The PR Agent workflow failed on
  an invalid Gemini API key (`API_KEY_INVALID`), an infrastructure failure, not
  a code finding.

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
- Shadow settlement is not operation-exact in this branch; equal-cost or
  cross-midnight ambiguity is bounded by the 120 s lease TTL. The hard-cap
  branch settles by exact operation ID and dispatch day.
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
