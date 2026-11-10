# Phase 2 Option C — rendered admission governor

**Status:** Unit 2 implemented.
**Tracking:** #616.
**Program constraints:** no new infrastructure, no server upgrade, exactly one
browser slot, **40 rendered crawls/hour nominal**, **48/hour emergency**, **35%
DISCOVERY floor** whenever discovery work is queued.

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
- **Emergency:** 48/hour, used only when the nominal window is already full and
  another rendered request is queued. A solitary 41st request without queued
  demand is denied until a window slot frees.
- **Discovery floor:** while a DISCOVERY request is waiting, non-DISCOVERY
  admissions are denied whenever the projected rolling share would fall below
  35%. The floor is demand-aware: when no discovery request is waiting,
  non-discovery work may use the remaining budget. The report will still show
  the lower share in that case; the governor cannot manufacture discovery
  demand.
- **Priority:** when the floor is short and a discovery waiter exists, the gate
  selects the discovery waiter before FIFO non-discovery waiters.
- **Denial:** throws the existing `RENDERED_FALLBACK_SATURATED` capacity class.
  The retry policy already treats that class as attempt-free, and the inspector
  records `CAPACITY_DEFERRED`, never a genuine acquisition failure. Denials are
  logged as `rendered_admission_denied` at most once per minute.
- **Process scope:** the window is in-process. The production deployment is a
  single app container with one browser slot, so a restart resets the rolling
  window; no multi-replica guarantee is claimed.

## Lane wiring

The lane travels from the inspection attribution into every rendered fallback
call:

`inspectAndValidateChannel` → `runChannelInspection` →
`crawlRenderedCommunitySurface` → `RenderedFallbackGate.run`.

Messaging-preview, linked-website, and social-profile rendered calls all carry
`channelData.renderedAdmissionLane`. Direct callers without a lane default to
`UNKNOWN` at the gate; they still consume the budget but never satisfy the
discovery floor.

## Configuration

| Setting | Production | Local/CI |
|---|---:|---:|
| `RENDERED_ADMISSION_GOVERNOR_ENABLED` | `true` (Dockerfile) | `false` (`.env.example`) |
| `RENDERED_ADMISSION_NOMINAL_PER_HOUR` | `40` | `40` |
| `RENDERED_ADMISSION_EMERGENCY_PER_HOUR` | `48` | `48` |
| `RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT` | `35` | `35` |

The code-level enable fallback is `NODE_ENV=production`; an explicit
`true`/`false` wins. CI browser harnesses stay unthrottled, while the governor
class is exercised directly with an injected clock and gate.

## Verification

1. `node --import tsx --test server/renderedAdmissionGovernor.test.ts`
   — env bounds, 40/h cap, 48/h emergency, 35% reservation, window expiry,
   disabled behavior, and lane wiring.
2. `node --import tsx --test server/browserCommunityFallback.test.ts`
   — gate denial releases the slot, over-budget crawls surface as
   `RENDERED_FALLBACK_SATURATED`, and a discovery waiter is selected first.
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
