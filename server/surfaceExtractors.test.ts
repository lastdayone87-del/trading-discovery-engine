import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractChannelIds,
  extractHandlesWithOffsets,
  extractHashtagsWithOffsets,
  extractUrls,
  parseChannelHandle,
  parseChannelTopicDetails,
  parseVideoTagsSnippet,
} from './surfaceExtractors';

test('hashtag extractor preserves literal with code-point offsets', () => {
  const spans = extractHashtagsWithOffsets('DAX #Morgenanalyse und #Börse-heute!');
  assert.equal(spans.length, 2);
  assert.equal(spans[0].literal, '#Morgenanalyse');
  assert.equal(spans[0].normalized, '#morgenanalyse');
  assert.ok(spans[0].startOffset < spans[0].endOffset);
  assert.ok(spans[1].startOffset > spans[0].endOffset);
});

test('hashtag extractor is empty-safe and deterministic', () => {
  assert.deepEqual(extractHashtagsWithOffsets(''), []);
  assert.deepEqual(extractHashtagsWithOffsets('no tags here'), []);
  const a = extractHashtagsWithOffsets('#DAX #dax');
  assert.equal(a.length, 2);
  assert.equal(a[0].normalized, a[1].normalized);
});

test('handle extractor finds @handles without throwing on prose', () => {
  const spans = extractHandlesWithOffsets('ft. @TraderMike und @börse_berlin!');
  assert.ok(spans.length >= 2);
  assert.ok(spans[0].literal.startsWith('@'));
});

test('channel-id and url extractors dedupe', () => {
  const id = 'UCJdBRGdAz-Or0MwCQoS072Q';
  assert.deepEqual(extractChannelIds(`see ${id} and ${id}`), [id]);
  assert.deepEqual(extractChannelIds('no id'), []);
  const urls = extractUrls('see https://example.com/a and https://example.com/a');
  assert.deepEqual(urls, ['https://example.com/a']);
});

test('video tags parser is fail-closed on malformed input', () => {
  assert.deepEqual(parseVideoTagsSnippet(null), []);
  assert.deepEqual(parseVideoTagsSnippet({}), []);
  assert.deepEqual(parseVideoTagsSnippet({ tags: 'not-array' }), []);
  assert.deepEqual(parseVideoTagsSnippet({ tags: ['DAX Analyse', 'x', 42, 'DAX Analyse'] }), ['dax analyse']);
});

test('topic details parser flattens ids and categories', () => {
  assert.deepEqual(parseChannelTopicDetails(null), []);
  assert.deepEqual(
    parseChannelTopicDetails({ topicDetails: { topicIds: ['/m/04rlf'], topicCategories: ['https://en.wikipedia.org/wiki/Music'] } }),
    ['/m/04rlf', 'https://en.wikipedia.org/wiki/Music'],
  );
});

test('channel handle parser prefers customUrl', () => {
  assert.equal(parseChannelHandle(null), null);
  assert.equal(parseChannelHandle({ customUrl: '@trader' }), '@trader');
  assert.equal(parseChannelHandle({ snippet: { customUrl: '@desk' } }), '@desk');
  assert.equal(parseChannelHandle({}), null);
});
