import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const restoreEnrichment = readFileSync(new URL('./db/migrations/088_restore_official_enrichment_flow.sql', import.meta.url), 'utf8');
const restoreAutonomous = readFileSync(new URL('./db/migrations/089_restore_autonomous_data_api_routing.sql', import.meta.url), 'utf8');

test('retained quota-free provider paths fail closed when persisted settings are absent', () => {
  assert.match(queueManager, /getAppSetting\('youtube_inner_tube_autonomous_enabled',[^\n]*\|\|'false'\)/);
  assert.match(queueManager, /getAppSetting\('youtube_js_hybrid_enrichment_enabled',[^\n]*\|\|'false'\)/);
  assert.doesNotMatch(queueManager, /YOUTUBE_INNERTUBE_AUTONOMOUS_ENABLED\s*\|\|\s*'true'/);
  assert.doesNotMatch(queueManager, /YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED\s*\|\|\s*'true'/);
});

test('persisted rollback migrations keep both production routes disabled', () => {
  assert.match(restoreAutonomous, /VALUES \('youtube_inner_tube_autonomous_enabled', 'false'\)/);
  assert.match(restoreEnrichment, /VALUES \('youtube_js_hybrid_enrichment_enabled', 'false'\)/);
});

test('official autonomous routing contract remains present behind the disabled InnerTube branch', () => {
  assert.match(queueManager, /operationType:\s*'SEARCH_YOUTUBE'/);
  assert.match(queueManager, /units:\s*100/);
  assert.match(queueManager, /searchYouTubeChannelPage/);
  assert.match(queueManager, /evaluateContinuation/);
  assert.match(queueManager, /finishQuotaReservation/);
});
