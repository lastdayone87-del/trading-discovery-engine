# Phase 15 — Portfolio Allocation and Adaptive Policy

Date: 2026-07-29
Status: implemented, fixed-policy foundation disabled by default; adaptive production rollout is **NO-GO**

## Scope and architectural decisions

Phase 15 adds the final portfolio policy boundary specified by the implementation
program. It does not add another acquisition adapter, provider, crawler, vocabulary
store, scheduler, or phase. The initial policy is transparent deterministic
best-first allocation with explicit provider and review budgets, program fairness
floors, a curated-search floor, action caps, and entity-cluster caps. Candidate ties
use stable timestamps and action IDs. Workers remain executors: simulation never
enqueues work, and persisted decisions pin the policy version and complete context.

A contextual-bandit policy may be stored, but fails closed at approval or canary
activation until an immutable passing offline evaluation exists. Historic outcomes
without propensities are not eligible for causal claims. Fixed best-first and the
unchanged rotating scheduler remain the fallback. No opaque reinforcement learning
is present.

## Database and migration safety

Migration 031 is expand-only. It adds versioned portfolio policies, immutable offline
evaluations, capacity allocations, immutable explainable decisions, and immutable
policy transitions. Decisions retain selection propensity, exact contextual and
constraint snapshots, score components, opportunity cost, program/action lineage,
and policy version. A partial unique index prevents two canary policies. There is no
backfill, destructive DDL, rewrite, or new requirement on existing tables, payloads,
producers, or workers. Old applications ignore the schema. Migration rollback retains
these tables as evidence and deploys the previous application.

## API, queue, and compatibility changes

All new endpoints are behind the existing fail-closed `/api` operator boundary:

- `GET /api/portfolio` returns policies, evaluations, explanations, and fallback state.
- `POST /api/portfolio/simulate` performs a side-effect-free deterministic simulation.
- `POST /api/portfolio/policies` creates an immutable-versioned draft configuration.
- `POST /api/portfolio/policies/:id/{approve,canary,pause,rollback}` performs an
  idempotency-keyed, reasoned transition.

No existing API or response changes. No queue payload is emitted in this disabled
foundation, so old jobs remain claimable and replay remains byte-for-byte governed by
their original policy. A later operational activation uses existing frontier actions
and jobs only after transactional capacity reservation; workers must never allocate.

## Trade-offs, operations, and risk controls

The fixed score is intentionally simpler than a learned policy and may leave some
short-term reward unused to honor fairness and curated-search floors. This is the
correct safety trade-off against rich-get-richer behavior. Monitor budget
reconciliation by provider and review capacity, floor satisfaction, rejected actions,
cluster concentration, propensity validity, precision, delayed verified reward,
queue latency, drift, and policy transitions. Alert on multiple canaries, any adaptive
assignment without a passing evaluation, starvation, cap breach, missing lineage, or
worker-side policy choice.

## Rollout and rollback

1. Apply migration 031 and deploy read/simulation paths with no active policy.
2. Replay held-out time windows and reconcile every provider/review unit and fairness
   constraint. Approve a fixed policy only after review.
3. Run fixed-policy shadow and A/A. Then use one tiny country/time-block canary with
   predeclared thresholds and automatic pause.
4. Collect randomized exposure with valid propensities. Only then evaluate a simple
   contextual candidate offline; shadow, A/A, and canary it separately.

Rollback pauses the active policy atomically (or retires it via `rollback`), stops new
portfolio assignments, and returns scheduling to fixed best-first or the existing
rotating scheduler. In-flight work stays pinned to its original decision. Migrations,
decisions, propensities, outcomes, and transitions are retained for reconciliation.

## Completion criteria and final go/no-go

Code-level criteria are met: deterministic replay, explicit explanations and
propensities, conserved independent capacities, fairness and cluster guardrails,
versioned policies, immutable causal evidence, fail-closed adaptive approval,
authorized controls, and backward-compatible fallback.

Broader production adoption remains **NO-GO** until a statistically adequate held-out
evaluation and guarded canary demonstrate improved verified incremental coverage per
total constrained cost at equal country/trading precision, with no safety, fairness,
reliability, review-capacity, or provider-capacity regression. This is an operational
evidence gate, not an implementation deviation. There are no deviations from the
approved Phase 15 architecture.
