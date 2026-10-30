import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContinuation, planPersistedPageRecovery } from './continuationPolicy';

const base = { pageNumber:1,maxPages:3,hasNextPage:true,distinctCreators:10,cumulativeDistinctCreators:10,newCreators:8,confirmedCreators:5,qualityConfirmedCreators:3,countryPrecision:.9,communityDiversity:.4,duplicateRatio:.1,consecutiveLowYieldPages:0,maxConsecutiveLowYieldPages:2 };
test('continues a productive page with explainable utility',()=>{const d=evaluateContinuation(base);assert.equal(d.shouldContinue,true);assert.equal(d.lowYield,false);assert.equal(d.primaryReason,'CONTINUE_PRODUCTIVE');assert.ok(d.marginalUtility>.2);});
test('allows one exploratory low-yield page with novel creators but stops consecutive low yield',()=>{const first=evaluateContinuation({...base,confirmedCreators:0,qualityConfirmedCreators:0,newCreators:1});assert.equal(first.shouldContinue,true);assert.equal(first.lowYield,true);assert.equal(first.reasonCodes.includes('ZERO_CONFIRMED_VALUE'),false);const second=evaluateContinuation({...base,confirmedCreators:0,qualityConfirmedCreators:0,newCreators:1,consecutiveLowYieldPages:1});assert.equal(second.shouldContinue,false);assert.equal(second.primaryReason,'CONSECUTIVE_LOW_YIELD');});
test('reports duplicate-heavy and wrong-country pages',()=>{const d=evaluateContinuation({...base,duplicateRatio:.9,countryPrecision:.2});assert.ok(d.reasonCodes.includes('DUPLICATE_HEAVY'));assert.ok(d.reasonCodes.includes('WRONG_COUNTRY'));});
test('honors token and safety ceilings deterministically',()=>{assert.equal(evaluateContinuation({...base,hasNextPage:false}).primaryReason,'NO_NEXT_PAGE');assert.equal(evaluateContinuation({...base,pageNumber:3}).primaryReason,'PAGE_CEILING');assert.deepEqual(evaluateContinuation(base),evaluateContinuation(base));});
test('deep adaptive ceiling allows productive page 3 to continue and stops at page 10',()=>{const deep={...base,maxPages:10};const page3=evaluateContinuation({...deep,pageNumber:3});assert.equal(page3.shouldContinue,true);assert.equal(page3.primaryReason,'CONTINUE_PRODUCTIVE');const page10=evaluateContinuation({...deep,pageNumber:10});assert.equal(page10.shouldContinue,false);assert.equal(page10.primaryReason,'PAGE_CEILING');});

test('persisted-page recovery replays the handoff instead of re-running the page',()=>{
  const observation = {
    pageNumber: 5, nextPageToken: 'token-6', shouldContinue: false,
    primaryReason: 'PAGE_CEILING', resumeMode: 'TOKEN' as const,
    continuationDecisionV2: {
      shouldContinue: false, defer: false, deferReason: null, lowValue: false,
      duplicateHeavy: false, wrongCountry: false, productive: false, marginalUtility: 0.4,
      primaryReason: 'PAGE_CEILING' as const, reasonCodes: ['PAGE_CEILING' as const],
      streaks: { lowValue: 0, duplicateHeavy: 0, wrongCountry: 0 },
      explorationPagesRemaining: 2, effectiveMaxPages: 5,
    },
  };
  const base = {
    pageNumber: 5, pagesCompleted: 5, continuationStatus: 'RUNNING',
    continuedToRunId: null, nextPageToken: 'token-6', resumeMode: 'TOKEN' as const,
    explorationPagesRemaining: 2, effectiveBindingBound: 'SAFETY' as const,
    paginationEnabled: true, observation,
  };
  const child = planPersistedPageRecovery({ ...base, continuedToRunId: 'child-1' });
  assert.deepEqual(child, {
    kind: 'ENSURE_CHILD', childRunId: 'child-1', nextPageToken: 'token-6', resumeMode: 'TOKEN',
  });
  const created = planPersistedPageRecovery(base);
  assert.deepEqual(created, {
    kind: 'CREATE_CHILD', nextPageToken: 'token-6', resumeMode: 'TOKEN', explorationPagesRemaining: 2,
  });
  assert.equal(planPersistedPageRecovery({ ...base, effectiveBindingBound: 'PROVIDER' }).kind, 'FINALIZE');
  assert.equal(planPersistedPageRecovery({ ...base, paginationEnabled: false }).kind, 'FINALIZE');
  assert.equal(planPersistedPageRecovery({ ...base, pagesCompleted: 6 }).kind, 'NONE');
  assert.equal(planPersistedPageRecovery({ ...base, continuationStatus: 'COMPLETE' }).kind, 'NONE');
  const deferred = planPersistedPageRecovery({
    ...base,
    observation: { ...observation, continuationDecisionV2: { ...observation.continuationDecisionV2, defer: true, deferReason: 'QUOTA' } },
  });
  assert.deepEqual(deferred, { kind: 'DEFER', reason: 'QUOTA' });
  const productive = planPersistedPageRecovery({
    ...base,
    observation: { ...observation, shouldContinue: true, primaryReason: 'CONTINUE_PRODUCTIVE' },
  });
  assert.equal(productive.kind, 'NONE');
  const terminal = planPersistedPageRecovery({
    ...base,
    observation: { ...observation, nextPageToken: null, primaryReason: 'NO_NEXT_PAGE' },
  });
  assert.equal(terminal.kind, 'FINALIZE');
});
