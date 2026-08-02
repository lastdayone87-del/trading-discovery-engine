# Release 3: creator-focus classification and gap-specific investigation

## Scope

Release 3 implements roadmap Phases 4 and 5 only. It consumes the immutable Phase-3 document/assertion plane, produces creator-level hypothesis distributions and staged classifier-v4 snapshots, and plans bounded evidence acquisition against explicit evidence gaps. It does not grant serving or terminal-decision authority.

## Preserved invariants

- Both controllers are `OFF` by default and use deterministic basis-point canaries.
- Creator-focus snapshots and investigation plans are immutable, versioned, provenance-linked, and replay inputs are identified by document/assertion keys and checksums.
- Classifier v4 always persists `effective_status = UNCERTAIN`; `TRADING_CONFIRMED` and `NON_TRADING` are counterfactual proposals only.
- Missing, insufficient, unsupported-language, uncalibrated, and unavailable-provider states abstain. A non-trading proposal requires affirmative dominant alternative-focus evidence.
- Correlated documents are collapsed by source family before aggregation and temporal decay is explicit.
- The investigation planner can select only governed, prerequisite-matching actions within provider, per-case, latency, and review constraints. Actions without a production adapter are explicitly `UNAVAILABLE` and infeasible.
- Shadow/control cases preserve the legacy scheduler. Release 3 records canary intent but does not add an unbounded worker or automatic terminal transition.

## Rollout

1. Apply migrations 057 and 058 additively.
2. Enable Phase-3 document and assertion dual writes.
3. Set `creator_focus_classifier_mode=SHADOW`; evaluate time-split, propensity-aware benchmarks and existing promotion gates.
4. Set `gap_specific_scheduler_mode=SHADOW`; inspect `/api/investigations/gap-plans` for gap/action coverage and budget feasibility.
5. Any canary requires a non-zero basis-point setting and an approved operational change. Roll back instantly by setting either mode to `OFF`.

## Independent repository audit

Phase 4 is represented by the closed hypothesis taxonomy, document semantic projection, source-family/temporal aggregation, eleven-stage conservative classifier, immutable snapshot migration, dual-write hook, inspection API, and focused tests. Existing decision-evaluation datasets, ground truth, propensity-aware metrics, calibration artifacts, and promotion gates are retained rather than duplicated.

Phase 5 is represented by the explicit gap taxonomy, complete action catalog, hard-constraint utility planner, unavailable-adapter fail-closed behavior, immutable plan/cost schema, deterministic controls, dual-write planning hook, inspection API, and budget/failure tests. Existing resumable investigations and the legacy VOI scheduler remain the production control path. No Phase-6 serving authority, operator dashboard mutation, or automatic terminal transition is included.
