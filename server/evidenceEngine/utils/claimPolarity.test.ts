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
  assert.equal(polarity('Scam gurus teach forex', 'forex'), 'QUOTED');
  assert.equal(polarity('Scam courses teach day trading', 'day trading'), 'QUOTED');
  assert.equal(polarity('They say guaranteed profits, then lose money', 'guaranteed profit'), 'QUOTED');
  assert.equal(polarity('Imagine guaranteed profits, then lose money', 'guaranteed profit'), 'HYPOTHETICAL');
  assert.equal(polarity('"Guaranteed profits" is a red flag', 'guaranteed profit'), 'QUOTED');
  assert.equal(polarity('Guaranteed profits are a red flag', 'guaranteed profit'), 'QUOTED');
  assert.equal(polarity('Guaranteed profits are fraudulent', 'guaranteed profit'), 'QUOTED');
  assert.equal(polarity('Guaranteed profits are lies', 'guaranteed profit'), 'QUOTED');
  assert.equal(polarity('Crypto trader teaching beginners to avoid scams', 'crypto trader'), 'ASSERTED');
  assert.equal(polarity('My courses teach day trading and order flow', 'day trading'), 'ASSERTED');
  assert.equal(polarity('My online courses teach day trading', 'day trading'), 'ASSERTED');
  assert.equal(polarity('My channel reviews courses that teach day trading', 'day trading'), 'QUOTED');
  assert.equal(polarity('I may teach day trading', 'day trading'), 'HYPOTHETICAL');
  assert.equal(polarity('My courses I teach day trading', 'day trading'), 'ASSERTED');
  assert.equal(polarity('My courses explain why gurus promise guaranteed profits', 'guaranteed profit'), 'QUOTED');
  assert.equal(polarity('May day trading recap', 'day trading'), 'ASSERTED');
  assert.equal(polarity('Order flow May 2026', 'order flow'), 'ASSERTED');
  assert.equal(polarity('Le day trading pourrait devenir mon activité', 'day trading'), 'HYPOTHETICAL');
  assert.equal(polarity('Day trading may become my activity', 'day trading'), 'HYPOTHETICAL');
  assert.equal(polarity('Day trading in theory', 'day trading'), 'HYPOTHETICAL');
  assert.equal(polarity('Guaranteed profits? Not financial advice.', 'guaranteed profit'), 'ASSERTED');
  assert.equal(polarity('Forex trading? No, this is a cooking channel.', 'forex trading'), 'NEGATED');
  assert.equal(polarity("Ce n'est pas du trading", 'trading'), 'NEGATED');
  assert.equal(polarity('لا ضمان على الأرباح', 'ضمان'), 'DISCLAIMER');
  assert.equal(polarity('これは投資助言ではありません', '投資助言'), 'DISCLAIMER');
});

test('claim polarity is clause-scoped: a disclaimer cannot suppress a later claim', () => {
  assert.equal(polarity('No guaranteed profits. I teach order flow.', 'order flow'), 'ASSERTED');
  assert.equal(polarity('No shortcuts, but guaranteed profits', 'guaranteed profit'), 'ASSERTED');
  assert.equal(polarity('No guaranteed profits; order flow is my method', 'order flow'), 'ASSERTED');
  assert.equal(polarity('Day trading. Not financial advice.', 'day trading'), 'ASSERTED');
  assert.equal(polarity('Guaranteed profits? No.', 'guaranteed profit'), 'NEGATED');
});

test('multilingual disclaimer frames are recognized', () => {
  assert.equal(polarity('Keine garantierten Gewinne', 'garantierten'), 'DISCLAIMER');
  assert.equal(polarity('Pas de conseil en investissement', 'conseil'), 'DISCLAIMER');
  assert.equal(polarity('Sin garantía de ganancias', 'garantía'), 'DISCLAIMER');
  assert.equal(polarity('过去的表现不代表未来收益', '表现'), 'DISCLAIMER');
});

test('claim polarity keeps ordinary creator framing asserted', () => {
  assert.equal(polarity("I don't need a broker, I trade stocks daily", 'stocks'), 'ASSERTED');
  assert.equal(polarity('I do not trade stocks and teach trading strategy', 'stocks'), 'NEGATED');
  assert.equal(polarity('I do not trade stocks and teach trading strategy', 'trading strategy'), 'ASSERTED');
  assert.equal(polarity('I do not teach day trading and order flow', 'day trading'), 'NEGATED');
  assert.equal(polarity('I do not teach day trading and order flow', 'order flow'), 'NEGATED');
  assert.equal(polarity('I do not trade stocks and crypto', 'crypto'), 'NEGATED');
  assert.equal(polarity('I teach day trading so you could learn to do it yourself', 'day trading'), 'ASSERTED');
  assert.notEqual(polarity('Zero to hero course not guaranteed profits', 'guaranteed profit'), 'ASSERTED');
  assert.equal(polarity('I teach day trading, no hype', 'day trading'), 'ASSERTED');
  assert.equal(polarity('No experience needed: learn forex trading', 'forex'), 'ASSERTED');
  assert.equal(polarity('No BS Forex Trading', 'forex'), 'ASSERTED');
  assert.equal(polarity('Zero to Hero Forex', 'forex'), 'ASSERTED');
  assert.equal(polarity('If you want to learn day trading, subscribe', 'day trading'), 'ASSERTED');
  // Criticism only neutralizes claim-like language, not a trading method it
  // merely appears near.
  assert.equal(polarity('Avoid fake breakouts with order flow', 'order flow'), 'ASSERTED');
  assert.equal(polarity('Trading could happen', 'trading'), 'HYPOTHETICAL');
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
