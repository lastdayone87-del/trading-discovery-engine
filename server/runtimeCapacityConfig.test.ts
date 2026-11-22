import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  databaseIdleInTransactionTimeoutMs,
  databasePoolMax,
} from './dbCore';
import { admissionEvidenceTimeoutMs, fetchAdmissionEvidence, setAdmissionEvidenceLoaderForTests } from './channelAdmission/evidence';

test('database pool sizing is explicit and bounded', () => {
  assert.equal(databasePoolMax({} as NodeJS.ProcessEnv), 25);
  assert.equal(databasePoolMax({ DATABASE_POOL_MAX: '30' } as NodeJS.ProcessEnv), 30);
  assert.equal(databasePoolMax({ DATABASE_POOL_MAX: '500' } as NodeJS.ProcessEnv), 50);
  assert.equal(databasePoolMax({ DATABASE_POOL_MAX: 'junk' } as NodeJS.ProcessEnv), 25);
  assert.equal(databasePoolMax({ DATABASE_POOL_MAX: '0' } as NodeJS.ProcessEnv), 25);
});

test('idle transactions are bounded without killing normal work', () => {
  assert.equal(databaseIdleInTransactionTimeoutMs({} as NodeJS.ProcessEnv), 60_000);
  assert.equal(databaseIdleInTransactionTimeoutMs({ DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '90000' } as NodeJS.ProcessEnv), 90_000);
  assert.equal(databaseIdleInTransactionTimeoutMs({ DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '1' } as NodeJS.ProcessEnv), 60_000);
  assert.equal(databaseIdleInTransactionTimeoutMs({ DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '9999999' } as NodeJS.ProcessEnv), 600_000);
});

test('admission evidence is bounded and returns a retryable partial on timeout', () => {
  assert.equal(admissionEvidenceTimeoutMs({} as NodeJS.ProcessEnv), 120_000);
  assert.equal(admissionEvidenceTimeoutMs({ ADMISSION_EVIDENCE_TIMEOUT_MS: '45000' } as NodeJS.ProcessEnv), 45_000);
  assert.equal(admissionEvidenceTimeoutMs({ ADMISSION_EVIDENCE_TIMEOUT_MS: '1' } as NodeJS.ProcessEnv), 120_000);
  assert.equal(admissionEvidenceTimeoutMs({ ADMISSION_EVIDENCE_TIMEOUT_MS: '9999999' } as NodeJS.ProcessEnv), 600_000);
});

test('a hung evidence loader resolves to a retryable partial at the deadline', async () => {
  setAdmissionEvidenceLoaderForTests(() => new Promise(() => {}));
  try {
    const started = Date.now();
    const evidence = await fetchAdmissionEvidence({
      candidate: {
        channelId: 'UCabcdefghijklmnopqrstuv',
        channelName: 'Desk',
        youtubeUrl: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
      } as any,
      targetCountry: 'US',
      source: 'automated_query',
    }, { timeoutMs: 25 });
    assert.equal(evidence.failureReason, 'ADMISSION_EVIDENCE_TIMEOUT');
    assert.equal(evidence.evidenceCoverage, 'PARTIAL');
    assert.ok(Date.now() - started < 1_000);
  } finally {
    setAdmissionEvidenceLoaderForTests(null);
  }
});

test('runtime wiring uses the dedicated heartbeat pool and avoids per-tick stale scans', () => {
  const db = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(db, /heartbeatPool \?\?= new Pool\(/);
  assert.match(db, /runtimePoolConfig\(requireDatabaseUrl\(\), 2, 'trading-discovery-heartbeat'\)/);
  assert.match(db, /export async function heartbeatJob[\s\S]{0,400}getHeartbeatDb\(\)/);
  assert.match(db, /idle_in_transaction_session_timeout=/);
  assert.match(db, /databasePoolMax\(\)/);
  assert.match(queue, /const CLAIM_STALE_RECOVERY_INTERVAL_MS =/);
  assert.match(queue, /claimStaleRecoveryInFlight/);
  assert.match(queue, /recoverStaleJobs\(JOB_STALE_AFTER_MINUTES\)/);
  assert.match(queue, /boundedPositiveEnv\('JOB_STALE_AFTER_MINUTES', 5, 2, 60\)/);
});
