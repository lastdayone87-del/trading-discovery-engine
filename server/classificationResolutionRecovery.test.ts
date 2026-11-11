import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CLASSIFICATION_RESOLUTION_RECOVERY_CYCLE_LIMIT,
  resolveResolutionRecoveryAction,
} from './classificationResolutionRecovery';

const base = {
  tradingStatus: 'UNCERTAIN',
  scanStatus: 'ENRICHMENT_PENDING',
  hasActiveJob: false,
  latestJobStatus: null as string | null,
  terminalFailureClass: null as string | null,
  recoveryCycles: 0,
  lastChecked: '2026-11-09T00:00:00.000Z',
  cutoff: '2026-11-01T00:00:00.000Z',
  now: Date.parse('2026-11-11T00:00:00.000Z'),
};

test('an active job always owns the channel', () => {
  assert.equal(resolveResolutionRecoveryAction({ ...base, hasActiveJob: true }).action, 'SKIP_ACTIVE');
});

test('terminal semantic decisions are never reopened', () => {
  assert.equal(resolveResolutionRecoveryAction({ ...base, tradingStatus: 'TRADING_CONFIRMED' }).action, 'SKIP_TERMINAL');
  assert.equal(resolveResolutionRecoveryAction({ ...base, tradingStatus: 'NON_TRADING' }).action, 'SKIP_TERMINAL');
  assert.equal(resolveResolutionRecoveryAction({ ...base, tradingStatus: 'HUMAN_REJECTED' }).action, 'SKIP_TERMINAL');
});

test('rows before the forward-recovery cutoff are reported but not mutated', () => {
  assert.equal(resolveResolutionRecoveryAction({ ...base, lastChecked: '2026-01-01T00:00:00.000Z' }).action, 'SKIP_LEGACY');
  assert.equal(resolveResolutionRecoveryAction({ ...base, lastChecked: '2026-01-01T00:00:00.000Z', includeLegacy: true }).action, 'ENQUEUE_RECOVERY');
  assert.equal(resolveResolutionRecoveryAction({ ...base, lastRecoveryAt: '2026-11-10T12:00:00.000Z' }).action, 'SKIP_COOLDOWN');
});

test('a permanent terminal failure is projected without retry or review', () => {
  assert.equal(resolveResolutionRecoveryAction({ ...base, terminalFailureClass: 'PERMANENT_INPUT' }).action, 'PROJECT_PERMANENT_FAILURE');
  assert.equal(resolveResolutionRecoveryAction({ ...base, terminalFailureClass: 'POLICY_TERMINAL' }).action, 'PROJECT_PERMANENT_FAILURE');
});

test('an unknown terminal failure is sent to human review instead of being retried', () => {
  const decision = resolveResolutionRecoveryAction({ ...base, terminalFailureClass: 'UNKNOWN' });
  assert.equal(decision.action, 'EXHAUSTED_REVIEW');
  assert.deepEqual(decision.reasonCodes, ['UNKNOWN_TERMINAL_FAILURE_REQUIRES_REVIEW']);
});

test('unknown-age legacy rows never bypass the forward-only cutoff', () => {
  assert.equal(resolveResolutionRecoveryAction({ ...base, lastChecked: null, createdAt: null }).action, 'SKIP_LEGACY');
  assert.equal(resolveResolutionRecoveryAction({ ...base, lastChecked: null, createdAt: '2026-11-09T00:00:00.000Z' }).action, 'ENQUEUE_RECOVERY');
  assert.equal(resolveResolutionRecoveryAction({ ...base, lastChecked: null, createdAt: null, includeLegacy: true }).action, 'ENQUEUE_RECOVERY');
});

test('orphan ENRICHMENT_PENDING rows get one bounded recovery pass', () => {
  assert.equal(resolveResolutionRecoveryAction(base).action, 'ENQUEUE_RECOVERY');
  assert.deepEqual(resolveResolutionRecoveryAction(base).reasonCodes, ['ORPHAN_ENRICHMENT_PENDING']);
});

test('generic failed enrichment is retryable until the cycle ceiling', () => {
  const failed = { ...base, scanStatus: 'FAILED', latestJobStatus: 'FAILED', terminalFailureClass: 'RETRYABLE' };
  assert.equal(resolveResolutionRecoveryAction(failed).action, 'ENQUEUE_RECOVERY');
  assert.equal(
    resolveResolutionRecoveryAction({ ...failed, recoveryCycles: CLASSIFICATION_RESOLUTION_RECOVERY_CYCLE_LIMIT }).action,
    'EXHAUSTED_REVIEW',
  );
});

test('a terminal recovery marker becomes human review, not another retry', () => {
  assert.equal(resolveResolutionRecoveryAction({ ...base, terminalRecoveryMarker: true }).action, 'EXHAUSTED_REVIEW');
});

test('a completed-but-UNCERTAIN row is exhausted, not successfully resolved', () => {
  assert.equal(
    resolveResolutionRecoveryAction({ ...base, scanStatus: 'COMPLETED', latestJobStatus: 'COMPLETED' }).action,
    'EXHAUSTED_REVIEW',
  );
});

test('an exhausted recovery never returns an automatic terminal classification', () => {
  const decision = resolveResolutionRecoveryAction({
    ...base,
    scanStatus: 'FAILED',
    latestJobStatus: 'FAILED',
    recoveryCycles: CLASSIFICATION_RESOLUTION_RECOVERY_CYCLE_LIMIT,
  });
  assert.equal(decision.action, 'EXHAUSTED_REVIEW');
  assert.ok(!decision.action.includes('TRADING'));
  assert.ok(!decision.action.includes('NON_TRADING'));
});

test('terminal job failures are classified structurally for recovery and monitoring', () => {
  const db = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  assert.match(db, /terminal_failure_class=\$5/);
  assert.match(db, /PERMANENT_INPUT/);
  assert.match(db, /POLICY_TERMINAL/);
  assert.match(db, /PROVIDER_QUOTA/);
  assert.match(db, /terminal_failure_class=NULL/);
});
