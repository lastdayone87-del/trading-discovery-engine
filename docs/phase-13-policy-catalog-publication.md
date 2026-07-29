# Phase 13 — Policy-driven catalog publication

## Scope and decisions

Phase 13 introduces only the approved decision/serving boundary. Reviewed Phase 11 catalogs and Phase 12 causal evidence remain inputs; the concept graph and AI remain off the online path. Serving versions copy compact surface/query data and are immutable. A scope is `(country, locale, lane)` and publication changes one row under a transaction and optimistic pointer version. Jobs copy the catalog and policy version at proposal time, so retries and already-claimed work retain their original decision context.

The lifecycle is explicit (`CANDIDATE`, `ELIGIBLE`, `PROVEN`, `STALE`, `SATURATED`, `HARMFUL`, `INVALID`). Allowed edges deliberately require recovery through eligibility, terminal invalidity cannot automatically reactivate, and cooldown is bypassed only by an audited manual override. Score snapshots are event/config/schedule driven rather than observation driven. The minimum curated share is 95%; initial rollout uses 100%.

## Migration, compatibility, and replay

Migration 028 is expand-only: it adds immutable catalog entries, approvals, publication/rollback events, lifecycle evidence, atomic active pointers, and nullable job pins. It drops or rewrites no Phase F–12 data. Existing jobs have null pins and workers continue to accept them. Existing planning remains the fallback when no active pointer exists. Old serving versions and evidence are never deleted, enabling deterministic reconstruction, replay, and rollback. The legacy Phase F lifecycle remains untouched pending a separately approved contraction.

## Operations, rollout, and rollback

1. Apply migration 028 and verify schema/idempotence before enabling publication APIs.
2. Stage a reviewed no-op catalog with `curatedShareBasisPoints=10000`, verify its checksum, approve it, then publish to one canary scope using expected pointer version `0`.
3. Rehearse rollback by atomically pointing that scope to the last known-good approved version. Confirm in-flight jobs retain their pins.
4. Canary one causally proven surface only after Phase 12 sample, lower-bound, precision, harm, review, and quota gates pass. Expand country by country with operator approval and precision alerts.
5. On drift or guardrail failure, stop terminology experiments, invoke rollback with the current pointer version, and leave all graph/evidence/catalog records intact for diagnosis.

Operational owners must alert on pointer conflicts, checksum mismatch, curated share below policy, missing scope fallback, country/script/locale precision, and canary guardrails. Publication adds no queue type or provider calls. Capacity impact is a compact catalog lookup per proposal; workers do not query either catalog pointers or the graph.

## Completion evidence and go/no-go

Automated tests cover transition rules/cooldown, deterministic reconstruction, scoped selection, expand-only migration, immutability, job pinning, and curated-floor constraints. Production GO additionally requires a database migration rehearsal, concurrent publication and rollback-under-load drill, no-op equivalence report, and canary metrics meeting the same predeclared causal guardrails as promotion. Until those environment-specific artifacts are signed, the operational decision is **NO-GO for candidate traffic**; deploy/schema review and no-op canary preparation are safe. Phase 14 remains blocked.
