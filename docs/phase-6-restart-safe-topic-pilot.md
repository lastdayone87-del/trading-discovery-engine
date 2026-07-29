# Phase 6 — Restart-Safe Topic Pilot

Date: 2026-07-29
Status: implementation evidence; production gate remains an operator decision

## Scope and architectural decisions

Phase 6 converts only the seeded `price-action-trading` Phase 5 program into a leased,
budgeted controller. It retains the existing query repertoire, `SEARCH_YOUTUBE` jobs,
workers, pagination policy, immutable Phase 4 outcomes, and Phase 5 lineage. It adds no
source, learned term, AI decision, or autonomous executor. Workers remain the sole
provider callers and the existing autonomous scheduler remains the fallback.

The common contract is represented by the expanded action lifecycle: proposed,
estimated, reserved, materialized as an existing job, executed by a worker, observed,
and attributed. Payload schema version 1, provider reservation/actual cost, one active
attempt per action, and exclusive country/time cohorts make each transition attributable
and retry-safe. Deterministic proposal identity includes query, country, time block, and
policy version so replay cannot change eligibility.

Controller ownership uses a compare-and-set database lease with a random fencing token.
Checkpoint release requires the same token and advances a monotonic version. A crashed
controller therefore loses authority when its short lease expires; it cannot overwrite
a replacement controller's checkpoint. This is deliberately a controller lease, not a
worker or provider-execution lease.

## Database, API, and worker changes

Migration 021 is expand-first. It adds checkpoints/leases, exclusive pilot cohorts,
fail-closed controls, cost columns, payload versioning, eligible-action indexing, and a
partial unique constraint preventing concurrent active attempts. Existing columns and
tables are not removed, old job payloads remain valid, and pre-Phase-6 actions receive
payload version 1 and zero reserved cost. `btree_gist` supports the overlap exclusion;
staging must confirm the deployment database role may install or already owns it.

Authorized reads add `GET /api/research-programs/price-action-trading`. Admin-only
controls add pause, resume, budget/mode, and kill-switch routes. Controls are additive.
Canary activation fails closed unless mode is `CANARY`, lifecycle is `ACTIVE`, the kill
switch is off, and both daily and total hard caps are non-zero. Migration defaults are
shadow, paused, killed, and zero quota, so deploying code or schema cannot spend quota.

No new queue type or worker is added. When a separately approved operator starts the
capped canary, actions must be materialized to the existing job type transactionally;
the exclusive cohort table prevents the legacy scheduler from owning the same
country/time block. Phase 6 does not change worker provider behavior or continuation
decisions and does not enable later-phase breadth, scoring, sleeping, or learning.

## Operations, rollout, and rollback

1. Snapshot and restore-test PostgreSQL. Apply migration 021 with the pilot paused;
   verify `SHADOW`, kill switch on, both caps zero, and no pilot cohorts.
2. Deploy compatible code and exercise lease expiry/fencing and deterministic shadow
   comparison. Compare pilot proposals with legacy selections and Phase 4/5 replay for
   query, page, cost, and outcome equality.
3. Only after retained shadow evidence is reviewed, assign one country/time block and
   set a zero or very small daily/total quota. Pause between increases. Record operator,
   policy/config versions, cohort, start/end, alerts, reconciliation, and decision.
4. Alert on overlapping ownership rejection, lease age, repeated controller failure,
   active-attempt age, reserved/actual mismatch, daily/total cap proximity, duplicate
   jobs, queue latency, provider errors, precision, and verified funnel/cost divergence.

Rollback is configuration-first: invoke the kill switch, which also pauses the pilot.
Release only unspent reservations using existing reservation policy; already claimed
jobs finish or cancel under existing worker policy. Return future cohort ownership to
the legacy scheduler. Retain migration 021, checkpoints, actions, attempts, immutable
outcomes, and cohort history for diagnosis and replay; do not destructively downgrade.

## Completion criteria and go/no-go verification

Automated checks cover deterministic/cohort-scoped proposal keys, fail-closed control
validation, additive migration safety, exclusive cohorts, lease/checkpoint structure,
hard caps, partial active-attempt uniqueness, authorization, types, build, and the full
suite. Migration SQL review confirms old jobs and reads remain compatible.

Production **GO** requires retained staging/acceptance evidence, not merely passing unit
tests: crash-before/after transaction drills, lease expiry/fencing, concurrent controller
exclusion, quota exhaustion/reset, stale-attempt recovery, duplicate proposals, and a
matched replay showing equal query/page decisions, quota, verified outcomes, precision,
cost, and availability within the predeclared tolerance. Until an operator reviews and
passes those drills, remain shadow/paused/killed at zero quota. This phase validates
mechanics only and does not authorize Phase 7.

## Trade-offs and deviations

The control and safety foundation is complete, but live canary activation remains an
operator gate because this repository has no production-like database or provider
credentials. No architectural capability is substituted: the durable job executor,
immutable measurement foundation, passive lineage, and legacy fallback remain intact.
The API exposes explicit controls instead of silently reading environment flags so each
change is centrally authorized and audited.
