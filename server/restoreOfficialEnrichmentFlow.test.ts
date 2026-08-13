import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('server/db/migrations/088_restore_official_enrichment_flow.sql', 'utf8');
const queueManager = readFileSync('server/queueManager.ts', 'utf8');
const youtube = readFileSync('server/youtube.ts', 'utf8');
const autonomous = readFileSync('server/autonomousDiscovery.ts', 'utf8');

test('migration 088 disables only the persisted hybrid enrichment flag', () => {
  assert.match(migration, /VALUES \('youtube_js_hybrid_enrichment_enabled', 'false'\)/);
  assert.doesNotMatch(migration, /UPDATE\s+jobs/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  assert.doesNotMatch(migration, /TRUNCATE/i);
});

test('hybrid false restores official quota-governed ENRICH_CHANNEL path', () => {
  assert.match(queueManager, /if\(hybridEnrichmentEnabled&&channel\.country_status==='CONFIRMED'\)/);
  assert.match(queueManager, /const enrichmentQuotaUnits=hybridEnrichmentEnabled\?1:\(enrichmentStage>=2\?202:101\)/);
  assert.match(youtube, /if\(!hybridEnabled\) return fetchYouTubeChannelEnrichmentOfficial\(channelId,fallback,stage\)/);
});

test('rollback does not disable autonomous discovery scheduler', () => {
  assert.match(autonomous, /export function startAutonomousDiscoveryScheduler\(\): void/);
  assert.match(autonomous, /await runAutonomousDiscoveryCycle\(\)/);
  assert.doesNotMatch(migration, /query_intelligence_paused|autonomous_discovery|discovery_interval_minutes/);
});
