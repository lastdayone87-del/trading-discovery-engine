import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildYouTubeApiUrl } from './youtube';
import { countrySearchHints } from './countrySearchHints';

test('Stage 5 locale request values match the effective YouTube query parameters', () => {
  const hints = countrySearchHints('France');
  const request = new URL(buildYouTubeApiUrl('search', 'placeholder-key', {
    part: 'snippet', type: 'video', q: 'analyse trading', maxResults: 25,
    regionCode: hints.regionCode, relevanceLanguage: hints.relevanceLanguage
  }));
  assert.equal(request.searchParams.get('regionCode'), 'FR');
  assert.equal(request.searchParams.get('relevanceLanguage'), 'fr');
  assert.deepEqual({
    regionCode: request.searchParams.get('regionCode'),
    relevanceLanguage: request.searchParams.get('relevanceLanguage')
  }, { regionCode: hints.regionCode, relevanceLanguage: hints.relevanceLanguage });
  assert.equal(request.searchParams.get('key'), 'placeholder-key');
});

test('Stage 5 provider telemetry derives locale from the final dispatched URL and uses additive persistence', () => {
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const resilience = readFileSync(new URL('./providerResilience.ts', import.meta.url), 'utf8');
  const db = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('./db/migrations/116_provider_request_locale_metadata.sql', import.meta.url), 'utf8');
  assert.match(youtube, /const dispatchedRequest = new URL\(dispatchedUrl\)/);
  assert.match(youtube, /regionCode: dispatchedRequest\.searchParams\.get\('regionCode'\)/);
  assert.match(youtube, /relevanceLanguage: dispatchedRequest\.searchParams\.get\('relevanceLanguage'\)/);
  assert.match(resilience, /requestMetadata\?: Record<string, string \| null>/);
  assert.match(db, /request_metadata/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS request_metadata JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE|VACUUM FULL/i);
});
