# Phase 2 Option C — bounded rendered-crawl deadline and fairness

**Status:** Unit 3 implemented.
**Tracking:** #616.
**Program constraints:** no new infrastructure, no server upgrade, exactly one
browser slot, 40 rendered crawls/hour nominal, 48 emergency, 35% DISCOVERY
reserve.

## Why this unit exists

The rendered crawl itself was already bounded to a **60-second total budget**,
but the wait for the single browser slot was not. Production showed:

- gate waits averaging **241s**, max **650s** in the measured 8-hour window;
- retry job attempts p50 **10–30 min**, p90 **30–51 min**;
- 122 heartbeat-expired attempts in 24h, all before the Unit 1/2 deploys
  (latest 13:30; none after).

A worker could therefore spend most of a job attempt waiting for a slot, even
though no crawl was running. That is the capacity-wait and long-attempt problem
this unit bounds.

## Policy

- **Per-crawl budget:** unchanged at 60s (`DEFAULT_BROWSER_FALLBACK_BUDGET.totalTimeoutMs`).
  The slot is held by one crawl for at most that budget plus bounded
  launch/cleanup work.
- **Bounded gate wait:** `RENDERED_FALLBACK_MAX_WAIT_MS`, default **90s**
  (clamped 1s..300s). A queued request that cannot acquire the slot in that
  time is removed from the queue and rejected as
  `RENDERED_FALLBACK_SATURATED`. This is the existing capacity class, so retry
  accounting stays attempt-free and the inspector records
  `CAPACITY_DEFERRED`, not a genuine acquisition failure. The error carries a
  `retryAt` hint for one wait window, so the durable retry does not immediately
  re-claim and time out again.
- **Active crawl is unaffected:** only waiters time out. The admitted crawl
  keeps its slot and per-crawl budget.
- **Fairness:** the queue remains FIFO with discovery priority only while the
  DISCOVERY share is below the 35% reserve. Unit 2's strict lane cap prevents
  non-DISCOVERY starvation; the wait bound prevents any waiter from being held
  indefinitely behind a busy slot.
- **Heartbeat:** the retry worker heartbeat remains every 60s and stale-lock
  recovery remains 15m. The bounded wait is an async promise, so it does not
  block the heartbeat; Unit 1's non-blocking telemetry write removed the
  observed DB stall that preceded the 13:30 failures. No stale-lock math is
  changed in this unit.
- **No retry-semantics change:** timeouts are capacity deferrals, not failures;
  the retry directive/backoff path is unchanged.

## Configuration

| Setting | Production | Local/CI |
|---|---:|---:|
| `RENDERED_FALLBACK_MAX_WAIT_MS` | `90000` (Dockerfile) | `90000` (`.env.example`) |
| Per-crawl total budget | `60000` (code default) | `60000` |

The wait bound is env-only and read when the gate is constructed. It is not a
new infrastructure or concurrency knob.

## Verification

1. `node --import tsx --test server/browserCommunityFallback.test.ts`
   — a blocked waiter times out as `RENDERED_FALLBACK_SATURATED`, is removed
   from the queue, and the next request is admitted after the active crawl
   releases; the active crawl itself is untouched.
2. `node --import tsx --test server/renderedAdmissionGovernor.test.ts`
   — the lane reserve, emergency, refunds, and retry hints remain intact.
3. `npx tsc --noEmit -p tsconfig.json`.
4. CI `.github/workflows/phase2-crawl-throughput.yml` runs the gate/governor
   assertions plus the PostgreSQL report regression.
5. After deploy: confirm `RENDERED_FALLBACK_MAX_WAIT_MS=90000`, health
   200/ready, and that post-deploy gate waits are at or below 90s. Re-check
   retry attempt p50/p90 and heartbeat-expired counts after a soak window.

## Non-goals

- No retry-backlog quarantine/triage (Unit 4).
- No new browser slot, worker pool, migration, or server upgrade.
- No change to the 60s per-crawl content budget or extraction behavior.
