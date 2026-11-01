import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectChannelVideoDescriptions,
  type InnertubeShadowSession,
} from './youtubeInnertubeDescriptions';

function stubSession(overrides: Partial<InnertubeShadowSession> = {}): InnertubeShadowSession & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listChannelVideos: async (channelId: string) => {
      calls.push(`list:${channelId}`);
      return { videos: [{ id: 'v1', title: 'one' }, { id: 'v2', title: 'two' }, { id: 'v3', title: 'three' }] };
    },
    fetchVideoDescription: async (videoId: string) => {
      calls.push(`desc:${videoId}`);
      if (videoId === 'v2') return null;
      return { description: `Description for ${videoId}` };
    },
    ...overrides,
  };
}

const noWait = { wait: async () => undefined, intervalMs: 0 };

test('recovers descriptions across listed videos with call accounting', async () => {
  const session = stubSession();
  const result = await collectChannelVideoDescriptions(session, 'UCtest', { ...noWait, maxVideos: 10 });
  assert.equal(result.failed, false);
  assert.equal(result.videosListed, 3);
  assert.equal(result.videosAttempted, 3);
  assert.equal(result.descriptionsRecovered, 2);
  assert.equal(result.calls, 4);
  assert.equal(result.callsPerDescription, 2);
  assert.equal(result.notFound, 1);
  assert.deepEqual(session.calls, ['list:UCtest', 'desc:v1', 'desc:v2', 'desc:v3']);
});

test('listing failure fails the channel fast with the error preserved', async () => {
  const session = stubSession({
    listChannelVideos: async () => { throw Object.assign(new Error('Tab "videos" not found'), { status: 404 }); },
  });
  const result = await collectChannelVideoDescriptions(session, 'UCempty', noWait);
  assert.equal(result.failed, true);
  assert.match(result.error || '', /Tab "videos" not found/);
  assert.equal(result.calls, 1);
  assert.ok(result.latencyMs.totalMs >= 0);
  assert.equal(result.callsPerDescription, null);
});

test('malformed listing shape is a parse failure, not a crash', async () => {
  const session = stubSession({ listChannelVideos: async () => ({ videos: 'nope' }) as any });
  const result = await collectChannelVideoDescriptions(session, 'UCbad', noWait);
  assert.equal(result.failed, true);
  assert.equal(result.parseFailures, 1);
});

test('429s are counted and skipped without aborting the channel', async () => {
  const session = stubSession({
    fetchVideoDescription: async (videoId: string) => {
      if (videoId === 'v1') throw Object.assign(new Error('Too many requests'), { status: 429 });
      return { description: `Description for ${videoId}` };
    },
  });
  const result = await collectChannelVideoDescriptions(session, 'UCrate', noWait);
  assert.equal(result.rateLimited, 1);
  assert.equal(result.descriptionsRecovered, 2);
  assert.equal(result.failed, false);
});

test('blank descriptions count as unavailable, session errors fire the callback', async () => {
  let invalidations = 0;
  const session = stubSession({
    fetchVideoDescription: async (videoId: string) => {
      if (videoId === 'v1') throw new Error('Session expired, please refresh visitor data');
      if (videoId === 'v2') return { description: '   ' };
      return { description: `Description for ${videoId}` };
    },
    onSessionError: () => { invalidations += 1; },
  });
  const result = await collectChannelVideoDescriptions(session, 'UCsess', noWait);
  assert.equal(result.sessionErrors, 1);
  assert.equal(invalidations, 1);
  assert.equal(result.notFound, 1);
  assert.equal(result.descriptionsRecovered, 1);
});

test('maxVideos bounds per-channel call volume', async () => {
  const session = stubSession();
  const result = await collectChannelVideoDescriptions(session, 'UCcap', { ...noWait, maxVideos: 2 });
  assert.equal(result.videosAttempted, 2);
  assert.equal(result.calls, 3);
});

test('hanging calls time out without hanging the channel', async () => {
  const session = stubSession({
    fetchVideoDescription: () => new Promise(() => undefined) as Promise<{ description: string } | null>,
  });
  const started = Date.now();
  const result = await collectChannelVideoDescriptions(session, 'UCslow', { intervalMs: 0, timeoutMs: 1000, maxVideos: 1 });
  assert.equal(result.timeouts, 1);
  assert.ok(Date.now() - started < 15000);
});

test('shadow module touches no database, queue, or browser runtime', () => {
  const source = readFileSync(new URL('./youtubeInnertubeDescriptions.ts', import.meta.url), 'utf8');
  for (const forbidden of ['./db', 'queueManager', 'playwright', 'crawlee', 'browserCommunityFallback', 'enqueueJob', 'getDb']) {
    assert.ok(!source.includes(forbidden), `shadow helper must not reference ${forbidden}`);
  }
});
