# Read-only enrichment backlog diagnostic

Purpose: diagnose whether ENRICH_CHANNEL is genuinely stuck, provider-deferred, or cycling through operational retries after PR #213. This change must not mutate queue state, retry timing, provider selection, channel classification, or investigations.

Implement an operator-authenticated read-only diagnostic endpoint (and optionally a minimal Queue Monitor panel) that returns:

- Aggregate ENRICH_CHANNEL counts by status and runnable/deferred state.
- Completion throughput for the last 15m, 1h, and 6h: claimed/running, completed, failed terminally, and retry/defer transitions where available from jobs/job_attempts.
- The oldest 10 non-completed ENRICH_CHANNEL jobs ordered by effective waiting age, including job id, channel id, status, created_at, updated_at, run_after, attempts, max_attempts, locked_by/locked_at, last_error, and whether run_after is currently runnable.
- Investigation linkage for each job when present: investigation id/state/deadline_at/current_step_id and exact step id/state/attempt_count/failure_class/lease_expires_at/recovery_generation.
- Most recent provider call telemetry for that job/channel where available: provider, operation, status, error_class, occurred_at, latency, actual/reserved cost.
- A derived, non-authoritative diagnosis label per job such as RUNNABLE_WAITING, PROVIDER_BACKOFF, ACTIVE_LEASE, OPERATIONAL_RETRY, INVESTIGATION_DEADLINE_RISK, or UNKNOWN, with the raw evidence retained.

Safety requirements:

1. SELECT-only production behavior. No UPDATE/INSERT/DELETE, no requeue, no pause/resume, no provider calls.
2. Reuse existing operator authentication boundary.
3. Hard limit response size; default 10 oldest, max 50.
4. Do not expose secrets, tokens, provider credentials, raw environment variables, or full payloads that may contain sensitive values. Return only channelId and explicitly whitelisted metadata.
5. Query should be bounded/index-friendly and avoid long locks.
6. Add focused tests that verify the diagnostic query/route is read-only and that classification of runnable vs deferred vs operational retry is based on persisted state only.
7. Do not alter YouTube.js, official YouTube quota policy, worker concurrency, retry timing, discovery, country policy, or trading thresholds.

Success criterion: after deployment we can answer from production evidence whether the ~500 ENRICH_CHANNEL backlog is draining, provider-backoff dominated, investigation/retry blocked, or actually unclaimed/stuck, before making any behavioral change.