# Production Readiness Report

Date: 2026-07-28

## Executive decision

**NO-GO for an internet-facing production release.** The application builds and its
deterministic unit suites pass, but this audit did not have a configured production-like
PostgreSQL database, Railway project, or YouTube/Gemini credentials. Persistence,
restart, migration, external-channel, and Railway checks therefore still require a
staging rehearsal. In addition, mutation and quota-consuming API routes have no
authentication, and Railway backups are not configured by this repository.

## Architecture and execution flow

1. Query Intelligence combines curated and validated learned vocabulary, selects a
   cooldown-eligible query, and records generation provenance.
2. Manual and queued searches enter the PostgreSQL `jobs` queue. Workers claim rows
   with `FOR UPDATE SKIP LOCKED`, call YouTube, and feed candidates into ingestion.
   The autonomous producer reserves diverse queries and quota, then enqueues durable
   search jobs; it never calls YouTube directly.
3. Ingestion deduplicates by channel ID, applies country inference/exclusion, runs the
   evidence-based classifier, schedules uncertain channels for durable enrichment,
   and performs Discord inspection only after preceding gates pass.
4. PostgreSQL stores channels, query history, vocabulary, queue attempts, quota, and
   scheduler state. Express exposes these records to the React dashboard.

## Integration findings

### Correctly integrated

- PostgreSQL is mandatory; there is no silent SQL.js runtime fallback.
- SQL migrations are transactional and now protected by a database advisory lock, so
  concurrent Railway starts cannot race the same migration.
- Queue claims use row locks with `SKIP LOCKED`, retry with exponential backoff, and
  recover stale processing locks. Terminal idempotency keys can now be reused while
  pending/processing jobs remain deduplicated.
- The autonomous scheduler is a short-lived, quota-paced producer. Query runs,
  reservations, and job attribution remain durable across process restarts.
- Country exclusion runs before country-targeted queue creation and is checked again
  by workers. Candidate-level country inference precedes classifier/Discord work.
- Uncertain classifications enter durable enrichment and become reviewable after the
  enrichment pass rather than silently completing.
- Query records retain trust tiers, exploration/exploitation mode, objective, reason,
  primary term, and generation metadata.
- The multilingual evidence provider is additive to the existing evidence engine and
  does not change API response shapes or the PostgreSQL schema.

### Remaining technical debt and known risks

#### Release blockers

1. **No API authentication or authorization.** Public callers can launch searches,
   spend API quota, alter country policy/vocabulary, pause workers, run stress tests,
   and change query state. Put the service behind Railway/private access or implement
   real operator authentication before exposing it publicly.
2. **No completed staging proof.** Run migration, queue restart, scheduler restart,
   and real-channel end-to-end checks against a disposable Railway environment.
3. **Backups are external-only.** The legacy backup endpoint intentionally errors for
   PostgreSQL. Enable Railway PostgreSQL backups and prove a restore before release.

#### High-priority debt

- The legacy `server/db.legacy.ts` snapshot remains in the runtime source tree. It is
  obsolete at runtime but should be retained until migration/rollback acceptance, then
  archived outside compiled source.
- The SQL.js migration tool validates aggregate counts and one channel sample, but it
  does not import legacy `quota_tracker` or `search_jobs_queue` rows. Do not claim a
  complete legacy migration unless those tables are intentionally declared ephemeral
  or migrated separately.
- Autonomous searches are restart-safe durable jobs. Candidate processing within one
  claimed search remains sequential, with a worker heartbeat protecting long claims.
- Stale queue recovery resets jobs but leaves the corresponding open attempt row
  unfinished. This affects operational audit quality, not job recovery itself.
- `server/db.ts` contains dense one-line compatibility code, increasing review and
  maintenance risk. `saveDb()` remains an intentional no-op compatibility shim.
- Startup deletes stress-test-prefixed channel records. This is deterministic but a
  startup write side effect and should be removed after test-data policy is finalized.
- PostgreSQL TLS defaults to `rejectUnauthorized: false` in production. Confirm the
  exact Railway certificate requirements; use verified TLS where supported.
- Quota reservations are transactional for autonomous, enrichment, and manual work;
  production staging still needs to prove reset, expiry, and allocation behavior.
- External provider calls need explicit timeouts/cancellation and production metrics.
  Provider errors can degrade to reduced evidence, which is resilient but can increase
  uncertain classifications.

## API compatibility

No endpoint paths or documented response contracts were changed in this audit. The
critical fixes affect internal migration serialization, job re-enqueue semantics,
scheduler locking, and logging only. The manual PostgreSQL backup endpoint remains an
existing incompatible legacy operation: it returns an error by design.

## Security and failure recovery

- Secrets are environment-driven and `.env*` is ignored except `.env.example`.
- SQL values inspected in the runtime use parameters. Dynamic scheduler-state column
  names are internal call-site keys, not direct request values, but should eventually
  be allow-listed.
- Express currently lacks authentication, rate limiting, request-size customization,
  security headers, and structured request IDs. These are mandatory considerations
  before a public release.
- Worker tick failures are now logged instead of silently swallowed.
- Gemini credentials are no longer included in the YouTube API key pool.
- Database startup fails loudly if `DATABASE_URL` is absent or unavailable.

## Performance concerns

- `/api/channels` reads every channel and filters in Node; move filtering and paging to
  SQL before large datasets.
- Configurable search and enrichment worker pools drain continuously; channel
  candidates within each search are still handled serially.
- Query and channel helper functions perform repeated round trips and some full-table
  reads. Add indexes/query plans and metrics based on staging load, not speculation.
- The health endpoint queries database and queue state on each probe. This is useful
  for readiness but should have a strict DB timeout.

## Required environment variables

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | Required; Railway PostgreSQL connection string. |
| `YOUTUBE_API_KEY` (or `_1` … `_5`) | Required for real discovery/enrichment. |
| `GEMINI_API_KEY` | Required for Gemini semantic evidence; do not use it as a YouTube key. |
| `NODE_ENV=production` | Required for production static serving/runtime behavior. |
| `PORT` | Railway injects it; local default is 3000. |
| `PGSSL` | Leave unset for Railway unless its connection requires another policy; `disable` is local-only. |
| `LOG_LEVEL` | Documented, although not yet enforced by a structured logger. |
| `QUERY_INTELLIGENCE_COOLDOWN_MINUTES` | Optional; default 360. |
| `QUERY_INTELLIGENCE_PRIMARY_TERM_MAX_USES` | Optional; default 2. |
| `QUERY_INTELLIGENCE_EXPLORATION_RATIO` | Optional; default 0.4. |
| `DISCOVERY_INTERVAL_MINUTES` | Optional producer cadence; default 5. |
| `DISCOVERY_BATCH_SIZE` | Optional maximum jobs per producer wake; default 5. |
| `DISCOVERY_TARGET_QUEUE_DEPTH` | Optional autonomous queue watermark; default 15. |
| `DAILY_YOUTUBE_QUOTA_BUDGET` | Application quota budget; default 9000. |
| `DISCOVERY_AUTONOMOUS_QUOTA_PERCENT` | Autonomous allocation; default 70. |
| `DISCOVERY_ENRICHMENT_QUOTA_PERCENT` | Enrichment allocation; default 20. |
| `DISCOVERY_MANUAL_QUOTA_PERCENT` | Manual reserve; default 10. |
| `SEARCH_WORKER_CONCURRENCY` | Search worker count; default 1. |
| `ENRICHMENT_WORKER_CONCURRENCY` | Enrichment worker count; default 1. |
| `YOUTUBE_DISCOVERY_MAX_RESULTS` | Results requested per search, clamped 10–50; default 25. |

`APP_URL` and legacy `DAILY_YOUTUBE_QUOTA_LIMIT` are currently documented but not consumed by
the audited server runtime. Remove or wire them in a separate, reviewed change.

## Migration and Railway checklist

1. Create a separate Railway staging project and PostgreSQL service.
2. Take checksummed copies of the primary and backup SQL.js files; make them immutable.
3. Set staging environment variables and run `npm install`, `npm run build`, then
   `npm run migrate`.
4. Run `npm run migrate:sqljs` once. Require a successful JSON report; independently
   compare every durable table count and representative records. Resolve the two
   legacy ephemeral tables noted above explicitly.
5. Run `npm run migrate` a second time to prove idempotence, and concurrently from two
   shells to prove advisory-lock serialization.
6. Run `npm run queue:smoke`; enqueue a real search, restart the service before claim,
   and verify it completes exactly once after restart.
7. Terminate a worker while processing, wait past stale-lock duration, and verify
   recovery/retry. Repeat for the scheduler and confirm no overlapping cycle.
8. Exercise query planning, country inference, exclusion, classification, enrichment,
   persistence, and dashboard APIs using real YouTube channel IDs/URLs.
9. Redeploy and restart Railway; compare PostgreSQL counts and samples before/after.
10. Enable Railway backups, perform a restore into a new database, and compare counts.
11. Add access control before assigning a public production domain.
12. Confirm `/api/health`, logs, restart policy, alerts, and production URL.

## Rollback plan

1. Stop workers and scheduler; record job and scheduler state and take a PostgreSQL
   backup immediately.
2. Roll back application deployment to the previous known-good image. Do not reverse
   migrations destructively; all current migrations are forward-only.
3. If PostgreSQL data is bad, restore the last verified PostgreSQL backup into a new
   database and atomically switch `DATABASE_URL`.
4. If the initial migration is rejected, keep the archived SQL.js files untouched,
   correct the migration tooling in staging, create a fresh PostgreSQL database, and
   rerun. Never overwrite the legacy archive.
5. Resume one worker first, verify queue/channel counts and health, then restore normal
   scheduler operation.

## Validation status

- Unit, TypeScript, and production build checks passed during this audit.
- Static source inspection covered routes, persistence, migrations, queue, scheduler,
  query planner, country inference/exclusion, evidence classification, enrichment,
  deployment configuration, and environment usage.
- Live PostgreSQL/Railway restart and external YouTube/Gemini validations were **not
  performed** because this workspace has no configured staging database/project or
  credentials, and its pre-existing `node_modules` does not contain the declared `pg`
  package. Both migration and queue-smoke commands therefore remain mandatory release
  gates after a clean dependency install.

The recommendation changes to **GO** only after all release blockers and staging
checklist items pass with retained logs, row-count reports, and backup-restore proof.
