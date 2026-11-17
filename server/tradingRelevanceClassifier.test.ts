import assert from 'node:assert/strict';
import test from 'node:test';
import { routingContentCategory, semanticProviderOutcomeFlags } from './tradingRelevanceClassifier';

test('an abstained relevant label never owns the content category', () => {
  assert.equal(routingContentCategory({
    isTrading: 'UNCERTAIN',
    taxonomyLabel: 'TRADING_EDUCATION',
  }), undefined);
  assert.equal(routingContentCategory(undefined), undefined);
});

test('a served verdict passes its category to routing', () => {
  assert.equal(routingContentCategory({
    isTrading: 'YES',
    taxonomyLabel: 'INVESTING_EDUCATION',
  }), 'INVESTING_EDUCATION');
  assert.equal(routingContentCategory({
    isTrading: 'NO',
    taxonomyLabel: 'HYPE',
  }), 'HYPE');
});

test('provider flags distinguish served, abstained, and failed semantics', () => {
  assert.deepEqual(semanticProviderOutcomeFlags([
    { provider: 'gemini_semantic', outcome: 'EXECUTED_WITH_EVIDENCE' },
  ]), { served: true, abstained: false, failed: false });
  assert.deepEqual(semanticProviderOutcomeFlags([
    { provider: 'gemini_semantic', outcome: 'ABSTAINED_NO_CITATIONS' },
  ]), { served: false, abstained: true, failed: false });
  assert.deepEqual(semanticProviderOutcomeFlags([
    { provider: 'gemini_semantic', outcome: 'FAILED_PROVIDER' },
    { provider: 'groq_semantic', outcome: 'FAILED_PROVIDER' },
  ]), { served: false, abstained: false, failed: true });
  assert.deepEqual(semanticProviderOutcomeFlags([
    { provider: 'gemini_semantic', outcome: 'UNAVAILABLE_CONFIGURATION' },
  ]), { served: false, abstained: false, failed: false });
});
