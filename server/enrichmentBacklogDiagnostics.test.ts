import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseEnrichmentBacklog } from './enrichmentBacklogDiagnosis';
import { CLASSIFICATION_DIAGNOSTIC_QUERIES, ENRICHMENT_DIAGNOSTIC_QUERIES } from './enrichmentBacklogDiagnostics';
import { routePolicyInventory } from './operatorAuth';

test('diagnostic SQL is SELECT-only',()=>{
  for(const sql of [...Object.values(ENRICHMENT_DIAGNOSTIC_QUERIES), ...Object.values(CLASSIFICATION_DIAGNOSTIC_QUERIES)]){
    const normalized=sql.trim().toUpperCase();
    assert.ok(normalized.startsWith('SELECT')||normalized.startsWith('WITH'));
    assert.equal(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/.test(normalized),false);
  }
});

test('diagnostic route is operator authenticated',()=>{
  const route=routePolicyInventory.find(r=>r.action==='diagnostics.enrichment-backlog.read');
  assert.ok(route);
  assert.equal(route?.method,'GET');
  assert.equal(route?.policy,'operator');
});

test('persisted states classify runnable, backoff, lease, and operational retry',()=>{
  const now=Date.parse('2026-08-13T12:00:00Z');
  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T11:59:00Z',runnable:true},now),'RUNNABLE_WAITING');
  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T12:30:00Z',runnable:false},now),'PROVIDER_BACKOFF');
  assert.equal(diagnoseEnrichmentBacklog({status:'RUNNING',runAfter:'2026-08-13T11:00:00Z',runnable:false,lockedBy:'worker',lockedAt:'2026-08-13T11:55:00Z'},now),'ACTIVE_LEASE');
  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T11:59:00Z',runnable:true,stepState:'RETRYING',failureClass:'PROVIDER_TIMEOUT'},now),'OPERATIONAL_RETRY');
});

test('classification retries are diagnosed from the job attempt and provider error class',()=>{
  const now=Date.parse('2026-08-13T12:00:00Z');
  // Classification jobs have no investigation step: the durable attempt count
  // plus the provider error class is the only retry evidence available.
  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T11:59:00Z',runnable:true,attempts:2,failureClass:'PROVIDER_RATE_LIMIT'},now),'OPERATIONAL_RETRY');
  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T11:59:00Z',runnable:true,attempts:2,lastError:'request timeout'},now),'OPERATIONAL_RETRY');
  // A deferred retry is still a provider backoff, not a never-claimed job.
  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T12:30:00Z',runnable:false,attempts:2,failureClass:'PROVIDER_RATE_LIMIT'},now),'PROVIDER_BACKOFF');
  // Non-operational errors keep the plain runnable label.
  assert.equal(diagnoseEnrichmentBacklog({status:'PENDING',runAfter:'2026-08-13T11:59:00Z',runnable:true,attempts:2,lastError:'channel not found'},now),'RUNNABLE_WAITING');
});

test('diagnostic SQL is built once per job type',()=>{
  assert.match(CLASSIFICATION_DIAGNOSTIC_QUERIES.aggregate,/type='CLASSIFY_DISCOVERED_CHANNEL'/);
  assert.match(CLASSIFICATION_DIAGNOSTIC_QUERIES.throughput,/j\.type='CLASSIFY_DISCOVERED_CHANNEL'/);
  assert.match(CLASSIFICATION_DIAGNOSTIC_QUERIES.oldest,/j\.type='CLASSIFY_DISCOVERED_CHANNEL'/);
  assert.equal(
    ENRICHMENT_DIAGNOSTIC_QUERIES.aggregate.replace("type='ENRICH_CHANNEL'","type='CLASSIFY_DISCOVERED_CHANNEL'"),
    CLASSIFICATION_DIAGNOSTIC_QUERIES.aggregate,
    'both queue views share one definition',
  );
});
