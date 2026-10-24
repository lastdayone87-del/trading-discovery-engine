import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OfficialYouTubeQuotaFenceError,
  assertOfficialYouTubeQuotaOriginKnown,
  currentOfficialYouTubeQuotaOrigin,
  isOfficialYouTubeQuotaOriginKnown,
  isProbeOfficialYouTubeQuotaOrigin,
  mergeQuotaOrigins,
  persistedQuotaOrigin,
  runWithOfficialYouTubeQuotaOrigin,
} from './officialYouTubeQuotaFence';
import {
  getChannelQuotaOrigin,
  resolveJobQuotaOrigin,
  resolvePipelineQuotaOrigin,
  type QuotaOriginDb,
} from './quotaOrigin';

test('origin merge is sticky: PROBE wins, UNKNOWN fails closed over NORMAL', () => {
  assert.equal(mergeQuotaOrigins('NORMAL', 'PROBE'), 'PROBE');
  assert.equal(mergeQuotaOrigins('PROBE', 'UNKNOWN'), 'PROBE');
  assert.equal(mergeQuotaOrigins('NORMAL', 'UNKNOWN'), 'UNKNOWN');
  assert.equal(mergeQuotaOrigins(undefined, 'NORMAL'), 'NORMAL');
});

test('ALS refuses to downgrade PROBE and fails closed without provenance', () => {
  assert.equal(currentOfficialYouTubeQuotaOrigin(), 'NORMAL');
  runWithOfficialYouTubeQuotaOrigin('PROBE', 'outer', () => {
    assert.equal(isProbeOfficialYouTubeQuotaOrigin(), true);
    runWithOfficialYouTubeQuotaOrigin('NORMAL', 'inner', () => {
      assert.equal(currentOfficialYouTubeQuotaOrigin(), 'PROBE');
    });
  });
  runWithOfficialYouTubeQuotaOrigin('UNKNOWN', 'unknown', () => {
    assert.equal(isOfficialYouTubeQuotaOriginKnown(), false);
    assert.throws(
      () => assertOfficialYouTubeQuotaOriginKnown('test'),
      (error: unknown) => error instanceof OfficialYouTubeQuotaFenceError
    );
  });
  assert.equal(persistedQuotaOrigin('UNKNOWN'), 'PROBE');
});

test('job origin: payload PROBE is sticky; persisted PROBE upgrades NORMAL', async () => {
  let queries = 0;
  const db: QuotaOriginDb = {
    query: async () => {
      queries++;
      return { rows: [{ channel_id: 'probe-channel', quota_origin: 'PROBE' }], rowCount: 1 };
    },
  };
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'probe-channel', quotaOrigin: 'PROBE' } }, db), 'PROBE');
  assert.equal(queries, 0, 'explicit PROBE evidence does not need a read');
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'probe-channel' } }, db), 'PROBE');
  assert.equal(queries, 1);
});

test('job origin: missing channel, malformed hint, or DB failure is UNKNOWN', async () => {
  const missing: QuotaOriginDb = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'gone' } }, missing), 'UNKNOWN');
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'x', quotaOrigin: 'something' } }, missing), 'UNKNOWN');
  const failing: QuotaOriginDb = { query: async () => { throw new Error('db down'); } };
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'x' } }, failing), 'UNKNOWN');
  assert.equal(await resolveJobQuotaOrigin({ type: 'SEARCH_YOUTUBE', payload: {} }, failing), 'NORMAL');
});

test('non-channel canary jobs default to NORMAL and still honor an explicit PROBE hint', async () => {
  const neverQueried: QuotaOriginDb = {
    query: async () => { throw new Error('non-channel jobs must not query channel provenance'); },
  };
  assert.equal(
    await resolveJobQuotaOrigin({ type: 'INSPECT_PLAYLIST', payload: { playlistId: 'PL123' } }, neverQueried),
    'NORMAL',
    'playlist canaries have their own adapter budget and no channel row'
  );
  assert.equal(
    await resolveJobQuotaOrigin({
      type: 'RELATIONSHIP_CANARY_EXPANSION',
      payload: { cohortId: 'cohort-1', seeds: [{ kind: 'channel', id: `UC${'a'.repeat(22)}` }] },
    }, neverQueried),
    'NORMAL',
    'relationship canaries are ordinary-quota jobs unless explicitly marked'
  );
  assert.equal(
    await resolveJobQuotaOrigin({ type: 'INSPECT_PLAYLIST', payload: { playlistId: 'PL123', quotaOrigin: 'PROBE' } }, neverQueried),
    'PROBE',
    'an explicit probe-origin hint remains authoritative'
  );
});

test('pipeline origin: existing PROBE is sticky; malformed persisted marker fails closed', async () => {
  const probe: QuotaOriginDb = { query: async () => ({ rows: [{ quota_origin: 'PROBE' }], rowCount: 1 }) };
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'c' }, undefined, probe), 'PROBE');
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'c', quotaOrigin: 'NORMAL' }, undefined, probe), 'PROBE');

  const malformed: QuotaOriginDb = { query: async () => ({ rows: [{ quota_origin: 'weird' }], rowCount: 1 }) };
  assert.equal(await getChannelQuotaOrigin('c', malformed), 'UNKNOWN');
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'c' }, undefined, malformed), 'UNKNOWN');

  const absent: QuotaOriginDb = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'new' }, undefined, absent), 'NORMAL');
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'new', quotaOrigin: 'PROBE' }, undefined, absent), 'PROBE');
});
