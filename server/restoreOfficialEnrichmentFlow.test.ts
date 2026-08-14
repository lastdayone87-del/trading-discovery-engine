import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('server/db/migrations/088_restore_official_enrichment_flow.sql', 'utf8');
const providerCostRecoveryMigration = readFileSync('server/db/migrations/093_recover_cached_enrichment_provider_cost.sql', 'utf8');
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
  assert.match(queueManager, /const candidateAlreadyEnriched=Number\(candidate\.enrichmentStage\|\|0\)>=enrichmentStage/);
  assert.match(queueManager, /const enrichmentQuotaUnits=candidateAlreadyEnriched\?0:\(enrichmentStage>=2\?202:101\)/);
  assert.match(queueManager, /operationType:\s*'ENRICH_CHANNEL'/);
  assert.match(queueManager, /candidateAlreadyEnriched\?candidate:await fetchYouTubeChannelEnrichment\(channelId,candidate,enrichmentStage/);
  assert.doesNotMatch(queueManager, /hybridEnrichmentEnabled|fetchYouTubeChannelEnrichmentQuotaFree|youtube_js_hybrid_enrichment_enabled|YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED/);
  assert.match(youtube, /export async function fetchYouTubeChannelEnrichment\(/);
  assert.doesNotMatch(youtube, /fetchInnerTubeChannelEnrichment|youtube_js_hybrid_enrichment_enabled|YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED/);
});

test('cached enrichment recovery attributes durable consumed quota to VOI outcome cost', () => {
  assert.match(providerCostRecoveryMigration, /NEW\.status\s*=\s*'SUCCEEDED'/);
  assert.match(providerCostRecoveryMigration, /COALESCE\(NEW\.provider_cost,\s*0\)\s*=\s*0/);
  assert.match(providerCostRecoveryMigration, /FROM quota_reservations qr/);
  assert.match(providerCostRecoveryMigration, /qr\.operation_type\s*=\s*'ENRICH_CHANNEL'/);
  assert.match(providerCostRecoveryMigration, /qr\.operation_id\s*=\s*NEW\.job_id::text/);
  assert.match(providerCostRecoveryMigration, /qr\.status\s*=\s*'CONSUMED'/);
  assert.match(providerCostRecoveryMigration, /NEW\.provider_cost\s*:=\s*recovered_units/);
  assert.match(providerCostRecoveryMigration, /BEFORE INSERT ON evidence_acquisition_outcomes/);
});

test('rollback does not disable autonomous discovery scheduler', () => {
  assert.match(autonomous, /export function startAutonomousDiscoveryScheduler\(\): void/);
  assert.match(autonomous, /await runAutonomousDiscoveryCycle\(\)/);
  assert.doesNotMatch(migration, /query_intelligence_paused|autonomous_discovery|discovery_interval_minutes/);
});
