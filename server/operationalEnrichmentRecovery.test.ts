import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { shouldReactivateOperationalEnrichment, reactivateOperationalEnrichment } from './operationalEnrichmentRecovery';

const base = (overrides: Record<string, unknown> = {}) => ({
  channel_id: 'channel-1',
  scan_status: 'FAILED' as const,
  trading_status: 'UNCERTAIN' as const,
  country_status: 'UNCERTAIN' as const,
  discord_validation_status: 'NOT_STARTED' as const,
  last_checked: '2026-08-20T00:00:00.000Z',
  inspection_trail: [],
  ...overrides
});

test('operational enrichment recovery reopens an old machine-owned failure', () => {
  const decision = shouldReactivateOperationalEnrichment(base(), Date.parse('2026-08-24T00:00:00.000Z'));
  assert.equal(decision.reactivate, true);
  assert.deepEqual(decision.reasonCodes, ['OPERATIONALLY_BLOCKED_ENRICHMENT_FAILURE', 'OPERATIONAL_RECOVERY_COOLDOWN_EXPIRED']);
  const updated = reactivateOperationalEnrichment(base() as any, decision.reasonCodes, '2026-08-24T00:00:00.000Z');
  assert.equal(updated.scan_status, 'ENRICHMENT_PENDING');
  assert.equal(updated.trading_status, 'UNCERTAIN');
  assert.equal(updated.last_checked, '2026-08-24T00:00:00.000Z');
});

test('operational enrichment recovery preserves a positive trading decision while recovering independent enrichment', () => {
  const channel = base({ trading_status: 'TRADING_CONFIRMED' });
  const decision = shouldReactivateOperationalEnrichment(channel, Date.parse('2026-08-24T00:00:00.000Z'));
  assert.equal(decision.reactivate, true);
  const updated = reactivateOperationalEnrichment(channel as any, decision.reasonCodes, '2026-08-24T00:00:00.000Z');
  assert.equal(updated.scan_status, 'ENRICHMENT_PENDING');
  assert.equal(updated.trading_status, 'TRADING_CONFIRMED');
});

test('operational enrichment recovery preserves negative semantic, human, and completed Discord terminal decisions', () => {
  for (const overrides of [
    { trading_status: 'NON_TRADING' },
    { trading_status: 'HUMAN_REJECTED' },
    { country_status: 'REJECTED' },
    { discord_validation_status: 'COMPLETED' },
    { scan_status: 'COMPLETED' }
  ]) {
    const decision = shouldReactivateOperationalEnrichment(base(overrides), Date.parse('2026-08-24T00:00:00.000Z'));
    assert.equal(decision.reactivate, false, JSON.stringify(overrides));
    assert.equal(decision.reasonCodes[0], overrides.discord_validation_status === 'COMPLETED'
      ? 'COMPLETED_DISCORD_OUTCOME_PRESERVED'
      : overrides.trading_status === 'NON_TRADING' || overrides.trading_status === 'HUMAN_REJECTED' || overrides.country_status === 'REJECTED'
        ? 'SEMANTIC_OR_HUMAN_DECISION_PRESERVED'
        : 'SCAN_STATUS_NOT_RECOVERABLE_FAILURE');
  }
});

test('operational enrichment recovery respects the 24-hour cooldown', () => {
  const decision = shouldReactivateOperationalEnrichment(base({ last_checked: '2026-08-23T12:00:00.000Z' }), Date.parse('2026-08-24T00:00:00.000Z'));
  assert.equal(decision.reactivate, false);
  assert.deepEqual(decision.reasonCodes, ['OPERATIONAL_RECOVERY_COOLDOWN_ACTIVE']);
});

test('runtime reconciliation admits confirmed trading rows and is null-safe for unresolved metadata', () => {
  const source = readFileSync(new URL('./operationalEnrichmentRecovery.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /c\.trading_status='UNCERTAIN'/);
  assert.match(source, /c\.trading_status IS DISTINCT FROM 'NON_TRADING'/);
  assert.match(source, /c\.trading_status IS DISTINCT FROM 'HUMAN_REJECTED'/);
  assert.match(source, /c\.discord_validation_status IS DISTINCT FROM 'COMPLETED'/);
  assert.match(source, /c\.country_status IS DISTINCT FROM 'REJECTED'/);
});

test('migration 121 is narrow, transactional, and resets stale transient-age provenance only for requeued jobs', () => {
  const migration = readFileSync(new URL('./db/migrations/121_recover_operational_enrichment_failures.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS operational_enrichment_recovery_events/);
  assert.match(migration, /trading_status='UNCERTAIN'/);
  assert.match(migration, /discord_validation_status.*COMPLETED/);
  assert.match(migration, /country_status.*REJECTED/);
  assert.match(migration, /active_job\.status IN \('PENDING','PROCESSING'\)/);
  assert.match(migration, /first_transient_failure_at=NULL/);
  assert.match(migration, /ON CONFLICT\(event_key\) DO NOTHING/);
  assert.doesNotMatch(migration, /DELETE FROM channels|TRUNCATE|DROP TABLE/);
});

test('worker invokes operational enrichment recovery before claiming the next job', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /await reconcileOperationalEnrichmentRecovery\(getDb, getChannelById, upsertChannel, enqueueOperationalEnrichmentRecoveryJob/);
  assert.match(source, /operationalEnrichmentRecoveryKey\(channel\.channel_id\)/);
  assert.match(source, /recoveryReasonCodes/);
  assert.match(source, /UPDATE jobs SET first_transient_failure_at=NULL WHERE id=\$1 AND status='PENDING'/);
});
