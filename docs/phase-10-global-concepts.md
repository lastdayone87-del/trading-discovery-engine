# Phase 10 — Global concepts, locale surfaces, and moderation

## Decision record

Phase 10 adds a **shadow federated concept graph** beside, not instead of, the Phase F
terminology tables. A concept is country-neutral; literal spelling, language, script,
locale, validity and ambiguity live on surfaces. Many-to-many senses deliberately keep
homonyms ambiguous. Country affinity is an overlay and `locally_eligible` is copied
only from that country's legacy record: global similarity never grants eligibility.

Every legacy canonical term initially receives a distinct deterministic concept ID.
This conservative choice avoids silently collapsing homonyms. Moderators may later
merge meanings, and can split them again. Merge/split facts and moderation decisions
are immutable; mutable concept/sense rows are rebuildable projections. Hierarchical
relation cycles are rejected. AI assertions remain evidence only and cannot publish.

## Data, API, and worker behavior

Migration 025 adds concepts, surfaces, senses, provenance-bearing relations, market
affinities, resolution proposals, immutable moderation decisions and projection events.
Nullable mappings expand the Phase F tables; no legacy table, column, identifier, or
endpoint is removed. The idempotent backfill maps canonical terms, aliases and
observations and exposes a compatibility view for reconciliation.

`GET /api/concepts` is an authorized shadow/dual-read inspection response including
mapping counts. `POST /api/concepts/:id/moderate` requires optimistic `expectedVersion`
and an idempotency key. Conflict is stable HTTP 409. The existing terminology endpoint
and planner remain Phase F-backed and unchanged.

`PROPOSE_CONCEPT_RESOLUTION` is a tolerant versioned durable job. It only creates an
ambiguous surface and idempotent review proposal; it never creates eligibility or a
live query. Resolution and both read switches start paused/off in
`concept_graph_controls`.

## Trade-offs and deviations

Initial concepts are intentionally not deduplicated globally. That reduces automatic
recall but makes backfill lossless and bad merges impossible. Conservative automatic
links are represented as proposals but no automatic proposal producer is enabled;
operators can evaluate the pilot before enabling it. This is within Phase 10's
shadow-only requirement. No Phase 11 catalog or evaluation behavior is included.

## Migration, rollout, and verification

The migration is additive, transactional under the existing advisory migration lock,
and idempotent. Before rollout, take a PostgreSQL backup and run the migration in a
production-shaped staging copy. Reconcile canonical and alias totals, verify that all
nullable mappings are populated, compare the legacy endpoint with
`phase10_legacy_term_compatibility`, then exercise merge/split on a pilot concept.

Roll out with resolution paused and all reads on Phase F. Next enable internal dual-read
reports, moderate only the pilot, and observe divergence. A compatibility read flag may
be enabled only after reconciliation. There is no live planner switch in this phase.

Rollback disables resolution and both Phase 10 read flags and deploys the prior image.
Keep all additive tables and immutable evidence. A bad merge is corrected by a split
event; production rollback never drops or rewrites evidence. The catalog rollback drill
is simply restoration of Phase F planner/endpoint reads because Phase 10 never changes
their source.

## Go/no-go record

GO requires: canonical and alias mapping counts match; ambiguous surfaces retain
multiple senses; merge/split round-trip and concurrent-version conflict tests pass;
hierarchical cycles are rejected; locale eligibility is equal to the originating
country only; legacy endpoint output remains unchanged; and disabling dual read restores
Phase F-only inspection. Until staging evidence confirms every item, remain NO-GO and
do not begin Phase 11.
