import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPublicAboutToCandidate,
  isChannelDescriptionInsufficient,
  parseYouTubeChannelAboutFromHtml,
  shouldAttemptPublicAboutCountryFallback,
  fetchLiveYouTubeChannelData
} from './youtubePublicAbout';
import { inferChannelCountry } from './countryInference';

/** Mirrors creatorLevelCountryEvidence About wiring without importing db-backed validator. */
function aboutEvidence(channelName: string, description: string) {
  return {
    channelName,
    aboutBio: description || '',
    videoTitles: [] as string[]
  };
}

const PH_EXCLUSIONS = [{ country_name: 'Philippines', reason: 'test exclusion' }];

test('isChannelDescriptionInsufficient treats empty and short text as insufficient', () => {
  assert.equal(isChannelDescriptionInsufficient(''), true);
  assert.equal(isChannelDescriptionInsufficient('short'), true);
  assert.equal(isChannelDescriptionInsufficient('Based in the Philippines trading forex daily'), false);
});

test('E: AVAILABLE_DECLARED does not attempt public About fallback', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'AVAILABLE_DECLARED',
      description: ''
    }),
    false
  );
});

test('E: AVAILABLE_NOT_DECLARED with usable description does not attempt fallback', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
      description: 'Long enough channel about text without needing public scrape'
    }),
    false
  );
});

test('AVAILABLE_NOT_DECLARED with empty description attempts bounded About fallback', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
      description: ''
    }),
    true
  );
});

test('publicAboutAttempted = true prevents repeated About fallback attempts', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
      description: '',
      publicAboutAttempted: true
    }),
    false
  );
});

test('A/D condition: UNAVAILABLE + UNCERTAIN + empty description attempts fallback', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'UNAVAILABLE',
      description: ''
    }),
    true
  );
});

test('fallback is not attempted when country is already REJECTED or CONFIRMED', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'REJECTED',
      countryMetadataStatus: 'UNAVAILABLE',
      description: ''
    }),
    false
  );
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'CONFIRMED',
      countryMetadataStatus: 'UNAVAILABLE',
      description: ''
    }),
    false
  );
});

test('G: parse ytInitialData About containing Philippines', () => {
  const html = `<html><script>ytInitialData = ${JSON.stringify({
    metadata: {
      channelMetadataRenderer: {
        description: 'Based in the Philippines. Daily forex analysis.'
      }
    }
  })};</script></html>`;
  const parsed = parseYouTubeChannelAboutFromHtml(html);
  assert.match(parsed.bio || '', /Philippines/i);
});

test('G/A/C/E: literal Philippines in About produces CHANNEL_ABOUT_BIO and REJECTED over UK discovery', () => {
  const result = inferChannelCountry(
    { ...aboutEvidence('PH Trader', 'Based in the Philippines'), discoveryCountry: 'United Kingdom' },
    PH_EXCLUSIONS
  );
  assert.equal(result.detectedCountry, 'Philippines');
  assert.equal(result.detectedCreatorCountry, 'Philippines');
  assert.equal(result.discoveryCountry, 'United Kingdom');
  assert.equal(result.status, 'REJECTED');
  const about = result.evidence.find(item => item.source === 'CHANNEL_ABOUT_BIO');
  assert.ok(about);
  assert.equal(about!.priority, 2);
  assert.ok(result.evidence.some(item => item.source === 'DISCOVERY_CONTEXT' && item.priority === 10));
});

test('B: About without country signals remains UNCERTAIN on discovery context with null creator country', () => {
  const result = inferChannelCountry(
    {
      ...aboutEvidence(
        'Generic Trader',
        'Daily charts and risk management tips for swing traders worldwide.'
      ),
      discoveryCountry: 'United Kingdom'
    },
    PH_EXCLUSIONS
  );
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.detectedCreatorCountry, null);
  assert.equal(result.detectedCountry, null);
  assert.equal(result.discoveryCountry, 'United Kingdom');
});

test('D: failed public About fetch is soft-fail (no description applied)', async () => {
  const candidate = { description: '', channelLinks: [] as string[] };
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    async () => new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/html' } })
  );
  assert.equal(live, null);
  assert.equal(applyPublicAboutToCandidate(candidate, live), false);
  assert.equal(candidate.description, '');
});

test('D: network error soft-fails to null', async () => {
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    async () => {
      throw new Error('network down');
    }
  );
  assert.equal(live, null);
});

test('applyPublicAboutToCandidate sets description from bio for Gate 1 re-validation', () => {
  const candidate = { description: '', channelLinks: [] as string[] };
  assert.equal(
    applyPublicAboutToCandidate(candidate, {
      bio: 'Based in the Philippines',
      channelLinks: ['https://twitter.com/x']
    }),
    true
  );
  assert.equal(candidate.description, 'Based in the Philippines');
  assert.deepEqual(candidate.channelLinks, ['https://twitter.com/x']);
});

test('parse falls back to og:description when ytInitialData missing', () => {
  const html =
    '<html><head><meta name="description" content="Trader from the Philippines" /></head><body></body></html>';
  const parsed = parseYouTubeChannelAboutFromHtml(html);
  assert.match(parsed.bio || '', /Philippines/i);
});
