import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('./db/migrations/090_reconcile_stale_channel_locks.sql', import.meta.url), 'utf8');

test('runtime reconciliation only follows PROCESSING to PENDING job releases', () => {
  assert.match(migration, /WHEN \(OLD\.status='PROCESSING' AND NEW\.status='PENDING'\)/);
  assert.match(migration, /AFTER UPDATE OF status ON jobs/);
  assert.match(migration, /c\.scan_status = 'LOCKED'/);
  assert.match(migration, /NOT EXISTS \([\s\S]*live\.status='PROCESSING'/);
});

test('stale lock recovery preserves review and enrichment-pending projections', () => {
  assert.match(migration, /c\.trading_status = 'NEEDS_REVIEW' THEN 'NEEDS_REVIEW'/);
  assert.match(migration, /pending\.type='ENRICH_CHANNEL'[\s\S]*pending\.status='PENDING'[\s\S]*THEN 'ENRICHMENT_PENDING'/);
  assert.match(migration, /ELSE 'PENDING'/);
});

test('one-time cleanup is bounded to old LOCKED rows without live ownership', () => {
  assert.match(migration, /c\.updated_at < now\(\)-interval '60 minutes'/);
  assert.match(migration, /WHERE c\.scan_status='LOCKED'/);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  assert.doesNotMatch(migration, /UPDATE\s+jobs/i);
});
