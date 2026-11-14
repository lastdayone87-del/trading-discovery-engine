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
  assert.match(called, /ie=utf-8/);
  assert.match(called, /oe=utf-8/);
  assert.match(called, /hl=de/);
  assert.match(called, /gl=DE/);
  assert.match(called, /ds=yt/);
});

test('autocomplete honors a non-UTF-8 response charset', async () => {
  const payload = '["dax",["dax grüße"]]';
  const latin1 = Uint8Array.from(payload, character => character.charCodeAt(0) & 0xff);
  const suggestions = await fetchYouTubeAutocomplete('dax', {
    language: 'de',
    regionCode: 'DE',
    fetchImpl: (async () => new Response(latin1, {
      status: 200,
      headers: { 'content-type': 'application/json; charset="iso-8859-1"' },
    })) as typeof fetch,
  });
  assert.deepEqual(suggestions, ['dax grüße']);
});

test('autocomplete failure is a cache miss, not discovery failure', async () => {
  const suggestions = await fetchYouTubeAutocomplete('forex', {
    language: 'fr',
    regionCode: 'FR',
    fetchImpl: (async () => { throw new Error('network'); }) as typeof fetch,
  });
  assert.deepEqual(suggestions, []);
});
