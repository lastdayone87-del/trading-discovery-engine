import test from 'node:test';
import assert from 'node:assert/strict';
import { countTrailingContinuationStreaks, evaluateContinuation, evaluateContinuationV2, planPersistedPageRecovery, type ContinuationDecisionV2 } from './continuationPolicy';

const base = { pageNumber:1,maxPages:3,hasNextPage:true,distinctCreators:10,cumulativeDistinctCreators:10,newCreators:8,confirmedCreators:5,qualityConfirmedCreators:3,countryPrecision:.9,communityDiversity:.4,duplicateRatio:.1,consecutiveLowYieldPages:0,maxConsecutiveLowYieldPages:2 };
test('continues a productive page with explainable utility',()=>{const d=evaluateContinuation(base);assert.equal(d.shouldContinue,true);assert.equal(d.lowYield,false);assert.equal(d.primaryReason,'CONTINUE_PRODUCTIVE');assert.ok(d.marginalUtility>.2);});
test('allows one exploratory low-yield page with novel creators but stops consecutive low yield',()=>{const first=evaluateContinuation({...base,confirmedCreators:0,qualityConfirmedCreators:0,newCreators:1});assert.equal(first.shouldContinue,true);assert.equal(first.lowYield,true);assert.equal(first.reasonCodes.includes('ZERO_CONFIRMED_VALUE'),false);const second=evaluateContinuation({...base,confirmedCreators:0,qualityConfirmedCreators:0,newCreators:1,consecutiveLowYieldPages:1});assert.equal(second.shouldContinue,false);assert.equal(second.primaryReason,'CONSECUTIVE_LOW_YIELD');});
test('reports duplicate-heavy and wrong-country pages',()=>{const d=evaluateContinuation({...base,duplicateRatio:.9,countryPrecision:.2});assert.ok(d.reasonCodes.includes('DUPLICATE_HEAVY'));assert.ok(d.reasonCodes.includes('WRONG_COUNTRY'));});
test('pending-only pages are not treated as wrong-country pages',()=>{const d=evaluateContinuation({...base,confirmedCreators:0,qualityConfirmedCreators:0,countryPrecision:0,duplicateRatio:.1,classificationPending:10});assert.equal(d.shouldContinue,true);assert.equal(d.lowYield,false);assert.equal(d.reasonCodes.includes('WRONG_COUNTRY'),false);assert.equal(d.reasonCodes.includes('CONSECUTIVE_LOW_YIELD'),false);});
test('partial country verdicts still report wrong-country while classifications are pending',()=>{const d=evaluateContinuation({...base,confirmedCreators:0,qualityConfirmedCreators:0,countryPrecision:.2,duplicateRatio:.1,classificationPending:4,consecutiveLowYieldPages:1});assert.ok(d.reasonCodes.includes('WRONG_COUNTRY'));assert.equal(d.shouldContinue,false);assert.equal(d.primaryReason,'CONSECUTIVE_LOW_YIELD');});
test('honors token and safety ceilings deterministically',()=>{assert.equal(evaluateContinuation({...base,hasNextPage:false}).primaryReason,'NO_NEXT_PAGE');assert.equal(evaluateContinuation({...base,pageNumber:3}).primaryReason,'PAGE_CEILING');assert.deepEqual(evaluateContinuation(base),evaluateContinuation(base));});
test('deep adaptive ceiling allows productive page 3 to continue and stops at page 10',()=>{const deep={...base,maxPages:10};const page3=evaluateContinuation({...deep,pageNumber:3});assert.equal(page3.shouldContinue,true);assert.equal(page3.primaryReason,'CONTINUE_PRODUCTIVE');const page10=evaluateContinuation({...deep,pageNumber:10});assert.equal(page10.shouldContinue,false);assert.equal(page10.primaryReason,'PAGE_CEILING');});

test('persisted-page recovery replays the handoff instead of re-running the page',()=>{
  const decision = (
    primaryReason: ContinuationDecisionV2['primaryReason'],
    shouldContinue: boolean,
    overrides: Partial<ContinuationDecisionV2> = {},
  ): ContinuationDecisionV2 => ({
    shouldContinue, defer: false, deferReason: null, lowValue: false,
    duplicateHeavy: false, wrongCountry: false,
    productive: primaryReason === 'CONTINUE_PRODUCTIVE', marginalUtility: 0.4,
    primaryReason, reasonCodes: [primaryReason],
    streaks: { lowValue: 0, duplicateHeavy: 0, wrongCountry: 0 },
    explorationPagesRemaining: 2, effectiveMaxPages: 5,
    ...overrides,
  });
  // A safety-ceiling handoff is terminal for the current page but creates a
  // linked segment; the top-level row must agree with the v2 decision.
  const observation = {
    pageNumber: 5, nextPageToken: 'token-6', shouldContinue: false,
    primaryReason: 'PAGE_CEILING', resumeMode: 'TOKEN' as const,
    continuationDecisionV2: decision('PAGE_CEILING', false),
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
    observation: {
      ...observation,
      continuationDecisionV2: decision('PAGE_CEILING', false, { defer: true, deferReason: 'QUOTA' }),
    },
  });
  assert.deepEqual(deferred, { kind: 'DEFER', reason: 'QUOTA' });
  const productive = planPersistedPageRecovery({
    ...base,
    observation: {
      ...observation,
      shouldContinue: true,
      primaryReason: 'CONTINUE_PRODUCTIVE',
      continuationDecisionV2: decision('CONTINUE_PRODUCTIVE', true),
    },
  });
  assert.equal(productive.kind, 'NONE');
  // Terminal rows must not leave a parent cursor behind: recovery would read
  // the stale token and resurrect a finished run. Keep a non-null top-level
  // cursor while the observation has none; finalization must not carry or
  // reuse the stale token.
  const terminal = planPersistedPageRecovery({
    ...base,
    nextPageToken: 'stale-top-level-token',
    observation: {
      ...observation,
      nextPageToken: null,
      shouldContinue: false,
      primaryReason: 'NO_NEXT_PAGE',
      continuationDecisionV2: decision('NO_NEXT_PAGE', false),
    },
  });
  assert.deepEqual(terminal, { kind: 'FINALIZE' });
});


test('community discovery never changes creator-search continuation utility or ordering', () => {
  const v1With = evaluateContinuation({ ...base, communityDiversity: 1 });
  const v1Without = evaluateContinuation({ ...base, communityDiversity: 0 });
  assert.equal(v1With.marginalUtility, v1Without.marginalUtility);
  assert.deepEqual(v1With, v1Without);

  const v2 = {
    pageNumber: 1, effectiveMaxPages: 10, hasNextPage: true,
    distinctCreators: 10, cumulativeDistinctCreators: 10,
    newCreators: 3, pageConfirmedCreators: 2, pageQualityCreators: 1,
    pageNonTradingCreators: 0, novelCandidateTerms: 0,
    countryPrecision: 0.9, duplicateRatio: 0.1,
    priorLowValueStreak: 0, priorDuplicateHeavyStreak: 0,
    priorWrongCountryStreak: 0, maxLowValuePages: 2,
    maxDuplicateHeavyPages: 2, maxWrongCountryPages: 2,
    explorationPagesRemaining: 1,
  };
  const v2With = evaluateContinuationV2({ ...v2, communityDiversity: 1 });
  const v2Without = evaluateContinuationV2({ ...v2, communityDiversity: 0 });
  assert.equal(v2With.marginalUtility, v2Without.marginalUtility);
  assert.deepEqual(v2With, v2Without);
});


test('v1 duplicate ratio reduces marginal utility', () => {
  const clean = evaluateContinuation({ ...base, duplicateRatio: 0 });
  const duplicateHeavy = evaluateContinuation({ ...base, duplicateRatio: 0.7 });
  assert.ok(duplicateHeavy.marginalUtility < clean.marginalUtility);
});


const noveltyBase = {
  pageNumber: 1, effectiveMaxPages: 10, hasNextPage: true,
  distinctCreators: 20, cumulativeDistinctCreators: 20,
  newCreators: 0, pageConfirmedCreators: 0, pageQualityCreators: 0,
  pageNonTradingCreators: 0, novelCandidateTerms: 0,
  countryPrecision: 0.95, duplicateRatio: 0.1,
  priorLowValueStreak: 0, priorDuplicateHeavyStreak: 0,
  priorWrongCountryStreak: 0, maxLowValuePages: 2,
  maxDuplicateHeavyPages: 2, maxWrongCountryPages: 2,
  explorationPagesRemaining: 1,
};

test('high actual channel overlap stops the first-page probe', () => {
  const decision = evaluateContinuationV2({
    ...noveltyBase,
    globalSeenShare: 0.9,
    freshCreatorCandidates: 0,
  });
  assert.equal(decision.shouldContinue, false);
  assert.equal(decision.primaryReason, 'LOW_NOVELTY_PROBE');
});

test('a ceiling decision carries its low-value streak into the linked child', () => {
  const ceiling = evaluateContinuationV2({
    ...noveltyBase,
    pageNumber: 50,
    effectiveMaxPages: 50,
    ceilingBound: 'SAFETY',
    priorLowValueStreak: 1,
  });
  assert.equal(ceiling.shouldContinue, false);
  assert.equal(ceiling.primaryReason, 'PAGE_CEILING');
  assert.equal(ceiling.streaks.lowValue, 2);
  const restored = countTrailingContinuationStreaks([{
    marginalUtility: ceiling.marginalUtility,
    reasonCodes: ceiling.reasonCodes,
    continuationDecisionV2: ceiling,
  }]);
  assert.deepEqual(restored, { lowValue: 2, duplicateHeavy: 0, wrongCountry: 0 });
});

test('a complementary lane with unseen candidates continues', () => {
  const decision = evaluateContinuationV2({
    ...noveltyBase,
    globalSeenShare: 0.9,
    freshCreatorCandidates: 6,
  });
  assert.equal(decision.shouldContinue, true);
  assert.notEqual(decision.primaryReason, 'LOW_NOVELTY_PROBE');
});

test('a page that is 90% seen with one fresh candidate is still a low-novelty probe', () => {
  const decision = evaluateContinuationV2({
    ...noveltyBase,
    distinctCreators: 20,
    globalSeenShare: 0.9,
    freshCreatorCandidates: 1,
  });
  assert.equal(decision.shouldContinue, false);
  assert.equal(decision.primaryReason, 'LOW_NOVELTY_PROBE');
});

test('freshly confirmed creators override the low-novelty stop', () => {
  const decision = evaluateContinuationV2({
    ...noveltyBase,
    globalSeenShare: 0.95,
    freshCreatorCandidates: 0,
    freshConfirmedCreators: 1,
    pageConfirmedCreators: 0,
  });
  assert.equal(decision.shouldContinue, true);
  assert.notEqual(decision.primaryReason, 'LOW_NOVELTY_PROBE');
});


test('a tiny page does not trigger the low-novelty stop', () => {
  const decision = evaluateContinuationV2({
    ...noveltyBase,
    distinctCreators: 2,
    globalSeenShare: 1,
    freshCreatorCandidates: 0,
  });
  assert.notEqual(decision.primaryReason, 'LOW_NOVELTY_PROBE');
});

test('a freshly confirmed creator prevents duplicate, wrong-country and low-value stops', () => {
  const decision = evaluateContinuationV2({
    ...noveltyBase,
    pageNumber: 3,
    duplicateRatio: 0.95,
    countryPrecision: 0.2,
    priorLowValueStreak: 1,
    priorDuplicateHeavyStreak: 1,
    priorWrongCountryStreak: 1,
    freshConfirmedCreators: 1,
  });
  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.primaryReason, 'CONTINUE_PRODUCTIVE');
});

test('a single unconfirmed new creator does not keep a 95%-overlap page running', () => {
  const decision = evaluateContinuationV2({
    ...noveltyBase,
    newCreators: 1,
    pageNumber: 2,
    globalSeenShare: 0.95,
    freshCreatorCandidates: 1,
    freshConfirmedCreators: 0,
    pageConfirmedCreators: 0,
    pageQualityCreators: 0,
    novelCandidateTerms: 0,
  });
  assert.equal(decision.shouldContinue, false);
  assert.equal(decision.primaryReason, 'LOW_NOVELTY');
});
