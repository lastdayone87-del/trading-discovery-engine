# Production Readiness Report

Date: 2026-07-29

## Phase A-F end-to-end validation

The six phases form a coherent pipeline: measurement-integrity funnel records feed
the short-query planner; the planner schedules exactly one attributed channel or
video retrieval lane per autonomous run; professional manual searches use separate
durable sessions; uncertain results enter immutable human review; and canonical
terminology consumes diverse creator evidence plus autonomous production yield.

Four integration defects were found and corrected during this validation:

1. **Phase C/F lane and quota attribution:** terminology performance was invoked
   through the query evaluator without the run's retrieval lane or quota cost, so
   otherwise valid performance rows were recorded as `UNKNOWN` with zero quota.
   The worker now passes the authoritative job lane and 100-unit search cost through
   the evaluator into terminology performance.
2. **Phase D/F learning isolation:** high-quality channels reached through an
   operator-directed manual search could enter automatic vocabulary extraction.
   Manual results are still persisted and measurable, but no longer train autonomous
   terminology unless the human-approval workflow later provides explicit provenance.
3. **Phase D durable-page idempotency:** a retry after a page observation committed
   could apply the session aggregate update again, duplicating quota and progress
   accounting. The unique observation insert is now the transaction's idempotency
   gate; a replay returns the durable session without changing aggregates.
4. **Worker recovery audit integrity:** stale recovery requeued a job but left its
   abandoned attempt marked `PROCESSING`. Recovery now closes those attempt rows as
   failed in the same transaction that releases the job lock.

The deterministic suite covers query compactness and script policy, lane allocation,
measurement math, terminology diversity/decay/demotion, review immutability, country
policy, and enrichment lifecycle. Type checking and the production build also pass.
Live PostgreSQL, provider, restart, and deployment validation remains outstanding.

### Subsystem assessment

- **Phase A — Measurement integrity:** raw, distinct, duplicate, known, net-new,
  country-rejected, classification, quality, and community outcomes are separated.
  Creator uniqueness is keyed by channel ID and duplicate search hits do not inflate
  the distinct funnel.
- **Phase B — Short native planner:** generated queries are compact combinations of
  native terms and formats with cooldown, primary-term, intent, script, normalization,
  and country constraints. Tests explicitly reject the former descriptive sentence
  pattern. Migrated `LEGACY` metadata remains for historical explainability, not as a
  planner execution path.
- **Phase C — Dual-lane discovery:** one lane is allocated per run to avoid doubling
  quota; the run, sighting, worker log, and terminology performance now share the same
  lane attribution.
- **Phase D — Manual search:** sessions, pages, continuation tokens, adaptive stop
  rules, quota reservations, cancellation, and progress are durable. Session updates
  are idempotent and operator-directed sampling is isolated from automatic learning.
- **Phase E — Human review:** approval/rejection uses bearer authentication,
  optimistic versions, idempotency keys, immutable decision rows, and permanent
  rejection. Force rescan is restricted to rejected reviews. Approved learning is
  delayed until post-approval enrichment succeeds.
- **Phase F — Terminology intelligence:** canonical country-scoped normalization,
  aliases, append-only observations, creator/community diversity, decay, lifecycle
  history, controlled search eligibility, production yield, demotion, and
  human-approved provenance are connected. Automatic promotion cannot result from
  occurrence volume alone, limiting self-reinforcing feedback.

### Dashboard assessment

The channel table, active queue depths, aggregate quota use, scheduler state, query
library, canonical terminology, review records, active manual-session progress, and
execution logs are backed by PostgreSQL APIs. Two UI/operational caveats remain:

- The “recently discovered” count is the size of the currently returned unpaginated
  channel array, not a separately calculated global statistic. This is accurate at
  current scale but does not scale.
- The queue monitor retains a `discord_validation` control although Discord inspection
  currently runs inline in channel ingestion and no `INSPECT_DISCORD` producer exists.
  Its depth will remain zero and pausing it does not suspend inline inspection. Treat
  that control as obsolete and remove it in a dedicated compatibility cleanup.

### Configuration assessment

Planner, scheduler, lane allocation, quota allocation, worker concurrency, retrieval
page size, and manual-search controls use environment defaults and, where documented,
lowercase `app_settings` overrides. Defaults are conservative. `REVIEW_API_TOKEN` and
`MANUAL_SEARCH_WORKER_CONCURRENCY` are implemented but were missing from the example
environment documentation and are now listed below. `APP_URL`, `LOG_LEVEL`, and
`DAILY_YOUTUBE_QUOTA_LIMIT` remain documented legacy/no-op settings; operators must use
`DAILY_YOUTUBE_QUOTA_BUDGET` for the application budget.

### Performance and cleanup recommendations

- Push channel filtering and pagination into PostgreSQL before the table grows.
- Consolidate dense compatibility helpers in `server/db.ts` into domain repositories
  and archive `server/db.legacy.ts` after migration acceptance.
- Remove unused `addManualCountrySearch`, the obsolete Discord queue control, the
  PostgreSQL-incompatible backup endpoint, checked-in debugging/scrape artifacts, and
  legacy no-op environment settings after confirming no external clients depend on
  them.
- Add an index supporting queue claims on `(status, run_after, priority DESC,
  created_at)` after checking the staging query plan; the current separate indexes may
  require extra sorting at scale.
- Batch terminology lifecycle reads/writes and channel lookups only after production
  traces show material latency; current algorithms are bounded but round-trip heavy.

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
- Stale queue recovery resets jobs and now closes the corresponding abandoned attempt
  row transactionally, preserving operational audit integrity.
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
| `YOUTUBE_API_KEY` (plus indexed keys through the configured `YOUTUBE_API_KEY_POOL_SIZE`) | Required for real discovery/enrichment. |
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
| `MANUAL_SEARCH_WORKER_CONCURRENCY` | Manual continuation worker count; default 1. |
| `ENRICHMENT_WORKER_CONCURRENCY` | Enrichment worker count; default 1. |
| `YOUTUBE_DISCOVERY_MAX_RESULTS` | Results requested per search, clamped 10–50; default 25. |
| `REVIEW_API_TOKEN` | Required bearer secret for review reads and decisions. |

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
  provider credentials. Migration and queue-smoke commands therefore remain mandatory
  release gates in the staging environment.

The recommendation changes to **GO** only after all release blockers and staging
checklist items pass with retained logs, row-count reports, and backup-restore proof.
