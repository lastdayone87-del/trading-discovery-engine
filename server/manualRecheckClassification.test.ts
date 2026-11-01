import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const ingestion = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
const recheck = queue.slice(queue.indexOf('export async function triggerManualRecheck'), queue.indexOf('export interface SearchExecutionResult'));

test('manual recheck acquires fresh creator metadata and reruns unified trading pipeline', () => {
  assert.match(recheck, /fetchYouTubeChannelEnrichment\(channelId, fallback, 1\)/);
  assert.match(recheck, /processChannelThroughPipeline\(freshCandidate, channel\.country, 'recheck', true, true\)/);
});

test('manual recheck establishes persisted provenance before official enrichment', () => {
  const fetchIndex = recheck.indexOf('fetchYouTubeChannelEnrichment(channelId, fallback, 1)');
  const originIndex = recheck.lastIndexOf('runWithOfficialYouTubeQuotaOrigin(', fetchIndex);
  assert.ok(fetchIndex >= 0 && originIndex >= 0 && originIndex < fetchIndex,
    'the persisted origin must wrap the enrichment fetch');
  const wrapper = recheck.slice(originIndex, fetchIndex);
  assert.match(wrapper, /channel\.quota_origin === 'PROBE' \? 'PROBE' : 'NORMAL'/);
});

test('manual recheck may continue community inspection only through the explicit degraded-classification fallback', () => {
  assert.match(recheck, /canContinueCommunityInspectionAfterDegradedManualClassification\(/);
  assert.match(recheck, /existingTradingStatus:\s*preserved\.trading_status/);
  assert.match(recheck, /errorCode:\s*code/);
  assert.match(recheck, /inspectAndValidateChannel\(preserved, freshCandidate, true, enableDebug, false\)/);
  assert.match(recheck, /MANUAL_RESCAN_COMMUNITY_INCOMPLETE/);
});

test('manual recheck does not enqueue autonomous corpus harvests', () => {
  assert.match(
    ingestion,
    /if \(extraction\.termHarvestEnabled && !isManualScan\) \{\s*await enqueueTermHarvest\(\{channelId:finalChannel\.channel_id,[\s\S]*?lineage:'AUTONOMOUS'\}\);/,
    'operator-triggered rechecks must not enter AUTONOMOUS corpus lineage',
  );
});

test('manual recheck preserves existing classification when fresh YouTube acquisition fails', () => {
  const acquisition = recheck.indexOf('fetchYouTubeChannelEnrichment');
  const pipeline = recheck.indexOf('processChannelThroughPipeline');
  assert.ok(acquisition >= 0 && pipeline > acquisition);
  assert.match(recheck, /MANUAL_RESCAN_UPSTREAM_FAILURE/);
  assert.match(recheck, /Existing trading classification was preserved/);
});

test('manual recheck still fails closed on degraded classifier provider coverage before diagnostic writes', () => {
  const classify = ingestion.indexOf('const productionClassification = await classifyTradingRelevanceDetailed(classifierInput);');
  const guard = ingestion.indexOf('manualRecheckDegradedError(productionClassification.decision.evidenceCollection)');
  const diagnostic = ingestion.indexOf('observeProductionDiagnosticReliably', classify);
  assert.ok(classify >= 0 && guard > classify && diagnostic > guard);
  const gate = readFileSync(new URL('./enrichmentOperationalFailure.ts', import.meta.url), 'utf8');
  assert.match(gate, /MANUAL_RESCAN_CLASSIFICATION_DEGRADED/);
});

test('manual recheck proceeds when a served fallback covers the degraded providers', () => {
  const gate = readFileSync(new URL('./enrichmentOperationalFailure.ts', import.meta.url), 'utf8');
  assert.match(gate, /uncoveredFailedProviders\(report\)/);
  assert.match(gate, /uncoveredFailedProviders\(collection\)/);
});
