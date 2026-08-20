# Phase 10 PostgreSQL lock order

Phase 10 mutations use one lock order for a canonical native term:

1. **Creator mutation authority** locks the affected `channels` row.
2. **Projection recomputation authority** locks affected
   `canonical_trading_terms` rows in ascending `id` order, before reading
   observations or creator classifications.
3. The reducer writes/locks `country_native_evidence_projections` and may disable
   matching pending `frontier_discovery_proposals`.
4. Proposal materialization locks the canonical term, then its projection, then
   the proposal row. It never locks a creator row.
5. Phase 8 locks the canonical term projection before its proposal row, then
   writes the reservation decision.
6. Scheduling commits the Phase 8 decision before Phase 9 reserves retrieval
   treatment/quota. Phase 9 never recomputes Phase 10 evidence.

Creator refresh obtains canonical-term locks in ascending order. Observation
insertion already owns only its canonical term before recomputation. Consequently
no path takes a creator lock after a canonical-term/projection/proposal lock, and
no path reverses proposal/projection ordering. The canonical-term lock is held
from before the authoritative aggregate read through projection and proposal
state writes, eliminating last-writer-wins stale aggregates while retaining exact
observation replay and immutable allocation snapshots.
