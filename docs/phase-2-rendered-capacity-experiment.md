# Rendered-Browser Capacity Experiment (Fix B)

**Status: IN PROGRESS (E1 running)**
Owner: muse audit session · Host: Coolify VPS `45.94.58.135` (4 cores / 8GB)

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
inside the container, and is observed for ≥60 min through a fixed
sampling monitor (`/root/fixb_monitor.sh` on the VPS, JSONL at
`/root/fixb_monitor.jsonl`, 120s cadence):

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

1. Two concurrent Chromiums are resource-safe on this VPS. CPU bursts
   reach ~4–5 cores briefly; load stays ≤10 sustained; memory headroom is
   massive. `BROWSER_RUNTIME_CONCURRENCY=2` is validated.
2. **The governor became the binding bottleneck immediately.** With two
   slots, the rendered tier consumed its entire rolling-window budget in
   ~25 minutes (26 admissions) and then denied every retry-lane request
   until the window freed (`retryAt` up to 60 min out). Non-discovery
   lanes cap at 65% × 40 = 26/h — the DISCOVERY_FLOOR makes the nominal
   40/h effectively 26/h for retries.
3. Per-run duration with two slots is roughly comparable to single-slot
   (~90–115s incl. launch overhead), so the two-slot lease sustains
   ~60–80 crawls/hour — the E2 governor raise (64/72) is sized to sit
   just under lease capacity.

## E2 — governor raise 64/72 with lease=2 — RUNNING

Config verified in container `…20261120T212037`:
`BROWSER_RUNTIME_CONCURRENCY=2`,
`RENDERED_ADMISSION_NOMINAL_PER_HOUR=64`,
`RENDERED_ADMISSION_EMERGENCY_PER_HOUR=72`. Window 21:26–22:30Z.

Purpose: prove the raised budget drains the retry queue faster without
resource distress, and observe whether the lease (not the governor) is
now the first bottleneck. Results: (pending)

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
* Rollback: remove the Coolify env row (or set `=1`) and redeploy.
