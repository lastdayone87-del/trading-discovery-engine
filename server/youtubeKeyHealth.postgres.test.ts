import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearYouTubeProviderSuspension,
  isYouTubeInputQuarantined,
  loadActiveYouTubeProviderSuspensions,
  recordYouTubeInvalidInput,
  recordYouTubeProviderSuspension,
} from './dbCore';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

const QUARANTINE_VALUE = 'UCabcdefghijklmnopqrstuv';
const SUSPENSION_FP = 'test-fingerprint-0001';

maybe('invalid-input quarantine records, reads, and expires', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  t.after(async () => {
    await db.query(`DELETE FROM youtube_invalid_input_quarantine WHERE input_kind='channelId' AND input_value=$1`, [QUARANTINE_VALUE]);
  });
  assert.equal(await isYouTubeInputQuarantined('channelId', QUARANTINE_VALUE), false);
  await recordYouTubeInvalidInput('channelId', QUARANTINE_VALUE, 'channel-uploads', 60_000);
  assert.equal(await isYouTubeInputQuarantined('channelId', QUARANTINE_VALUE), true);
  await recordYouTubeInvalidInput('channelId', QUARANTINE_VALUE, 'channel-uploads', 60_000);
  const hits = await db.query(`SELECT hits FROM youtube_invalid_input_quarantine WHERE input_kind='channelId' AND input_value=$1`, [QUARANTINE_VALUE]);
  assert.equal(Number(hits.rows[0]?.hits), 2);
  // Expiry is honored without waiting: backdate and re-check.
  await db.query(`UPDATE youtube_invalid_input_quarantine SET expires_at=now()-interval '1 second' WHERE input_kind='channelId' AND input_value=$1`, [QUARANTINE_VALUE]);
  assert.equal(await isYouTubeInputQuarantined('channelId', QUARANTINE_VALUE), false);
  // Empty/invalid inputs are no-ops, never rows.
  await recordYouTubeInvalidInput('', '', 'channel-uploads', 60_000);
  await recordYouTubeInvalidInput('channelId', QUARANTINE_VALUE, 'channel-uploads', -1);
});

maybe('provider suspension records, hydrates while fresh, and clears', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  t.after(async () => {
    await db.query(`DELETE FROM youtube_provider_suspension WHERE key_fingerprint=$1`, [SUSPENSION_FP]);
  });
  await clearYouTubeProviderSuspension(SUSPENSION_FP);
  assert.deepEqual(await loadActiveYouTubeProviderSuspensions().then(rows => rows.filter(row => row.keyFingerprint === SUSPENSION_FP)), []);
  await recordYouTubeProviderSuspension({
    keyFingerprint: SUSPENSION_FP,
    keyIndex: 3,
    envName: 'YOUTUBE_API_KEY_2',
    quotaGroup: 'project-a',
    status: 'SUSPENDED',
    retryAfterMs: 7 * 24 * 60 * 60_000,
    reason: 'CONSUMER_SUSPENDED',
  });
  const active = await loadActiveYouTubeProviderSuspensions();
  const row = active.find(item => item.keyFingerprint === SUSPENSION_FP);
  assert.ok(row);
  assert.equal(row.keyIndex, 3);
  assert.equal(row.envName, 'YOUTUBE_API_KEY_2');
  assert.equal(row.quotaGroup, 'project-a');
  assert.equal(row.status, 'SUSPENDED');
  assert.equal(row.reason, 'CONSUMER_SUSPENDED');
  assert.equal(row.probeCount, 1);
  // Re-recording bumps the probe count and refreshes the horizon.
  await recordYouTubeProviderSuspension({ keyFingerprint: SUSPENSION_FP, reason: 'CONSUMER_SUSPENDED', retryAfterMs: 60_000 });
  const again = (await loadActiveYouTubeProviderSuspensions()).find(item => item.keyFingerprint === SUSPENSION_FP);
  assert.equal(again?.probeCount, 2);
  await clearYouTubeProviderSuspension(SUSPENSION_FP);
  assert.deepEqual((await loadActiveYouTubeProviderSuspensions()).filter(item => item.keyFingerprint === SUSPENSION_FP), []);
});
