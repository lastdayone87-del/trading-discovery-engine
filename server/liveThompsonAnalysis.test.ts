import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeFirstOwnedInvites, summarizeArmOutcomes } from './liveThompsonAnalysis';

const LIVE = 'live-thompson-eval-v1';

function find(overrides: Record<string, unknown> = {}) {
  return {
    inviteCode: 'abc123',
    channelId: 'UC-test',
    experimentId: LIVE,
    arm: 'THOMPSON',
    quotaUnits: 100,
    validatedAt: '2026-10-09T10:00:00.000Z',
    runId: 'run-1',
    ...overrides,
  };
}

test('first-seen ownership wins; retries and duplicates never double-count', () => {
  const rows = attributeFirstOwnedInvites([
    find({ channelId: 'UC-second', validatedAt: '2026-10-09T12:00:00.000Z', runId: 'run-2' }),
    find({ channelId: 'UC-first', validatedAt: '2026-10-09T10:00:00.000Z', runId: 'run-1' }),
    find({ channelId: 'UC-first', validatedAt: '2026-10-09T10:00:00.000Z', runId: 'run-1b' }),
  ]);
  assert.equal(rows.filter(r => r.firstSeen).length, 1);
  assert.equal(rows.find(r => r.firstSeen)?.channelId, 'UC-first');
  assert.equal(rows.find(r => r.channelId === 'UC-second')?.firstSeen, false);
});

test('cross-arm rediscovery keeps the original owner only', () => {
  const rows = attributeFirstOwnedInvites([
    find({ arm: 'THOMPSON', channelId: 'UC-a', validatedAt: '2026-10-09T10:00:00.000Z', runId: 'run-t' }),
    find({ arm: 'CONTROL', channelId: 'UC-b', validatedAt: '2026-10-09T11:00:00.000Z', runId: 'run-c' }),
  ]);
  assert.equal(rows.find(r => r.arm === 'THOMPSON')?.firstSeen, true);
  assert.equal(rows.find(r => r.arm === 'CONTROL')?.firstSeen, false);
});

test('ownership matching is case-insensitive on the invite code', () => {
  const rows = attributeFirstOwnedInvites([
    find({ inviteCode: 'AbC123', channelId: 'UC-a', validatedAt: '2026-10-09T10:00:00.000Z' }),
    find({ inviteCode: 'abc123', channelId: 'UC-b', validatedAt: '2026-10-09T09:00:00.000Z' }),
  ]);
  assert.equal(rows.find(r => r.channelId === 'UC-b')?.firstSeen, true);
  assert.equal(rows.find(r => r.channelId === 'UC-a')?.firstSeen, false);
});

test('arm totals scope to one exact experiment identity', () => {
  const summary = summarizeArmOutcomes(
    [
      { ...find({ arm: 'THOMPSON' }), experimentId: LIVE },
      { ...find({ arm: 'CONTROL', inviteCode: 'def456', channelId: 'UC-c' }), experimentId: LIVE },
      { ...find({ arm: 'THOMPSON', inviteCode: 'xyz999', channelId: 'UC-x' }), experimentId: 'benchmark-prereg-v1-selection' },
      { ...find({ arm: 'THOMPSON', inviteCode: 'xyz998', channelId: 'UC-y' }), experimentId: 'other-exp' },
      { ...find({ arm: 'CONTROL', inviteCode: 'xyz997', channelId: 'UC-z' }), experimentId: null as unknown as string },
    ],
    LIVE
  );
  assert.equal(summary.length, 2);
  assert.equal(summary.find(s => s.arm === 'THOMPSON')?.invites, 1);
  assert.equal(summary.find(s => s.arm === 'CONTROL')?.invites, 1);
  assert.ok(summary.every(s => s.experimentId === LIVE));
});

test('quota counts once per distinct run, never per invite', () => {
  const summary = summarizeArmOutcomes(
    [
      { ...find({ arm: 'THOMPSON', inviteCode: 'a1', channelId: 'UC-1' }), experimentId: LIVE, quotaUnits: 100, runId: 'run-1' },
      { ...find({ arm: 'THOMPSON', inviteCode: 'a2', channelId: 'UC-2' }), experimentId: LIVE, quotaUnits: 100, runId: 'run-1' },
    ],
    LIVE
  );
  assert.equal(summary.find(s => s.arm === 'THOMPSON')?.invites, 2);
  assert.equal(summary.find(s => s.arm === 'THOMPSON')?.quotaUnits, 100);
  assert.equal(summary.find(s => s.arm === 'THOMPSON')?.runs, 1);
});
