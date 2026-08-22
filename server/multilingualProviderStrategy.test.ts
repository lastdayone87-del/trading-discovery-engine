import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countrySearchHints, countrySearchLanguageCandidates } from './countrySearchHints';

test('Stage 7: multilingual country language selection is evidence-aware and country-pinned', () => {
  const cases = [
    ['Belgium', 'Dutch', 'nl', 'BE'],
    ['Belgium', 'French', 'fr', 'BE'],
    ['Belgium', 'German', 'de', 'BE'],
    ['Switzerland', 'German', 'de', 'CH'],
    ['Switzerland', 'French', 'fr', 'CH'],
    ['Switzerland', 'Italian', 'it', 'CH'],
    ['Canada', 'English', 'en', 'CA'],
    ['Canada', 'French', 'fr', 'CA']
  ] as const;
  for (const [country, preferred, language, region] of cases) {
    assert.deepEqual(countrySearchHints(country, [], preferred), { regionCode: region, relevanceLanguage: language });
  }
});

test('Stage 7: language candidates are deterministic, bounded, and do not become country selection', () => {
  assert.deepEqual(countrySearchLanguageCandidates('Belgium'), ['nl', 'fr', 'de']);
  assert.deepEqual(countrySearchLanguageCandidates('Switzerland'), ['de', 'fr', 'it']);
  assert.deepEqual(countrySearchLanguageCandidates('Canada'), ['en', 'fr']);
  assert.deepEqual(countrySearchHints('Belgium', [], 'Japanese'), { regionCode: 'BE', relevanceLanguage: 'nl' });
  assert.deepEqual(countrySearchHints('Canada', ['French'], 'French'), { regionCode: 'CA', relevanceLanguage: 'fr' });
});

test('Stage 7: the queue uses existing query/evidence metadata as a language preference', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const retrieval = readFileSync(new URL('./providerAwareRetrieval.ts', import.meta.url), 'utf8');
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.match(queue, /queryMetadata\.language, queryMetadata\.locale, queryMetadata\.dominantLocale/);
  assert.match(queue, /preferredLanguage/);
  assert.match(retrieval, /preferredLanguage: request\.preferredLanguage/);
  assert.match(youtube, /countrySearchHints\(countryName, vocab\?\.languages \|\| \[\], lifecycle\?\.preferredLanguage\)/);
  assert.match(youtube, /regionCode: searchHints\.regionCode/);
  assert.match(youtube, /relevanceLanguage: searchHints\.relevanceLanguage/);
});
