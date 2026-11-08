import assert from 'node:assert/strict';
import test from 'node:test';
import { decayWeight, decideLifecycle, getPlannerTerminology, getTerminologyDashboard, inferScript, normalizeTerm } from './terminologyIntelligence';
import { normalizeNativeTerm } from './countryNativeIntelligence';

test('normalization is Unicode-safe and stable across whitespace variants', () => {
  assert.equal(normalizeTerm('  ＮＱ   Futures '), 'nq futures');
  assert.equal(inferScript('テクニカル分析'), 'Hani');
  assert.equal(inferScript('Börsenanalyse'), 'Latn');
});

test('external observation concepts use the same English normalization as terminology surfaces', () => {
  // readExternalTermEvidence matches the stored canonical_concept against
  // normalizeTerm targets. These must stay byte-identical, including under
  // locales whose database lower() differs (for example Turkish I).
  for (const value of ['I', 'İ', '  Börse   Handel ', 'ＮＱ Futures', 'PETR4']) {
    assert.equal(normalizeNativeTerm(value), normalizeTerm(value));
  }
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

test('governed provenance bypasses only the semantic lexicon, not shape/script gates', () => {
  const base = { current: 'MULTI_CREATOR_VALIDATED' as const, decayedEvidence: 6, distinctCreators: 3, distinctCommunities: 2, executions: 0, decayedYield: 0, termType: 'TERMINOLOGY' as const, term: 'frobnicate', country: 'Germany', language: 'de' };
  // A producer-authorized surface skips only the learned-term lexicon.
  const governed = decideLifecycle({ ...base, requireTradingSemantics: false });
  assert.equal(governed.status, 'SEARCH_TRIAL');
  assert.equal(governed.searchEligible, true);
  // Without the bypass the same surface stays shape-ineligible.
  const learned = decideLifecycle(base);
  assert.equal(learned.searchEligible, false);
  assert.match(learned.reason, /no-trading-semantics/);
  assert.equal(learned.status, 'MULTI_CREATOR_VALIDATED');
  // The bypass is not a shape waiver: a CTA-only surface still fails.
  const cta = decideLifecycle({ ...base, term: 'subscribe', requireTradingSemantics: false });
  assert.equal(cta.searchEligible, false);
  assert.match(cta.reason, /cta-only/);
  // Nor does it waive script compatibility: a Japanese surface under a Latin
  // country profile is still rejected by the script gate.
  const incompatible = decideLifecycle({ ...base, term: 'トレード', language: 'ja', requireTradingSemantics: false });
  assert.equal(incompatible.searchEligible, false);
  assert.match(incompatible.reason, /script-incompatible/);
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

test('planner ranks by execution-weighted yield so inert audit rows cannot lower a term', async () => {
  let capturedSql = '';
  const runner = {
    async query(sql: string) {
      capturedSql = sql;
      return { rows: [] };
    }
  } as any;

  await getPlannerTerminology('Germany', runner, { isKillSwitchActive: async () => false });

  // A run whose classifications are all queued writes an inert executions=0
  // audit row. A bare AVG would count each zero and dilute (or invert) the
  // term's rank, so the planner uses the same executions-weighted average as
  // lifecycle refresh.
  assert.match(capturedSql, /SUM\(p\.decayed_yield_score\*p\.executions\)\/NULLIF\(SUM\(p\.executions\),0\)/);
  assert.doesNotMatch(capturedSql, /AVG\(p\.decayed_yield_score\)/);
});
