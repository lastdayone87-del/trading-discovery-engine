import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseEnrichmentBacklog } from './enrichmentBacklogDiagnosis';
import { ENRICHMENT_DIAGNOSTIC_QUERIES } from './enrichmentBacklogDiagnostics';
import { routePolicyInventory } from './operatorAuth';

test('diagnostic SQL is SELECT-only',()=>{
  for(const sql of Object.values(ENRICHMENT_DIAGNOSTIC_QUERIES)){
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
