import assert from 'node:assert/strict';
import test from 'node:test';
import { decayWeight, decideLifecycle, getTerminologyDashboard, inferScript, normalizeTerm } from './terminologyIntelligence';

test('normalization is Unicode-safe and stable across whitespace variants', () => {
  assert.equal(normalizeTerm('  ＮＱ   Futures '), 'nq futures');
  assert.equal(inferScript('テクニカル分析'), 'Hani');
  assert.equal(inferScript('Börsenanalyse'), 'Latn');
});

test('recency decay halves evidence at the configured half life', () => {
  const now = new Date('2026-07-29T00:00:00Z');
  const observed = new Date('2026-04-30T00:00:00Z');
  assert.ok(Math.abs(decayWeight(observed, now, 90) - 0.5) < 0.0001);
});

test('promotion requires creator and community diversity, not occurrence volume', () => {
  const insufficientDiversity = decideLifecycle({ current: 'OBSERVED', decayedEvidence: 100, distinctCreators: 1, distinctCommunities: 1, executions: 0, decayedYield: 0, termType: 'TERMINOLOGY' });
  assert.equal(insufficientDiversity.status, 'OBSERVED');
  assert.equal(insufficientDiversity.searchEligible, false);
  const trial = decideLifecycle({ current: 'MULTI_CREATOR_VALIDATED', decayedEvidence: 6, distinctCreators: 3, distinctCommunities: 2, executions: 0, decayedYield: 0, termType: 'TERMINOLOGY' });
  assert.equal(trial.status, 'SEARCH_TRIAL');
  assert.equal(trial.searchEligible, true);
});

test('branding never automatically becomes search eligible', () => {
  const result = decideLifecycle({ current: 'OBSERVED', decayedEvidence: 50, distinctCreators: 20, distinctCommunities: 10, executions: 10, decayedYield: 0.8, termType: 'BRAND' });
  assert.equal(result.searchEligible, false);
});

test('poor repeated production yield demotes without deleting evidence', () => {
  const result = decideLifecycle({ current: 'PROVEN_SEARCH_TERM', decayedEvidence: 20, distinctCreators: 8, distinctCommunities: 5, executions: 6, decayedYield: 0.04, termType: 'TERMINOLOGY' });
  assert.equal(result.status, 'DEMOTED');
  assert.match(result.reason, /demotion threshold/);
});

test('terminology dashboard projects the weighted yield before aggregating the derived relation', async () => {
  let capturedSql = '';
  const runner = {
    async query(sql: string) {
      capturedSql = sql;
      return { rows: [] };
    }
  } as any;

  await getTerminologyDashboard(undefined, runner);

  assert.match(capturedSql, /SUM\(decayed_yield_score\*executions\) weighted_yield_total/);
  assert.match(capturedSql, /SUM\(weighted_yield_total\)\/NULLIF\(SUM\(executions\),0\)/);
  const derivedRelation = capturedSql.match(/FROM \(SELECT ([\s\S]+?) FROM terminology_performance/)?.[1] || '';
  assert.match(derivedRelation, /weighted_yield_total/);
});
