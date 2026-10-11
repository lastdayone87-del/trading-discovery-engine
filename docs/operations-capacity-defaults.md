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

Rule (enforced, not just documented): **no benchmark plan may be created
and no benchmark may execute unless queue depth 30 is established.**
`server/benchmarkCapacityGuard.ts` (non-frozen) fails closed with
`BENCHMARK_QUEUE_DEPTH_UNESTABLISHED`:
- `--plan`: `assertBenchmarkQueueDepthEstablished(settings, env, 'plan')`
  runs right after the gate checks, before any snapshot query or file write —
  the frozen resolution must evidence exactly 30 (which, given the frozen
  `'15'` fallback, proves an explicit database/environment value).
- `--execute`: the live environment is re-checked AND the plan file's own
  `plannedKnobs` must record `'30'`
  (`assertBenchmarkPlannedQueueDepth`) — a pre-guard plan with a
  fallback-governed 15 can never execute. Both checks run before the record
  mutates to `IN_PROGRESS`.
Fallback-derived benchmark records must not be compared against the
30-runtime. This invariant is pinned by test
(`server/benchmarkCapacityGuard.test.ts`, plus the divergence pin in
`server/searchCapacityDefaults.test.ts`).

Time-of-check/time-of-use closure: the execute path captures the validated
numeric depth once (`benchmarkValidatedQueueDepth`) and pins it into every
discovery cycle (`pinnedTargetQueueDepth`, applied by
`resolveCycleTargetQueueDepth` inside `runAutonomousDiscoveryCycle`). Each
cycle still reads the live setting via `getDiscoveryConfig()`, but the pinned
depth overrides the live-resolved value for benchmark capacity calculation
(the pin itself is validated as an integer in 1..500), so a database change
after validation cannot divert the run while the record stays valid. Without
a pin (all existing production callers), live resolution flows through
unchanged.

## Benchmark execution serialization

Concurrent `--execute` runs against one output directory are mutually
excluded by `server/benchmarkExecutionLock.ts`: the runner claims
`execution-record.execute.lock` atomically (link(2)) after read-only
preflight and before the `IN_PROGRESS` mutation, and every schedule happens
only while holding it. A refused contender throws
`BENCHMARK_EXECUTION_LOCK_HELD` with no scheduling or record mutation. The
lock releases on completion and handled failures (release verifies the owner
token, so cleanup can never remove another process's lock); a crashed
holder's stale lock is taken over only after its owner is proven dead —
never by age — through a phased inspect-then-commit protocol
(`inspectStaleLock` pins the exact instance by hard-link inode identity plus
token; `commit` re-verifies path identity, token, and dead owner immediately
before removing the shared name and refuses on any change), so a recovery
paused across another process's completed takeover can never delete the new
live lock. Only `ENOENT` (vanished path) rejoins the retry flow; permission,
I/O, and unexpected filesystem failures propagate instead of masquerading
as contention. Owner identity combines pid liveness with the recorded
command line, so a pid recycled into an unrelated process reads as stale
rather than blocking recovery forever (pre-marker files and unreadable
command lines keep the conservative pid-only verdict). Holders
re-verify ownership before every mutation and schedule, so even a residual
takeover race resolves with exactly one proceeding executor. After acquiring
the lock the runner reloads the record and snapshot from disk and
revalidates them, so a delayed process never overwrites a completed record
with stale data. Cross-process proof (separate OS processes sequenced over
IPC, plus an N-way claim barrier) lives in
`server/benchmarkExecutionLock.process.test.ts`. An interrupted
`IN_PROGRESS` run stays resumable and is never permanently blocked.

Copies of one plan running from different output directories on the same
host serialize on a snapshot-keyed global lock
(`acquirePlanExecutionLock`, same atomic protocol): the second executor
fails closed instead of racing the ledger read-to-schedule window. A second
executor that does observe the first executor's ledger runs adopts them
(`planRowAttempt` → `adopt-recovered`) rather than duplicating work. Copies
on different hosts are not prevented (same-host lock scope) — their shared
ledger still converges through adoption, but duplicate provider spend is
possible there; do not run copies of one plan on multiple hosts concurrently.
`--plan --force` refuses while a live execution holds the directory lock, so
planning can never replace artifacts an executor is using.

## Post-deploy verification (read-only)
- `docker inspect <app-container> --format '{{json .Config.Env}}'` shows
  `SEARCH_WORKER_CONCURRENCY=4`, unless an explicit runtime override sets a
  different value — in that case `.Config.Env` shows the overridden value,
  which wins by design.
- Read-only database `SELECT setting_value FROM app_settings WHERE
  setting_key='discovery_target_queue_depth'` still returns `30`.
