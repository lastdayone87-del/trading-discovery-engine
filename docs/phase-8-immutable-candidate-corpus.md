# Phase 8 — Immutable corpus and source-bound candidates

## Decision and scope

Phase 8 adds a shadow-only evidence corpus. It does not change Phase F reads, query
eligibility, planner behavior, provider allocation, Phase 4 outcomes, or the Phase 5–7
controller. Candidate generation is deterministic (Unicode-aware 1–5 grams), and AI
is absent from ingestion and harvesting. Every occurrence retains the exact literal,
Unicode scalar-value offsets, document hash, extraction version, source lineage, and
qualification decision.

## Architecture and trade-offs

* `TERM_HARVEST` is asynchronous, durably idempotent by content hash and extractor
  version, retryable, and independently paused. It defaults paused with zero daily
  compute-document budget. Existing workers remain tolerant because job selection is
  opt-in and payload schema version 1 is checked before processing.
* Only autonomous confirmed/high-quality creators and explicitly human-approved
  manual lineage qualify. Cluster/day contribution caps reduce correlated affiliate
  evidence. Later semantic scoring, AI assertions, concepts, and activation belong to
  Phases 9–13 and are deliberately absent.
* Text is NFC-normalized before hashing and offset calculation. Offsets count Unicode
  code points, avoiding JavaScript UTF-16 ambiguity. Minimal excerpts are capped at
  8,000 code units and expire after 90 days; policy deletion erases the excerpt and
  appends a deletion decision while retaining non-content hashes and lineage.
* A content hash shared by sources resolves to one document. This saves storage, but
  the immutable artifact rows preserve each known source assertion. Legacy content
  without coordinates is not imported or accepted.

## Database, APIs, and operations

Migration 023 is expand-only. It adds artifacts, documents, extraction runs, exact
occurrences, qualification decisions, controls, indexes, immutable-event triggers,
and a paused queue control. It does not alter or backfill existing terminology.

Authorized, read-only `GET /api/corpus` and `GET /api/corpus/documents/:id` expose the
funnel, provenance, retention/deletion status, and spans. There is no activation or
candidate mutation endpoint.

## Rollout and rollback

1. Apply migration with harvesting paused and verify Phase F output is unchanged.
2. Obtain legal/source-policy approval; set a non-zero compute cap, then unpause one
   worker for a small approved creator cohort.
3. Inspect storage, candidate precision, cluster caps, queue latency, and multilingual
   offset samples. Expand one country at a time and freeze a labeled sample.
4. Roll back by pausing `term_harvest`, restoring the prior application image, and
   leaving additive tables in place. Execute required excerpt deletion through the
   retention routine. Phase F continues unchanged throughout.

## Completion evidence and go/no-go

Code-level gates cover deterministic extraction, exact multilingual offsets, stable
hashes, additive/immutable schema, caps, deletion status, retry-safe identities, no AI
dependency, lint, build, and the complete test suite. Production **GO remains pending**
legal/policy approval and staged evidence showing zero untraceable accepted spans,
acceptable labeled precision/storage cost, and unchanged ingestion latency. Phase 9
must not begin until those operational gates and Phase 8 review are approved.
