# Phase 5 — Passive Exploration-Control-Plane Ledger

Date: 2026-07-29
Status: implementation evidence; production gate remains an operator decision

## Scope and architectural decisions

Phase 5 adds a passive, topic-centric measurement projection above the existing query
executor. The durable query scheduler, jobs, continuation policy, ingestion gates, and
legacy query aggregates remain authoritative. The control-plane schema intentionally
has no lease columns, claim query, mutation API, activation API, producer, or executor.
Its only program is the seeded `price-action-trading` pilot in `PAUSED`/`SHADOW` mode,
and a database check permanently fixes `activation_enabled` to false for this phase.

Each completed autonomous page maps to one action, attempt, and provisional outcome.
Page one is `SEARCH_TERM`; later pages are `CONTINUE_RESULT_PAGE` children. A canonical
NFKC-normalized query, source run, page, action type, and policy version produce the
semantic key. A UTC-day validity window permits a future revisit without conflating it
with the current observation. Closure-table lineage preserves the exact root-to-page
path and database foreign keys reject missing parents.

The immutable Phase 4 ledger remains the measurement foundation. Page recording now
atomically appends `PAGE_FUNNEL_RECORDED`; the Phase 5 outcome references that immutable
event key and copies only its bounded projection for inspection. Final run outcomes and
all existing aggregate reads are unchanged. This avoids deriving Phase 5 accounting
from mutable query averages while preserving production compatibility.

## Database and API changes

Migration 020 is expand-only. It adds programs, versioned budgets, hypotheses, actions,
attempts, immutable outcomes, lineage, and a shadow-write failure ledger. It adds one
allowed Phase 4 event type using PostgreSQL's `NOT VALID` then `VALIDATE` pattern. No
column is made mandatory on an existing production table, no data is rewritten, and no
table or index is removed. Foreign keys from passive records to old runs/jobs are
nullable on deletion; semantic parent and outcome relationships remain restrictive.

`GET /api/research-programs` is an operator-authorized, read-only inspection response.
It explicitly reports `mode: SHADOW`, `executionEnabled: false`, the legacy/Phase 4
authoritative source, bounded program/action/failure lists, and page/cost reconciliation.
There is no write route. Existing paths and response bodies are untouched.

## Queue and worker behavior

Existing `SEARCH_YOUTUBE` jobs retain their payload and idempotency keys. After the
existing page observation and immutable Phase 4 event commit, the worker attempts the
passive projection. Its deterministic keys make retries and stale recovery idempotent.
A projection failure is caught, recorded with a safe error class, and never retries,
duplicates, delays, or changes provider work. Pagination continues to be decided and
enqueued exclusively by the existing continuation policy.

Trade-off: the projection occurs inline after provider work, rather than through a new
queue, because Phase 5 forbids a competing executor and exact ordering simplifies
reconciliation. The acceptance gate therefore requires confirming no material worker
latency impact. A later approved phase may introduce a separately bounded projection
worker, but this phase does not.

## Operations, rollout, and rollback

1. Snapshot and restore-test the target database; apply migration 020 with workers
   paused, and confirm the pilot is `PAUSED`, `SHADOW`, and activation-disabled.
2. Deploy compatible workers. Start with `PHASE5_SHADOW_WRITES=false`, smoke-test all
   existing scheduling and pagination, then enable it for the acceptance window.
3. Monitor `/api/research-programs`: failure count, source page/shadow outcome equality,
   source/shadow cost equality, database write latency, worker duration, queue latency,
   and storage growth. Compare Phase 4 page events to passive outcomes by event key.
4. Record policy version, operator, window, alerts, reconciliation, latency deltas, and
   the explicit gate decision in the release evidence.

Rollback is configuration-first: set `PHASE5_SHADOW_WRITES=false` or deploy the prior
image. Keep migration 020 and its append-only evidence; do not reverse it in production.
The existing scheduler, worker payloads, aggregate reads, and final Phase 4 outcomes
remain operational. Hide the read endpoint by rolling back the image if necessary.

## Completion criteria and go/no-go verification

Automated checks cover deterministic normalization/keys, page/run separation, the
absence of execution exports, immutable event replay compatibility, types, build, and
the entire test suite. Migration review verifies expand-only DDL, bounded enums, parent
integrity, immutable outcomes, indexes, and the hard-disabled pilot.

The operational **GO** still requires an acceptance window in the target environment:
every autonomous page must have exactly one action/attempt/outcome and Phase 4 event;
page and cost totals must be equal; lineage/failure queries must be clean or explain all
residuals; and p95 worker and scheduler/queue latency must show no material regression.
Until that retained evidence is reviewed, the pilot stays paused and Phase 6 is **NO-GO**.

## Deviations

No approved Phase 5 capability was deferred. The program mentions sampling before
full rollout; a binary environment flag is used rather than probabilistic sampling so
an acceptance window is exhaustive and deterministic. Deployment cohorts provide the
sample boundary. Budgets are recorded as versioned passive limits but never reserved or
consumed, because doing so could imply that this ledger controlled production work.
