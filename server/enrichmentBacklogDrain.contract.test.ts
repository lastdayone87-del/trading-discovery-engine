import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Gemini rate pressure cannot monopolize an enrichment worker for the full cooldown by default',()=>{
  const source=fs.readFileSync(new URL('./providerResilience.ts',import.meta.url),'utf8');
  assert.match(source,/GEMINI_SEMANTIC_MAX_INLINE_WAIT_MS', 8000/);
  assert.doesNotMatch(source,/GEMINI_SEMANTIC_MAX_INLINE_WAIT_MS', 90000/);
});

test('paid YouTube enrichment is durably cached and its reservation is closed at the same boundary',()=>{
  const source=fs.readFileSync(new URL('./queueManager.ts',import.meta.url),'utf8');
  const payloadWrite=source.indexOf("UPDATE jobs SET payload=jsonb_set(payload,'{candidate}'");
  const persistedFlag=source.indexOf('acquisitionPersisted=true',payloadWrite);
  const consume=source.indexOf("finishQuotaReservation('ENRICH_CHANNEL',job.id,true)",persistedFlag);
  const pipeline=source.indexOf('processChannelThroughPipeline(enriched,targetCountry,source,false,true)',consume);
  assert.ok(payloadWrite>=0&&persistedFlag>payloadWrite&&consume>persistedFlag&&pipeline>consume);
  assert.match(source,/candidateAlreadyEnriched\?candidate:await fetchYouTubeChannelEnrichment/);
  assert.match(source,/else \{[\s\S]*?finishQuotaReservation\('ENRICH_CHANNEL',job\.id,true\);[\s\S]*?\}[\s\S]*?const pipelineOutcome=/);
});

test('a crash after payload persistence cannot release already-consumed quota',()=>{
  const source=fs.readFileSync(new URL('./queueManager.ts',import.meta.url),'utf8');
  assert.match(source,/let acquisitionPersisted=candidateAlreadyEnriched/);
  assert.match(source,/if\(quotaReserved\)await finishQuotaReservation\('ENRICH_CHANNEL',job\.id,acquisitionPersisted\)/);
});

test('expired cached enrichment reservations are restored to consumed and retain provider cost',()=>{
  const migration=fs.readFileSync(new URL('./db/migrations/093_recover_cached_enrichment_provider_cost.sql',import.meta.url),'utf8');
  assert.match(migration,/OLD\.status = 'RESERVED'[\s\S]*?NEW\.status = 'EXPIRED'[\s\S]*?NEW\.operation_type = 'ENRICH_CHANNEL'/);
  assert.match(migration,/payload->'candidate'->>'enrichmentStage'/);
  assert.match(migration,/NEW\.status := 'CONSUMED'/);
  assert.match(migration,/status IN \('RESERVED','EXPIRED'\)[\s\S]*?RETURNING units INTO recovered_units/);
  assert.match(migration,/NEW\.provider_cost := recovered_units/);
});
