import assert from 'node:assert/strict';
import test from 'node:test';
import { inferChannelCountry } from './countryInference';
import { creatorLevelCountryEvidence } from './countryValidator';
import {
  applyPublicAboutToCandidate,
  fetchLiveYouTubeChannelData,
  shouldAttemptPublicAboutCountryFallback
} from './youtubePublicAbout';

async function runGate1CountryPhase(input: {
  channelName: string;
  channelId: string;
  youtubeUrl: string;
  discoveryCountry: string;
  initialDescription: string;
  apiMetadata: string;
  apiOfficialCountry?: string;
  publicAboutHtml?: string | null;
  publicAboutStatus?: number;
  exclusions: { country_name: string; reason: string }[];
}) {
  const calls = { publicAboutFetch: 0, upsert: 0, inspect: 0 };
  const candidate = {
    channelId: input.channelId,
    channelName: input.channelName,
    youtubeUrl: input.youtubeUrl,
    description: input.initialDescription,
    videoTitles: [] as string[],
    channelLinks: [] as string[],
    locationTag: undefined as string | undefined,
    countryMetadataStatus: 'NOT_REQUESTED' as string
  };

  let evidence = creatorLevelCountryEvidence({
    channelName: candidate.channelName,
    description: candidate.description,
    videoTitles: candidate.videoTitles,
    locationTag: candidate.locationTag,
    externalLinks: candidate.channelLinks
  });
  let inference = inferChannelCountry(
    { ...evidence, discoveryCountry: input.discoveryCountry },
    input.exclusions
  );
  let countryStatus = inference.status;

  candidate.countryMetadataStatus = input.apiMetadata;
  if (input.apiOfficialCountry) candidate.locationTag = input.apiOfficialCountry;
  evidence = creatorLevelCountryEvidence({
    channelName: candidate.channelName,
    description: candidate.description,
    videoTitles: candidate.videoTitles,
    locationTag: candidate.locationTag,
    externalLinks: candidate.channelLinks
  });
  inference = inferChannelCountry(
    { ...evidence, discoveryCountry: input.discoveryCountry, officialCountry: candidate.locationTag },
    input.exclusions
  );
  countryStatus = inference.status;

  if (
    shouldAttemptPublicAboutCountryFallback({
      countryStatus,
      countryMetadataStatus: candidate.countryMetadataStatus,
      description: candidate.description
    })
  ) {
    calls.publicAboutFetch++;
    let live = null as Awaited<ReturnType<typeof fetchLiveYouTubeChannelData>>;
    if (input.publicAboutStatus && input.publicAboutStatus >= 400) {
      live = await fetchLiveYouTubeChannelData(candidate.youtubeUrl, false, async () =>
        new Response('blocked', { status: input.publicAboutStatus!, headers: { 'content-type': 'text/html' } })
      );
    } else if (input.publicAboutHtml != null) {
      live = await fetchLiveYouTubeChannelData(candidate.youtubeUrl, false, async () =>
        new Response(input.publicAboutHtml!, { status: 200, headers: { 'content-type': 'text/html' } })
      );
    }
    if (applyPublicAboutToCandidate(candidate, live)) {
      evidence = creatorLevelCountryEvidence({
        channelName: candidate.channelName,
        description: candidate.description,
        videoTitles: candidate.videoTitles,
        locationTag: candidate.locationTag,
        externalLinks: candidate.channelLinks
      });
      inference = inferChannelCountry(
        { ...evidence, discoveryCountry: input.discoveryCountry, officialCountry: candidate.locationTag },
        input.exclusions
      );
      countryStatus = inference.status;
    }
  }

  const rejected = countryStatus === 'REJECTED';
  if (!rejected) {
    calls.upsert++;
    calls.inspect++;
  }
  return {
    calls,
    countryStatus,
    detectedCountry: inference.detectedCountry,
    evidence: inference.evidence,
    persisted: !rejected
  };
}

const PH = [{ country_name: 'Philippines', reason: 'excluded' }];
const aboutHtml = (text: string) =>
  `<html><script>ytInitialData = ${JSON.stringify({
    metadata: { channelMetadataRenderer: { description: text } }
  })};</script></html>`;

test('SCENARIO 1: excluded Philippines About rejects before persist/inspect', async () => {
  const result = await runGate1CountryPhase({
    channelName: 'PH Trader',
    channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
    youtubeUrl: 'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx',
    discoveryCountry: 'United Kingdom',
    initialDescription: '',
    apiMetadata: 'UNAVAILABLE',
    publicAboutHtml: aboutHtml('Based in the Philippines'),
    exclusions: PH
  });
  assert.equal(result.calls.publicAboutFetch, 1);
  assert.ok(result.evidence.some(e => e.source === 'CHANNEL_ABOUT_BIO' && e.priority === 2));
  assert.equal(result.detectedCountry, 'Philippines');
  assert.equal(result.countryStatus, 'REJECTED');
  assert.equal(result.persisted, false);
  assert.equal(result.calls.upsert, 0);
  assert.equal(result.calls.inspect, 0);
});

test('SCENARIO 2: About with no country remains UNCERTAIN and continues', async () => {
  const result = await runGate1CountryPhase({
    channelName: 'Generic Trader',
    channelId: 'UCyyyyyyyyyyyyyyyyyyyyyy',
    youtubeUrl: 'https://www.youtube.com/channel/UCyyyyyyyyyyyyyyyyyyyyyy',
    discoveryCountry: 'United Kingdom',
    initialDescription: '',
    apiMetadata: 'UNAVAILABLE',
    publicAboutHtml: aboutHtml('Daily charts and risk management tips for swing traders worldwide.'),
    exclusions: PH
  });
  assert.equal(result.calls.publicAboutFetch, 1);
  assert.equal(result.countryStatus, 'UNCERTAIN');
  assert.equal(result.persisted, true);
  assert.equal(result.calls.upsert, 1);
});

test('SCENARIO 3: AVAILABLE_DECLARED keeps P1; no public About fetch', async () => {
  const result = await runGate1CountryPhase({
    channelName: 'UK Official',
    channelId: 'UCzzzzzzzzzzzzzzzzzzzzzz',
    youtubeUrl: 'https://www.youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz',
    discoveryCountry: 'United Kingdom',
    initialDescription: '',
    apiMetadata: 'AVAILABLE_DECLARED',
    apiOfficialCountry: 'United Kingdom',
    publicAboutHtml: aboutHtml('Based in the Philippines'),
    exclusions: PH
  });
  assert.equal(result.calls.publicAboutFetch, 0);
  assert.ok(result.evidence.some(e => e.source === 'OFFICIAL_YOUTUBE_METADATA' && e.priority === 1));
  assert.equal(result.detectedCountry, 'United Kingdom');
});

test('SCENARIO 4: public About 403 soft-fails to UNCERTAIN', async () => {
  const result = await runGate1CountryPhase({
    channelName: 'Blocked',
    channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    youtubeUrl: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
    discoveryCountry: 'United Kingdom',
    initialDescription: '',
    apiMetadata: 'UNAVAILABLE',
    publicAboutStatus: 403,
    exclusions: PH
  });
  assert.equal(result.calls.publicAboutFetch, 1);
  assert.equal(result.countryStatus, 'UNCERTAIN');
  assert.equal(result.persisted, true);
});

test('SCENARIO 5: Target search country mismatch with detected excluded country returns exact telemetry fields', async () => {
  const { INITIAL_EXCLUDED_COUNTRIES } = await import('../src/data/initial_countries');
  assert.ok(INITIAL_EXCLUDED_COUNTRIES.length > 0, 'Initial excluded countries policy must be available');
  const excludedCountryName = INITIAL_EXCLUDED_COUNTRIES[0].country_name;
  const exclusions = [{ country_name: excludedCountryName, reason: 'Configured High-Spam Exclusion' }];

  const result = await runGate1CountryPhase({
    channelName: `Trader ${excludedCountryName}`,
    channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb',
    youtubeUrl: 'https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb',
    discoveryCountry: 'Canada',
    initialDescription: `Trader active in ${excludedCountryName}`,
    apiMetadata: 'UNAVAILABLE',
    exclusions
  });
  assert.equal(result.countryStatus, 'REJECTED');
  assert.equal(result.detectedCountry, excludedCountryName);
  assert.equal(result.persisted, false);

  const inference = inferChannelCountry(
    { aboutBio: `Trader active in ${excludedCountryName}`, discoveryCountry: 'Canada' },
    exclusions
  );
  assert.equal(inference.status, 'REJECTED');
  assert.equal(inference.detectedCountry, excludedCountryName);
  assert.match(inference.rejectionReason || '', new RegExp(`${excludedCountryName} is excluded by policy`));
});
