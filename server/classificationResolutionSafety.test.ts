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
  assert.match(recovery, /date_trunc\('milliseconds', last_checked\)/);
  assert.match(recovery, /CLASSIFY_DISCOVERED_CHANNEL/);
  assert.match(recovery, /classification-resolution-failure:/);
  assert.doesNotMatch(recovery, /terminal_recovery_marker,\s*FROM channels/);
  assert.match(recovery, /AND \(\$3::boolean OR NOT \(/);
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

test('a stale exhaustion projection leaves a recoverable failed state', () => {
  const pipeline = read('./ingestionPipeline.ts');
  assert.match(pipeline, /review\.reason === 'STALE_ELIGIBILITY_PROJECTION'[\s\S]{0,400}projectBlockedEnrichmentScanStatus\(candidate\.channelId,'FAILED'/);
  assert.doesNotMatch(pipeline, /withheldChannel\.scan_status = 'FAILED'/);
});

test('the normal eligibility path preserves an exhausted pending review lineage', () => {
  const store = read('./reviewEligibility/store.ts');
  assert.match(store, /evidence_snapshot->>'reasonFamily'='EVIDENCE_EXHAUSTED'/);
  assert.match(store, /preservedExhaustedReview:true/);
  assert.match(store, /SET trading_status='NEEDS_REVIEW',scan_status='NEEDS_REVIEW'/);
  assert.match(store, /SELECT pg_advisory_xact_lock/);
});

test('recovery excludes active jobs and guards the permanent projection against races', () => {
  const recovery = read('./classificationResolutionRecovery.ts');
  assert.match(recovery, /hasActiveJob: false/);
  assert.match(recovery, /date_trunc\('milliseconds', last_checked\) IS NOT DISTINCT FROM date_trunc\('milliseconds', \$2::timestamptz\)/);
  assert.match(recovery, /if \(projected\.rowCount\) permanentFailures \+= 1/);
  assert.match(recovery, /terminalFailureClass === 'UNKNOWN'/);
  assert.match(recovery, /decision\.action === 'SKIP_COOLDOWN'/);
  assert.match(recovery, /country_status/);
  assert.match(recovery, /classification_resolution_recovery_item_failed/);
});

test('the maintenance sweep defaults to read-only until explicitly enabled', () => {
  const scheduler = read('./operationalMaintenanceScheduler.ts');
  assert.match(scheduler, /CLASSIFICATION_RESOLUTION_RECOVERY_APPLY/);
  assert.match(scheduler, /dryRun: !classificationResolutionRecoveryApplyEnabled\(\)/);
  assert.match(scheduler, /result\.failures > 0/);
});

test('the cooldown probe reserves its interval before scanning and skips hydrated jobs', () => {
  const queue = read('./queueManager.ts');
  assert.match(queue, /if \(probeTimeAllowed\) lastSemanticCooldownEnrichProbeAt = nowMs/);
  assert.match(queue, /COALESCE\(\(payload->'candidate'->>'enrichmentStage'\)::int,0\) >= COALESCE\(\(payload->>'enrichmentStage'\)::int,1\)/);
});

test('the dry-run script is write-safe and validates flags', () => {
  const script = read('../scripts/reconcileClassificationResolution.ts');
  assert.match(script, /--apply'\) && !dryRunFlag/);
  assert.match(script, /--limit must be an integer/);
  assert.match(script, /--cutoff requires --include-legacy/);
  assert.match(script, /finally \{[\s\S]*?db\.end\(\)/);
  assert.match(script, /process\.exitCode = 1/);
});

test('the migration avoids a validated CHECK and blocking index build on jobs', () => {
  const migration = read('./db/migrations/180_classification_resolution_safety.sql');
  assert.doesNotMatch(migration, /ADD CONSTRAINT/);
  assert.doesNotMatch(migration, /CREATE INDEX/);
  assert.match(migration, /ALTER TABLE jobs[\s\S]*?ADD COLUMN IF NOT EXISTS terminal_failure_class/);
});
