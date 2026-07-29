# Phase 2 — provider resilience and trustworthy telemetry

## Decision record

Phase 2 adds one provider boundary rather than changing discovery or classification.
Every instrumented call receives a deadline/cancellation signal, a deterministic
outcome class, bounded identifiers, and an append-only event. Events deliberately do
not contain URLs, API keys, prompts, responses, or provider payloads. The policy is
versioned as `provider-resilience-v1`.

The deadline flag defaults off. This preserves production behavior while telemetry
establishes p99 latency. YouTube, Gemini, and Discord have separate timeout settings because
their latency and degradation semantics differ. Gemini remains additive: on failure,
the existing deterministic evidence path continues. YouTube key rotation remains the
existing retry mechanism; permanent input errors are typed non-retryable for callers
that adopt the typed contract.

## Database and API

Migration 017 creates only `provider_call_events`, three retention-friendly indexes,
and non-destructive settings. It changes no existing column, constraint, or read path.
The event UUID makes retries of an event insert idempotent. `GET /api/provider-metrics`
is operator-authorized and reports bounded-label counts, average latency, timeout and
error totals, reserved/actual costs, policy version, alert thresholds, and this
runbook. `/api/health` retains `status` and adds only a redacted `readiness` field.

`actual_cost` uses provider quota units for YouTube. Existing `quota_tracker` and
reservation totals remain authoritative during Phase 2; operators reconcile them to
successful provider events before later phases switch any accounting read. Gemini
cost is recorded as zero until billing usage is supplied by its SDK; it is reported
separately and is never represented as YouTube quota.

## Queue, retry, and stale recovery

No job type or payload version changes. Therefore queued jobs created by older images
remain readable. Worker heartbeats continue on the existing timer while provider calls
are bounded. A timeout, cancellation, rate limit, transient error, permanent input
error, and credential exhaustion have distinct typed classes. Only safe classes are
retryable. Existing quota reservations remain idempotently consumed or released by
the durable run/job completion paths; provider events observe costs and do not perform
a second quota charge. Stale recovery consequently cannot charge through telemetry.

## Operations, alerts, and ownership

The discovery on-call owns provider alerts. Dashboard alerts should evaluate the
authorized metrics endpoint over at least 15 minutes:

* timeout rate above `PROVIDER_TIMEOUT_ALERT_RATE` (default 5%);
* non-timeout error rate above `PROVIDER_ERROR_ALERT_RATE` (default 10%);
* p95 latency approaching 80% of the configured deadline;
* successful YouTube event cost diverging from quota/reservation totals.

On alert, pause the affected producer, inspect status by provider/operation, confirm
quota reservations, and avoid unbounded manual retries. Labels are limited to
provider, operation, and status; request/run/job IDs stay in the event ledger and must
not become metric labels.

## Rollout

1. Apply migration 017 with deadline enforcement disabled.
2. Deploy compatible workers; confirm old queued payloads complete.
3. Observe provider latency/cost for a representative window and reconcile YouTube
   successful-event units with the quota ledger.
4. Configure staging alerts and run success, timeout, cancellation, 429, 400, 503,
   stale-lease, and restart fault injection.
5. Set each timeout above observed p99, enable YouTube in staging/canary, then Gemini,
   and expand only if discovery funnel metrics remain at baseline.

Record baseline/canary cohort, configuration version, operator, timestamps, alerts,
and decision in the release record. This repository supplies deterministic fake-
provider coverage; environment-specific alert delivery and staging evidence must be
attached to that record.

## Rollback

Set `provider_deadlines_enabled=false` (or `PROVIDER_DEADLINES_ENABLED=false`) to stop
deadline enforcement without a deploy. Roll back the application image to stop event
emission. Retain migration 017 and all events; do not reverse the forward migration.
Pause producers and reconcile open quota reservations before replaying work. Never
compensate for a timeout with an unlimited retry loop.

## Phase 2 go/no-go checklist

- [x] External YouTube, Gemini, and Discord calls have bounded/cancellable paths.
- [x] Typed retry classes and payload-free, append-only events are deterministic.
- [x] Costs are separated, and telemetry never double-charges quota.
- [x] Existing APIs, jobs, quota totals, and classification behavior remain compatible.
- [x] Metrics expose provider latency, errors, timeouts, and costs with bounded labels.
- [x] Alert thresholds, owner, response, rollout, and rollback are documented.
- [x] Unit fault injection covers success, timeout, cancellation classification, rate
  limit, transient failure, and permanent input failure.
- [ ] Release owner has attached staging stale-recovery/restart fault-injection logs,
  cost reconciliation, alert delivery evidence, and discovery-regression comparison.

The unchecked environment evidence item is the formal operational gate: production
rollout and Phase 3 are **NO-GO** until the release owner attaches and approves it.
There are no deviations from the approved Phase 2 architectural scope; live alert
delivery remains deployment configuration rather than a second in-process scheduler.
