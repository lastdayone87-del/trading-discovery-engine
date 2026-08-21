# Phase 11 — External OSINT Proposal Sources

## Boundary and ownership map

Phase 11 is an evidence producer only. `externalOsint.ts` owns bounded adapters, immutable observation normalization, correlation-aware aggregation, validation, and bounded proposal materialization. Canonical normalization remains shared with Country-Native Intelligence; `frontier_discovery_proposals` owns persistence, deduplication and `PENDING`/`DISABLED`/`TRIED`/`EXPIRED`; Phase 8's frontier allocator exclusively reserves quota/capacity and snapshots evidence; Query Intelligence constructs the exact allocated neighborhood; Phase 9's existing durable query-run workers exclusively retrieve and continue; existing quota/provider resilience owns cost, Pacific quota day, cooldown and 429 feedback; query runs own completion; persisted allocation lineage owns attribution; the autonomous producer remains the sole scheduler.

Flow: approved external adapter → append-only observation → normalized concept → validated independent evidence aggregate → `EXTERNAL_OSINT` proposal → Phase 8 allocation snapshot → Query Intelligence → Phase 9 query run → idempotent outcome attribution. External failures abstain and never become semantic evidence. No crawler, scheduler, allocator, retrieval path, quota ledger, completion authority, or terminology authority is introduced.

## Governance model

Observations have deterministic IDs over source identity, stable external identity and content checksum. A changed page creates a new historical observation; exact replay is a no-op. Original surfaces remain separate from NFKC canonical identity. HTTPS URLs and external identifiers are inert data; surfaces, scores, timestamps, languages and evidence sizes are validated. Adapters declare identity, family, timeout, request/cost bounds and bounded exponential retry. Their failures are isolated.

Correlation keys collapse known mirrors/reposts into one independence bucket; without metadata, each approved source identity is conservatively one bucket. Eligibility requires two independent sources, weighted confidence/reliability/relevance of at least 0.55, one script context, and evidence no older than 30 days. OSINT never overwrites Country-Native or other authoritative evidence because proposal family provenance is distinct while shared normalized concept/neighborhood identity prevents query fragmentation.

Materialization defaults to 20 proposals/cycle, five/source family and four/country, ordered deterministically and round-robin across country/family buckets. It is default-off (`enabled` must be explicit), deadline bounded, and operates inside the existing producer boundary. The existing frontier kill switch and daily assignment/quota canary caps remain authoritative. Disabling Phase 11 leaves observations intact and restores the legacy path.

## Precedence, lifecycle, concurrency, and attribution

Exact replay does not mutate. A higher monotonic evidence revision may refresh a non-terminal OSINT proposal; stale/weaker evidence loses the compare-and-swap. Independent observations are retained even when canonical concepts match Country-Native. Conflicts abstain. `TRIED` and `EXPIRED` never resurrect; disabling/releasing does not consume, successful scheduling follows the existing transition to `TRIED`, and malformed construction is quarantined so it cannot starve scheduling. Historical Phase 8 snapshots are immutable and freshness is revalidated under the allocator lock immediately before reservation.

The observation primary key serializes duplicate fetches. Proposal dedup keys plus monotonic revision predicates serialize source-family races. Phase 8 locks the proposal and compares its evidence checksum before reservation; allocation snapshots remain immutable across later evidence refresh. Attribution derives only from that snapshot and uses a deterministic `(decision, query run)` key. Crash/retry at every boundary is therefore replay-safe; orphan reservations remain handled by Phase 8 recovery.

The attribution row records proposal, allocation, run, frozen source families/concept/country/evidence, quota, raw/distinct/new/relevant/quality/confirmed creators, wrong-country results, coverage expansion and yield for Phase 12. It never infers provenance from query text.
