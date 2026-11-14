import assert from 'node:assert/strict';
import test from 'node:test';
import { generatedQueryShape } from './generatedQueryShape';

test('generated query shape keeps the bounded whitespace-token contract', () => {
  assert.deepEqual(generatedQueryShape('forex trading'), {
    tokens: 2,
    characters: 12,
    unspaced: false,
    bounded: true,
  });
  assert.equal(generatedQueryShape('trading').bounded, false);
  assert.equal(generatedQueryShape('one two three four five six').bounded, true);
  assert.equal(generatedQueryShape('one two three four five six seven').bounded, false);
});

test('unspaced CJK surfaces use a bounded character count', () => {
  const japanese = generatedQueryShape('日経225先物');
  assert.equal(japanese.tokens, 1);
  assert.equal(japanese.unspaced, true);
  assert.equal(japanese.bounded, true);

  assert.equal(generatedQueryShape('日').bounded, false);
  assert.equal(generatedQueryShape('日'.repeat(21)).bounded, false);
  assert.equal(generatedQueryShape('日経 225 先物').bounded, true);
});
