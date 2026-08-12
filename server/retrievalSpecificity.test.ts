import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRetrievalSpecificity, RETRIEVAL_SPECIFICITY_POLICY_VERSION } from './retrievalSpecificity';

test('governed trading entities may remain standalone', () => {
  const decision = evaluateRetrievalSpecificity({ semanticClass: 'INSTRUMENT', governed: true });
  assert.equal(decision.eligibility, 'STANDALONE');
  assert.ok(decision.specificity > decision.ambiguity);
});

test('country vocabulary instruments require an independent trading anchor', () => {
  const decision = evaluateRetrievalSpecificity({ semanticClass: 'INSTRUMENT', governed: false });
  assert.equal(decision.eligibility, 'MODIFIER_ONLY');
  assert.ok(decision.requiredCompanionClasses.includes('METHOD'));
  assert.ok(decision.reasonCodes.includes('UNGOVERNED_ENTITY_REQUIRES_TRADING_ANCHOR'));
});

test('ungoverned methods cannot become standalone searches merely from their semantic label', () => {
  const decision = evaluateRetrievalSpecificity({ semanticClass: 'METHOD', governed: false });
  assert.equal(decision.eligibility, 'MODIFIER_ONLY');
  assert.ok(decision.requiredCompanionClasses.includes('INSTRUMENT'));
});

test('learned and organic expansion surfaces still require trading anchors', () => {
  const learned = evaluateRetrievalSpecificity({ semanticClass: 'LEARNED', governed: false });
  assert.equal(learned.eligibility, 'MODIFIER_ONLY');
  assert.equal(RETRIEVAL_SPECIFICITY_POLICY_VERSION, 'retrieval-specificity-v2');
});
