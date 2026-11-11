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
| `ACQUISITION_LANE_TELEMETRY_ENABLED` | `true` in the production image; code fallback `false` | `Dockerfile` (`ENV`), `.env.example`, `server/acquisitionLaneTelemetry.ts` | Environment only, read per inspection. Enables the append-only `acquisition_lane_events` baseline used by the Phase 2 40/48 rendered-browser-crawls-per-hour and 35% discovery-floor report. A write failure is observational and never changes an acquisition result; the write is not awaited on the acquisition path. |
| `RENDERED_ADMISSION_GOVERNOR_ENABLED` | `true` in the production image; code fallback: only when `NODE_ENV=production` | `Dockerfile` (`ENV`), `.env.example`, `server/renderedAdmissionGovernor.ts` | Environment only, read at process start. Enforces the single browser-slot admission budget. Local/CI harnesses stay unthrottled unless explicitly enabled. |
| `RENDERED_ADMISSION_NOMINAL_PER_HOUR` | `40` | `server/renderedAdmissionGovernor.ts`, `.env.example` | Rolling 60-minute rendered-crawl admissions; clamped to [1, 1000]. |
| `RENDERED_ADMISSION_EMERGENCY_PER_HOUR` | `48` | `server/renderedAdmissionGovernor.ts`, `.env.example` | Emergency allowance used only when the nominal window is full and another rendered request is queued; clamped to [nominal, 1000]. |
| `RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT` | `35` | `server/renderedAdmissionGovernor.ts`, `.env.example` | DISCOVERY share reserved whenever discovery work is queued; clamped to [0, 100], evaluated at 0.01% precision. |
| `RENDERED_FALLBACK_MAX_WAIT_MS` | `90000` | `Dockerfile` (`ENV`), `server/browserCommunityFallback.ts`, `.env.example` | Maximum gate-queue wait for one rendered request; clamped to [1s, 300s] for both explicit and environment values. A timed-out waiter is removed and deferred as `RENDERED_FALLBACK_SATURATED` capacity. The admitted crawl's own total budget remains 60s. |

Basis: previously authorized production capacity change (October 2026);
`SEARCH_WORKER_CONCURRENCY=4` restores that change in code after it was lost
by a container recreate, and depth `30` matches the standing production
database value (verified read-only).

## Post-deploy verification (read-only)

- `docker inspect <app-container> --format '{{json .Config.Env}}'` shows
  `SEARCH_WORKER_CONCURRENCY=4`, unless an explicit runtime override sets a
  different value — in that case `.Config.Env` shows the overridden value,
  which wins by design.
- The same env output must show `ACQUISITION_LANE_TELEMETRY_ENABLED=true` and
  the admission budget: `RENDERED_ADMISSION_GOVERNOR_ENABLED=true`,
  `RENDERED_ADMISSION_NOMINAL_PER_HOUR=40`,
  `RENDERED_ADMISSION_EMERGENCY_PER_HOUR=48`,
  `RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT=35`, and
  `RENDERED_FALLBACK_MAX_WAIT_MS=90000` (or an explicitly approved override).
  If the governor is disabled, the 40/48/35 budget is not enforced.
- Read-only database `SELECT setting_value FROM app_settings WHERE
  setting_key='discovery_target_queue_depth'` still returns `30`.
