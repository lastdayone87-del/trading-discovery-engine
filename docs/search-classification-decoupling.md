# Search / classification decoupling (Phase 3)

## Problem

Autonomous search pages were spending almost all worker wall time inside the
per-channel ingestion pipeline. Production measurement from the approved plan:
a search job averaged ~615s, of which ~606s was channel processing and only
~3.8s retrieval. One page of 21 channels recorded 11.34M ms of processing against
14.3s of retrieval (~540s/channel). Four search workers were therefore
head-of-line blocked by semantic provider waits, even though retrieval and
YouTube quota were not saturated.

## Design

`SEARCH_CLASSIFICATION_DECOUPLING_ENABLED` (default `true`) switches the
autonomous search loop from inline classification to durable admission. The
durable queue is the active production path; an explicit `false` is the
rollback switch.

When enabled, for every newly retrieved channel the search worker:

1. Keeps `recordNomination` inline (candidate ledger visibility is unchanged).
2. Reads the existing row once and applies the existing
   `shouldPreserveExistingChannel` policy. Hard-terminal and known-complete rows
   are reported immediately with their durable outcome and are **not** enqueued.
   The one preserved-row exception is the existing low-audience refresh
   (`COMPLETED` + fresh <30 subscriber evidence), which still needs the pipeline.
3. Applies backpressure:
   - global cap `CLASSIFY_DISCOVERED_CHANNEL_MAX_PENDING` (default 500)
     PENDING+PROCESSING jobs;
   - per-query cap `CLASSIFY_DISCOVERED_CHANNEL_MAX_PER_QUERY` (default 50)
     keyed by query run, else query+country, else normalized query text.
   - At either cap the channel is processed **inline** with the legacy
     `processDiscoveredChannelContained` path. The discovery is never dropped and
     the cap cannot be exceeded indefinitely.
4. Otherwise inserts a provisional row with **insert-only** semantics
   (`ON CONFLICT DO NOTHING`) and enqueues one durable
   `CLASSIFY_DISCOVERED_CHANNEL` job.
   - Idempotency key: `classify:${channelId}:${UTC day}` with
     `preventReopen: true`.
   - An already active PENDING/PROCESSING job for the channel is reused; no
     duplicate is enqueued.
   - If the same day's job is already terminal (the key cannot reopen it), the
     rediscovery is classified inline instead of waiting until the next day.
   - Queue write failures also fall back inline; a discovery is never lost to a
     queue error.

The classification handler runs the same unified pipeline as the legacy path:
`processChannelThroughPipeline(candidate, targetCountry, source, false, false,
{ forceExtraction, quotaOrigin })`, then reconciles the query sighting.

The provisional row exists so page accounting can count a real new creator and
so the job has durable quota provenance. It is created with
`country='UNKNOWN'`, `country_status='UNCERTAIN'`, `trading_status='UNCERTAIN'`,
and `scan_status='CLASSIFICATION_PENDING'`; it never asserts a semantic verdict
or claims the retrieval target as the creator's country. The pipeline remains
the only writer of classification outcomes.

## Worker capacity

Worker counts are unchanged: 4 search workers and 3 enrichment workers.

The 3 enrichment workers keep the total but split claim preference:

| Flag | Shared workers (`CLASSIFY` then `ENRICH`) | ENRICH-only workers |
| --- | --- | --- |
| on | 2 | 1 |
| off (rollback drain) | 1 | 2 |

Classification priority is 15: above the default ENRICH priority (10) so new
discoveries drain promptly, below search continuations and operator work. The
dedicated ENRICH worker prevents the pre-existing ~44-job backlog from starving
behind new classifications.

Do not raise enrichment workers to 6 until semantic success rate is >90%, p95
classification latency is <30s, and the backlog is stable (Phase 4 gate).

## Query learning

A pending observation counts as:

- `distinctResults`, `newChannels`, and novelty (a real provider result), so a
  productive page is not misread as low-yield and pagination does not stop too
  early;
- **not** `evaluated`, so it cannot dilute country/trading precision or claim a
  trading outcome. A page whose country outcomes are all still pending is
  neutral for the legacy continuation precision term and cannot trigger a
  wrong-country stop; partially evaluated pages still report the real
  wrong-country share.

When classification completes, `reconcileClassificationSighting` rewrites every
`channel_sightings` row for that channel whose `funnel_outcome` is
`CLASSIFICATION_PENDING` to the durable terminal outcome. Query-quality
selection reads `channel_sightings`, so delayed learning uses the real verdict
without double-counting historical page aggregates.

A maintenance sweep (`reconcileStaleClassificationSightings`) closes the race
where a classification completes before the search worker writes its page-end
sighting, and repairs incomplete reconciliations. Withheld candidates whose
placeholder was removed reconcile to `UNCERTAIN` after a five-minute grace
period.

## Monitoring

- `getQueueStatus()` now exposes:
  - `classificationQueue`: pending, processing, oldest pending, enabled, global
    cap, and per-source breakdown;
  - `searchWorkers`: configured main search width and busy claim owners.
- `GET /api/diagnostics/enrichment-backlog` (operator) now includes a `classification`
  block with the same aggregate, throughput, and oldest-job diagnostics as
  ENRICH_CHANNEL.
- `/api/provider-metrics` keeps semantic route health / daily quota signals from
  the provider-resilience work; classify jobs appear in its queue latency by
  type.

Healthy signs after enabling:

- search page wall time drops toward retrieval + enqueue (~5–15s);
- search worker busy time is no longer dominated by semantic waits;
- classification pending depth stays below the cap and drains;
- ENRICH-only worker still completes the legacy backlog;
- semantic success rate and p95 latency do not regress.

Alerts worth adding operationally:

- classification pending > 80% of the global cap for 15 minutes;
- oldest pending classification age > 30 minutes while providers are healthy;
- `CLASSIFICATION_PENDING` sightings older than 24 hours (sweep not keeping up);
- classification terminal-failure rate > 10% of attempts in 1 hour.

## Rollback

The queue is active by default. Rollback is one explicit setting:

1. Set `SEARCH_CLASSIFICATION_DECOUPLING_ENABLED=false` and redeploy/restart.
2. The search loop immediately returns to the legacy inline path for every new
   discovery; no new classification jobs are enqueued.
3. Existing PENDING/PROCESSING classification jobs remain claimable through the
   dedicated drain lane and complete idempotently. They can also be left
   pending; the queue is not lost.
4. No schema migration is required and no data rewrite is needed. Provisional
   rows are reclaimed by normal classification, terminal projection, or the
   placeholder deletion path.

## Failure recovery

- Retryable provider failures use the existing `failJob` backoff, including
  cooldown-aware `run_after` and attempt-free provider deferrals.
- Terminal failure projects `scan_status='PROVIDER_DEFERRED'` (operational
  deferral) or `'FAILED'` for a still-untouched placeholder, keeps trading
  `UNCERTAIN`, records admission shadow evidence, and reconciles the sighting to
  the channel's durable state.
- A policy exclusion at claim time removes only the untouched placeholder and
  reconciles the sighting as country-rejected; the already-completed search run
  is never failed by later classification.
- Stale PROCESSING locks are recovered by the existing generic job sweep.
- Withheld / non-persisted classifications delete the untouched placeholder so a
  later independent rediscovery can classify with fresh evidence.

## Known limitations

- Manual operator searches remain inline. They are low-volume, operator-visible,
  and their page metrics assume immediate outcomes; decoupling them would
  require a separate pending-aware manual report. This is deliberate scope.
- The day-bucketed key means a failed channel can retry at most once per UTC day
  through the durable lane. A same-day rediscovery after a terminal failure is
  processed inline instead of enqueued again.
- Historical `query_runs` page counters keep their discovery-time values
  (pending counted as new). Delayed truth is authoritative through
  `channel_sightings` and query-quality selection.
- The day-bucket boundary is UTC; a classification may be retried at most once
  per day, not per provider cooldown window.

## Tests

- `server/classificationDecoupling.test.ts`: flag/config defaults, caps,
  idempotency key, scope key, admission, provisional row, outcome mapping,
  worker split, rollback drain, source wiring.
- `server/queryPerformance.test.ts`: pending counts as persisted new but is
  excluded from evaluated precision.
- Existing `searchCapacityDefaults`, `enrichConcurrencyDefaults`, and
  `enrichmentBacklogDiagnostics` suites pin the unchanged worker defaults and
  provider-neutral SQL.
