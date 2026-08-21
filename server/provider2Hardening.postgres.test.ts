import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, reserveProviderRequest, settleProviderRequest } from './db';
import { BRAVE_DIRECT_PROVIDER, stageDiscoveredCandidates } from './braveSearch';

const enabled = Boolean(process.env.DATABASE_URL);

test('Provider 2 PostgreSQL reservation and settlement are replay-safe and distributed', { skip: !enabled }, async () => {
  const db = await getDb();
  await db.query("UPDATE discovery_provider_registry SET mode='SHADOW' WHERE provider_key='brave-search'");
  await db.query("UPDATE app_settings SET setting_value='1' WHERE setting_key='brave_concurrency_cap'");
  await db.query("UPDATE app_settings SET setting_value='100' WHERE setting_key='brave_per_cycle_request_cap'");
  await db.query("UPDATE app_settings SET setting_value='100' WHERE setting_key='brave_daily_cost_cap_usd'");
  await db.query("UPDATE app_settings SET setting_value='' WHERE setting_key='brave_cooldown_until'");
  await db.query("DELETE FROM provider_request_ledger WHERE request_id LIKE 'provider2-pg-test-%'");
  await db.query("DELETE FROM provider_budget_ledger WHERE provider_key='brave-search' AND cycle_key='default'");

  const first = await reserveProviderRequest({ provider: BRAVE_DIRECT_PROVIDER, requestId: 'provider2-pg-test-1' });
  const replay = await reserveProviderRequest({ provider: BRAVE_DIRECT_PROVIDER, requestId: 'provider2-pg-test-1' });
  assert.equal(replay.reservationId, first.reservationId);
  assert.equal(await settleProviderRequest(first.requestId, 'SUCCEEDED', 0.005), true);
  assert.equal(await settleProviderRequest(first.requestId, 'SUCCEEDED', 0.005), false);

  const concurrent = await Promise.allSettled([
    reserveProviderRequest({ provider: BRAVE_DIRECT_PROVIDER, requestId: 'provider2-pg-test-2' }),
    reserveProviderRequest({ provider: BRAVE_DIRECT_PROVIDER, requestId: 'provider2-pg-test-3' })
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
  const admitted = concurrent.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ requestId: string }>;
  await settleProviderRequest(admitted.value.requestId, 'FAILED', 0, 'TEST_FAILURE');
});

test('Provider 2 ACTIVE_GLOBAL mode and kill switch remain governed and reversible', { skip: !enabled }, async () => {
  const db = await getDb();
  await db.query("UPDATE discovery_provider_registry SET mode='ACTIVE_GLOBAL', updated_by='test:provider2-active-global' WHERE provider_key='brave-search'");
  await db.query("UPDATE app_settings SET setting_value='false' WHERE setting_key='brave_kill_switch'");
  const active = await db.query("SELECT mode FROM discovery_provider_registry WHERE provider_key='brave-search'");
  assert.equal(active.rows[0].mode, 'ACTIVE_GLOBAL');
  await db.query("UPDATE app_settings SET setting_value='true' WHERE setting_key='brave_kill_switch'");
  const kill = await db.query("SELECT setting_value FROM app_settings WHERE setting_key='brave_kill_switch'");
  assert.equal(kill.rows[0].setting_value, 'true');
  await db.query("UPDATE app_settings SET setting_value='false' WHERE setting_key='brave_kill_switch'");
  await db.query("UPDATE discovery_provider_registry SET mode='SHADOW', updated_by='test:provider2-rollback' WHERE provider_key='brave-search'");
  const restored = await db.query("SELECT mode FROM discovery_provider_registry WHERE provider_key='brave-search'");
  assert.equal(restored.rows[0].mode, 'SHADOW');
});

test('Provider 2 PostgreSQL staging converges canonical identity while retaining observations', { skip: !enabled }, async () => {
  const db = await getDb();
  await db.query("DELETE FROM discovery_candidate_observations WHERE opportunity_key LIKE 'provider2-pg-test-%'");
  await db.query("DELETE FROM discovery_candidate_staging WHERE canonical_candidate_key=encode(digest('YOUTUBE_CHANNEL:UC1234567890123456789012','sha256'),'hex')");
  const candidate = {
    candidateType: 'CHANNEL_ID' as const,
    normalizedIdentity: 'UC1234567890123456789012',
    rawLocator: 'https://www.youtube.com/channel/UC1234567890123456789012',
    title: 'Derived title',
    snippet: 'Derived snippet',
    discoveryMode: 'DIRECT_YOUTUBE' as const,
    confidence: 1,
    isNoise: false
  };
  const [direct, osint] = await Promise.all([
    stageDiscoveredCandidates([candidate], { providerKey: 'brave-search', retrievalSurface: 'BRAVE_YOUTUBE_DIRECT', providerCapability: 'SEARCH_BRAVE_DIRECT', opportunityKey: 'provider2-pg-test-direct', country: 'GB', language: 'en' }),
    stageDiscoveredCandidates([candidate], { providerKey: 'brave-search', retrievalSurface: 'BRAVE_EXTERNAL_OSINT', providerCapability: 'SEARCH_BRAVE_EXTERNAL_OSINT', opportunityKey: 'provider2-pg-test-osint', country: 'US', language: 'en' })
  ]);
  const canonical = await db.query("SELECT COUNT(*)::int AS count FROM discovery_candidate_staging WHERE normalized_identity='UC1234567890123456789012'");
  const observations = await db.query("SELECT COUNT(*)::int AS count FROM discovery_candidate_observations WHERE normalized_identity='UC1234567890123456789012'");
  assert.equal(direct.stagedCount + osint.stagedCount, 1);
  assert.equal(Number(canonical.rows[0].count), 1);
  assert.equal(Number(observations.rows[0].count), 2);
});
