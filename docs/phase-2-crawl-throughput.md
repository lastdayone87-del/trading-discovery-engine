# Phase 2 Option C — crawl throughput telemetry

**Status:** Unit 1 implemented (telemetry activation, read-only report, tests).
**Tracking:** #616.
**Program constraints:** no new infrastructure, no server upgrade, exactly one
browser slot, **40 crawls/hour nominal**, **48 crawls/hour emergency**, **35%
DISCOVERY floor**.

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
append-only writer and adds the report; it does **not** change admission,
retry, ordering, or browser concurrency.

## Metric definitions

Source: `acquisition_lane_events`, one row per completed inspection pass.

- **Capacity lane**: `DISCOVERY`, `ENRICHMENT`, `RETRY`, or `MANUAL`.
  `MAINTENANCE` and `UNKNOWN` are reported but excluded from the browser-slot
  denominator because maintenance jobs are DB-local.
- **Crawl attempt**: a lane event whose outcome proves a crawl started. Events
  with `NEVER_EXECUTED`, `CAPACITY_DEFERRED`, or `RUNTIME_UNAVAILABLE` are not
  crawls. `ACQUISITION_FAILED` and `INCONCLUSIVE` events still consumed slot
  time and do count.
- **Completed**: `ACQUIRED`, `INSPECTED_NO_MATCH`, `PARTIALLY_INSPECTED`, or
  `EXTERNALLY_BLOCKED`.
- **Crawls/hour**: capacity crawl attempts divided by elapsed wall time in the
  window. The current UTC hour is partial, so the denominator uses real elapsed
  time instead of assuming a full hour.
- **Peak crawls/hour**: the largest capacity crawl count in any single UTC hour
  bucket. This is the emergency-ceiling signal.
- **DISCOVERY share**: DISCOVERY crawl attempts divided by all capacity crawl
  attempts. `MAINTENANCE` never dilutes the denominator.

## Gates

| Gate | Value | Failure code |
|---|---:|---|
| Nominal crawls/hour | 40 | `crawls_per_hour_below_nominal_target` |
| Emergency ceiling | 48 in any hour | `peak_crawls_per_hour_above_emergency_ceiling` |
| DISCOVERY floor | 35% | `discovery_share_below_floor` |
| No capacity data | — | `no_capacity_crawl_data` |

`--check` exits non-zero when any failure code is present. Use it for the
post-soak gate, not for the first minutes after a deploy; a fresh window
legitimately reports `no_capacity_crawl_data` until inspections complete.

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
change the acquisition result. The code-level fallback remains `false`, so
tests and local runs are unaffected unless the flag is explicitly set.

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
   against production read-only. Expect `no_capacity_crawl_data` only until the
   first inspections land, then non-zero per-lane counts.
6. Unit 2 may not rely on the report until at least one full UTC hour of
   events is present.

## Non-goals

- No admission governor yet (Unit 2).
- No crawl deadline/fairness change yet (Unit 3).
- No retry-backlog mutation (Unit 4).
- No new browser slot, worker pool, migration, or server upgrade.
