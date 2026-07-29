# Phase 12 — Randomized, capped terminology trials

Status: implemented dark; live assignment remains disabled pending the operational go/no-go drill.

## Scope, decisions, and trade-offs

Phase 12 adds only the approved experiment plane. Experiments pin a reviewed Phase 11
catalog, seed, immutable policy checksum, weighted curated/candidate arms, and explicit
country, lane, ordering, and time-block strata. SHA-256 seeded assignment provides a
uniform, replayable draw: the experiment/action unique key makes retries return the
original treatment and propensity. This is preferable to process-local randomness,
whose result could change after restart. It is not an adaptive bandit; that belongs to
Phase 15. Historical Phase F observations are explicitly non-causal.

Assignments, eligibility facts, exposures, reward components, propensities, sufficient
statistics, guardrail events, and stop decisions are append-only. Provisional delayed
rewards remain distinguishable from finalized review/enrichment outcomes. Estimates
retain sample size, finalized sample size, standard error, and confidence bounds.
Predeclared harm, review-capacity, and quota rules take precedence over a positive
reward estimate. No term promotion or catalog publication path is introduced.

## Database and migration

Migration 027 is expand-first: it adds experiment, arm, stratum, eligibility,
assignment, exposure, reward, statistics, guardrail, stop-decision, and singleton
control tables without changing an earlier table or read path. Immutable event tables
reuse the existing mutation-rejection trigger. Unique experiment/action and external
event keys provide replay/idempotency. The control defaults are a kill switch on, zero
live basis points, a 95% minimum curated floor, and a maximum 5% reviewed trial ceiling.
The migration is safe to leave installed during rollback because dormant tables have
no production dependency.

## API, queue, and compatibility

Authorized endpoints create and inspect experiments and transition state with an
optimistic version and idempotency key. RUNNING is structurally refused while the kill
switch is set or live allocation is zero. Reads expose controls, experiments,
sufficient statistics, and guardrails. There is no promotion endpoint.

The existing search worker and payload remain unchanged. The schema requires an
assignment and quota reservation before a job can be linked; integration into the
existing producer is intentionally dark until an A/A and shadow-assignment drill has
passed. Manual and review quota are never eligible for trial reservation. Safe rollback
cancels only pending trial jobs, never an executing job or immutable exposure.

## Testing and operational plan

Tests cover deterministic retry, 10,000-action A/A balance, delayed/reordered outcome
analysis, guardrail priority, migration immutability, caps, curated control, and the
default-off kill switch. The complete repository test, typecheck, build, and migration
static-safety checks form the release evidence package.

Rollout is: apply migration 027; reconcile deterministic A/A assignments; run one
country/concept in SHADOW; verify zero provider/quota effects; explicitly configure a
tiny allocation only after review; then enable RUNNING with automatic stops and daily
human review. Rollback sets the kill switch, pauses/stops assignment, cancels safe
pending trial actions, restores curated traffic, and retains all evidence.

## Completion criteria and go/no-go

The implementation provides reconcilable costs and assignments, immutable propensity,
delayed reward completeness, uncertainty, and hard guardrails. The code gate is ready
for the A/A and shadow operational drills. **NO-GO for live terminology traffic** until
the predeclared sample is sufficient, the cost-aware lower confidence bound passes,
country/trading/harm/review capacity do not regress, and the rollout owner records the
signed evidence package. Phase 13 remains out of scope and blocked.

## Deviations

The reviewed program describes persisting an assignment before enqueue. This change
installs and tests that durable contract but does not connect it to the production
producer while the mandatory A/A/shadow gate is unexecuted. This conservative dark
launch avoids silently enabling live traffic and is consistent with the approved
rollout order; the producer hook is gated operational activation work within Phase 12,
not Phase 13 functionality.
