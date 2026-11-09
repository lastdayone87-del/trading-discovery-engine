import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('confirmed unresolved-country rediscovery hydrates country evidence before preserving trading', () => {
  const pipeline = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  const confirmed = pipeline.indexOf('shouldRevalidateConfirmedCountry(existing, isManualScan)');
  const call = pipeline.indexOf('validateCountryWithHydration(candidate, existing, targetCountry, now, { includeAudience: false })', confirmed);
  assert.ok(confirmed > 0, 'confirmed-country revalidation branch exists');
  assert.ok(call > confirmed, 'confirmed branch uses the shared hydration helper');
  assert.match(pipeline, /fetchYouTubeChannelCountryMetadata\(candidate\.channelId, candidate\)/);
  assert.match(pipeline, /fetchLiveYouTubeChannelData\(candidate\.youtubeUrl\)/);
  assert.match(pipeline, /applyCandidateObservability\(existing, candidate\);\s*\n\s*confirmedCountryUpdated = true;/);
});

test('the confirmed country pass never invokes trading classification', () => {
  const pipeline = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  const start = pipeline.indexOf('shouldRevalidateConfirmedCountry(existing, isManualScan)');
  const end = pipeline.indexOf('const refreshedAudienceGate', start);
  const branch = pipeline.slice(start, end);
  assert.doesNotMatch(branch, /classifyTradingRelevance/);
  assert.doesNotMatch(branch, /enqueueJob/);
});
