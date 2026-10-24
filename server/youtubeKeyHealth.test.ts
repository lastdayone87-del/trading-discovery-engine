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
  isYouTubePageTokenFailure,
  isYouTubeQuotaAccountingError,
  normalizeYouTubeQuarantineInput,
  retryYouTubeQuotaAccounting,
  serializeYouTubeSuspensionWrite,
  shouldClearYouTubeSuspension,
  suspensionRestoreHorizonMs,
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
  assert.match(wrapper, /const shadowOperationId = getYouTubeResponseShadowOperationId\(response\);/);
  assert.match(wrapper, /incrementQuota\(unitsConsumed, providerKey, operationId, reservation \?\? shadowOperationId\)/);
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
  const batch = dbCore.slice(dbCore.indexOf('export async function deleteQuotaAccountingBatch'));
  assert.match(batch, /DELETE FROM youtube_quota_accounting_ops WHERE ctid IN \(SELECT ctid FROM youtube_quota_accounting_ops WHERE created_at </);
  assert.match(batch, /ORDER BY created_at LIMIT \$2/, 'oldest-first bounded batches, never one unbounded startup statement');
  const prune = dbCore.slice(dbCore.indexOf('export async function pruneYouTubeQuotaAccountingOps'));
  assert.match(prune, /deleteQuotaAccountingBatch\(db, retentionMs, perBatch\)/, 'wrapper loops over bounded batches');
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

test('page-token failures never quarantine the valid input they rode along with', () => {
  assert.equal(isYouTubePageTokenFailure({ providerReasons: ['invalidPageToken'] }), true);
  assert.equal(isYouTubePageTokenFailure({ providerReasons: ['quotaExceeded', 'invalidPageToken'] }), true);
  assert.equal(isYouTubePageTokenFailure({ providerReasons: ['invalidSearchFilter'] }), false);
  assert.equal(isYouTubePageTokenFailure({ providerReasons: [] }), false);
  assert.equal(isYouTubePageTokenFailure({}), false);
  assert.equal(isYouTubePageTokenFailure(null), false);
  assert.equal(isYouTubePageTokenFailure({ providerReasons: 'invalidPageToken' }), false, 'non-array reasons are ignored');
  // The hazard this guards: a search URL carrying a page token still
  // extracts the query identity, so without the guard a stale token would
  // quarantine a healthy query for 7 days of silent discovery gaps.
  const extracted = extractYouTubeQuarantineInput('search', 'https://youtube.googleapis.com/youtube/v3/search?part=snippet&q=OBX+Aksjehandel&pageToken=CAUQAA&key=K');
  assert.equal(extracted?.kind, 'searchQuery');
  assert.equal(extracted?.value, normalizeYouTubeQuarantineInput('searchQuery', 'OBX Aksjehandel'));
  // The record branch consults the guard; every other 400/404/422 still records.
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.match(youtube, /else if\(isYouTubeInputFailure\(error\) && !isYouTubePageTokenFailure\(error\)\)\{/);
});

test('suspension writes serialize so a newer durable row survives a gated clear', async () => {
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  // FIFO under interleaved awaits, and a rejection never breaks the chain.
  const order: string[] = [];
  await Promise.all([
    serializeYouTubeSuspensionWrite(async () => { await tick(); order.push('first'); }),
    serializeYouTubeSuspensionWrite(async () => { await tick(); order.push('second'); }),
  ]);
  assert.deepEqual(order, ['first', 'second']);
  await assert.rejects(serializeYouTubeSuspensionWrite(async () => { throw new Error('boom'); }), /boom/);
  const after: string[] = [];
  await serializeYouTubeSuspensionWrite(async () => { after.push('runs-after-rejection'); });
  assert.deepEqual(after, ['runs-after-rejection']);
  // Durable-row model over a Map standing in for the suspension table.
  // UNSERIALIZED (old behavior), staged deterministically: the recheck
  // passes, a concurrent record lands during the delete's await, the
  // delete lands last and wipes the fresh row.
  const rows = new Map<string, number>();
  const record = async (fp: string) => { await tick(); rows.set(fp, (rows.get(fp) || 0) + 1); };
  const remove = async (fp: string) => { await tick(); rows.delete(fp); };
  rows.set('fp', 1);
  const staleClear = (async () => { await tick(); await remove('fp'); })();
  await record('fp');
  await staleClear;
  assert.equal(rows.has('fp'), false, 'unserialized clear deletes the fresh row (reproduces the finding)');
  // SERIALIZED (fixed behavior), same staging: both writes share the
  // chain, so the record ordered after the clear recreates the row.
  rows.set('fp', 1);
  const gatedClear = serializeYouTubeSuspensionWrite(async () => { await tick(); await remove('fp'); });
  const concurrentRecord = serializeYouTubeSuspensionWrite(() => record('fp'));
  await Promise.all([gatedClear, concurrentRecord]);
  assert.equal(rows.get('fp'), 1, 'serialized writes preserve the newer suspension');
  // Production wiring: the persist path shares the chain with gated clears.
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.match(youtube, /serializeYouTubeSuspensionWrite\(\(\) => recordYouTubeProviderSuspension\(\{/);
});

test('suspended keys reprobe on a documented daily cadence (durable row is restart backup)', async () => {
  const { YouTubeProviderCooldown } = await import('./youtubeProviderCooldown');
  let now = 1_000_000;
  const cooldown = new YouTubeProviderCooldown({ initialRateLimitCooldownMs: 100, maxRateLimitCooldownMs: 400, now: () => now });
  cooldown.failed('key-a', 'CONSUMER_SUSPENDED');
  assert.equal(cooldown.eligible('key-a'), false);
  now += 24 * 60 * 60_000 - 1;
  assert.equal(cooldown.eligible('key-a'), false, 'still suspended just inside the 24h window');
  now += 1;
  assert.equal(cooldown.eligible('key-a'), true, 'reprobe due after 24h by design: 4xx probes cost no quota and re-suspend on failure');
  // The durable horizon stays 7 days: it backs restarts via hydration, it
  // was never a 7-day dispatch ban (migration 132 keeps in-memory authority
  // on the hot path), and the probe count exists precisely because periodic
  // reprobes are the intended liveness cadence.
  assert.equal(YOUTUBE_SUSPENSION_RETRY_AFTER_MS, 7 * 24 * 60 * 60_000);
  const migration = readFileSync(new URL('./db/migrations/132_youtube_key_health.sql', import.meta.url), 'utf8');
  assert.match(migration, /hot-path authority/);
});

test('restart hydration preserves the probe cadence instead of extending to the durable horizon', () => {
  const DAY = 24 * 60 * 60_000;
  const suspendedAt = 1_000_000_000;
  // Suspended 23h ago, restarted now: reprobe lands on the original
  // schedule (T+24h), not seven days out.
  assert.equal(
    suspensionRestoreHorizonMs({ retryAfterMs: suspendedAt + 7 * DAY, observedAtMs: suspendedAt, nowMs: suspendedAt + 23 * 3_600_000, probeIntervalMs: DAY }),
    suspendedAt + DAY,
  );
  // Durable horizon still wins when it arrives first (short custom horizon).
  assert.equal(
    suspensionRestoreHorizonMs({ retryAfterMs: suspendedAt + 3_600_000, observedAtMs: suspendedAt, nowMs: suspendedAt, probeIntervalMs: DAY }),
    suspendedAt + 3_600_000,
  );
  // Unknown suspension start falls back to one probe interval from restart.
  assert.equal(
    suspensionRestoreHorizonMs({ retryAfterMs: suspendedAt + 7 * DAY, observedAtMs: NaN, nowMs: suspendedAt, probeIntervalMs: DAY }),
    suspendedAt + DAY,
  );
  // Missing durable horizon restores the cadence cap alone.
  assert.equal(
    suspensionRestoreHorizonMs({ retryAfterMs: NaN, observedAtMs: suspendedAt, nowMs: suspendedAt, probeIntervalMs: DAY }),
    suspendedAt + DAY,
  );
});

test('hydration restores a pre-restart suspension on its original probe schedule', async () => {
  const { youtubeProviderCooldown } = await import('./youtubeProviderCooldown');
  const { fingerprintYouTubeKey } = await import('./youtubeQuotaAttribution');
  const DAY = 24 * 60 * 60_000;
  const key = 'test-hydration-cadence-key';
  const observedAt = new Date(Date.now() - 23 * 3_600_000).toISOString();
  const retryAfter = new Date(Date.now() + 6 * DAY + 23 * 3_600_000).toISOString();
  process.env.YOUTUBE_API_KEY = key;
  try {
    const summary = await hydrateYouTubeProviderSuspensions(async () => [
      { keyFingerprint: fingerprintYouTubeKey(key), retryAfter, observedAt },
    ]);
    assert.deepEqual(summary, { restored: 1, skipped: 0 });
    const status = youtubeProviderCooldown.status(key);
    assert.equal(status.status, 'Suspended');
    const expected = Date.parse(observedAt) + DAY;
    assert.ok(
      status.retryAt !== null && Math.abs(status.retryAt - expected) < 5_000,
      `hydrated retryAt must track the original probe schedule, got ${status.retryAt} want ~${expected}`,
    );
  } finally {
    delete process.env.YOUTUBE_API_KEY;
    youtubeProviderCooldown.succeeded(key);
    youtubeProviderCooldown.resolveSuspensionCandidate(key);
  }
});

test('expired suspension still clears its durable row on a genuinely current success', async () => {
  const { YouTubeProviderCooldown } = await import('./youtubeProviderCooldown');
  let now = 2_000_000;
  const cooldown = new YouTubeProviderCooldown({ initialRateLimitCooldownMs: 100, maxRateLimitCooldownMs: 400, now: () => now });
  cooldown.failed('key-expired', 'CONSUMER_SUSPENDED');
  assert.equal(cooldown.hasSuspensionCandidate('key-expired'), true);
  // The 24h quarantine lapses with no restart: active suspension is gone,
  // but the durable row (7d) is still out there.
  now += 24 * 60 * 60_000 + 1;
  assert.equal(cooldown.isSuspended('key-expired'), false, 'in-memory quarantine expired');
  assert.equal(cooldown.hasSuspensionCandidate('key-expired'), true, 'durable candidate remembered past expiry');
  // A probe dispatched now succeeds with the current generation.
  const generation = cooldown.failureGeneration('key-expired');
  assert.equal(cooldown.succeeded('key-expired', generation), true);
  const wasSuspended = cooldown.isSuspended('key-expired') || cooldown.hasSuspensionCandidate('key-expired');
  assert.equal(shouldClearYouTubeSuspension(true, wasSuspended), true, 'expired-then-recovered clears the durable row');
  // Confirmed clear resolves the candidate so later successes stay cheap.
  let cleared: string[] = [];
  assert.equal(await clearYouTubeSuspensionIfCurrent('key-expired', generation, {
    currentGeneration: () => cooldown.failureGeneration('key-expired'),
    clear: async fp => { cleared.push(fp); },
  }), true);
  assert.equal(cleared.length, 1);
  cooldown.resolveSuspensionCandidate('key-expired');
  assert.equal(cooldown.hasSuspensionCandidate('key-expired'), false);
  // A newer suspension between validation and clear still wins.
  cooldown.failed('key-expired', 'CONSUMER_SUSPENDED');
  const staleGeneration = cooldown.failureGeneration('key-expired');
  cooldown.failed('key-expired', 'CONSUMER_SUSPENDED');
  cleared = [];
  assert.equal(await clearYouTubeSuspensionIfCurrent('key-expired', staleGeneration, {
    currentGeneration: () => cooldown.failureGeneration('key-expired'),
    clear: async fp => { cleared.push(fp); },
  }), false, 'newer suspension survives a stale clear');
  assert.deepEqual(cleared, []);
  assert.equal(cooldown.hasSuspensionCandidate('key-expired'), true, 'unresolved candidate retained while suspended');
  cooldown.succeeded('key-expired');
  cooldown.resolveSuspensionCandidate('key-expired');
});

test('reader rehabilitates on candidate-aware suspension state', () => {
  // Production wiring: the success path consults the remembered candidate,
  // not just the active quarantine, before deciding a durable clear.
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const reader = youtube.slice(youtube.indexOf('export async function readYouTubeJsonObject'), youtube.indexOf('/** A request-rate limit'));
  assert.match(reader, /hasSuspensionCandidate\(context\.providerKey\)/);
});

test('a newer suspension racing the delete keeps its candidate', async () => {
  const { youtubeProviderCooldown } = await import('./youtubeProviderCooldown');
  const key = 'race-candidate-key';
  youtubeProviderCooldown.failed(key, 'CONSUMER_SUSPENDED');
  const validationGen = youtubeProviderCooldown.failureGeneration(key);
  // A newer suspension lands after validation but before the post-delete
  // recheck: the validated delete still runs, but the fresh candidate
  // must survive it for the next success to clear.
  let calls = 0;
  let cleared: string[] = [];
  try {
    const result = await clearYouTubeSuspensionIfCurrent(key, validationGen, {
      currentGeneration: () => (calls++ === 0 ? validationGen : validationGen + 1),
      clear: async fp => { cleared.push(fp); },
    });
    assert.equal(result, true, 'the validated delete still runs');
    assert.equal(cleared.length, 1);
    assert.equal(youtubeProviderCooldown.hasSuspensionCandidate(key), true, 'newer suspension candidate survives the stale clear');
  } finally {
    youtubeProviderCooldown.succeeded(key);
    youtubeProviderCooldown.resolveSuspensionCandidate(key);
  }
});

test('confirmed clear with a stable generation resolves the candidate', async () => {
  const { youtubeProviderCooldown } = await import('./youtubeProviderCooldown');
  const key = 'stable-candidate-key';
  youtubeProviderCooldown.failed(key, 'CONSUMER_SUSPENDED');
  const generation = youtubeProviderCooldown.failureGeneration(key);
  let cleared: string[] = [];
  try {
    assert.equal(await clearYouTubeSuspensionIfCurrent(key, generation, {
      currentGeneration: () => generation,
      clear: async fp => { cleared.push(fp); },
    }), true);
    assert.equal(cleared.length, 1);
    assert.equal(youtubeProviderCooldown.hasSuspensionCandidate(key), false, 'confirmed clear drops the candidate so later successes stay cheap');
  } finally {
    youtubeProviderCooldown.succeeded(key);
    youtubeProviderCooldown.resolveSuspensionCandidate(key);
  }
});
