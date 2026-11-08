import test from 'node:test';
import assert from 'node:assert/strict';
import { SEMANTIC_RESULT_FIELD_NAMES, isSemanticResultShape } from './semanticResultShape';

function result(overrides: Record<string, unknown> = {}) {
  return {
    label: 'UNRELATED',
    confidence: 90,
    supportedLanguage: true,
    reasonCodes: ['TEST'],
    explanation: 'Fixture result.',
    concepts: ['risk'],
    languages: [],
    citations: [{ field: 'channel_bio' }],
    ...overrides,
  };
}

test('citations may reference every advertised corpus field', () => {
  for (const field of ['pinned_comment', 'location']) {
    assert.equal(isSemanticResultShape(result({ citations: [{ field }] })), true, `${field} must be citable`);
    assert.equal(isSemanticResultShape(result({ languages: [{ language: 'en', script: 'Latn', confidence: 90, field }] })), true, `${field} must be a valid language field`);
  }
});

test('field references must be strings from the allowed set', () => {
  assert.equal(isSemanticResultShape(result({ citations: [{ field: ['channel_title'] }] })), false, 'array field must not pass String coercion');
  assert.equal(isSemanticResultShape(result({ citations: [{ field: { name: 'channel_title' } }] })), false);
  assert.equal(isSemanticResultShape(result({ citations: [{ field: 'not_a_field' }] })), false);
  assert.equal(isSemanticResultShape(result({ languages: [{ language: 'en', script: 'Latn', confidence: 90, field: ['location'] }] })), false);
});

test('citation indices stay non-negative integers and source ids stay strings', () => {
  assert.equal(isSemanticResultShape(result({ citations: [{ field: 'video_title', index: 0, sourceId: 'abc' }] })), true);
  assert.equal(isSemanticResultShape(result({ citations: [{ field: 'video_title', index: -1 }] })), false);
  assert.equal(isSemanticResultShape(result({ citations: [{ field: 'video_title', index: 1.5 }] })), false);
  assert.equal(isSemanticResultShape(result({ citations: [{ field: 'video_title', sourceId: 7 }] })), false);
});

test('the field set includes the canonical pinned-comment and location evidence', () => {
  assert.ok(SEMANTIC_RESULT_FIELD_NAMES.has('pinned_comment'));
  assert.ok(SEMANTIC_RESULT_FIELD_NAMES.has('location'));
});
