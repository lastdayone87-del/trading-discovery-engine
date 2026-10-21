import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STALE_CHANNEL_LOCK_AFTER_MINUTES,
  STALE_CHANNEL_LOCK_RECOVERY_BATCH_SIZE,
  STALE_CHANNEL_LOCK_RECOVERY_INTERVAL_MS,
  projectRecoveredStaleChannelLockStatus,
  shouldRecoverStaleChannelLock,
  shouldRunStaleChannelLockRecovery,
} from './staleChannelLockRecovery';

const migration = readFileSync(new URL('./db/migrations/090_reconcile_stale_channel_locks.sql', import.meta.url), 'utf8');
const terminalMigration = readFileSync(new URL('./db/migrations/153_reconcile_channel_locks_on_terminal_jobs.sql', import.meta.url), 'utf8');
const dbSource = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
const queueSource = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('runtime reconciliation only follows PROCESSING to PENDING job releases', () => {
  assert.match(migration, /WHEN \(OLD\.status='PROCESSING' AND NEW\.status='PENDING'\)/);
  assert.match(migration, /AFTER UPDATE OF status ON jobs/);
  assert.match(migration, /c\.scan_status = 'LOCKED'/);
  assert.match(migration, /NOT EXISTS \([\s\S]*live\.status='PROCESSING'/);
});

test('terminal job release also reconciles a stranded channel lock', () => {
  assert.match(terminalMigration, /NEW\.status NOT IN \('PENDING','FAILED','COMPLETED'\)/);
  assert.match(terminalMigration, /WHEN \([\s\S]*NEW\.status IN \('PENDING','FAILED','COMPLETED'\)/);
  assert.match(terminalMigration, /c\.scan_status = 'LOCKED'/);
  assert.match(terminalMigration, /live\.id <> NEW\.id/);
  assert.match(terminalMigration, /live\.status='PROCESSING'/);
  assert.match(terminalMigration, /NEW\.status = 'PENDING' OR c\.updated_at < now\(\) - interval '60 minutes'/);
  assert.match(terminalMigration, /pg_advisory_xact_lock\(hashtext\('channel_lock_release:' \|\| channel_id_value\)\)/);
});

test('stale channel lock recovery is bounded and never clears a live owner', () => {
  const nowMs = Date.parse('2026-10-21T03:00:00.000Z');
  const oldLock = new Date(nowMs - (STALE_CHANNEL_LOCK_AFTER_MINUTES + 1) * 60_000).toISOString();
  const freshLock = new Date(nowMs - (STALE_CHANNEL_LOCK_AFTER_MINUTES - 1) * 60_000).toISOString();

  assert.equal(shouldRecoverStaleChannelLock({
    scanStatus: 'LOCKED', updatedAt: oldLock, hasLiveProcessingJob: false, nowMs,
  }), true, 'an abandoned lock past the grace period is recoverable');

  assert.equal(shouldRecoverStaleChannelLock({
    scanStatus: 'LOCKED', updatedAt: oldLock, hasLiveProcessingJob: true, nowMs,
  }), false, 'a live PROCESSING job keeps its channel locked regardless of age');

  assert.equal(shouldRecoverStaleChannelLock({
    scanStatus: 'LOCKED', updatedAt: freshLock, hasLiveProcessingJob: false, nowMs,
  }), false, 'a fresh lock is not recovered before the grace period');

  assert.equal(shouldRecoverStaleChannelLock({
    scanStatus: 'COMPLETED', updatedAt: oldLock, hasLiveProcessingJob: false, nowMs,
  }), false, 'only LOCKED projections are eligible');

  assert.equal(shouldRecoverStaleChannelLock({
    scanStatus: 'LOCKED', updatedAt: null, hasLiveProcessingJob: false, nowMs,
  }), false, 'a missing timestamp cannot prove abandonment');

  assert.equal(shouldRecoverStaleChannelLock({
    scanStatus: 'LOCKED',
    updatedAt: new Date(nowMs - STALE_CHANNEL_LOCK_AFTER_MINUTES * 60_000).toISOString(),
    hasLiveProcessingJob: false,
    nowMs,
  }), false, 'exactly at the grace period matches the strict SQL boundary');
});

test('runtime recovery sweep is throttled and bounded per tick', () => {
  const nowMs = Date.parse('2026-10-21T03:00:00.000Z');

  assert.equal(shouldRunStaleChannelLockRecovery({ nowMs, lastRunMs: null }), true, 'the first tick runs');
  assert.equal(shouldRunStaleChannelLockRecovery({
    nowMs, lastRunMs: nowMs - (STALE_CHANNEL_LOCK_RECOVERY_INTERVAL_MS - 1),
  }), false, 'a tick inside the cooldown skips the sweep');
  assert.equal(shouldRunStaleChannelLockRecovery({
    nowMs, lastRunMs: nowMs - STALE_CHANNEL_LOCK_RECOVERY_INTERVAL_MS,
  }), true, 'a tick at the cooldown boundary runs');

  assert.ok(STALE_CHANNEL_LOCK_RECOVERY_BATCH_SIZE > 0 && STALE_CHANNEL_LOCK_RECOVERY_BATCH_SIZE <= 100);
  assert.match(dbSource, /LIMIT \(\$2\)::bigint/);
  assert.match(dbSource, /FOR UPDATE SKIP LOCKED/);
  assert.match(dbSource, /STALE_CHANNEL_LOCK_RECOVERY_BATCH_SIZE/);
  assert.match(queueSource, /shouldRunStaleChannelLockRecovery/);
  assert.match(queueSource, /lastStaleChannelLockRecoveryMs/);
});

test('terminated jobs recover only after the grace period when no live job remains', () => {
  const nowMs = Date.parse('2026-10-21T03:00:00.000Z');
  const oldLock = new Date(nowMs - 61 * 60_000).toISOString();
  assert.equal(shouldRecoverStaleChannelLock({
    scanStatus: 'LOCKED', updatedAt: oldLock, hasLiveProcessingJob: false, nowMs,
  }), true);
});

test('stale lock recovery preserves review and enrichment-pending projections', () => {
  assert.match(migration, /c\.trading_status = 'NEEDS_REVIEW' THEN 'NEEDS_REVIEW'/);
  assert.match(migration, /pending\.type='ENRICH_CHANNEL'[\s\S]*pending\.status='PENDING'[\s\S]*THEN 'ENRICHMENT_PENDING'/);
  assert.match(migration, /ELSE 'PENDING'/);

  assert.equal(projectRecoveredStaleChannelLockStatus({
    tradingStatus: 'NEEDS_REVIEW', hasPendingEnrichment: true,
  }), 'NEEDS_REVIEW');
  assert.equal(projectRecoveredStaleChannelLockStatus({
    tradingStatus: 'UNCERTAIN', hasPendingEnrichment: true,
  }), 'ENRICHMENT_PENDING');
  assert.equal(projectRecoveredStaleChannelLockStatus({
    tradingStatus: 'UNCERTAIN', hasPendingEnrichment: false,
  }), 'PENDING');
  assert.equal(projectRecoveredStaleChannelLockStatus({
    tradingStatus: 'ACTIVE', hasPendingEnrichment: true,
  }), 'PENDING');
});

test('runtime recovery is bounded to old LOCKED rows without live ownership', () => {
  assert.match(dbSource, /export async function recoverStaleChannelLocks/);
  assert.match(dbSource, /WHERE c\.scan_status='LOCKED'/);
  assert.match(dbSource, /c\.updated_at < now\(\)-\(\$1\|\|' minutes'\)::interval/);
  assert.match(dbSource, /live\.status='PROCESSING'/);
  assert.match(dbSource, /live\.payload->>'channelId'=c\.channel_id/);
  assert.match(dbSource, /RETURNING c\.channel_id/);
});

test('worker tick runs channel lock recovery alongside stale job recovery', () => {
  assert.match(queueSource, /await recoverStaleJobs\(\);[\s\S]*await recoverStaleChannelLocks\(\);/);
});

test('one-time cleanup is bounded to old LOCKED rows without live ownership', () => {
  assert.match(migration, /c\.updated_at < now\(\)-interval '60 minutes'/);
  assert.match(migration, /WHERE c\.scan_status='LOCKED'/);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  assert.doesNotMatch(migration, /UPDATE\s+jobs/i);
});
