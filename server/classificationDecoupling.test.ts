import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CLASSIFICATION_JOB_TYPE,
  CLASSIFICATION_DECOUPLING_FLAG,
  CLASSIFICATION_JOB_PRIORITY_DEFAULT,
  ENRICHMENT_WORKER_CONCURRENCY_DEFAULT,
  SEARCH_WORKER_CONCURRENCY_DEFAULT,
  buildClassificationJobPayload,
  buildProvisionalClassificationChannel,
  classificationAdmission,
  classificationDayBucket,
  classificationJobIdempotencyKey,
  classificationQueryScopeKey,
  enrichmentJobIdempotencyKey,
  mapClassificationOutcomeToFunnelOutcome,
  resolveClassificationDecouplingConfig,
  resolveEnrichmentWorkerCount,
  resolveEnrichmentWorkerSplit,
  resolveSearchWorkerCount,
  routeSearchPageChannel,
} from './classificationDecoupling';

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ ...overrides } as NodeJS.ProcessEnv);

test('decoupling is active by default and an explicit false is the rollback switch', () => {
  assert.equal(resolveClassificationDecouplingConfig(env()).enabled, true);
  assert.equal(resolveClassificationDecouplingConfig(env({ [CLASSIFICATION_DECOUPLING_FLAG]: 'TRUE' })).enabled, true);
  assert.equal(resolveClassificationDecouplingConfig(env({ [CLASSIFICATION_DECOUPLING_FLAG]: 'false' })).enabled, false);
  assert.equal(resolveClassificationDecouplingConfig(env({ [CLASSIFICATION_DECOUPLING_FLAG]: '0' })).enabled, false);
  assert.equal(resolveClassificationDecouplingConfig(env({ [CLASSIFICATION_DECOUPLING_FLAG]: 'off' })).enabled, false);
});

test('an unrecognized rollback value warns once and keeps the default', () => {
  const token = `disabled-${Date.now()}`;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    assert.equal(resolveClassificationDecouplingConfig(env({ [CLASSIFICATION_DECOUPLING_FLAG]: token })).enabled, true);
    assert.equal(resolveClassificationDecouplingConfig(env({ [CLASSIFICATION_DECOUPLING_FLAG]: token })).enabled, true);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, 'the same unrecognized token warns once, not on every resolve');
  assert.match(warnings[0], /Unrecognized SEARCH_CLASSIFICATION_DECOUPLING_ENABLED value/);
  assert.match(warnings[0], /Use false\/0\/off to roll back/);
});

test('caps, priority, and attempts clamp to safe positives', () => {
  const defaults = resolveClassificationDecouplingConfig(env());
  assert.equal(defaults.maxPending, 500);
  assert.equal(defaults.maxPerQuery, 50);
  assert.equal(defaults.priority, CLASSIFICATION_JOB_PRIORITY_DEFAULT);
  assert.equal(defaults.maxAttempts, 4);
  const configured = resolveClassificationDecouplingConfig(env({
    CLASSIFY_DISCOVERED_CHANNEL_MAX_PENDING: '12',
    CLASSIFY_DISCOVERED_CHANNEL_MAX_PER_QUERY: '3',
    CLASSIFY_DISCOVERED_CHANNEL_PRIORITY: '25',
    CLASSIFY_DISCOVERED_CHANNEL_MAX_ATTEMPTS: '2',
  }));
  assert.deepEqual(
    { maxPending: configured.maxPending, maxPerQuery: configured.maxPerQuery, priority: configured.priority, maxAttempts: configured.maxAttempts },
    { maxPending: 12, maxPerQuery: 3, priority: 25, maxAttempts: 2 },
  );
  const invalid = resolveClassificationDecouplingConfig(env({
    CLASSIFY_DISCOVERED_CHANNEL_MAX_PENDING: '0',
    CLASSIFY_DISCOVERED_CHANNEL_MAX_PER_QUERY: 'abc',
  }));
  assert.equal(invalid.maxPending, 500);
  assert.equal(invalid.maxPerQuery, 50);
});

test('worker counts stay at the measured 4/3 defaults and env overrides still win', () => {
  assert.equal(SEARCH_WORKER_CONCURRENCY_DEFAULT, 4);
  assert.equal(ENRICHMENT_WORKER_CONCURRENCY_DEFAULT, 3);
  assert.equal(resolveSearchWorkerCount(env()), 4);
  assert.equal(resolveEnrichmentWorkerCount(env()), 3);
  assert.equal(resolveSearchWorkerCount(env({ SEARCH_WORKER_CONCURRENCY: '2' })), 2);
  assert.equal(resolveEnrichmentWorkerCount(env({ ENRICHMENT_WORKER_CONCURRENCY: '5' })), 5);
  assert.equal(resolveSearchWorkerCount(env({ SEARCH_WORKER_CONCURRENCY: 'not-a-number' })), 4);
  assert.equal(resolveEnrichmentWorkerCount(env({ ENRICHMENT_WORKER_CONCURRENCY: 'NaN' })), 3);
  assert.equal(resolveSearchWorkerCount(env({ SEARCH_WORKER_CONCURRENCY: '0' })), 1);
  assert.equal(resolveEnrichmentWorkerCount(env({ ENRICHMENT_WORKER_CONCURRENCY: '0' })), 1);
  // The pre-decoupling startup capped one enrichment pool at 20 workers. Two
  // pools are started now, so the total is capped in the resolver first.
  assert.equal(resolveEnrichmentWorkerCount(env({ ENRICHMENT_WORKER_CONCURRENCY: '50' })), 20);
  assert.equal(resolveEnrichmentWorkerCount(env({ ENRICHMENT_WORKER_CONCURRENCY: '1e6' })), 20);
});

test('enrichment pool splits 2/1 when enabled and always leaves an ENRICH-only lane', () => {
  assert.deepEqual(resolveEnrichmentWorkerSplit(3, true), { classificationWorkers: 2, enrichmentOnlyWorkers: 1 });
  assert.deepEqual(resolveEnrichmentWorkerSplit(3, false), { classificationWorkers: 1, enrichmentOnlyWorkers: 2 });
  assert.deepEqual(resolveEnrichmentWorkerSplit(1, true), { classificationWorkers: 1, enrichmentOnlyWorkers: 0 });
  assert.deepEqual(resolveEnrichmentWorkerSplit(2, false), { classificationWorkers: 1, enrichmentOnlyWorkers: 1 });
  // A two-worker pool must keep one lane on the existing ENRICH backlog even
  // when the classification queue never empties.
  assert.deepEqual(resolveEnrichmentWorkerSplit(2, true), { classificationWorkers: 1, enrichmentOnlyWorkers: 1 });
  // Direct callers keep their configured total: there is no second 100-worker
  // clamp inside the split. Startup applies the historical 20-worker cap in
  // resolveEnrichmentWorkerCount before calling this function.
  assert.deepEqual(resolveEnrichmentWorkerSplit(4, true), { classificationWorkers: 3, enrichmentOnlyWorkers: 1 });
  assert.deepEqual(resolveEnrichmentWorkerSplit(5, true), { classificationWorkers: 3, enrichmentOnlyWorkers: 2 });
  assert.deepEqual(resolveEnrichmentWorkerSplit(250, true), { classificationWorkers: 3, enrichmentOnlyWorkers: 247 });
  // Total worker count is preserved for every split.
  for (const total of [1, 2, 3, 6, 250]) {
    for (const enabled of [true, false]) {
      const split = resolveEnrichmentWorkerSplit(total, enabled);
      assert.equal(split.classificationWorkers + split.enrichmentOnlyWorkers, total);
      if (total > 1) assert.ok(split.enrichmentOnlyWorkers > 0, 'the ENRICH backlog must retain a dedicated lane');
    }
  }
});

test('day-bucketed idempotency key is stable within a UTC day and changes next day', () => {
  const morning = Date.UTC(2026, 10, 7, 1, 0, 0);
  const evening = Date.UTC(2026, 10, 7, 23, 59, 0);
  assert.equal(classificationDayBucket(morning), '2026-11-07');
  assert.equal(classificationJobIdempotencyKey('chan-1', morning), 'classify:chan-1:2026-11-07');
  assert.equal(classificationJobIdempotencyKey('chan-1', evening), classificationJobIdempotencyKey('chan-1', morning));
  assert.notEqual(classificationJobIdempotencyKey('chan-1', Date.UTC(2026, 10, 8, 0, 0, 1)), classificationJobIdempotencyKey('chan-1', morning));
});

test('Discord evidence passes carry the forceClassification marker while ordinary payloads do not', () => {
  const candidate = { channelId: 'chan-1', channelName: 'Trader', youtubeUrl: 'https://youtube.com/channel/chan-1', description: '', videoTitles: [], channelLinks: [] };
  const baseInput = { candidate, targetCountry: 'Netherlands', source: 'automated_query' as const, queryScopeKey: 'discord:chan-1', discoveryJobId: 'discord:chan-1', quotaOrigin: 'NORMAL' as const, forceExtraction: false };
  assert.equal(buildClassificationJobPayload(baseInput).forceClassification, undefined);
  assert.equal(buildClassificationJobPayload({ ...baseInput, forceClassification: true }).forceClassification, true);
});

test('ordinary enrichment identity is stable per stage across days; explicit rechecks get fresh keys', () => {
  const morning = Date.UTC(2026, 10, 7, 1, 0, 0);
  const nextDay = Date.UTC(2026, 10, 8, 1, 0, 0);
  assert.equal(enrichmentJobIdempotencyKey('chan-1', 1, morning), 'enrich:chan-1:stage:1');
  assert.equal(enrichmentJobIdempotencyKey('chan-1', 1, nextDay), 'enrich:chan-1:stage:1');
  assert.notEqual(enrichmentJobIdempotencyKey('chan-1', 2, morning), enrichmentJobIdempotencyKey('chan-1', 1, morning));
  assert.equal(
    enrichmentJobIdempotencyKey('chan-1', 1, morning, { explicitRecheck: true, recheckNonce: 42 }),
    'enrich:chan-1:stage:1:recheck:42',
  );
  assert.notEqual(
    enrichmentJobIdempotencyKey('chan-1', 1, morning, { explicitRecheck: true, recheckNonce: 42 }),
    enrichmentJobIdempotencyKey('chan-1', 1, morning),
  );

});

test('per-query scope prefers the run, then query+country, then normalized text', () => {
  assert.equal(classificationQueryScopeKey({ queryRunId: 'run-1', queryId: 3, query: 'x', country: 'DE' }), 'run:run-1');
  assert.equal(classificationQueryScopeKey({ queryRunId: null, queryId: 3, query: 'x', country: 'DE' }), 'query:3:DE');
  assert.equal(
    classificationQueryScopeKey({ query: '  FX   Trading ', country: 'de' }),
    'text:fx trading:DE',
  );
});

test('admission enqueues below both caps and processes inline at either cap', () => {
  const below = { globalPending: 10, scopedPending: 5, maxPending: 500, maxPerQuery: 50 };
  assert.equal(classificationAdmission(below), 'ENQUEUE');
  assert.equal(classificationAdmission({ ...below, globalPending: 500 }), 'INLINE');
  assert.equal(classificationAdmission({ ...below, scopedPending: 50 }), 'INLINE');
  assert.equal(classificationAdmission({ ...below, globalPending: 499, scopedPending: 49 }), 'ENQUEUE');
});

test('flag-off routes only through the legacy inline path; flag-on uses durable admission', async () => {
  const calls: string[] = [];
  const inlineOutcome = { marker: 'inline' };
  const admitted = { outcome: { marker: 'admitted' }, pending: true };
  const off = await routeSearchPageChannel({
    decouplingEnabled: false,
    inline: async () => { calls.push('inline'); return inlineOutcome; },
    admit: async () => { calls.push('admit'); return admitted; },
  });
  assert.deepEqual(off, { outcome: inlineOutcome, pending: false });
  assert.deepEqual(calls, ['inline'], 'the flag-off path must never enqueue');

  calls.length = 0;
  const on = await routeSearchPageChannel({
    decouplingEnabled: true,
    inline: async () => { calls.push('inline'); return inlineOutcome; },
    admit: async () => { calls.push('admit'); return admitted; },
  });
  assert.deepEqual(on, admitted);
  assert.deepEqual(calls, ['admit'], 'the flag-on path delegates to durable admission');
});

test('job payload keeps the exact candidate and durable provenance', () => {
  const candidate = {
    channelId: 'chan-1',
    channelName: 'FX Daily',
    youtubeUrl: 'https://www.youtube.com/@fxdaily',
    subscriberCount: 1200,
    channelThumbnailUrl: 'https://img.example/chan.jpg',
  };
  const payload = buildClassificationJobPayload({
    candidate: candidate as never,
    targetCountry: 'DE',
    source: 'automated_query',
    queryRunId: 'run-1',
    queryId: 7,
    queryScopeKey: 'run:run-1',
    discoveryJobId: 'job-1',
    nominationId: 'nom-1',
    catalogPin: { checksum: 'abc' },
    quotaOrigin: 'PROBE',
    forceExtraction: true,
  });
  assert.equal(CLASSIFICATION_JOB_TYPE, 'CLASSIFY_DISCOVERED_CHANNEL');
  assert.equal(payload.channelId, 'chan-1');
  assert.equal(payload.targetCountry, 'DE');
  assert.equal(payload.source, 'automated_query');
  assert.equal(payload.queryRunId, 'run-1');
  assert.equal(payload.queryId, 7);
  assert.equal(payload.queryScopeKey, 'run:run-1');
  assert.equal(payload.discoveryJobId, 'job-1');
  assert.equal(payload.nominationId, 'nom-1');
  assert.deepEqual(payload.catalogPin, { checksum: 'abc' });
  assert.equal(payload.quotaOrigin, 'PROBE');
  assert.equal(payload.forceExtraction, true);
  assert.deepEqual(payload.candidate, candidate);
});

test('provisional channel is insert-safe and never claims classification', () => {
  const channel = buildProvisionalClassificationChannel({
    channelId: 'chan-1',
    channelName: 'FX Daily',
    youtubeUrl: 'https://www.youtube.com/@fxdaily',
    subscriberCount: '1200',
    channelThumbnailUrl: 'https://img.example/chan.jpg',
  }, 'automated_query', '2026-11-07T00:00:00.000Z');
  assert.equal(channel.channel_id, 'chan-1');
  assert.equal(channel.scan_status, 'CLASSIFICATION_PENDING');
  assert.equal(channel.country, 'UNKNOWN');
  assert.equal(channel.country_status, 'UNCERTAIN');
  assert.equal(channel.trading_status, 'UNCERTAIN');
  assert.equal(channel.discovery_source, 'automated_query');
  assert.equal(channel.first_seen, '2026-11-07T00:00:00.000Z');
});

test('terminal outcome mapping preserves country and human rejection semantics', () => {
  assert.equal(mapClassificationOutcomeToFunnelOutcome({ countryStatus: 'REJECTED', tradingStatus: 'NON_TRADING' }), 'COUNTRY_REJECTED');
  assert.equal(mapClassificationOutcomeToFunnelOutcome({ countryStatus: 'CONFIRMED', tradingStatus: 'HUMAN_REJECTED' }), 'NON_TRADING');
  assert.equal(mapClassificationOutcomeToFunnelOutcome({ countryStatus: 'CONFIRMED', tradingStatus: 'TRADING_CONFIRMED' }), 'TRADING_CONFIRMED');
  assert.equal(mapClassificationOutcomeToFunnelOutcome({ countryStatus: 'UNCERTAIN', tradingStatus: 'UNCERTAIN' }), 'UNCERTAIN');
});

test('source wiring keeps the inline path as the explicit rollback fallback and drains it', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const db = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  // The rollback branch still calls the exact legacy containment helper through
  // the executable routing unit.
  assert.match(queue, /decouplingEnabled: classificationDecoupling\.enabled/);
  assert.match(queue, /inline: \(\) => processDiscoveredChannelContained\(raw, country, source/);
  assert.match(queue, /return admitDiscoveredChannel\(\{/);
  // Classification is claimed by shared enrichment workers and dispatched.
  assert.match(queue, /push\(CLASSIFICATION_JOB_TYPE\)/);
  assert.match(queue, /job\.type === CLASSIFICATION_JOB_TYPE[\s\S]{0,120}processClassificationJob/);
  assert.match(queue, /startWorkerPool\('ENRICH_CHANNEL', enrichmentSplit\.classificationWorkers, \[CLASSIFICATION_JOB_TYPE, ADMISSION_VERIFICATION_JOB_TYPE\]/);
  // Phase 4 startup clamps through the measured gate and the approved hard
  // ceiling before splitting into the two pools.
  assert.match(queue, /resolveEnrichmentWorkerSplit\(Math\.min\(ENRICHMENT_WORKER_SCALE_CEILING, effectiveWorkers\), decoupling\.enabled\)/);
  // The search run must not fail because a later classification failed.
  assert.match(queue, /job\.type === CLASSIFICATION_JOB_TYPE \? '' : String\(job\.payload\?\.queryRunId/);
  // Provisional rows are insert-only and classification reconciliation is durable.
  assert.match(db, /insertOnly\?: boolean/);
  assert.match(db, /ON CONFLICT\(channel_id\) DO NOTHING/);
  assert.match(db, /export async function reconcileClassificationSighting/);
  assert.match(example, /SEARCH_CLASSIFICATION_DECOUPLING_ENABLED="true"/);
});

test('an owned placeholder insert stays novel while a conflict re-reads the winner', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(
    queue,
    /if \(queued\.status === 'PENDING' \|\| queued\.status === 'PROCESSING'\) \{[\s\S]{0,900}const channel = insertedPlaceholder\s*\? existing\s*: \(existing \|\| await getChannelById\(raw\.channelId\)\);\s*return \{ outcome: classificationPendingOutcome\(raw, channel\), pending: true \};/,
  );
  // A row this worker just inserted is a genuinely new discovery. Re-reading
  // it unconditionally would set wasKnown=true and erase its novelty.
  assert.doesNotMatch(
    queue,
    /if \(queued\.status === 'PENDING' \|\| queued\.status === 'PROCESSING'\) \{[\s\S]{0,400}const channel = existing \|\| await getChannelById\(raw\.channelId\);/,
  );
  // The atomic-admission rejection path must preserve the same novelty rule.
  assert.match(
    queue,
    /if \(!queued\) \{[\s\S]{0,400}const channel = insertedPlaceholder\s*\? existing\s*: \(existing \|\| await getChannelById\(raw\.channelId\)\);/,
  );
  assert.doesNotMatch(
    queue,
    /if \(!queued\) \{[\s\S]{0,250}const channel = existing \|\| await getChannelById\(raw\.channelId\);/,
  );
});

test('sweep revisions are recency-bounded and one-shot', () => {
  const db = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  // A job may revise a sweep projection only inside a short window...
  assert.match(db, /metadata->>'reconciledBy'='MAINTENANCE_SWEEP'[\s\S]{0,250}> now\(\)-interval '1 hour'/);
  // ...and applying the job verdict clears the marker so later jobs cannot
  // rewrite the same historical row again.
  assert.match(db, /metadata=\(metadata - 'reconciledBy'\)\|\|\$6::jsonb/);
});

test('pending-sighting sweep is indexed and bounded for post-rollback repair', () => {
  const migration = readFileSync(new URL('./db/migrations/168_classification_sighting_sweep_index.sql', import.meta.url), 'utf8');
  assert.match(migration, /idx_channel_sightings_classification_pending/);
  assert.match(migration, /ON public\.channel_sightings \(observed_at\)/);
  assert.match(migration, /WHERE funnel_outcome='CLASSIFICATION_PENDING'/);
  // A missing table must fail the migration instead of silently recording it
  // as applied without the index.
  assert.doesNotMatch(migration, /IF to_regclass\('public\.channel_sightings'\) IS NULL THEN\s+RETURN;/);
  assert.match(migration, /IF EXISTS \(SELECT 1 FROM public\.channel_sightings LIMIT 1\) THEN/);
  const db = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  // The populated-table index is built concurrently before the transactional
  // migration loop, and the migration itself only adopts it.
  assert.match(db, /await ensureClassificationSightingIndex\(client\)/);
  assert.match(db, /CREATE INDEX CONCURRENTLY IF NOT EXISTS \$\{name\}/);
  // The orphan sweep is bounded so maintenance cannot rewrite the whole history.
  assert.match(db, /FROM orphans\s+WHERE s\.id=orphans\.id/);
  assert.match(db, /LIMIT \$2/);
});
