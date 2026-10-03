# Benchmark-preregistration-v1 runbook

Authority: `docs/BENCHMARK_PREREGISTRATION.md` (frozen; do NOT edit it).
Implementation: `scripts/runBenchmarkPreregV1.ts` + `server/benchmarkPreregV1.ts`.

## Plan (safe; this is the only step performed during implementation)

```sh
npx tsx scripts/runBenchmarkPreregV1.ts --plan --out ./benchmark-prereg-v1
```

Read-only against the database plus two JSON files out. Fails closed when:
frozen versions drift, any benchmark gate is engaged, migrations are behind
137, the pool is empty, or a record already exists (pass `--force` to
re-plan before any observation). Schedules nothing; creates no observations.

## Execute (explicit review approval required; NOT run during implementation)

```sh
npx tsx scripts/runBenchmarkPreregV1.ts --execute --out ./benchmark-prereg-v1
```

Requires the `--plan` record. Re-verifies versions/gates/snapshot hash,
then schedules one designated attempt per pool row through the untouched
`runAutonomousDiscoveryCycle` path with the exact frozen configuration
(selection `benchmark-prereg-v1-selection` THOMPSON+CONTEXTUAL 5000 /
priors 1,1 / weights 0.5,0.35,0.1; ordering `benchmark-prereg-v1-ordering`
5000 with the stored-`scheduled_at` 90-day window). Stops at 300 covered,
14-day ceiling, quota exhaustion, kill switch, or infra incident. Never use
`fastBenchmark`, `evaluateBenchmark`, or semantic benchmark scripts here.

## Safeguards

- Stop the autonomous scheduler before `--execute` (concurrent producer
  cycles abort the run as an infra incident).
- Do not tune, enable gates, or edit the frozen spec; any change needs a
  new spec version, not an execution flag.
