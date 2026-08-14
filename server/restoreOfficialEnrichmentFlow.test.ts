import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('server/db/migrations/088_restore_official_enrichment_flow.sql', 'utf8');
const queueManager = readFileSync('server/queueManager.ts', 'utf8');
const youtube = readFileSync('server/youtube.ts', 'utf8');
const autonomous = readFileSync('server/autonomousDiscovery.ts', 'utf8');

test('migration 088 remains historical and non-destructive', () => {
  assert.match(migration, /VALUES \('youtube_js_hybrid_enrichment_enabled', 'false'\)/);
  assert.doesNotMatch(migration, /UPDATE\s+jobs/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  assert.doesNotMatch(migration, /TRUNCATE/i);
});

test('ENRICH_CHANNEL is unconditional official quota-governed enrichment', () => {
  assert.match(queueManager, /const enrichmentQuotaUnits=enrichmentStage>=2\?202:101/);
  assert.match(queueManager, /operationType:\s*'ENRICH_CHANNEL'/);
  assert.match(queueManager, /fetchYouTubeChannelEnrichment\(channelId, candidate,enrichmentStage\)/);
  assert.doesNotMatch(queueManager, /hybridEnrichmentEnabled|fetchYouTubeChannelEnrichmentQuotaFree|youtube_js_hybrid_enrichment_enabled|YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED/);
  assert.match(youtube, /export async function fetchYouTubeChannelEnrichment\(/);
  assert.doesNotMatch(youtube, /fetchInnerTubeChannelEnrichment|youtube_js_hybrid_enrichment_enabled|YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED/);
});

test('rollback does not disable autonomous discovery scheduler', () => {
  assert.match(autonomous, /export function startAutonomousDiscoveryScheduler\(\): void/);
  assert.match(autonomous, /await runAutonomousDiscoveryCycle\(\)/);
  assert.doesNotMatch(migration, /query_intelligence_paused|autonomous_discovery|discovery_interval_minutes/);
});
