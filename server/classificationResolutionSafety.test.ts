import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('request-rescan is authorized and supersedes the pending review', () => {
  const auth = read('./operatorAuth.ts');
  const store = read('./reviewStore.ts');
  assert.match(auth, /force-rescan\|request-rescan/);
  assert.match(store, /REQUEST_RESCAN'\) \{ if\(state!=='PENDING'\)[\s\S]*?return 'SUPERSEDED'/);
  assert.match(store, /input\.action==='APPROVE'\|\|input\.action==='REJECT'/);
  assert.match(store, /if\(input\.action!=='REQUEST_RESCAN'\)/);
});

test('recovery reuses the existing cooldown, cycle ceiling and active-job exclusion', () => {
  const recovery = read('./classificationResolutionRecovery.ts');
  assert.match(recovery, /CLASSIFICATION_RESOLUTION_RECOVERY_COOLDOWN_MS/);
  assert.match(recovery, /SKIP_COOLDOWN/);
  assert.match(recovery, /OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES/);
  assert.match(recovery, /NOT EXISTS\([\s\S]*?active\.status IN\('PENDING','PROCESSING'\)/);
  assert.match(recovery, /operational-enrichment-terminal:/);
  assert.match(recovery, /await client\.query\('BEGIN'\)[\s\S]*?enqueueOperationalEnrichmentRecoveryJob[\s\S]*?INSERT INTO operational_enrichment_recovery_events/);
});

test('exhausted review materialization records dashboard lineage and projection events', () => {
  const materializer = read('./reviewEligibility/exhaustedReview.ts');
  assert.match(materializer, /recordDashboardCorpusShadow/);
  assert.match(materializer, /review_eligibility_events/);
  assert.match(materializer, /input\.classificationDiagnosticId \|\| 'none'\}:\$\{checksum\}/);
  assert.match(materializer, /pg_advisory_xact_lock/);
  assert.match(materializer, /WHERE excluded\.decided_at >= review_eligibility_projection\.decided_at/);
  assert.match(materializer, /STALE_ELIGIBILITY_PROJECTION/);
});

test('the normal eligibility path preserves an exhausted pending review lineage', () => {
  const store = read('./reviewEligibility/store.ts');
  assert.match(store, /evidence_snapshot->>'reasonFamily'='EVIDENCE_EXHAUSTED'/);
  assert.match(store, /preservedExhaustedReview:true/);
  assert.match(store, /SELECT pg_advisory_xact_lock/);
});

test('recovery excludes active jobs and guards the permanent projection against races', () => {
  const recovery = read('./classificationResolutionRecovery.ts');
  assert.match(recovery, /AS has_active_job/);
  assert.match(recovery, /hasActiveJob: row\.has_active_job === true/);
  assert.match(recovery, /last_checked IS NOT DISTINCT FROM \$2::timestamptz/);
  assert.match(recovery, /if \(projected\.rowCount\) permanentFailures \+= 1/);
  assert.match(recovery, /terminalFailureClass === 'UNKNOWN'/);
});

test('the dry-run script is write-safe and validates flags', () => {
  const script = read('../scripts/reconcileClassificationResolution.ts');
  assert.match(script, /--apply'\) && !dryRunFlag/);
  assert.match(script, /--limit must be an integer/);
  assert.match(script, /--cutoff requires --include-legacy/);
  assert.match(script, /db\.end\(\)/);
});

test('the migration avoids a validated CHECK and blocking index build on jobs', () => {
  const migration = read('./db/migrations/180_classification_resolution_safety.sql');
  assert.doesNotMatch(migration, /ADD CONSTRAINT/);
  assert.doesNotMatch(migration, /CREATE INDEX/);
  assert.match(migration, /ALTER TABLE jobs[\s\S]*?ADD COLUMN IF NOT EXISTS terminal_failure_class/);
});
