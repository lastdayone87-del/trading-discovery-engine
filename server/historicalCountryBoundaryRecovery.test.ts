import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('./db/migrations/124_reconcile_historical_uncertain_country_rejections.sql', import.meta.url), 'utf8');

test('historical country recovery is tied to durable unresolved pre-boundary evidence', () => {
  assert.match(migration, /c\.country_status='REJECTED'/);
  assert.match(migration, /trail->>'step'='COUNTRY_VALIDATION'/);
  assert.match(migration, /Target Country Boundary: REJECTED/);
  assert.match(migration, /Status:\[\[:space:\]\]\*UNCERTAIN/);
  assert.match(migration, /Status:\[\[:space:\]\]\*LIKELY/);
  assert.doesNotMatch(migration, /Status:\[\[:space:\]\]\*CONFIRMED/);
});

test('historical country recovery preserves semantic negatives and low-audience state', () => {
  assert.match(migration, /trading_status IS DISTINCT FROM 'NON_TRADING'/);
  assert.match(migration, /trading_status IS DISTINCT FROM 'HUMAN_REJECTED'/);
  assert.match(migration, /SKIPPED_LOW_AUDIENCE/);
  assert.doesNotMatch(migration, /DELETE FROM channels|TRUNCATE|DROP TABLE/i);
});

test('historical country recovery restores machine ownership for eligible rows', () => {
  assert.match(migration, /country_status=recover\.restored_country_status/);
  assert.match(migration, /scan_status=recover\.resulting_scan_status/);
  assert.match(migration, /'ENRICH_CHANNEL'/);
  assert.match(migration, /'CHANNEL_RECENT_METADATA'/);
  assert.match(migration, /LEGACY_TARGET_COUNTRY_BOUNDARY_FALSE_REJECTION/);
  assert.match(migration, /active_job\.status IN \('PENDING','PROCESSING'\)/);
  assert.match(migration, /ON CONFLICT\(idempotency_key\) DO NOTHING/);
  assert.match(migration, /'enrichmentStage',\s*0/);
});

test('recovered ENRICH_CHANNEL job does not bypass metadata acquisition', () => {
  const stage0Index = migration.indexOf("'enrichmentStage',0");
  const jobInsertIndex = migration.indexOf("INSERT INTO jobs");
  assert.ok(stage0Index > jobInsertIndex, 'Recovery job payload explicitly sets candidate.enrichmentStage = 0 to enforce fresh metadata fetch');
});

test('historical country recovery writes an idempotent durable ledger', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS historical_country_boundary_recovery_events/);
  assert.match(migration, /event_key TEXT PRIMARY KEY/);
  assert.match(migration, /ON CONFLICT\(event_key\) DO NOTHING/);
  assert.match(migration, /target-country-boundary-recovery-v1/);
});
