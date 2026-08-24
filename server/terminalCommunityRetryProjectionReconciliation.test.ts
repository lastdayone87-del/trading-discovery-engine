import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('./db/migrations/123_reconcile_terminal_community_retry_projections.sql', import.meta.url), 'utf8');

test('historical terminal retry projection reconciliation is additive and idempotent', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS community_retry_projection_reconciliation_events/);
  assert.match(migration, /event_key TEXT PRIMARY KEY/);
  assert.match(migration, /ON CONFLICT\(event_key\) DO NOTHING/);
  assert.match(migration, /CREATE TEMP TABLE _terminal_community_retry_projection_reconciliation/);
});

test('historical reconciliation selects only latest failed retry jobs with no active retry owner', () => {
  assert.match(migration, /SELECT DISTINCT ON \(j\.payload->>'channelId'\)/);
  assert.match(migration, /j\.type='RETRY_COMMUNITY_ACQUISITION'/);
  assert.match(migration, /latest_retry\.status='FAILED'/);
  assert.match(migration, /NOT EXISTS \(\s*SELECT 1 FROM jobs active_job/);
  assert.match(migration, /active_job\.status IN \('PENDING','PROCESSING'\)/);
});

test('historical reconciliation preserves semantic terminal channels and scan state', () => {
  assert.match(migration, /c\.scan_status IN \('FAILED','FAILED_PERMANENT'\)/);
  assert.match(migration, /c\.discord_validation_status='RETRY_PENDING'/);
  assert.match(migration, /c\.country_status <> 'REJECTED'/);
  assert.match(migration, /c\.trading_status NOT IN \('NON_TRADING','HUMAN_REJECTED'\)/);
  assert.match(migration, /discord_validation_status=reconcile\.resulting_validation_status/);
  assert.doesNotMatch(migration, /SET scan_status=/);
  assert.doesNotMatch(migration, /SET status='PENDING'/);
  assert.match(migration, /'FAILED_OPERATIONAL'::text AS resulting_validation_status/);
});
