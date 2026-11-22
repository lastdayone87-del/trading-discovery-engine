import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertYouTubeRelevanceLanguage,
  resolveYouTubeRelevanceLanguage,
  usesProviderLanguageFallback,
  YOUTUBE_RELEVANCE_LANGUAGE_FALLBACKS,
  YOUTUBE_SUPPORTED_RELEVANCE_LANGUAGES,
} from './youtubeLanguageSupport';

test('resolver replaces provider-rejected languages with explicit fallbacks', () => {
  assert.deepEqual(resolveYouTubeRelevanceLanguage(['lb']), { language: 'fr', source: 'lb', fallback: true });
  assert.deepEqual(resolveYouTubeRelevanceLanguage(['mi']), { language: 'en', source: 'mi', fallback: true });
  assert.deepEqual(resolveYouTubeRelevanceLanguage(['ga']), { language: 'en', source: 'ga', fallback: true });
});

test('resolver prefers the first supported candidate and preserves supported codes', () => {
  assert.deepEqual(resolveYouTubeRelevanceLanguage(['lb', 'fr', 'de']), { language: 'fr', source: 'lb', fallback: true });
  assert.deepEqual(resolveYouTubeRelevanceLanguage(['de', 'fr']), { language: 'de', source: 'de' });
  assert.deepEqual(resolveYouTubeRelevanceLanguage(['xx', 'ja']), { language: 'ja', source: 'ja' });
  assert.deepEqual(resolveYouTubeRelevanceLanguage([]), {});
});

test('every fallback target is itself supported and no fallback loops', () => {
  for (const [from, to] of Object.entries(YOUTUBE_RELEVANCE_LANGUAGE_FALLBACKS)) {
    assert.equal(YOUTUBE_SUPPORTED_RELEVANCE_LANGUAGES.has(to), true, `${from} -> ${to}`);
    assert.notEqual(from, to);
  }
});

test('fallback-country detection is limited to countries with rejected languages', () => {
  assert.equal(usesProviderLanguageFallback('Luxembourg'), true);
  assert.equal(usesProviderLanguageFallback('New Zealand'), true);
  assert.equal(usesProviderLanguageFallback('Ireland'), true);
  assert.equal(usesProviderLanguageFallback('Germany'), false);
  assert.equal(usesProviderLanguageFallback('France'), false);
  assert.equal(usesProviderLanguageFallback('Unsupported Market'), false);
});

test('dispatch assertion rejects unsupported values before provider dispatch', () => {
  assert.equal(assertYouTubeRelevanceLanguage('fr'), 'fr');
  assert.equal(assertYouTubeRelevanceLanguage(undefined), undefined);
  assert.throws(() => assertYouTubeRelevanceLanguage('lb'), /UNSUPPORTED_YOUTUBE_RELEVANCE_LANGUAGE:lb/);
  assert.throws(() => assertYouTubeRelevanceLanguage('not-a-language'), /UNSUPPORTED_YOUTUBE_RELEVANCE_LANGUAGE/);
});
