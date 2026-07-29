# Adaptive Trading Classifier shadow architecture

The production Evidence-Based Trading Verification Engine remains authoritative. Its provider evidence is collected once and reused as the immutable baseline for a parallel adaptive score; the shadow path is not consulted by any ingestion gate.

## Safe integration

1. **Governed feature snapshot.** Adaptive matching admits only active, unambiguous Concept Graph senses that also have explicit human terminology approval, an approved immutable serving-catalog entry, or an explicit sense-moderation approval. Merely observed, search-eligible, trial, proposed, ambiguous, learned, or graph-related terms are excluded.
2. **Bounded evidence.** Catalog matches are medium-reliability and capped. Evidence Graph relations are corroboration-only, require an active high-confidence channel-to-concept edge, and have a smaller cap. At least two distinct corroborated concepts are required for an adaptive confirmation.
3. **Conservative veto.** The current scorer and thresholds are reused. A production `NON_TRADING` result can never be changed to shadow `TRADING_CONFIRMED`; conflicting or insufficient adaptive evidence abstains to `UNCERTAIN`.
4. **Failure isolation.** Production classification executes first. Shadow evaluation and persistence are detached, never awaited by ingestion, and contain failures at their observer boundary. Review labels are likewise scheduled only after the authoritative review transaction commits, so neither observer can delay or roll back production work.
5. **Immutable measurement.** Each successfully persisted run pins classifier, policy, catalog, and feature checksums and records both decisions, full evidence, evidence deltas, agreement, and review-rate delta in an append-only ledger. Completed human reviews asynchronously append labels; the inspection report derives accuracy, precision, recall, false positives, false negatives, and false-positive delta without rewriting history.

## Promotion gate

There is intentionally no automatic promotion mechanism. A future replacement requires a separately reviewed policy and offline time-split plus production-shadow evaluation. It must show a statistically defensible recall improvement, no false-positive increase (including confidence bounds and country/locale slices), acceptable review cost, stable disagreement analysis, and rollback readiness. Approved terminology or graph updates create measurable new snapshots; they never mutate production behavior.
