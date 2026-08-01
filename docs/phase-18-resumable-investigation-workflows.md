# Phase 18 — Idempotent and resumable investigation workflows

## Scope and authority

Phase 18 makes multi-step evidence investigations recoverable before the engine
adds broader graph and entity adapters. It wraps the existing
`ENRICH_CHANNEL` execution without replacing the durable queue, evidence engine,
country gate, quota reservation, or terminal decision policy.

PostgreSQL `jobs` is the transactional outbox. A workflow step and its job are
created in one transaction, and existing workers continue to claim the same job
type. The feature flag defaults off, so pre-migration and rollback jobs remain
valid.

## State and lineage

An investigation identifies its subject, purpose, deadline, policy and utility
versions, initial context, and checksum. Each step pins:

- a strictly increasing sequence number;
- governed action type;
- exact input snapshot and checksum;
- durable job identity;
- policy version;
- worker, attempt, lease, result, and output checksum.

The investigation and step rows are repairable current projections. Immutable
events retain started, scheduled, claimed, retrying, completed, failed, review,
recovery, and supersession history. Existing `job_attempts`, classification
diagnostics, evidence-acquisition outcomes, and provider telemetry retain the
detailed execution and semantic lineage rather than being copied.

## Execution guarantees

- Scheduling the same active action is idempotent.
- Step and job creation commit or roll back together.
- Claims establish a workflow lease and append an attempt-scoped start event.
- Job and workflow heartbeats advance together.
- Completion atomically finishes the step, job attempt, job, and investigation
  projection.
- A newly scheduled successor keeps the investigation active when its parent
  completes uncertain.
- Retryable failures preserve the investigation and append attempt history.
- Exhausted retries and investigation deadlines route to review; they cannot
  retry forever.
- Stale job recovery is reconciled into stale workflow-step recovery.
- Periodic orphan reconciliation repairs the crash window between a channel
  projection becoming enrichment-pending and initial transactional scheduling.
- A checksummed repair operation can rebuild current investigation state from
  durable step history and records an immutable recovery event.

## Rollout and rollback

`investigation_workflow_enabled=false` preserves the existing direct enqueue
path. When enabled, only new uncertain enrichment work is wrapped. Existing
jobs without investigation identifiers execute unchanged. If initial workflow
scheduling fails, the compatible legacy enqueue remains available; once an
investigation has started, successor scheduling failure fails the current step
instead of silently escaping lineage.

Rollback disables the flag. In-flight workflow jobs remain ordinary
`ENRICH_CHANNEL` jobs and complete safely; their workflow metadata is
observational to the classifier.

## Operational measurements

The inspection contract reports active, completed, review, and failed
investigations together with step and event timelines. Stage 1 evaluation can
join investigation, evidence-action, classification, review, provider-cost, and
latency lineage through diagnostic, job, and channel identities.

Production readiness requires fault-injection evidence for:

- crash after scheduling but before claim;
- crash after claim and before provider completion;
- provider success followed by projection persistence failure;
- repeated delivery of the same job and action;
- stale lease recovery;
- deadline expiry;
- successor scheduling failure;
- projection repair and event replay.

No discovery or classifier uplift is claimed from this stage. Its measurable
value is fewer stranded uncertain channels, bounded recovery time, no duplicate
workflow effects, reproducible attempt lineage, and safe scaling of later graph
actions.
