import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseArmFromStates,
  classifyQueryShape,
  discoveryArmPlan,
  selectQueryArm,
  type QueryDiscoveryArm,
} from './queryDiscoveryArms';

test('query shape classifies long-tail, entity and recency surfaces', () => {
  assert.equal(classifyQueryShape('TFSA day trading CRA rules warning', '', 'education'), 'LONG_TAIL');
  assert.equal(classifyQueryShape('nq futures strategy', '', 'futures'), 'ENTITY');
  assert.equal(classifyQueryShape('nq futures strategy', '', 'strategy'), 'ENTITY');
  assert.equal(classifyQueryShape('day trading basics course', '', 'education'), 'LONG_TAIL');
  assert.equal(classifyQueryShape('day trading live', '', 'live_trading'), 'RECENCY');
});

test('arm plans put the shape-appropriate probe first', () => {
  assert.deepEqual(discoveryArmPlan('RECENCY', 'day trading live')[0], { lane: 'VIDEO', ordering: 'DATE' });
  assert.deepEqual(discoveryArmPlan('ENTITY', 'nq futures strategy')[0], { lane: 'CHANNEL', ordering: 'RELEVANCE' });
  assert.deepEqual(discoveryArmPlan('LONG_TAIL', 'TFSA day trading CRA rules warning')[0], { lane: 'VIDEO', ordering: 'RELEVANCE' });
  assert.ok(discoveryArmPlan('LONG_TAIL', 'TFSA day trading CRA rules warning').every(arm => arm.lane !== 'CHANNEL'));
});

test('a productive complementary arm is preferred; low arms are skipped', () => {
  const base: QueryDiscoveryArm = {
    queryId: 1, lane: 'CHANNEL', ordering: 'RELEVANCE', status: 'LOW_NOVELTY',
    probeRuns: 1, completedRuns: 1, freshCandidates: 0, freshConfirmed: 0,
    quotaUnits: 100, lastGlobalSeenShare: 0.9, lastFreshShare: 0,
    lastRunAt: new Date().toISOString(), cooldownUntil: null, lastReason: 'LOW_NOVELTY',
  };
  const selected = chooseArmFromStates(1, 'nq futures strategy', 'futures', [base]);
  assert.deepEqual(selected, { lane: 'VIDEO', ordering: 'RELEVANCE' });

  const productive = {
    ...base, lane: 'VIDEO' as const, status: 'PRODUCTIVE' as const,
    freshCandidates: 5, freshConfirmed: 2, cooldownUntil: null,
  };
  assert.deepEqual(chooseArmFromStates(1, 'nq futures strategy', 'futures', [base, productive]), {
    lane: 'VIDEO', ordering: 'RELEVANCE',
  });
});

test('quota-free searches cannot select CHANNEL or DATE arms', () => {
  for (const shape of ['RECENCY', 'ENTITY', 'LONG_TAIL'] as const) {
    assert.deepEqual(
      discoveryArmPlan(shape, 'nq futures strategy', { quotaFreeRequired: true }),
      [{ lane: 'VIDEO', ordering: 'RELEVANCE' }],
    );
  }
  const productiveChannel: QueryDiscoveryArm = {
    queryId: 1, lane: 'CHANNEL', ordering: 'RELEVANCE', status: 'PRODUCTIVE',
    probeRuns: 2, completedRuns: 2, freshCandidates: 10, freshConfirmed: 4,
    quotaUnits: 100, lastGlobalSeenShare: 0.2, lastFreshShare: 0.5,
    lastRunAt: new Date().toISOString(), cooldownUntil: null, lastReason: 'PRODUCTIVE',
  };
  assert.deepEqual(
    chooseArmFromStates(1, 'nq futures strategy', 'futures', [productiveChannel], Date.now(), '', { quotaFreeRequired: true }),
    { lane: 'VIDEO', ordering: 'RELEVANCE' },
  );
});

test('quota-free exhaustion does not cool a query that still has a paid arm', async () => {
  const statements: string[] = [];
  const coolingFreeArm = {
    query_id: 1,
    retrieval_lane: 'VIDEO',
    search_ordering: 'RELEVANCE',
    status: 'LOW_NOVELTY',
    probe_runs: 1,
    completed_runs: 1,
    fresh_candidates: 0,
    fresh_confirmed: 0,
    quota_units: 100,
    last_global_seen_share: 1,
    last_fresh_share: 0,
    last_run_at: new Date().toISOString(),
    cooldown_until: new Date(Date.now() + 60 * 60_000).toISOString(),
    last_reason: 'LOW_NOVELTY',
  };
  const runner = {
    query: async (text: string) => {
      statements.push(text);
      return { rows: [coolingFreeArm] };
    },
  };
  const selected = await selectQueryArm(
    1, 'nq futures strategy', 'futures', 'nq futures strategy',
    { quotaFreeRequired: true }, runner,
  );
  assert.equal(selected, null, 'the free arm is still cooling');
  assert.equal(
    statements.some(statement => /UPDATE\s+query_library/i.test(statement)),
    false,
    'the available CHANNEL/DATE arms must not be hidden by a query-level cooldown',
  );
});

test('a productive VIDEO/DATE arm cannot be selected for a quota-free recency query', () => {
  const productiveDate: QueryDiscoveryArm = {
    queryId: 1, lane: 'VIDEO', ordering: 'DATE', status: 'PRODUCTIVE',
    probeRuns: 2, completedRuns: 2, freshCandidates: 10, freshConfirmed: 4,
    quotaUnits: 100, lastGlobalSeenShare: 0.2, lastFreshShare: 0.5,
    lastRunAt: new Date().toISOString(), cooldownUntil: null, lastReason: 'PRODUCTIVE',
  };
  assert.deepEqual(
    chooseArmFromStates(1, 'day trading live', 'live_trading', [productiveDate], Date.now(), '', { quotaFreeRequired: true }),
    { lane: 'VIDEO', ordering: 'RELEVANCE' },
  );
});
