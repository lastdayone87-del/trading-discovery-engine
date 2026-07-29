# Phase 14b — Playlist Adapter Tiny Canary

Date: 2026-07-29  
Status: implemented, disabled by default; production activation is **NO-GO** pending operator approval and equal-budget evidence

## Scope and decisions

This is the next Phase 14 subphase after the merged evidence-graph and playlist
proposal foundation. It adds only the separately budgeted `INSPECT_PLAYLIST` tiny
canary. Channel relations, websites, links, communities, cross-platform acquisition,
and Phase 15 remain out of scope. PostgreSQL and the existing durable queue, provider
resilience layer, global quota ledger, evidence graph, and channel ingestion gates are
reused rather than redesigned.

One job performs at most one YouTube `playlistItems` request, never follows a page
token, and admits at most ten deterministically ordered channel owners. Provider order
cannot affect replay output. The playlist adapter is claimable only when its versioned
control is `CANARY`, unpaused, and not killed; the migration does not change its
existing killed, paused, zero-budget defaults. Search remains authoritative fallback.

## Database, API, and worker changes

Migration 030 adds only the immutable `acquisition_adapter_runs` replay ledger and an
index. It has no backfill, destructive DDL, rewrite, or new requirement on old workers.
Old binaries ignore the table. Forward schema is retained on rollback.

The authorized administrator control endpoint uses optimistic configuration versions,
caps activation at 10 units/day and 100 units total, and caps fan-out at ten. A separate
administrator endpoint enqueues an already-proposed action and requires an explicit
target country. The existing graph and proposal endpoints are now included in the
fail-closed authorization inventory. Payload schema version 1 and policy version must
match at execution time; stale or mixed-version work fails closed.

The worker reserves one unit in the existing global quota ledger before calling the
provider, finalizes it only after a successful call, routes every owner through the
existing country/trading ingestion pipeline, writes program-specific visits, and
records an immutable outcome. Semantic job and action keys suppress duplicate spend.
Evidence nodes are globally reusable but visits remain program-specific.

## Trade-offs and operational considerations

The canary intentionally inspects only the first provider page. This limits reach but
makes cost and fan-out strict and replayable. Playlist ownership is treated as strong
source evidence (9000 basis points), not as proof of trading relevance; existing
classifiers remain authoritative. A requested country is explicit rather than inferred
from a playlist, avoiding silent attribution drift. Successful provider observations
are immutable; corrections must be additive.

Monitor adapter queue age, provider errors/timeouts, global and adapter quota
reconciliation, duplicate suppression, fan-out, country/trading rejection, review
load, cluster diversity, evidence growth, and incremental verified coverage. Alert on
any call while killed/paused, cap breach, payload/policy mismatch, or consumed quota
without a run ledger entry.

## Rollout and rollback

1. Apply migration 030 while all adapter controls remain paused, killed, and zero.
2. Deploy tolerant workers and APIs; verify old search jobs and historical replay.
3. In staging, configure positive caps while still killed, enqueue nothing, and audit
   control/version behavior. Then unkill one approved country/time block and one action.
4. Reconcile provider calls, reservations, immutable runs, program visits, ingestion
   outcomes, and total cost before each additional action. Never overlap evaluation
   with another new adapter.
5. Production expansion remains prohibited until the predeclared equal-budget trial
   proves cluster-diverse verified incremental coverage without country/trading
   precision, drift, harm, or review-load regression.

Rollback sets the kill switch and pause flag immediately, then restores the prior
application image if necessary. Pending jobs are not claimable while disabled. Retain
migration 030, evidence, runs, and quota records for reconciliation; return unused
budget to search. Policy-violating artifacts follow existing deletion rules.

## Completion criteria and go/no-go

The tiny-canary implementation criteria are met in code: bounded idempotent execution,
provider and adapter quota accounting, deterministic fixtures, full lineage, immutable
outcomes, version checks, existing ingestion gates, fail-closed controls, and an
expand-first rollback-safe migration. No deviation from the approved program was
introduced.

Operational **GO is not claimed**. It requires migration rehearsal, staging proof, an
explicit operator activation, and the adapter-specific matched equal-budget trial.
`INSPECT_CHANNEL_RELATIONS` and later subphases must not begin before this playlist
gate is reviewed and approved.
