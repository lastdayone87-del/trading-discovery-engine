import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('./db/migrations/092_retire_invalid_phase_b_retrieval_assignments.sql', import.meta.url),
  'utf8'
);

test('legacy invalid retrieval assignments are durably retired from the active retry queue', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS phase_b_observation_retirements/);
  assert.match(migration, /INVALID_RETRIEVAL_SAMPLING_POLICY/);
  assert.match(migration, /observation_type = 'RETRIEVAL_ASSIGNMENT'/);
  assert.match(migration, /status <> 'COMPLETED'/);
  assert.match(migration, /policyKey/);
  assert.match(migration, /'salt'/);
  assert.match(migration, /'version'/);
  assert.match(migration, /jsonb_typeof\(o\.payload->'policy'->'version'\) = 'number'/);
  assert.match(migration, /::numeric <= 0/);
  assert.match(migration, /trunc\(\(o\.payload->'policy'->>'version'\)::numeric\)/);
  assert.doesNotMatch(migration, /version'.*\!~\s*'\^\[1-9\]/s);
  assert.match(migration, /ON CONFLICT \(observation_key\) DO NOTHING/);
  assert.match(migration, /DELETE FROM phase_b_observation_outbox/);
});

test('retirement is audit preserving and does not invent a valid sampling assignment', () => {
  assert.match(migration, /payload JSONB NOT NULL/);
  assert.match(migration, /prior_status TEXT NOT NULL/);
  assert.match(migration, /attempts INTEGER NOT NULL/);
  assert.match(migration, /last_error TEXT/);
  assert.match(migration, /retired_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.doesNotMatch(migration, /INSERT INTO evaluation_cohort_assignments/);
  assert.doesNotMatch(migration, /UPDATE\s+phase_b_observation_outbox\s+SET\s+status\s*=\s*'PENDING'/i);
});
