# Benchmark-preregistration-v1 runbook

Authority: `docs/BENCHMARK_PREREGISTRATION.md` (frozen; do NOT edit it).
Implementation: `scripts/runBenchmarkPreregV1.ts` + `server/benchmarkPreregV1.ts`.

## Plan (safe; this is the only step performed during implementation)

```sh
npx tsx scripts/runBenchmarkPreregV1.ts --plan --out ./benchmark-prereg-v1
```

Read-only against the database plus two JSON files out. Fails closed when:
frozen versions drift, any benchmark gate is engaged, migrations are behind
137, the pool is empty or holds fewer than the frozen 300 eligible rows
(`BENCHMARK_PREREG_INSUFFICIENT_POOL` with deterministic exclusion counts),
or a record already exists (pass `--force` to re-plan before any
observation). Schedules nothing; creates no observations.

## Execute (explicit review approval required; NOT run during implementation)

```sh
npx tsx scripts/runBenchmarkPreregV1.ts --execute --out ./benchmark-prereg-v1
```

Requires the `--plan` record. Re-verifies versions/gates/snapshot hash,
then schedules one designated attempt per pool row through the
`runAutonomousDiscoveryCycle` path with the exact frozen configuration
(selection `benchmark-prereg-v1-selection` THOMPSON+CONTEXTUAL 5000 /
priors 1,1 / weights 0.5,0.35,0.1; ordering `benchmark-prereg-v1-ordering`
5000 with the stored-`scheduled_at` 90-day window). Two benchmark-scoped
enforcements are inert without a benchmark scope: research/frontier/native
allocations are declined for designated cycles, and every selection pool
narrows to the designated row — a benchmark attempt serves ONLY that row
or records a coded exclusion, never unrelated work. Each scheduled run is
awaited to terminal COMPLETED/FAILED *with* its accounting attribution row
before it counts; scheduling alone is never an observation. Every row ends
in one unambiguous terminal state (observed complete/failed, or a coded
exclusion: eligibility, capacity, selected-another, execution-failure); the
scope completes only when all 300 are terminally accounted. Stops at the
14-day ceiling (durable first-observation anchor, restart-safe), quota
exhaustion, kill switch, per-row configuration drift, or infra incident.
Resume is idempotent: ledger-matched runs are adopted, never rescheduled.
Never use `fastBenchmark`, `evaluateBenchmark`, or semantic benchmark
scripts here.

## Safeguards

- Stop the autonomous scheduler before `--execute` (concurrent producer
  cycles abort the run as an infra incident).
- Do not tune, enable gates, or edit the frozen spec; any change needs a
  new spec version, not an execution flag.
