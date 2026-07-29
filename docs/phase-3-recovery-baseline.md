# Phase 3 — recovery proof and calibrated production baseline

Date: 2026-07-29  
Policy: `phase-3-baseline-v1`  
Scope: Phase 3 only; no learning or exploration control-plane behavior is enabled.

## Architecture decisions and trade-offs

Phase 3 adds an append-only **evidence index**, not a second scheduler or replay
system. `validation_runs` retains the kind, environment, result, policy/dataset
versions, timestamps, safe summary, and SHA-256 checksum. Backups, logs, corpora,
provider payloads, and secrets remain in access-controlled artifact storage. This
keeps the database small and makes evidence tampering detectable, at the trade-off
that operators must retain the referenced artifact under the release retention
policy.

Classifier evaluation is a deterministic offline function. It reports overall and
per-country confusion matrices, precision/recall, sample sizes, and reliability bins.
Empty denominators are `null`, never zero, and legacy/missing provenance is reported
as its own baseline segment rather than imputed. The CLI refuses a dataset not marked
held-out to reduce test-set tuning. Phase 3 does not change classifier thresholds. A
demonstrated defect would require a separately reviewed, versioned configuration and
canary record.

The authorized `GET /api/validation-status` endpoint is additive and read-only. No
public response, existing database column, queue payload, quota authority, classifier
decision, or discovery behavior changes. Migration 018 is expand-only and safe to
leave in place during application rollback.

## Database and migration safety

Migration 018 creates `validation_runs` plus indexes; it alters or backfills no table.
The status/kind/checksum/time constraints reject ambiguous evidence. Inserts are
idempotent by UUID and existing records are never updated by application code.

Before staging migration, checksum both SQL.js archives and make the copies read-only.
Run migrations twice and concurrently to verify the existing advisory lock. Compare
all durable table counts and deterministic samples, including legacy `quota_tracker`
and `search_jobs_queue`; if these intentionally remain ephemeral, the release owner
must record that explicit disposition. Preserve the archives until migration,
restore, dual comparison, and rollback acceptance are signed.

## Recovery rehearsal (disposable staging only)

Retain command output, database identifiers, before/after counts, representative row
hashes, timestamps, image SHA, operator, and artifact checksums for every step.

1. Run `npm run migrate`, `npm run migrate:sqljs`, then `npm run migrate` again.
2. Enqueue a current search job, stop the service before claim, restart it, and prove
   the same job completes once. No payload version changes are part of Phase 3.
3. Kill a worker during processing, wait beyond the stale lease, run the normal
   worker tick, and prove the abandoned attempt closes and the job retries within its
   existing limit. Repeat at exhaustion and prove no further provider call occurs.
4. Kill the scheduler while holding its lease; after expiry prove one replacement
   acquires it and that no overlapping cycle is emitted.
5. Create a reservation, let it expire, and prove it becomes `EXPIRED` exactly once.
   Cross UTC midnight in a controlled clock/database fixture and prove the quota
   tracker resets once without altering consumed reservation history.
6. Exercise real YouTube and Gemini paths with approved non-sensitive fixtures;
   reconcile provider events, reservations, and the authoritative quota ledger.
7. Take the platform backup, restore into a **new** PostgreSQL service, run migrations,
   and compare schema versions, durable table counts, sampled row hashes, open jobs,
   quota state, and validation evidence. Never restore over the source database.
8. Point a single paused application instance at the restored database, verify health
   and authorized reads, resume one worker, then confirm exactly-once recovery.

Record each result as `PASS`, `FAIL`, or `INCOMPLETE`; a missing result is not a pass.
The release record may be changed to GO only when every required artifact is retained
and approved.

## Baseline and drift contract

Run `npm run phase3:baseline -- <held-out.json> <report.json>`. The versioned input has
separate country and trading predictions (`country`, `expected`, `predicted`, and a
0–1 confidence) plus the measurement window, raw/duplicate hits, verified net-new
creators and communities, country coverage, legacy/missing provenance, and separate
YouTube, AI, compute, and review costs.

Review country strata individually. The production release record must set thresholds
from the approved baseline for country precision, trading precision, unsafe/spam rate,
review load, expected calibration error, and sample-size/drift alerts. Do not pool a
weak country into a global average or claim ecosystem recall. Coverage remains an
estimate with documented uncertainty and unreachable cells.

## Rollout, operations, and rollback

This is a staging/evidence rollout. Apply migration 018, deploy with workers and the
scheduler paused, execute recovery and restore rehearsals, capture the baseline, and
resume one worker only after comparison passes. The on-call owner monitors queue age,
stale recovery, provider latency/errors/cost, quota reconciliation, classifier drift,
and validation failures. Evidence artifacts use the same retention and access policy
as backups and review data.

Rollback by pausing producers/workers, snapshotting state, and restoring the previous
image. Keep migration 018 and its evidence. For corrupt data, restore the last verified
backup into a new service and atomically switch `DATABASE_URL`; never destructively
reverse a forward migration. Keep the SQL.js archive. Restore a previous classifier
policy version independently if a later approved calibration canary regresses.

## Completion criteria and go/no-go verification

- [x] Repository support exists for checksummed, append-only validation evidence.
- [x] Per-country country/trading confusion matrices, precision/recall, reliability,
  held-out enforcement, cost categories, and missing-provenance segmentation exist.
- [x] Database/API changes are additive; existing job and public contracts are intact.
- [x] Restart, stale recovery, exhaustion, scheduler, quota, provider, migration, and
  isolated restore procedures and evidence requirements are documented.
- [ ] Disposable staging migration/count/sample comparison is attached and approved.
- [ ] Queued-before-restart, killed-worker, stale/exhaustion, and scheduler logs pass.
- [ ] Quota reset/expiry and provider reconciliation evidence passes.
- [ ] A restored database has passed counts, hashes, health, and one-worker proof.
- [ ] Real YouTube/Gemini evidence and reviewed held-out per-country baseline are
  attached, and drift thresholds have named owners.
- [ ] `docs/production-readiness-report.md` is formally changed from NO-GO to GO by
  the release owner.

The unchecked items require deployment credentials and human approval and cannot be
truthfully completed by repository tests. Until they are attached, the formal Phase 3
gate remains **NO-GO** and Phase 4 must not begin. There are no implementation
deviations from the approved Phase 3 scope.
