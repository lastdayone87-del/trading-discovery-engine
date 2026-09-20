import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  YOUTUBE_INPUT_QUARANTINE_TTL_MS,
  YOUTUBE_SUSPENSION_RETRY_AFTER_MS,
  advanceYouTubeRotation,
  annotateYouTubeErrorMetadata,
  buildYouTubeTelemetryMetadata,
  extractYouTubeQuarantineInput,
  isYouTubeInputFailure,
  normalizeYouTubeQuarantineInput,
  youtubeDeploymentId,
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

test('search queries normalize case-insensitively and truncate', () => {
  assert.equal(normalizeYouTubeQuarantineInput('searchQuery', '  OBX   Aksjehandel '), 'obx aksjehandel');
  assert.equal(normalizeYouTubeQuarantineInput('searchQuery', '   '), null);
  assert.equal(normalizeYouTubeQuarantineInput('searchQuery', undefined), null);
  const long = normalizeYouTubeQuarantineInput('searchQuery', 'x'.repeat(500));
  assert.ok(long && long.length <= 120);
});

test('quarantine input extraction prefers channel identity, falls back to query', () => {
  assert.deepEqual(
    extractYouTubeQuarantineInput('channel-uploads', 'https://youtube.googleapis.com/youtube/v3/search?part=snippet&channelId=UCabcdefghijklmnopqrstuv&key=K'),
    { kind: 'channelId', value: 'UCabcdefghijklmnopqrstuv' },
  );
  assert.deepEqual(
    extractYouTubeQuarantineInput('channel-details', 'https://youtube.googleapis.com/youtube/v3/channels?part=snippet&id=UCabcdefghijklmnopqrstuv&key=K'),
    { kind: 'channelId', value: 'UCabcdefghijklmnopqrstuv' },
  );
  assert.deepEqual(
    extractYouTubeQuarantineInput('search', 'https://youtube.googleapis.com/youtube/v3/search?part=snippet&q=OBX+Aksjehandel&key=K'),
    { kind: 'searchQuery', value: 'obx aksjehandel' },
  );
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
