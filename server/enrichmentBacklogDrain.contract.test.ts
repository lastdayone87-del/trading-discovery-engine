import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Gemini rate pressure cannot monopolize an enrichment worker for the full cooldown by default',()=>{
  const source=fs.readFileSync(new URL('./providerResilience.ts',import.meta.url),'utf8');
  assert.match(source,/GEMINI_SEMANTIC_MAX_INLINE_WAIT_MS', 8000/);
  assert.doesNotMatch(source,/GEMINI_SEMANTIC_MAX_INLINE_WAIT_MS', 90000/);
});

test('job-level semantic retry reuses the already paid YouTube enrichment payload',()=>{
  const source=fs.readFileSync(new URL('./queueManager.ts',import.meta.url),'utf8');
  assert.match(source,/candidateAlreadyEnriched=Number\(candidate\.enrichmentStage\|\|0\)>=enrichmentStage/);
  assert.match(source,/candidateAlreadyEnriched\?candidate:await fetchYouTubeChannelEnrichment/);
  assert.match(source,/payload=jsonb_set\(payload,'\{candidate\}'/);
  assert.match(source,/if\(quotaReserved\)await finishQuotaReservation/);
});
