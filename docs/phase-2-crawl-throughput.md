# Phase 2 Option C — crawl throughput telemetry

**Status:** Unit 1 implemented (telemetry activation, rendered-crawl counting,
read-only report, tests).
**Tracking:** #616.
**Program constraints:** no new infrastructure, no server upgrade, exactly one
browser slot, **40 browser crawls/hour nominal**, **48 browser crawls/hour
emergency**, **35% DISCOVERY floor**.

## Why this unit exists

The Phase 2 baseline was collected read-only on 2026-11-10:

- `RETRY_COMMUNITY_ACQUISITION`: 2,554 pending; 1,990 older than 7 days.
- Retry attempts: ~15/hour; completions: 71 in 7 days (~0.4/hour).
- 25% of retry attempts failed `BROWSER_GATE_SATURATION`.
- Attempt duration p50 7.1 min, p90 37 min.
- `acquisition_lane_events` was empty. The writer already existed in
  `server/acquisitionLaneTelemetry.ts` and was wired inside
  `inspectAndValidateChannel`, but `ACQUISITION_LANE_TELEMETRY_ENABLED` was
  unset, so every durable write was skipped.

Without a durable baseline there is no trustworthy way to enforce a crawls/hour
ceiling or a discovery floor. Unit 1 therefore activates the existing
append-only writer, records how many actual rendered seed crawls each
inspection pass performed, and adds the report. It does **not** change
admission, retry, ordering, or browser concurrency.

## Metric definitions

Source: `acquisition_lane_events`, one row per inspection pass.

- **Browser crawl**: a unique, non-empty seed URL whose observation carries
  `telemetry.mode = 'RENDERED'` **and positive crawl evidence** (pages
  inspected, requests started/finished, or clicks succeeded). It is written to
  the row's `detail.renderedCrawls` count. A pass can contain several rendered
  seeds, and each one consumes the single browser slot. Static HTTP
  observations (`mode = 'STATIC'`), no-work outcomes, gate refusals/launch
  failures with zero evidence, URL-less observations, and shared-evidence rows
  (no refetch) are not browser crawls.
- **Inspection pass**: one lane-event row. Outcome counts (`completedPasses`,
  `failedPasses`, `deferredPasses`, etc.) are per pass, not per browser crawl.
- **All lanes count toward the browser ceiling**, including `MAINTENANCE`
  (false-negative and country-boundary recovery can invoke the rendered
  fallback) and `UNKNOWN`. They are also reported separately as
  `maintenanceBrowserCrawls` and `unknownBrowserCrawls`, so browser work cannot
  hide behind a lane label.
- **Per-lane totals**: `lanes` reports inspection passes and browser crawls for
  `DISCOVERY`, `ENRICHMENT`, `RETRY`, `MANUAL`, `MAINTENANCE`, and `UNKNOWN`,
  so non-zero work in each lane is directly verifiable.
- **Completed pass**: `ACQUIRED`, `INSPECTED_NO_MATCH`, `PARTIALLY_INSPECTED`,
  or `EXTERNALLY_BLOCKED`.
- **Browser crawls/hour**: rendered browser crawls divided by elapsed wall time
  in the window. The current UTC hour is partial, so the denominator uses real
  elapsed time instead of assuming a full hour.
- **Peak browser crawls/hour**: the largest rendered crawl count in any single
  UTC hour bucket. This is the emergency-ceiling signal.
- **DISCOVERY share**: DISCOVERY rendered crawls divided by all rendered
  crawls. Maintenance and unknown browser work stay in the denominator.
- **Unmetered pass**: a row without a trustworthy `detail.renderedCrawls`
  (for example, a row written before this unit). It is reported as a warning
  and contributes zero browser crawls rather than being guessed.

## Gates

| Gate | Value | Failure code |
|---|---:|---|
| Nominal browser crawls/hour | 40 | `browser_crawls_per_hour_below_nominal_target` |
| Emergency ceiling | 48 in any hour | `peak_browser_crawls_per_hour_above_emergency_ceiling` |
| DISCOVERY floor | 35% | `discovery_share_below_floor` |
| No browser data | — | `no_browser_crawl_data` |

`--check` exits non-zero when any failure code is present. Use it for the
post-soak gate, not for the first minutes after a deploy; a fresh window
legitimately reports `no_browser_crawl_data` until the first rendered crawl
with positive work evidence is recorded.

## Running the report

```bash
npm run phase2:crawl-throughput -- --window-hours=24
npm run phase2:crawl-throughput -- --window-hours=24 --check
npm run phase2:crawl-throughput -- --window-hours=6 --out=phase2-report.json
```

The CLI uses `createReadOnlyDbPool()`, one `REPEATABLE READ READ ONLY`
transaction, and never writes.

## Production activation

The production image bakes:

```text
ACQUISITION_LANE_TELEMETRY_ENABLED=true
```

The writer updates process-local counters and appends one row per inspection.
A write failure is logged as `acquisition_lane_event_write_failed` and cannot
change the acquisition result. The code-level fallback and `.env.example`
remain `false`, so tests and local runs are unaffected unless the flag is
explicitly set. The write is observational and is not awaited on the
acquisition result path.

## Verification

1. `node --import tsx --test server/crawlThroughputReport.test.ts`
2. `node --import tsx --test server/crawlThroughputReport.postgres.test.ts`
   with `PHASE2_CRAWL_REPORT_TEST_DATABASE_URL` pointing at a migrated scratch
   database. The regression writes through the production writer inside a
   transaction and rolls every fixture back; it does not delete from the
   append-only table.
3. `npx tsc --noEmit -p tsconfig.json`
4. CI: `.github/workflows/phase2-crawl-throughput.yml` runs the migrations,
   static assertions, and PostgreSQL regression on a disposable database.
5. After deploy, confirm the env flag on the app container and run the report
   against production read-only. Expect `no_browser_crawl_data` only until the
   first rendered inspections land, then non-zero per-lane counts.
6. Unit 2 may not rely on the report until at least one full UTC hour of
   rendered events is present.

## Known boundary

One lane event summarizes an inspection pass; `detail.renderedCrawls` records
how many rendered seed crawls it contained. The report therefore measures
**actual rendered seed crawls**, not static HTTP fetches or individual pages
inside one browser run. Unit 2's admission governor will meter the gate
admission itself, so the two measurements can be cross-checked.

## Non-goals

- No admission governor yet (Unit 2).
- No crawl deadline/fairness change yet (Unit 3).
- No retry-backlog mutation (Unit 4).
- No new browser slot, worker pool, migration, or server upgrade.
