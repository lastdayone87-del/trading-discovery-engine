# Phase 7 — Coverage Cells, Sleeping, and Reactivation

Date: 2026-07-29
Status: implementation evidence; production gate remains an operator decision

## Scope and architectural decisions

Phase 7 adds a versioned coverage matrix and deterministic topic lifecycle policy only
to the existing `price-action-trading` pilot. Existing `SEARCH_TERM` and
`CONTINUE_RESULT_PAGE` actions remain the only acquisition actions. Existing workers,
the durable `SEARCH_YOUTUBE` queue, local page-continuation policy, Phase 4 immutable
outcomes, Phase 5 lineage, Phase 6 leases/cohorts/caps, and the legacy scheduler fallback
are unchanged.

Coverage is represented by versioned dimensions, explicit cells, and compact sufficient
statistics. Reports deliberately say “estimate with uncertainty”; the implementation
does not calculate or expose a false absolute ecosystem-recall percentage. Cell identity
is stable within a dimension version, while a later reviewed definition can be added as
a new version without rewriting old evidence.

The policy ranks already-approved actions by expected incremental coverage, information
gain, and freshness value divided by expected total cost. It does not introduce a
bandit, learned term, AI decision, graph traversal, source adapter, or portfolio
allocator. Sleeping requires every approved predicate: a minimum evidence window, the
best frontier upper bound below the hurdle, stable rediscovery, all target cells covered
or explicitly unreachable, no eligible high-information action, and a sufficiently
small delayed-review backlog. A hard budget or page ceiling remains a checkpoint, not
evidence of semantic exhaustion.

Reactivation is restricted to the six approved triggers: terminology burst, new
creator/content, stale coverage, provider capability change, human nomination, or a
scheduled freshness probe. Freshness probes carry a separately recorded provider-cost
cap and still pass through Phase 6 hard budgets and existing queue execution. Manual
controls require a reason and idempotency key. All decisions record the actor, policy,
decision version, trigger, evidence window/predicates when automated, and transition.

## Database, API, and queue/worker changes

Migration 022 is expand-first. It adds dimension versions, cells and unreachable-gap
reasons, sufficient-statistics projections, immutable projection markers, immutable
lifecycle decisions, and immutable reactivation events. It removes no table, column,
endpoint, or legacy aggregate. Projection markers key directly to immutable frontier
outcomes, so retry is a no-op; the pure reducer is order invariant and supports a full
rebuild from outcomes. Corrections remain new outcome facts rather than mutation of
evidence.

`GET /api/research-programs/price-action-trading/coverage` is an additive authorized
read exposing cells, sufficient statistics, evidence times, unreachable gaps, policy
and decision versions, and recent lifecycle decisions. Admin-only lifecycle pause and
reactivate endpoints are additive. Reactivation rejects unknown triggers and uncapped
scheduled probes may be recorded only with a zero cap (which cannot spend); operators
must explicitly supply a positive cap before a live probe is useful. Existing Phase 6
pause/resume/budget/kill-switch endpoints remain available for compatibility.

Workers continue only to emit immutable outcomes. A controller projection transaction
first establishes the cell, inserts a unique outcome marker, and then updates the
compact statistics. Concurrent/retried processing therefore counts an outcome once.
No new queue type, executor, provider call, or job payload version is introduced. The
current local pagination rule remains authoritative, and lifecycle enforcement affects
only the capped pilot.

## Trade-offs, operational considerations, and deviations

PostgreSQL sufficient statistics were chosen instead of a warehouse or graph database:
the volume is bounded to one pilot and transactional idempotency matters more than
analytical scale. Mutable projections are acceptable because their immutable input and
projector version permit deterministic replay. Event-time minima/maxima avoid arrival
order changing the evidence window.

The repository has no production outcome stream, controller daemon, provider
credentials, or reviewed false-sleep/zombie tolerance values. Consequently this phase
ships the schema, deterministic policy, idempotent projector, APIs, and fail-closed
controls, but does **not** autonomously enforce shadow recommendations or start live
freshness work. That is an operational gate, not a replacement capability. No claim is
made that production GO evidence exists merely because automated tests pass.

Monitor projection lag and conflicts, delayed backlog, false-sleep reviews, zombie
rate, cell concentration, unreachable-gap rate, best-action upper bound, freshness
probe cost, Phase 6 cap proximity, precision, verified incremental coverage per total
cost, and fallback ownership. Alert on lifecycle churn, repeated idempotency conflicts,
projection divergence after replay, stale sleeping programs without probes, or any
attempt to schedule outside the assigned cohort/budget.

## Rollout and rollback

1. Snapshot and restore-test PostgreSQL. Apply migration 022 while the pilot remains
   `SHADOW`, paused, killed, and at zero quota. Verify all legacy jobs remain claimable.
2. Deploy compatible readers, populate cells from retained outcomes in shadow, replay
   in different arrival orders, and reconcile statistics with Phase 4/5/6 evidence.
3. Review cell definitions and unreachable reasons for bias. Establish and approve
   numerical evidence-window, false-sleep, zombie, backlog, and upper-bound tolerances.
4. Emit lifecycle recommendations without enforcement. Human reviewers compare matched
   pilot country/time blocks and retain decisions, policy versions, alerts, and costs.
5. Only after the go/no-go evidence is approved, allow sleeping/reactivation for the
   capped pilot. Begin with a zero-cost scheduled probe, then a very small explicit cap;
   pause between increases. Keep the admin override and legacy scheduler ready.

Rollback is configuration-first: kill and pause the pilot, disable lifecycle
enforcement/projector invocation, and return future cohort ownership to the legacy
scheduler. Already claimed jobs follow existing cancellation policy. Retain migration
022, immutable decisions, reactivation records, projection markers, statistics, and all
Phase 4–6 evidence. Do not destructively downgrade; projections can be rebuilt later.

## Completion criteria and go/no-go verification

The independently reviewable implementation criteria are met when migration safety,
authorization, deterministic scoring, all-predicate sleeping, all six triggers,
idempotent concurrent projection, order-invariant replay, delayed-backlog protection,
types, build, and the full regression suite pass. Backward compatibility is preserved
because API changes are additive, no existing job or action payload changes, and the
legacy fallback remains authoritative outside the pilot.

Production **GO** additionally requires retained shadow evidence demonstrating that
coverage reports reproduce, reviewed false-sleep and zombie rates are within
predeclared tolerances, distinct promising branches are pursued without precision or
budget regression, lifecycle decisions survive restart, and late verified outcomes
produce the same replayed result. If any predicate, reconciliation, cap, precision, or
fallback check fails, the decision is **NO-GO**: remain shadow/paused and do not begin
Phase 8.
