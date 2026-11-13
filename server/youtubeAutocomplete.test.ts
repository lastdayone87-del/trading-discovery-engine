import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchYouTubeAutocomplete } from './youtubeAutocomplete';

test('YouTube autocomplete sends language and region and parses suggestions', async () => {
  let called = '';
  const suggestions = await fetchYouTubeAutocomplete('dax', {
    language: 'de',
    regionCode: 'DE',
    fetchImpl: (async (url: string) => {
      called = String(url);
      return new Response(JSON.stringify(['dax', ['dax trading', 'dax analyse heute', 'DAX live']]), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual(suggestions, ['dax trading', 'dax analyse heute', 'DAX live']);
  assert.match(called, /hl=de/);
  assert.match(called, /gl=DE/);
  assert.match(called, /ds=yt/);
});

test('autocomplete failure is a cache miss, not discovery failure', async () => {
  const suggestions = await fetchYouTubeAutocomplete('forex', {
    language: 'fr',
    regionCode: 'FR',
    fetchImpl: (async () => { throw new Error('network'); }) as typeof fetch,
  });
  assert.deepEqual(suggestions, []);
});
