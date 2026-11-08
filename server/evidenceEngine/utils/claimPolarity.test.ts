import assert from 'node:assert/strict';
import test from 'node:test';
import {
  affirmedTerms,
  classifyClaimPolarity,
  findScopedTermMatches,
  hasAffirmedTerm,
} from './claimPolarity';

function polarity(text: string, term: string): string {
  const match = findScopedTermMatches(text, [term])[0];
  assert.ok(match, `${term} should match in ${text}`);
  return match.polarity;
}

test('claim polarity distinguishes assertions, disclaimers and negations', () => {
  assert.equal(polarity('Guaranteed profits', 'guaranteed profit'), 'ASSERTED');
  assert.equal(polarity('No guaranteed profits', 'guaranteed profit'), 'DISCLAIMER');
  assert.equal(polarity('This is not financial advice', 'financial advice'), 'DISCLAIMER');
  assert.equal(polarity("I don't trade forex", 'forex'), 'NEGATED');
  assert.equal(polarity('Never trade without a stop loss', 'stop loss'), 'NEGATED');
  assert.equal(polarity('Not only trading, but also investing', 'trading'), 'ASSERTED');
});

test('claim polarity neutralizes quoted criticism and hypotheticals', () => {
  assert.equal(polarity('Scam gurus promise guaranteed profits', 'guaranteed profit'), 'QUOTED');
  assert.equal(polarity('They say guaranteed profits, then lose money', 'guaranteed profit'), 'QUOTED');
  assert.equal(polarity('If you want guaranteed profits, this is not for you', 'guaranteed profit'), 'HYPOTHETICAL');
  assert.equal(polarity('"Guaranteed profits" is a red flag', 'guaranteed profit'), 'QUOTED');
});

test('claim polarity is clause-scoped: a disclaimer cannot suppress a later claim', () => {
  assert.equal(polarity('No guaranteed profits. I teach order flow.', 'order flow'), 'ASSERTED');
  assert.equal(polarity('No shortcuts, but guaranteed profits', 'guaranteed profit'), 'ASSERTED');
  assert.equal(polarity('No guaranteed profits; order flow is my method', 'order flow'), 'ASSERTED');
});

test('multilingual disclaimer frames are recognized', () => {
  assert.equal(polarity('Keine garantierten Gewinne', 'garantierten'), 'DISCLAIMER');
  assert.equal(polarity('Pas de conseil en investissement', 'conseil'), 'DISCLAIMER');
  assert.equal(polarity('Sin garantía de ganancias', 'garantía'), 'DISCLAIMER');
  assert.equal(polarity('过去的表现不代表未来收益', '表现'), 'DISCLAIMER');
});

test('affirmedTerms keeps only asserted occurrences', () => {
  const text = 'No guaranteed profits. I teach order flow and trading psychology.';
  assert.deepEqual(affirmedTerms(text, ['guaranteed profit', 'order flow', 'trading psychology']).sort(), [
    'order flow',
    'trading psychology',
  ]);
  assert.equal(hasAffirmedTerm(text, ['guaranteed profit']), false);
  assert.equal(hasAffirmedTerm(text, ['order flow']), true);
});

test('classifyClaimPolarity returns bounded offsets for diagnostics', () => {
  const result = findScopedTermMatches('No guaranteed profits', ['guaranteed profit'])[0];
  assert.equal(result.start, 3);
  assert.equal(result.end, 20);
  assert.equal(result.cue, 'No guaranteed profits');
  assert.equal(result.confidence, 0.95);
});
