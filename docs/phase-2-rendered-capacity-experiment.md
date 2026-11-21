# Rendered-Browser Capacity Experiment (Fix B)

**Status: COMPLETE — validated config deployed to production; the guarded
two-slot image is in review (PR #673) and not yet the deployed artifact**

Investigated on the Coolify production VPS (4 cores / 8GB RAM). Host-level
details (IP, paths) live in the internal runbook; this document contains no
infrastructure identifiers.

## Why

Production telemetry (Nov 2026) shows the rendered-browser tier is
capacity-starved: `RENDERED_FALLBACK_SATURATED` is the #1 failure class
(48,772 observations / 2,726 channels in 3 days), and 94.5% of channels
processed on Nov 20 hit the saturated admission/launch gate. Rendered
success currently touches only 0–16 channels/hour against 94–524
channels inspected/hour. The admission governor admits 40/h nominal
(48/h emergency); the process-wide browser lease runs ONE Chromium
(`BROWSER_RUNTIME_CONCURRENCY` unset).

## Method

Controlled production experiment on the live Coolify deployment. Each
step changes ONE variable via Coolify env (runtime-only), verified
inside the container, and is observed for a fixed window through a
sampling monitor (read-only `docker stats` + SELECT-only SQL, JSONL
log, 120s cadence). The baseline window was shorter than the
experiment windows (~24 min of samples plus a 24-hour hourly trail
analysis) — noted so the baseline's confidence is not overstated.

* container CPU% / mem usage (`docker stats`)
* host load1 + MemAvailable (the resource-safety inputs)
* 5-minute window: observation count, `RENDERED_FALLBACK_SATURATED`
  count, `HTTP_ERROR` count, distinct channels
* queue cohorts: RETRY_PENDING / NOT_STARTED(UNCERTAIN) / PENDING(scan)

Stage markers are appended to the JSONL (`BASELINE_START`,
`E1_START`, …) so every sample is attributable to exactly one config.

## Baseline (image defaults: lease=1, governor 40/48, floor 35%, wait 90s)

Sampled 19:21–19:45Z Nov 20 (monitor restart gap 19:38–19:40 noted).

| Metric | Range over samples |
|---|---|
| Container CPU | 54% – 407% (bursty; peaks hit all 4 cores) |
| Container memory | 1.63 – 1.84 GiB |
| Host load1 | 0.7 – 17.7 (one extreme spike; mostly 3–8) |
| Host MemAvailable | 5.3 – 5.4 GB |
| Saturation share of observations | 17% – 29% per 5-min window |
| Channels in 5-min window | 7 – 23 |

Hourly trail analysis (24h): rendered-tier success retained candidates
for 0–16 channels/hour; saturation hit 60–80% of inspected channels
during daytime hours. Post-deploy window Nov 19 20:00–23:00 with a fresh
governor budget and lower demand showed near-zero saturation — demand
growth from 08:00 Nov 20 re-saturated it, confirming the 40/h budget as
the binding constraint under current load.

## E1 — browser lease concurrency 2 (governor unchanged 40/48) — COMPLETE

Config verified in container `…20261120T202130`:
`BROWSER_RUNTIME_CONCURRENCY=2`, `RENDERED_ADMISSION_NOMINAL_PER_HOUR=40`.
Window 20:26–21:26Z (acquisition lane resumed ~20:54 after the deploy's
search-phase warm-up).

| Metric | E1 observed |
|---|---|
| Container CPU | 126% – 511% bursts (vs 54–407% baseline) |
| Container memory | 0.58 – 1.3 GiB (fresh process; below the 24h-old baseline's 1.6–1.8) |
| Host load1 | 0.9 – 9.2 sustained; single post-deploy spikes 15–17 |
| Host MemAvailable | 5.0 – 5.7 GB (resource guard threshold 1500MB is comfortable) |
| Saturation share | 20% – 29% of observations — unchanged from baseline (expected: governor still 40/h) |
| Governor denials | 21 logged in the hour, all RETRY lane, `reason=DISCOVERY_FLOOR` |

**E1 findings:**

1. Two concurrent Chromium slots fit the host's memory comfortably and
   the load stayed workable (≤9.2 sustained), but CPU oversubscription
   is real: bursts reached ~4–5 cores on a 4-core VPS with brief load
   spikes to 15–17. The config is acceptable at the measured load; the
   CPU risk is named here — more slots or heavier pages need CPU
   evidence before raising further.
2. **The governor's discovery floor was the binding constraint.** With
   two slots, the retry lane's non-discovery cap (65% × 40 = 26/h —
   a lane-level allocation, not the full budget) was hit within ~25
   minutes (21 `DISCOVERY_FLOOR` denials) while discovery demand sat
   near zero in that window. See the DISCOVERY_FLOOR section below for
   the demand data and the policy adjustment this motivated.
3. Per-run duration with two slots is roughly comparable to single-slot
   (~90–115s incl. launch overhead). **Important caveat discovered in
   review:** the rendered-crawl gate (`renderedFallbackGate`) still
   defaulted to ONE active crawl during E1/E2, so the two browser slots
   were never actually exercised in overlap — the measured rates are
   gate-serialized one-at-a-time rates. The gate now derives its
   concurrency from the lease slot budget (this PR), and the sustained
   two-slot rate is pending post-merge measurement.

## E2 — governor raise 64/72 with lease=2 — COMPLETE

Config verified in container `…20261120T212037`:
`BROWSER_RUNTIME_CONCURRENCY=2`,
`RENDERED_ADMISSION_NOMINAL_PER_HOUR=64`,
`RENDERED_ADMISSION_EMERGENCY_PER_HOUR=72`. Window 21:26–22:30Z.

| Metric | E2 observed |
|---|---|
| Completed rendered crawls | 44 in ~64 min (~41–62/h across phases; E1 burst measured 62/h) |
| Governor denials | 17 (all RETRY lane, `reason=DISCOVERY_FLOOR`) |
| Container CPU | 25% – 447% bursts |
| Host load1 | 0.8 – 15.7 (post-deploy spikes; ≤10 sustained) |
| Container memory | 0.6 – 0.9 GiB |
| Host MemAvailable | 5.4 – 5.7 GB |

**E2 findings:**

1. The raised budget served more rendered work (44 completed crawls in
   one window vs the old 40/h nominal budget — 48/h with the emergency
   allowance) with no resource distress: container memory stayed under
   0.9GiB (whole-container `docker stats` reading, not a per-browser
   footprint measurement), host headroom above 5.4GB. The memory guard
   was NOT deployed during E1/E2 (it ships in this PR), so the guard
   threshold remains to be exercised in production.
2. The remaining retry-lane constraint was the **DISCOVERY_FLOOR
   policy** (non-discovery admissions capped at 65% of the budget even
   with no discovery demand queued — 41/h at nominal 64). The demand
   evidence and the demand-aware reserve adjustment are in the
   DISCOVERY_FLOOR section below.
3. Observability note: `RENDERED_FALLBACK_SATURATED` observations also
   cover the separate classification-rendered lane
   (`CLASSIFICATION_RENDERED_FALLBACK_MAX_WAIT_MS=5000`), which has its
   own 5s gate outside the governor. Its saturation is out of scope for
   this experiment's knobs and is flagged for future measurement.

## E3 — post-merge production validation (merged image, all fixes live)

Deployed via the PR #673 merge, container started 00:00Z Nov 21. Config
verified in-container: `BROWSER_RUNTIME_CONCURRENCY=2`, governor
`64/72`, gate concurrency derived from the lease (2), demand-aware
discovery floor, budget clock at lease grant, cgroup-aware memory guard.

| Metric | E3 first ~50 min |
|---|---|
| Completed rendered crawls | **62** (~74/h instantaneous — two-slot overlap working; E2's full window was 44) |
| Governor denials | **0** |
| Container CPU | 143% – 566% bursts |
| Host load1 | 1.3 – 5.5 |
| Container memory | 0.8 – 1.15 GiB |
| Host MemAvailable | 5.2 – 5.4 GB (guard threshold 1500MB comfortably satisfied) |

Interpretation: with the gate coupled to the lease and the budget clock
fixed, the second slot is actually usable and the retry lane runs
unthrottled while discovery is idle — the E2 waste pattern is gone. The
observation window continues; cohort drain (RETRY_PENDING) is the
multi-day signal to watch in the weekly regression queries above.

## Validated permanent configuration

| Knob | Old | New | Evidence |
|---|---|---|---|
| `BROWSER_RUNTIME_CONCURRENCY` | 1 (unset) | **2** | E1: two slots memory-safe; CPU bursts ≤4–5 cores with load spikes to 15–17 named as the open risk; ≥5GB memory headroom |
| `RENDERED_ADMISSION_NOMINAL_PER_HOUR` | 40 | **64** | E1: retry lane hit its 26/h floor cap in 25 min at 40; E2: 64/h budget served 44 crawls/window with headroom left |
| `RENDERED_ADMISSION_EMERGENCY_PER_HOUR` | 48 | **72** | Stays above nominal, within the two-slot design capacity (sustained two-slot rate pending post-merge measurement) |
| `RENDERED_FALLBACK_CONCURRENCY` | 1 | **derived from the lease** (2) | Review finding: the gate serialized rendered crawls during E1/E2; the gate now follows the lease slot budget so the slots are actually usable |
| `BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB` | — (new) | **1500** (code default) | Container memory ≤0.9GiB during E2 (not a per-browser measurement); 1500MB reserve is conservative and untested in production |
| `MAX_BROWSER_RUNTIME_CONCURRENCY` (code cap) | 2 | 2 (unchanged) | 4-core VPS: CPU bursts already reach all cores; more slots need CPU evidence |
| `RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT` | 35 (strict) | **35 (demand-aware)** | 7-day demand: RETRY 73% / DISCOVERY 27%; strict reserve idled 22 slots in E2's window while retries were denied — reserve now binds only while discovery demand is pending |

The resource-safety guard (earlier commit) keeps the second slot
closed whenever memory headroom — host and, when configured, cgroup —
drops below the threshold, so the raised defaults cannot overwhelm a
smaller host. It is risk reduction, not a hard guarantee: unreadable
host telemetry fails open to the configured limit. The experiments ran
WITHOUT the guard deployed (it ships in this PR), so the guarded
configuration is untested in production until post-merge monitoring.

## Backfill plan (post-capacity)

The "leaked" NOT_FOUND cohort (192 channels) was investigated and is
**by-design dedup**: every detected invite there is registry-owned by a
different, healthy channel (53 ACTIVE + 10 UNCERTAIN owners); the
canonical persist→claim→discard path retained each channel's trail.
Re-persisting them would be instantly discarded again — **no backfill
for that cohort**.

The capacity-starved cohorts are the real backlog and drain naturally
once rendered throughput rises:

1. `RETRY_PENDING` (~5,451): attempt-free saturation retries already
   own this work; raised admission capacity increases drain rate.
   No manual enqueue needed. Watch: cohort size ↓ and
   `discord_validation_status` transitions to COMPLETED.
2. `NOT_STARTED(UNCERTAIN)` (~13,548): processed by the search/discovery
   lane; unaffected by rendered capacity except through overall
   pipeline speed. Watch: cohort size ↓ per day.
3. `PENDING(scan)` (878): includes hard-stuck channels (oldest ~48d).
   After E2, sample the still-stuck subset (>14d stale) and inspect
   individually — if they remain, that is a separate triage.

Regression queries (run weekly):

```sql
-- Cohort sizes
SELECT count(*) FILTER (WHERE discord_validation_status='RETRY_PENDING') AS retry_pending,
       count(*) FILTER (WHERE discord_validation_status='NOT_STARTED' AND discord_status='UNCERTAIN') AS not_started_unc,
       count(*) FILTER (WHERE scan_status='PENDING') AS pending_scan
FROM channels;

-- Stuck >14 days inside RETRY_PENDING
SELECT count(*) FROM channels
WHERE discord_validation_status='RETRY_PENDING' AND updated_at < now() - interval '14 days';

-- Daily saturation share (the E-metric)
SELECT date_trunc('day',observed_at)::date AS d,
       round(100.0*count(*) FILTER (WHERE failure_class='RENDERED_FALLBACK_SATURATED')/greatest(count(*),1),1) AS sat_pct
FROM external_acquisition_observations
WHERE observed_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1;
```

## Safety

* Monitor is read-only (`docker stats`, SELECT-only SQL).
* Resource-safety guard (already merged to the working branch, not yet
  deployed): slot >1 requires host MemAvailable ≥
  `BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB` (default 1500MB); degraded host
  falls back to single-slot; unreadable telemetry fails open.
* Rollback: removing the Coolify env rows does NOT restore the old
  behavior — the image bakes the new defaults. Use the explicit
  overrides or previous image described in the Rollback section below.

## DISCOVERY_FLOOR: what the denials were and the policy adjustment

During E2, 17 retry-lane rendered requests were denied with
`reason=DISCOVERY_FLOOR` while capacity sat idle. The mechanism (verified
in code): with the floor at 35%, non-discovery admissions were capped at
`limit − ceil(limit × 0.35)` — 26/h at the old nominal 40, 41/h at 64 —
**even when no discovery request was queued**, so the reserved share sat
idle while retry work was denied until the rolling window freed.

Production demand over the 7 days around the experiment (from
`acquisition_lane_events`, per inspection pass):

| Lane | Rendered crawls | Share |
|---|---|---|
| RETRY | 4,574 | 71.3% |
| DISCOVERY | 1,679 | 26.2% |
| ENRICHMENT | 157 | 2.4% |

(Shares of the 6,410 total rendered crawls in the window.)

Daily discovery share ran 23–31% (Nov 20: 15.2%) — consistently below
the 35% floor target, because the total budget was the binding
constraint, not lane allocation. So the strict reserve both (a) wasted
idle capacity in retry-heavy windows and (b) did not actually deliver a
35% discovery share under the old budget.

**Policy adjustment (this PR)**: the reserve is now demand-aware — the
admit path reuses the same predicate the gate already used for waiter
selection (`shouldReserveDiscoveryAt`): the strict cap binds only while
discovery demand is pending and its projected share is below the floor.
When nothing discovery-bearing is queued, the full budget serves the
queued demand. When discovery arrives, it keeps queue priority and the
cap returns, so a retry flood cannot starve it. Discovery's worst case
under the new policy is "shares the rolling budget FIFO with retries
when it arrives late", with the `crawlThroughputReport` discovery-share
gate continuing to surface any sustained shortfall.

## Rollback

Rolling back is **not** "remove the Coolify env row": after this change
the image itself bakes `BROWSER_RUNTIME_CONCURRENCY=2` and the 64/72
governor defaults, so deleting the experiment rows restores the *image
defaults*, which are the new configuration. To return to the old
behavior, either deploy the previous image or set explicit overrides in
Coolify env (encrypted values, runtime scope):

```
BROWSER_RUNTIME_CONCURRENCY=1
RENDERED_ADMISSION_NOMINAL_PER_HOUR=40
RENDERED_ADMISSION_EMERGENCY_PER_HOUR=48
RENDERED_FALLBACK_CONCURRENCY=1   # only needed if the gate-coupling change is already deployed
```

The resource-safety guard cannot be env-disabled, but it only ever
narrows the effective slot count, so `BROWSER_RUNTIME_CONCURRENCY=1`
fully restores single-slot behavior.
