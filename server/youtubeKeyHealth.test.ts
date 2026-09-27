import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  YOUTUBE_INPUT_QUARANTINE_TTL_MS,
  YOUTUBE_SUSPENSION_RETRY_AFTER_MS,
  advanceYouTubeRotation,
  annotateYouTubeErrorMetadata,
  buildYouTubeTelemetryMetadata,
  clearYouTubeSuspensionIfCurrent,
  ensureYouTubeSuspensionHydration,
  extractYouTubeQuarantineInput,
  hydrateYouTubeProviderSuspensions,
  isYouTubeInputFailure,
  isYouTubeQuotaAccountingError,
  normalizeYouTubeQuarantineInput,
  retryYouTubeQuotaAccounting,
  shouldClearYouTubeSuspension,
  youtubeDeploymentId,
  YouTubeQuotaAccountingError,
} from './youtubeKeyHealth';
import {
  YouTubeQuarantinedInputError,
  adaptPlaylistItemsToSearchShape,
  isConsumerSuspended,
  isInvalidApiKey,
  isYouTubeQuarantinedInput,
  isYouTubeRateLimited,
} from './youtube';
import { isQuotaExceeded } from './youtubePoolBackoff';

test('quarantine constants keep invalid inputs out for days, suspensions for a week', () => {
  assert.equal(YOUTUBE_INPUT_QUARANTINE_TTL_MS, 7 * 24 * 60 * 60_000);
  assert.equal(YOUTUBE_SUSPENSION_RETRY_AFTER_MS, 7 * 24 * 60 * 60_000);
});

test('channel IDs normalize strictly; anything else is not worth remembering', () => {
  assert.equal(normalizeYouTubeQuarantineInput('channelId', 'UCabcdefghijklmnopqrstuv'), 'UCabcdefghijklmnopqrstuv');
  assert.equal(normalizeYouTubeQuarantineInput('channelId', '  UCabcdefghijklmnopqrstuv  '), 'UCabcdefghijklmnopqrstuv');
  assert.equal(normalizeYouTubeQuarantineInput('channelId', 'not-a-channel'), null);
  assert.equal(normalizeYouTubeQuarantineInput('channelId', 'UCshort'), null);
  assert.equal(normalizeYouTubeQuarantineInput('channelId', null), null);
  assert.equal(normalizeYouTubeQuarantineInput('channelId', ''), null);
});

test('search queries normalize in full, then hash (no cleartext, no prefix collisions)', () => {
  const a = normalizeYouTubeQuarantineInput('searchQuery', '  OBX   Aksjehandel ');
  const b = normalizeYouTubeQuarantineInput('searchQuery', 'obx aksjehandel');
  assert.ok(a && /^[0-9a-f]{64}$/.test(a), 'normalized query must persist as a SHA-256 hex digest');
  assert.equal(a, b, 'casing/whitespace variants share one identity');
  assert.equal(normalizeYouTubeQuarantineInput('searchQuery', '   '), null);
  assert.equal(normalizeYouTubeQuarantineInput('searchQuery', undefined), null);
  // Distinct long queries sharing the first 120 characters must not collide.
  const prefix = 'y'.repeat(120);
  const first = normalizeYouTubeQuarantineInput('searchQuery', `${prefix} one`);
  const second = normalizeYouTubeQuarantineInput('searchQuery', `${prefix} two`);
  assert.ok(first && second && /^[0-9a-f]{64}$/.test(first) && /^[0-9a-f]{64}$/.test(second));
  assert.notEqual(first, second, 'full-query hashing keeps distinct queries distinct');
});

test('quarantine input extraction prefers channel identity, falls back to query hash', () => {
  assert.deepEqual(
    extractYouTubeQuarantineInput('channel-uploads', 'https://youtube.googleapis.com/youtube/v3/search?part=snippet&channelId=UCabcdefghijklmnopqrstuv&key=K'),
    { kind: 'channelId', value: 'UCabcdefghijklmnopqrstuv' },
  );
  assert.deepEqual(
    extractYouTubeQuarantineInput('channel-details', 'https://youtube.googleapis.com/youtube/v3/channels?part=snippet&id=UCabcdefghijklmnopqrstuv&key=K'),
    { kind: 'channelId', value: 'UCabcdefghijklmnopqrstuv' },
  );
  const extracted = extractYouTubeQuarantineInput('search', 'https://youtube.googleapis.com/youtube/v3/search?part=snippet&q=OBX+Aksjehandel&key=K');
  assert.equal(extracted?.kind, 'searchQuery');
  assert.ok(extracted && /^[0-9a-f]{64}$/.test(extracted.value), 'extracted query identity must be the hash');
  assert.equal(extracted?.value, normalizeYouTubeQuarantineInput('searchQuery', 'OBX Aksjehandel'));
  assert.equal(extractYouTubeQuarantineInput('search', 'https://youtube.googleapis.com/youtube/v3/search?part=snippet&key=K'), null);
  assert.equal(extractYouTubeQuarantineInput('channel-uploads', 'not a url'), null);
});

test('only 400/404/422 prove a bad input (never quota, suspension, or transport)', () => {
  assert.equal(isYouTubeInputFailure({ status: 400 }), true);
  assert.equal(isYouTubeInputFailure({ status: 404 }), true);
  assert.equal(isYouTubeInputFailure({ status: 422 }), true);
  assert.equal(isYouTubeInputFailure({ status: 403 }), false);
  assert.equal(isYouTubeInputFailure({ status: 429 }), false);
  assert.equal(isYouTubeInputFailure({ status: 500 }), false);
  assert.equal(isYouTubeInputFailure(new Error('boom')), false);
  assert.equal(isYouTubeInputFailure(null), false);
});

test('quarantined-input errors match no key/quota failure classifier', () => {
  const error = new YouTubeQuarantinedInputError('channelId', 'UCabcdefghijklmnopqrstuv', 'channel-uploads');
  assert.equal(isYouTubeQuarantinedInput(error), true);
  assert.equal(isYouTubeQuarantinedInput(new Error('other')), false);
  // A bad input must never look like a bad key: rotation and cooldowns stay out.
  assert.equal(isConsumerSuspended(error), false);
  assert.equal(isYouTubeRateLimited(error), false);
  assert.equal(isInvalidApiKey(error), false);
  assert.equal(isQuotaExceeded(error), false);
});

test('rotation advances round-robin instead of sticking', () => {
  assert.equal(advanceYouTubeRotation(30, 0), 1);
  assert.equal(advanceYouTubeRotation(30, 29), 0);
  assert.equal(advanceYouTubeRotation(1, 0), 0);
  assert.equal(advanceYouTubeRotation(0, 0), 0);
  assert.equal(advanceYouTubeRotation(30, -1), 0);
  // Full cycle visits every slot exactly once.
  const visited = new Set<number>();
  let index = 0;
  for (let step = 0; step < 30; step++) {
    visited.add(index);
    index = advanceYouTubeRotation(30, index);
  }
  assert.equal(visited.size, 30);
  assert.equal(index, 0);
});

test('telemetry metadata carries fingerprint/index/group/deployment, never the key', () => {
  const metadata = buildYouTubeTelemetryMetadata({
    providerKey: 'AIza-secret',
    poolKeys: ['AIza-other', 'AIza-secret'],
    quotaGroup: 'project-a',
    deploymentId: 'deploy-1',
  });
  assert.equal(typeof metadata.youtubeKeyFingerprint, 'string');
  assert.equal(metadata.youtubeKeyFingerprint, createHash('sha256').update('AIza-secret').digest('hex').slice(0, 32));
  assert.ok(!Object.values(metadata).some(value => value === 'AIza-secret'), 'raw key must never appear');
  assert.equal(metadata.youtubeKeyIndex, '2');
  assert.equal(metadata.youtubeQuotaGroup, 'project-a');
  assert.equal(metadata.youtubeDeploymentId, 'deploy-1');
  const unknown = buildYouTubeTelemetryMetadata({ providerKey: 'AIza-x', poolKeys: ['AIza-y'] });
  assert.equal(unknown.youtubeKeyIndex, null);
  assert.equal(unknown.youtubeQuotaGroup, null);
  const empty = buildYouTubeTelemetryMetadata({});
  assert.deepEqual(empty, { youtubeQuotaGroup: null, youtubeDeploymentId: null });
});

test('error annotation stamps HTTP status and API reasons onto the live metadata object', () => {
  const metadata: Record<string, string | null> = { youtubeKeyFingerprint: 'abc' };
  annotateYouTubeErrorMetadata(metadata, { status: 403, providerReasons: ['consumerSuspended', 'odd reason!!', 'x'.repeat(200)] });
  assert.equal(metadata.youtubeHttpStatus, '403');
  assert.equal(metadata.youtubeApiReasons, 'consumerSuspended');
  assert.equal(metadata.youtubeKeyFingerprint, 'abc');
  const transport: Record<string, string | null> = {};
  annotateYouTubeErrorMetadata(transport, new Error('socket hang up'));
  assert.ok(!('youtubeHttpStatus' in transport));
  assert.ok(!('youtubeApiReasons' in transport));
});

test('deployment identity resolves from Railway env, else null', () => {
  assert.equal(youtubeDeploymentId({ RAILWAY_DEPLOYMENT_ID: 'd-1' } as NodeJS.ProcessEnv), 'd-1');
  assert.equal(youtubeDeploymentId({ RAILWAY_REPLICA_ID: 'r-2' } as NodeJS.ProcessEnv), 'r-2');
  assert.equal(youtubeDeploymentId({} as NodeJS.ProcessEnv), null);
});

test('playlistItems payloads adapt into the search item shape enrichment consumes', () => {
  const adapted = adaptPlaylistItemsToSearchShape({
    items: [
      { snippet: { publishedAt: '2026-09-01T00:00:00Z', title: 'T', description: 'D', resourceId: { videoId: 'vid1' } } },
      { snippet: { publishedAt: 'not-a-date', title: '', resourceId: {} } },
      {},
    ],
  });
  assert.equal(adapted.items.length, 3);
  assert.equal(adapted.items[0].id.videoId, 'vid1');
  assert.equal(adapted.items[0].snippet.publishedAt, '2026-09-01T00:00:00Z');
  assert.equal(adapted.items[1].id.videoId, null);
  assert.deepEqual(adaptPlaylistItemsToSearchShape({}).items, []);
  assert.deepEqual(adaptPlaylistItemsToSearchShape({ items: 'nope' as unknown as [] }).items, []);
});

test('quota accounting retries the same response, then surfaces persistent failure', async () => {
  const calls: number[] = [];
  await retryYouTubeQuotaAccounting(async units => { calls.push(units); }, 100);
  assert.deepEqual(calls, [100], 'success accounts exactly once');
  const flaky: number[] = [];
  let attempts = 0;
  await retryYouTubeQuotaAccounting(async units => {
    flaky.push(units);
    attempts += 1;
    if (attempts < 2) throw new Error('transient ledger blip');
  }, 1);
  assert.deepEqual(flaky, [1, 1], 'a transient failure retries the same units, never a new request');
  const dead: number[] = [];
  await assert.rejects(
    retryYouTubeQuotaAccounting(async units => { dead.push(units); throw new Error('ledger down'); }, 100),
    /ledger down/,
  );
  assert.deepEqual(dead, [100, 100], 'persistent failure retries once, then throws without publishing');
  const custom: number[] = [];
  await assert.rejects(retryYouTubeQuotaAccounting(async units => { custom.push(units); throw new Error('x'); }, 5, 1), /x/);
  assert.deepEqual(custom, [5], 'maxAttempts=1 never retries');
});

test('durable suspension clears only on a current success under suspension', () => {
  // Regression: an older in-flight success arriving after a newer suspension
  // event is stale (providerSuccessIsCurrent=false) and must not clear the
  // durable row, even though the request ran while suspended.
  assert.equal(shouldClearYouTubeSuspension(true, true), true);
  assert.equal(shouldClearYouTubeSuspension(false, true), false, 'stale success must not rehabilitate');
  assert.equal(shouldClearYouTubeSuspension(true, false), false, 'non-suspended keys have no row to clear');
  assert.equal(shouldClearYouTubeSuspension(false, false), false);
});

test('stale generation never validates: older in-flight success after suspension', async () => {
  const { YouTubeProviderCooldown } = await import('./youtubeProviderCooldown');
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({ initialRateLimitCooldownMs: 100, maxRateLimitCooldownMs: 400, now: () => now });
  // Older request dispatches first and captures generation 0.
  const dispatchGeneration = providers.failureGeneration('key-a');
  // A newer request fails with suspension while the older one is in flight.
  providers.failed('key-a', 'CONSUMER_SUSPENDED');
  assert.equal(providers.isSuspended('key-a'), true);
  // The older response arrives: its captured generation is stale.
  const providerSuccessIsCurrent = providers.succeeded('key-a', dispatchGeneration);
  assert.equal(providerSuccessIsCurrent, false, 'older generation must compare stale');
  assert.equal(shouldClearYouTubeSuspension(providerSuccessIsCurrent, true), false, 'durable row must survive');
  assert.equal(providers.isSuspended('key-a'), true, 'in-memory suspension must survive');
  // A genuinely current success still rehabilitates.
  const currentGeneration = providers.failureGeneration('key-a');
  assert.equal(providers.succeeded('key-a', currentGeneration), true);
});

test('hydration gate is shared and never rejects', async () => {
  const first = ensureYouTubeSuspensionHydration();
  const second = ensureYouTubeSuspensionHydration();
  assert.equal(first, second, 'dispatch and startup must await the same promise');
  const summary = await first;
  assert.deepEqual(Object.keys(summary).sort(), ['restored', 'skipped']);
});

test('accounting failures are marked so the attempt flow never fails over to another key', () => {
  const accounting = new YouTubeQuotaAccountingError(100, 'key-a', { cause: new Error('ledger down') });
  assert.equal(accounting.code, 'YOUTUBE_QUOTA_ACCOUNTING');
  assert.equal(accounting.units, 100);
  assert.equal(accounting.providerKey, 'key-a');
  assert.match(String(accounting.cause), /ledger down/);
  assert.equal(isYouTubeQuotaAccountingError(accounting), true);
  assert.equal(isYouTubeQuotaAccountingError({ code: 'YOUTUBE_QUOTA_ACCOUNTING' }), true);
  assert.equal(isYouTubeQuotaAccountingError(new Error('provider 429')), false);
  assert.equal(isYouTubeQuotaAccountingError(null), false);
  // The enrichment catch must surface these before any provider-failure
  // bookkeeping: a refetch on another key would burn a second provider
  // call while the first call's units stay unrecorded.
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const attemptCatch = youtube.slice(youtube.indexOf('} catch (error: any) {', youtube.indexOf('export async function fetchYouTubeChannelEnrichment(')));
  assert.match(attemptCatch, /if\(isYouTubeQuotaAccountingError\(error\)\)throw error;/);
  const breakout = attemptCatch.indexOf('isYouTubeQuotaAccountingError');
  const failover = attemptCatch.indexOf('recordProviderFailure(apiKey,error)');
  assert.ok(breakout >= 0 && breakout < failover, 'accounting breakout must precede provider-failure bookkeeping');
});

test('accounting wrapper uses one stable operation ID and surfaces accounting errors', () => {
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const wrapper = youtube.slice(youtube.indexOf('async function accountYouTubeQuotaResponse'), youtube.indexOf('/** Adapts a playlistItems.list payload'));
  // One ID per provider response: stable across that call's internal
  // retries (generated once), unique per response (fresh UUID per call),
  // so a retry after an unknown commit outcome cannot double-charge.
  assert.match(wrapper, /const operationId = randomUUID\(\);/);
  assert.match(wrapper, /incrementQuota\(unitsConsumed, providerKey, operationId\)/);
  assert.match(wrapper, /throw new YouTubeQuotaAccountingError\(units, providerKey, \{ cause: error \}\);/);
  // The ledger honors the ID transactionally, with a pre-migration
  // fallback so accounting keeps working until migration 133 applies.
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /INSERT INTO youtube_quota_accounting_ops\(op_id,quota_day,key_fingerprint,units\)/);
  assert.match(dbCore, /ON CONFLICT\(op_id\) DO NOTHING RETURNING op_id/);
  assert.ok(existsSync(new URL('./db/migrations/133_youtube_quota_accounting_idempotency.sql', import.meta.url)), 'idempotency table migration must exist');
  const migration = readFileSync(new URL('./db/migrations/133_youtube_quota_accounting_idempotency.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS youtube_quota_accounting_ops/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS youtube_quota_accounting_ops_created_at_idx/);
});

test('idempotency ledger is pruned on a schedule outside the charge path', async () => {
  const { pruneYouTubeQuotaAccountingOps } = await import('./dbCore');
  assert.equal(await pruneYouTubeQuotaAccountingOps(0), 0, 'non-positive retention prunes nothing without touching the database');
  assert.equal(await pruneYouTubeQuotaAccountingOps(NaN), 0);
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const prune = dbCore.slice(dbCore.indexOf('export async function pruneYouTubeQuotaAccountingOps'));
  assert.match(prune, /DELETE FROM youtube_quota_accounting_ops WHERE created_at </);
  assert.match(prune, /code === '42P01'/);
  // Startup (not per-charge) invokes it best-effort; the charge path never
  // references the prune so accounting transactions scan no history.
  const startup = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const purgeTask = startup.slice(startup.indexOf("'startup maintenance purge'"));
  assert.match(purgeTask, /pruneYouTubeQuotaAccountingOps\(\)\.catch\(\(\) => 0\)/);
  const charge = dbCore.slice(dbCore.indexOf('export async function incrementQuota'), dbCore.indexOf('export async function getSchemaInfo'));
  assert.doesNotMatch(charge, /pruneYouTubeQuotaAccountingOps/);
});

test('durable clear is generation-gated and awaited, never deleting a newer suspension', async () => {
  // A newer suspension recorded after validation compares unequal: the
  // fresh durable row must survive even though the success was current
  // when observed.
  let cleared: string[] = [];
  assert.equal(await clearYouTubeSuspensionIfCurrent('key-a', 7, { currentGeneration: () => 8, clear: async fp => { cleared.push(fp); } }), false);
  assert.deepEqual(cleared, [], 'stale validation must not touch the database');
  assert.equal(await clearYouTubeSuspensionIfCurrent('key-a', undefined, { currentGeneration: () => 7, clear: async fp => { cleared.push(fp); } }), false);
  assert.equal(await clearYouTubeSuspensionIfCurrent('', 7, { currentGeneration: () => 7, clear: async fp => { cleared.push(fp); } }), false);
  assert.equal(await clearYouTubeSuspensionIfCurrent('key-a', 7, { currentGeneration: () => 7, clear: async fp => { cleared.push(fp); } }), true);
  assert.equal(cleared.length, 1);
  assert.ok(/^[0-9a-f]{32}$/.test(cleared[0]), 'clear addresses the key fingerprint, never the key');
  // A failing clear propagates so the caller (which swallows it) keeps the
  // row; a missed clear only delays rehabilitation.
  await assert.rejects(clearYouTubeSuspensionIfCurrent('key-a', 7, { currentGeneration: () => 7, clear: async () => { throw new Error('db down'); } }), /db down/);
  // The reader awaits the gated clear with the response generation instead
  // of fire-and-forget deleting by fingerprint alone.
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const reader = youtube.slice(youtube.indexOf('export async function readYouTubeJsonObject'), youtube.indexOf('/** A request-rate limit'));
  assert.match(reader, /await clearYouTubeSuspensionIfCurrent\(context\.providerKey, context\.providerFailureGeneration\)\.catch\(\(\) => undefined\)/);
  assert.doesNotMatch(reader, /clearYouTubeProviderSuspension\(fingerprintYouTubeKey\(context\.providerKey\)\)/);
});

test('failed hydration loads reject so the gate retries instead of caching zeros', async () => {
  await assert.rejects(hydrateYouTubeProviderSuspensions(async () => { throw new Error('db down'); }), /db down/);
  const empty = await hydrateYouTubeProviderSuspensions(async () => []);
  assert.deepEqual(empty, { restored: 0, skipped: 0 });
  const unknown = await hydrateYouTubeProviderSuspensions(async () => [
    { keyFingerprint: 'gone-key-fp', retryAfter: null },
    { keyFingerprint: 'other-gone-fp', retryAfter: new Date(Date.now() + 60_000).toISOString() },
  ]);
  assert.equal(unknown.restored + unknown.skipped, 2, 'unresolvable rows are skipped, never applied to the wrong key');
  // ensure() drops the fallback after a failed load so a later dispatch
  // retries once the database recovers; successes stay cached.
  const health = readFileSync(new URL('./youtubeKeyHealth.ts', import.meta.url), 'utf8');
  const gate = health.slice(health.indexOf('export function ensureYouTubeSuspensionHydration'), health.indexOf('/** Restores durable suspensions'));
  assert.match(gate, /sharedSuspensionHydration = null;/);
});

test('uploads adapter prefers the video publication time over the playlist-add time', () => {
  const adapted = adaptPlaylistItemsToSearchShape({
    items: [
      {
        snippet: { title: 'v1', publishedAt: '2026-09-10T00:00:00.000Z', resourceId: { videoId: 'vid1' } },
        contentDetails: { videoPublishedAt: '2026-09-01T00:00:00.000Z' },
      },
      {
        snippet: { title: 'v2', publishedAt: '2026-09-10T00:00:00.000Z', resourceId: { videoId: 'vid2' } },
      },
    ],
  });
  assert.equal(adapted.items[0].snippet.publishedAt, '2026-09-01T00:00:00.000Z', 'videoPublishedAt wins when present');
  assert.equal(adapted.items[1].snippet.publishedAt, '2026-09-10T00:00:00.000Z', 'snippet time remains the fallback');
  assert.equal(adapted.items[0].id.videoId, 'vid1');
  const invalid = adaptPlaylistItemsToSearchShape({
    items: [{ snippet: { publishedAt: '2026-09-10T00:00:00.000Z', resourceId: { videoId: 'vid3' } }, contentDetails: { videoPublishedAt: 'not-a-date' } }],
  });
  assert.equal(invalid.items[0].snippet.publishedAt, '2026-09-10T00:00:00.000Z', 'unparsable videoPublishedAt keeps the fallback');
  // The uploads request must fetch the contentDetails part (no extra quota:
  // list-call cost is per call, not per part) so the adapter can see it.
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.match(youtube, /buildYouTubeApiUrl\('playlistItems',apiKey,\{part:'snippet,contentDetails',playlistId:String\(uploadsPlaylistId\)/);
});
