# Phase 4 — Immutable outcomes and reproducible replay

Date: 2026-07-29  
Status: implementation complete; production acceptance evidence required for GO

## Scope and architectural decisions

Phase 4 adds only the experiment/measurement foundation in the approved program. It
does not add an exploration control plane, a new scheduler, a provider call, or a new
production decision path. Existing `query_runs`, `channel_sightings`, performance
details, and quota records remain authoritative. The new ledgers are shadow dual
writes and the replay endpoint is read-only.

The canonical taxonomy is intentionally narrow: query funnel and channel observation
are provisional outcomes; human review is verified or corrective; quota finalization
is reserved for explicit cost outcomes. Decisions and outcomes identify their schema,
policy, and feature versions and retain query/run/job lineage whenever it exists.
Unknown historical lineage is represented by nullable columns, never inferred.

Event keys are deterministic business keys. `ON CONFLICT DO NOTHING` makes worker and
request retry safe, while database triggers reject update and delete. Event time means
when the decision/outcome happened; `recorded_at` means when PostgreSQL received it.
Late review therefore appends a later verified/corrective event without rewriting the
original observation. Minimal JSON objects exclude provider payloads, credentials,
and direct reviewer identity; application validation caps them at 20 KB.

Replay is a pure in-process projection over retained rows and has no provider or queue
dependency. It sorts processing time plus event key for deterministic late-arrival
handling, reports country/lane segments, and compares against legacy completed-run
aggregates at a predeclared tolerance. Benchmark and replay metadata are themselves
append-only; checksums cover the event projection and configuration/code versions.
A replay worker was deliberately not introduced: the current data volume does not
justify another job class, and the offline command provides a stronger no-network
boundary. If replay duration later threatens serving capacity, a separately reviewed
compute-only worker with an isolated pool/concurrency budget is required.

## Database and API changes

Migration `019` is expand-only. It creates `decision_events`, `outcome_events`,
`benchmark_datasets`, and `replay_runs`, their lineage/segment indexes, constraints,
and immutable triggers. It alters or removes no existing column, constraint, table,
aggregate, or row. Foreign keys use `ON DELETE SET NULL` so legacy cleanup cannot
delete the retained event; stable string lineage remains available.

`GET /api/measurement/replay?from=<ISO>&to=<ISO>&tolerance=<ratio>` is an authorized
operator read. Its additive response declares shadow mode, the legacy authoritative
source, no-network execution, versions, replay totals/segments/checksum, and explained
residuals. No existing endpoint or successful response changes.

Current autonomous scheduling records the exact selection context atomically with the
run/job/quota reservation. Page sightings and completed funnel totals append outcomes
in their existing transactions. Human review appends verified/corrective outcomes in
the review transaction. Existing job payloads and claimable job types are unchanged,
so old jobs remain readable and workers remain backward compatible.

## Testing and acceptance

Unit coverage proves stable checksums, reordering determinism, retry-key idempotency,
late correction visibility, segmented projection, residual tolerance, and payload
safety. Migration review must confirm expand-only DDL and immutable triggers. The full
test, type/lint, build, and formatting checks are recorded in the PR.

Production acceptance uses an approved UTC window and a predeclared tolerance:

```bash
REPLAY_FROM=... REPLAY_TO=... REPLAY_TOLERANCE=0 npm run phase4:replay
```

Run it daily in shadow, reconcile by country/lane, and repair instrumentation rather
than editing history. Freeze `benchmark-v1` only after reviewers approve its window,
checksum, policy/feature/code versions, sampling limitations, and residual
explanations. Reusing a version never changes it; the immutable trigger rejects that.

## Operations, rollout, and rollback

1. Back up PostgreSQL and apply migration 019 while producers continue on the old
   image; the additive tables are unused and safe.
2. Deploy compatible workers first, keep event dual-write enabled, and leave every
   legacy read and discovery policy authoritative.
3. Monitor event insert errors, unique conflicts, table/index growth, write latency,
   missing-lineage rate, and daily country/lane residuals. Alert on unexplained
   residuals or material transaction-latency change.
4. Retain events through the benchmark/acceptance horizon. Any future partitioning or
   retention policy requires separate approval because deletion would affect replay.
5. After the acceptance window reconciles, run the offline command and retain its
   checksum/report with release evidence. This phase never switches reads.

Rollback disables the application dual-write/replay route by restoring the prior
image. Legacy aggregates immediately remain the sole path. Do not reverse migration
019 or delete event rows; retained additive tables are inert. If event insertion adds
unsafe latency, pause producers briefly, restore the old image, verify legacy run/job
transactions, and reconcile the last successful event key. No provider quota can be
spent by replay.

## Completion criteria and go/no-go

- **Implemented:** immutable, idempotent decisions and provisional/delayed/corrective
  outcomes; version and available lineage; no-network deterministic replay; additive
  authorized report; legacy authoritative reads; immutable benchmark/replay metadata.
- **Evidence required:** complete acceptance-window dual-write, daily country/lane
  reconciliation, reviewed benchmark-v1 checksum, and documented explanations for
  every residual outside the predeclared tolerance.
- **GO:** only when retained production data reproduces the current selection policy
  and funnel/cost report throughout that window and reviewers approve all residuals.
  Until that evidence is attached, the gate is **NO-GO** and Phase 5 must not begin.

There are no implementation deviations from the approved Phase 4 scope. The optional
queued replay worker was not selected for the operational reason above.
