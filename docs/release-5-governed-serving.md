# Release 5: governed serving cutover

## Scope

Release 5 implements only the roadmap's governed dashboard-corpus cutover and Review Eligibility v2 queue-admission phases. It does not change classifier thresholds, evidence semantics, discovery acceptance, or human decision authority. It introduces no post-cutover optimization or later-release learning behavior.

## Mandatory gates

A serving activation is immutable, actor/reason attributed, linked to a `PROMOTE` decision from the existing propensity-aware evaluation plane, and capability matched to either dashboard corpus or review eligibility. `CANARY` requires a nonzero bounded allocation; `ACTIVE` requires 10,000 basis points. An immutable assignment pins each channel to treatment or legacy control for one activation. Separate `app_settings` kill switches default to `OFF` and must agree with the activation projection before any serving behavior changes.

Release 5 serving depends on the corresponding Release 4 observer remaining enabled so new corpus and eligibility decisions continue to be produced. A missing pinned projection or decision fails closed rather than falling back for treatment subjects.

## Dashboard cutover

When OFF, listing, revision, and dashboard summaries retain `OPERATOR_VISIBLE_CHANNEL_SQL`. In CANARY, assigned channels use only the Release-4 `CONFIRMED` and `REVIEW` corpora while controls retain the legacy predicate. In ACTIVE, the projected corpus is authoritative and missing projection rows fail closed. All dashboard endpoints share the same runtime predicate and report their scope.

## Review cutover

Only an immutable, policy-version-pinned `ELIGIBLE` Review Eligibility v2 decision may materialize a review row, and only for an assigned treatment channel under a promoted activation. Existing pending, approved, or rejected review state is never overwritten. New/reopened rows retain the pinned eligibility checksum, reasons, activation, and bounded channel snapshot; an immutable materialization event records the transition. Human approve/reject/force-rescan semantics remain unchanged.

## Replay, rollback, and operations

Immutable activation lineage replays into a repairable projection with gap detection. Verification and administrator-only repair endpoints are provided. Revocation appends a new activation record and projects `OFF`; either independent kill switch also restores legacy/no-materialization behavior immediately. No immutable decision, assignment, or review materialization event is deleted during rollback.

## Independent audit

- **Implemented:** migration 061, promotion/capability gates, deterministic canary assignments, kill switches, dashboard dual-serving predicate, pinned review materialization, immutable provenance, activation replay/verify/repair, admin controls, and focused tests.
- **Retained:** Releases 1–4 ledgers/projections, legacy dashboard fallback, review state machine, country exclusion policy, human authority, classifier abstention, and evidence provenance.
- **Not implemented:** any Release 6 or later adaptive optimization, automatic promotion, threshold relaxation, destructive migration, or unbounded rollout.
