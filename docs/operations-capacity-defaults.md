# Operations capacity defaults (current-facing)

This document records the **current** production capacity defaults. It is a
living operations note — update it when the defaults change. Do not confuse it
with `docs/production-readiness-report.md`, which is a historical snapshot
dated 2026-07-29 and must keep its original values.

## Current defaults

| Setting | Default | Defined in | Precedence |
|---|---|---|---|
| `SEARCH_WORKER_CONCURRENCY` | `4` | `Dockerfile` (`ENV`), `server/queueManager.ts` (`SEARCH_WORKER_CONCURRENCY_DEFAULT` + `resolveSearchWorkerCount`), `.env.example` | Explicit runtime env wins; otherwise the baked default applies. There is **no** database override for this knob (env-only, read once at startup). |
| `discovery_target_queue_depth` / `DISCOVERY_TARGET_QUEUE_DEPTH` | `30` | `server/autonomousDiscovery.ts` (`DISCOVERY_TARGET_QUEUE_DEPTH_DEFAULT` + `resolveDiscoveryTargetQueueDepth`), `.env.example` | Database `app_settings` first, environment second, code fallback last, clamped to [1, 500]. Production holds an explicit database value of `30`, which keeps winning over the fallback. |

Basis: previously authorized production capacity change (October 2026);
`SEARCH_WORKER_CONCURRENCY=4` restores that change in code after it was lost
by a container recreate, and depth `30` matches the standing production
database value (verified read-only).

## Frozen benchmark divergence (must-read before any benchmark work)

`server/benchmarkPreregV1.ts` is **frozen** and pins
`discovery_target_queue_depth` fallback `'15'` in
`BENCHMARK_PREREG_DRIFT_KNOBS`. The runtime fallback is now `30`. Do not edit
the frozen file to "fix" the divergence.

Implications:

- Drift detection (`effectiveBenchmarkKnobs` vs `detectConfigurationDrift`)
  resolves plan-time and execute-time knobs through the **same frozen table**,
  so it cannot detect a runtime-code fallback change: on an environment with
  no explicit database/environment value, a benchmark record would show `15`
  while the live runtime actually operates at `30` — a silent
  misrepresentation of effective configuration.
- The completed V1/V2 benchmark records are terminal and unaffected (they
  recorded explicitly resolved values, and production carries an explicit
  database `30`, so plan and execute agreed).

Rule: **any benchmark environment must carry an explicit
`discovery_target_queue_depth` database or environment value of `30`
(matching production) so the frozen fallback never governs a record.**
Fallback-derived benchmark records must not be compared against the
30-runtime. This invariant is pinned by test
(`server/searchCapacityDefaults.test.ts`: frozen fallback stays `'15'`,
runtime default stays `30`, explicit `30` resolves through
`effectiveBenchmarkKnobs`).

## Post-deploy verification (read-only)

- `docker inspect <app-container> --format '{{json .Config.Env}}'` shows
  `SEARCH_WORKER_CONCURRENCY=4` (absent only if an explicit runtime value
  overrides it, which still wins by design).
- Read-only database `SELECT setting_value FROM app_settings WHERE
  setting_key='discovery_target_queue_depth'` still returns `30`.
