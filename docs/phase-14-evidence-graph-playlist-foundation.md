# Phase 14a — Evidence Graph and Playlist Adapter Foundation

Date: 2026-07-29  
Status: implemented, proposal-only; production execution remains **NO-GO**

## Scope and architectural decisions

This change implements the first independently reviewable Phase 14 subphase required
by the implementation program: the relational evidence graph, common adapter safety
contract, and the first adapter in the mandated merge order (`INSPECT_PLAYLIST`). It
does not implement channel-relation, website, community, link, cross-platform, or
Phase 15 portfolio allocation. PostgreSQL remains the graph store; an online graph
service would add operational risk before measured scale justifies it.

Evidence nodes are globally reusable canonical artifacts. Immutable typed edges and
assertions retain source artifact, source locator, confidence, observation time,
extractor version, validity and path. Program visits are deliberately separate, so a
cache hit or evidence reuse cannot imply coverage for another program. Corrections
must be new assertions linked through `supersedes_assertion_id`; evidence is never
rewritten. The existing concept graph is referenced rather than duplicated.

The common adapter contract uses deterministic semantic keys, payload version 1,
bounded depth (maximum 3), bounded fan-out (maximum 50), explicit provider quota
class/caps, versioned policy, attribution path, and proposal-only children. Stable
sorting makes replay independent of provider ordering. `INSPECT_PLAYLIST` is installed
paused, killed, with zero budget, in `SHADOW`. Its proposal API can only materialize a
deduplicated frontier proposal and cannot enqueue or call a provider. Search and all
existing ingestion/classification behavior remain authoritative fallbacks.

## Database and migration safety

Migration 029 is expand-first. It adds `evidence_nodes`, `evidence_edges`,
`evidence_assertions`, `evidence_program_visits`, and
`acquisition_adapter_controls`; it only expands the existing frontier action-type
constraint using PostgreSQL's `NOT VALID` then `VALIDATE` sequence. There are no
destructive data changes, backfills, column rewrites, or new non-null columns on large
existing tables. Evidence tables are append-only via the established immutable-event
trigger. Indexes support bounded path reads in both edge directions and program visit
inspection.

Forward migrations are intentionally retained during rollback. Old application
images ignore the new tables and continue to accept old jobs. No new queue payload is
emitted, so mixed-version workers and replay of every prior phase remain compatible.
Before a later canary, tolerant workers must be deployed before any producer emits an
`INSPECT_PLAYLIST` job.

## API, queue, and worker changes

The authorized `GET /api/evidence-graph` endpoint provides bounded node counts,
adapter controls and attributed visits. The authorized
`POST /api/acquisition-adapters/playlist/proposals` endpoint records only a shadow
proposal and returns `executionEnqueued: false`. There is intentionally no crawl,
execution, budget mutation, or unrestricted graph endpoint.

No worker is enabled and no queue job is emitted in this subphase. This is a safety
decision required by the roadmap's schema/reader-compatibility and proposal-only
stages. A later, separately reviewed Phase 14 playlist canary must add its typed
provider-policy implementation, reservation/finalization accounting, golden provider
fixtures, ingestion through existing gates, and equal-budget experiment evidence.

## Trade-offs and operational considerations

Relational adjacency queries are less specialized than a graph database but preserve
existing backup, transaction, migration, and observability controls. Immutable nodes
mean identity corrections create a new canonical node and an attributable relation or
assertion rather than silently changing history. Depth three and fan-out fifty are
conservative hard ceilings; adapter controls may only lower effective rollout values.
Global cache reuse saves provider cost, but a program visit is still written for every
program attribution.

Monitor table growth, edge/path cardinality, duplicate suppression, rejected depth,
proposal rate by hub/domain, and program attribution reconciliation. Retention or
policy-driven artifact deletion must preserve required lineage and is not introduced
here. Provider/robots policy is not bypassed because this subphase performs no fetch.

## Rollout and rollback

1. Apply migration 029 with all producers and workers unchanged.
2. Verify schema constraints, immutable triggers, zero budgets, `paused=true`, and
   `kill_switch=true`.
3. Deploy the reader and proposal API; exercise deterministic duplicate proposals in
   staging and reconcile program visits. Keep execution disabled.
4. Review proposal relevance, cycle/fan-out simulations, and storage growth before a
   separately approved playlist canary change.

Rollback disables access to the proposal endpoint or restores the prior image. No
jobs need cancellation and no quota needs compensation because execution is absent.
The additive schema and immutable evidence remain for diagnosis. If any proposal is
invalid, record a corrective assertion or ignore it through policy; do not mutate
evidence. Search automatically remains the fallback.

## Completion criteria and go/no-go

The foundation criteria are met: typed source-bound evidence, canonical mapping,
complete program-specific lineage, deterministic semantic dedupe, explicit validity,
depth/fan-out ceilings, zero-cost proposal-only behavior, immutable replayable facts,
and backward-compatible inspection are present and tested.

The production adapter gate is deliberately **NO-GO**. The approved roadmap requires
an adapter-specific equal-budget trial demonstrating verified cluster-diverse
incremental coverage at acceptable cost and unchanged country/trading precision,
drift, harm, and review load. No such trial can be conducted before proposal-only
review. `INSPECT_CHANNEL_RELATIONS` and all later adapters must not begin until the
playlist adapter receives its separate approval. Phase 15 remains out of scope.

## Deviations

There are no architecture deviations. Phase 14 is split exactly as the implementation
program requires. Production execution and the equal-budget go/no-go evidence are
deferred rather than simulated or claimed prematurely.
