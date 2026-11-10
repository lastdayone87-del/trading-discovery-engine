# Phase 2 Option C — rendered admission governor

**Status:** Unit 2 implemented.
**Tracking:** #616.
**Program constraints:** no new infrastructure, no server upgrade, exactly one
browser slot, **40 rendered crawls/hour nominal**, **48/hour emergency**, **35%
DISCOVERY reserve**.

## Why this unit exists

Unit 1 showed the real single-slot baseline: ~11 rendered crawls/hour, gate
waits around 200 seconds, a 2,554-job retry backlog, and 0% discovery share in
the measured window. The browser lease had no admission budget: any number of
requests could queue, and nothing reserved capacity for discovery work.

## Policy

`server/renderedAdmissionGovernor.ts` runs in-process beside the existing
`RenderedFallbackGate` (one browser slot, no new worker).

- **Window:** rolling 60 minutes, not fixed UTC hours.
- **Nominal:** 40 rendered crawl admissions per rolling hour.
- **Emergency:** 48/hour when the nominal window is already full and demand is
  queued — either the request itself waited behind the active crawl, or another
  rendered request is already waiting. A solitary 41st request that never
  queued is denied until a window slot frees.
- **Strict DISCOVERY reserve:** non-DISCOVERY admissions are capped at
  `limit - ceil(limit * 35%)` (26 of 40, 31 of 48), even when no discovery
  request is currently queued. The reserve is not reassigned to non-discovery
  work. When a discovery waiter exists and the share is short, the gate selects
  it before FIFO non-discovery waiters.
- **Queue reserve:** when the non-discovery pending queue is full, a discovery
  request may still enter a small extra queue reserve (35% of the pending cap,
  at least one slot) so the floor can see the demand.
- **Denial:** reuses the existing `RENDERED_FALLBACK_SATURATED` capacity class.
  The retry policy already treats that class as attempt-free, and the inspector
  records `CAPACITY_DEFERRED`, never a genuine acquisition failure. Rate-limit
  and reserve denials carry the governor's `retryAt` hint when a capacity
  expiry exists; rendered observations persist it, so a durable retry can wait
  for the window to free a slot. A 100% reserve has no expiry hint.
- **Failed starts are refunded:** if the proxy/browser setup fails before
  navigation actually runs — no handler entry, page evidence, or request
  counter — the gate removes that admission from the window. A failed start
  cannot consume an hour of capacity or count toward the discovery floor.
  `HANDLER_ENTERED`/`PAGE_PROCESSED` counts as real work even when the counter
  snapshot is still zero.
- **Process scope:** the window is in-process. The production deployment is a
  single app container with one browser slot, so a restart resets the rolling
  window; no multi-replica guarantee is claimed.

## Lane wiring

The lane travels from the inspection attribution into every rendered fallback
call:

`inspectAndValidateChannel` → `runChannelInspection` →
`crawlRenderedCommunitySurface` → `RenderedFallbackGate.run`.

Messaging-preview, linked-website, and social-profile rendered calls all carry
`channelData.renderedAdmissionLane`. The deferred-discovery replay in
`ENRICH_CHANNEL` explicitly keeps `lane: 'DISCOVERY'`; it is discovery work even
though the durable job type is enrichment. Direct callers without a lane default
to `UNKNOWN`; they consume the budget but never satisfy the discovery reserve.

## Configuration

| Setting | Production | Local/CI |
|---|---:|---:|
| `RENDERED_ADMISSION_GOVERNOR_ENABLED` | `true` (Dockerfile) | `false` (`.env.example`) |
| `RENDERED_ADMISSION_NOMINAL_PER_HOUR` | `40` | `40` |
| `RENDERED_ADMISSION_EMERGENCY_PER_HOUR` | `48` | `48` |
| `RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT` | `35` | `35` |

The code-level enable fallback is `NODE_ENV=production`; an explicit
`true`/`false` wins. Node test processes are disabled unless explicitly
enabled. CI browser harnesses stay unthrottled, while the governor class and
gate are exercised directly with an injected clock and enabled governor.

## Verification

1. `node --import tsx --test server/renderedAdmissionGovernor.test.ts`
   — env bounds/blank overrides, 40/h cap, 48/h emergency with queued demand,
   strict 35% reserve, window expiry, refunds, disabled behavior, and lane
   wiring (including deferred discovery and observation retry hints).
2. `node --import tsx --test server/browserCommunityFallback.test.ts`
   — gate denial carries `retryAt`, a zero-work start is refunded, a full
   non-discovery queue still admits a discovery waiter, and discovery is
   selected first when the reserve is short.
3. `npx tsc --noEmit -p tsconfig.json`.
4. CI workflow `.github/workflows/phase2-crawl-throughput.yml` runs both suites
   plus the PostgreSQL report regression.
5. After deploy: confirm the four env values on the container, health
   200/ready, and the read-only report. A denial log
   (`rendered_admission_denied`) appears only when the cap/floor blocks work.

## Non-goals

- No crawl deadline/fairness change (Unit 3).
- No retry-backlog mutation (Unit 4).
- No new browser slot, worker pool, migration, or server upgrade.
