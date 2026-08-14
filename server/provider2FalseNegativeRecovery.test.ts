import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('./db/migrations/091_recover_provider2_false_negatives.sql', import.meta.url),
  'utf8'
);

test('Provider2 false-negative recovery is incident-scoped, bounded and auditable', () => {
  assert.match(migration, /2026-08-12 13:12:22\+00/);
  assert.match(migration, /2026-08-13 18:45:43\+00/);
  assert.match(migration, /c\.trading_status = 'NON_TRADING'/);
  assert.match(migration, /c\.scan_status = 'SKIPPED_NON_TRADING'/);
  assert.match(migration, /c\.country_status <> 'REJECTED'/);
  assert.match(migration, /r\.decision = 'REJECT'/);
  assert.match(migration, /cr\.state = 'REJECTED'/);
  assert.match(migration, /suspicion_score > 0/);
  assert.match(migration, /LIMIT 25/);
  assert.match(migration, /'PROVIDER2_FALSE_NEGATIVE_RESCAN'/);
  assert.match(migration, /'provider2_false_negative_v1'/);
  assert.match(migration, /INTERVAL '4 minutes'/);
  assert.match(migration, /ON CONFLICT\(idempotency_key\) DO NOTHING/);
});

test('recovery does not mutate terminal classifications directly', () => {
  assert.doesNotMatch(migration, /UPDATE\s+channels/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+channels/i);
  assert.doesNotMatch(migration, /SET\s+trading_status/i);
});

test('recovery uses persisted evidence_items for contradictory positive evidence', () => {
  assert.match(migration, /evidenceCollection/);
  assert.match(migration, /degraded/);
  assert.match(migration, /INSUFFICIENT/);
  assert.match(migration, /evidence_items/);
  assert.match(migration, /item->>'polarity' = 'POSITIVE'/);
  assert.doesNotMatch(migration, /decision->'positiveEvidence'/);
  assert.match(migration, /thinCreatorInput/);
});
