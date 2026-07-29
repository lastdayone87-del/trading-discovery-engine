# Phase 11 — Offline candidate evaluation and catalog governance

Status: implemented in shadow; production publication is intentionally unavailable.

## Scope and architectural decisions

Phase 11 adds a compute-only evaluation plane over the Phase 8 corpus, Phase 9
assertions, and Phase 10 shadow concept graph. Evaluation policies, dataset/code
versions, held-out/time-split metadata, results, explanations, catalogs, approvals,
and checksums are durable. Candidate queries are never executed. Missing or expired
cached evidence is classified as `INSUFFICIENT_EVIDENCE`, not as a negative result.

Evaluation uses predeclared precision, verified-quality, incremental-coverage,
quota-cost, and review-cost proxy guardrails. A Wilson-style normal confidence radius
is retained with the sample size. This deliberately favors a transparent,
deterministic conservative gate over a model-based counterfactual estimate: cached
observations cannot establish causal incrementality. Catalog identity is a canonical
SHA-256 digest of sorted accepted entries. Country and lane remain explicit strata.

The database is expand-first. Evidence, results, entries, approvals, and shadow
selections reject mutation; run and catalog projections only move through operational
status transitions. Supersession preserves invalid historical artifacts. Cached data
is usable only when provider retention is explicitly permitted and unexpired.

## API and worker behavior

Authorized endpoints create and inspect evaluations, build catalogs from completed
accepted results, and review a draft as shadow-approved or rejected. Optimistic state
checks and idempotency keys protect review. There is deliberately no publish endpoint.
The optional `OFFLINE_CANDIDATE_EVALUATION` worker is paused by default, reads only the
retention-approved cache, and is claimable only while the no-provider-access invariant
is true. Planner-facing selection is deterministic and shadow-only; Phase F remains
the declared production source and no search or quota reservation is created.

## Operations, rollout, and rollback

1. Apply migration 026 while workers remain paused. Confirm new tables, constraints,
   indexes, and immutable triggers; no existing table or production read is changed.
2. Load a checksummed, provider-policy-approved held-out/time-split cache. Create a
   small-country policy/run, enable only the offline worker, and reconcile a repeated
   replay's result and catalog checksums.
3. Review error and uncertainty distributions by country/lane, then approve a frozen
   catalog for shadow use. Enable shadow loading for an acceptance window and verify
   production query decisions and quota accounting are byte-for-byte unchanged.
4. A later phase requires separate approval before publication can exist.

Rollback requires disabling `shadow_loading_enabled`, pausing
`offline_candidate_evaluation`, and stopping evaluation workers. Phase F continues
unchanged throughout. Do not delete evaluation evidence; mark a bad run/catalog
`SUPERSEDED` through a corrective operational migration. Migration 026 need not be
reversed because it is additive and its dormant tables have no production dependency.

## Completion and go/no-go verification

The implementation reports precision, verified-quality, coverage distribution,
quota/review cost proxies, uncertainty, duplication and guardrail reasons. Golden
tests cover reproducibility, missing counterfactual evidence, redundant coverage,
country/lane isolation, deterministic shadow choice, expand-only migration safety,
no-network controls, and structurally disabled publication. **GO** requires an
operator-reviewed catalog to pass configured offline guardrails, repeated checksums to
match, retention/leakage review to pass, and a shadow acceptance run to prove production
selection is unchanged. Until those operational drills are recorded, remain **NO-GO**
for Phase 12.

## Deviations

No architectural scope was moved forward. The implementation uses a deterministic
normal confidence radius rather than a richer posterior because Phase 11 is a
screening gate, not the randomized causal experiment assigned to Phase 12. Atomic
production publication is intentionally omitted; “approval” means shadow review only.
