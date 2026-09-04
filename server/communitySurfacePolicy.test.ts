import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAcquisitionOutcomes, rankCommunitySurfaces, scoreCommunitySurface } from './communitySurfacePolicy';

test('creator and community surfaces rank ahead of affiliate referral destinations', () => {
  const ranked = rankCommunitySurfaces([
    { url: 'https://www.binance.com/activity/referral-entry/CPA', contextMatches: false, source: 'VIDEO_2_DESCRIPTION' },
    { url: 'https://creator.example.com', contextMatches: false, source: 'CHANNEL_LINKS' },
    { url: 'https://linktr.ee/creator', contextMatches: false, source: 'CHANNEL_LINKS' },
    { url: 'https://www.degiro.fr/parrainage/start?id=abc', contextMatches: false, source: 'VIDEO_2_DESCRIPTION' },
    { url: 'https://creator.example.com/community', contextMatches: true, source: 'VIDEO_1_DESCRIPTION' },
  ]);

  assert.equal(ranked[0].url, 'https://creator.example.com/community');
  assert.ok(ranked.findIndex(item => item.url === 'https://creator.example.com') < ranked.findIndex(item => item.url.includes('binance.com')));
  assert.ok(ranked.findIndex(item => item.url.includes('linktr.ee')) < ranked.findIndex(item => item.url.includes('degiro.fr')));
});

test('ranking is prioritization only and keeps low-value URLs for later inspection', () => {
  const inputs = [
    { url: 'https://refer.ig.com/nulls-26', contextMatches: false, source: 'VIDEO_2_DESCRIPTION' },
    { url: 'https://beacons.ai/trader', contextMatches: false, source: 'CHANNEL_LINKS' },
    { url: 'https://mabanque.fortuneo.fr/offers?origine=PARRAINAGE', contextMatches: false, source: 'VIDEO_5_DESCRIPTION' },
  ];
  const ranked = rankCommunitySurfaces(inputs);
  assert.equal(ranked.length, inputs.length);
  assert.deepEqual(new Set(ranked.map(item => item.url)), new Set(inputs.map(item => item.url)));
  assert.ok(scoreCommunitySurface(ranked[0]) > scoreCommunitySurface(ranked[ranked.length - 1]));
});

test('required rendered success supersedes earlier non-required static failure regardless of order', () => {
  const staticFailure = {
    requestedUrl: 'https://creator.example/guide',
    surface: 'CREATOR_WEBSITES',
    outcome: 'ACQUISITION_FAILED' as const,
    required: false,
  };
  const renderedSuccess = {
    requestedUrl: 'https://creator.example/guide',
    surface: 'CREATOR_WEBSITES',
    outcome: 'INSPECTED_NO_MATCH' as const,
    required: true,
  };
  for (const observations of [[staticFailure, renderedSuccess], [renderedSuccess, staticFailure]]) {
    const effective = effectiveAcquisitionOutcomes(observations);
    assert.equal(effective.length, 1);
    assert.equal(effective[0].outcome, 'INSPECTED_NO_MATCH');
    assert.equal((effective[0] as { required?: unknown }).required, true);
  }
});

test('required rendered failure overrides earlier non-required static clean regardless of order', () => {
  const staticClean = {
    requestedUrl: 'https://creator.example/guide',
    surface: 'CREATOR_WEBSITES',
    outcome: 'INSPECTED_NO_MATCH' as const,
    required: false,
  };
  const renderedFailure = {
    requestedUrl: 'https://creator.example/guide',
    surface: 'CREATOR_WEBSITES',
    outcome: 'ACQUISITION_FAILED' as const,
    required: true,
  };
  for (const observations of [[staticClean, renderedFailure], [renderedFailure, staticClean]]) {
    const effective = effectiveAcquisitionOutcomes(observations);
    assert.equal(effective.length, 1);
    assert.equal(effective[0].outcome, 'ACQUISITION_FAILED');
    assert.equal((effective[0] as { required?: unknown }).required, true);
  }
});

test('required rendered success supersedes non-required static partial results', () => {
  const effective = effectiveAcquisitionOutcomes([
    {
      requestedUrl: 'https://creator.example/guide',
      surface: 'CREATOR_WEBSITES',
      outcome: 'PARTIALLY_INSPECTED' as const,
      required: false,
    },
    {
      requestedUrl: 'https://creator.example/guide',
      surface: 'CREATOR_WEBSITES',
      outcome: 'INSPECTED_NO_MATCH' as const,
      required: true,
    },
  ]);
  assert.equal(effective.length, 1);
  assert.equal(effective[0].outcome, 'INSPECTED_NO_MATCH');
});

test('explicit zero-evidence clean never beats a real failure signal for the same URL', () => {
  const zeroEvidence = { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0, budgetExhausted: false };
  const effective = effectiveAcquisitionOutcomes([
    {
      requestedUrl: 'https://creator.example/guide',
      surface: 'CREATOR_WEBSITES',
      outcome: 'INSPECTED_NO_MATCH' as const,
      required: true,
      telemetry: zeroEvidence,
    },
    {
      requestedUrl: 'https://creator.example/guide',
      surface: 'CREATOR_WEBSITES',
      outcome: 'ACQUISITION_FAILED' as const,
      required: true,
      telemetry: { pagesInspected: 1, requestsStarted: 0, redirectsFollowed: 0, budgetExhausted: false },
    },
  ]);
  assert.equal(effective.length, 1);
  assert.equal(effective[0].outcome, 'ACQUISITION_FAILED');
});

test('successful rendered coverage supersedes an earlier static failure for the same URL', () => {
  const observations = effectiveAcquisitionOutcomes([
    {
      requestedUrl: 'https://example.com/',
      surface: 'CREATOR_WEBSITES',
      outcome: 'ACQUISITION_FAILED' as const,
      observedAt: '2026-08-16T10:00:00Z',
    },
    {
      requestedUrl: 'https://example.com',
      surface: 'CREATOR_WEBSITES',
      outcome: 'INSPECTED_NO_MATCH' as const,
      observedAt: '2026-08-16T10:00:05Z',
    },
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0].outcome, 'INSPECTED_NO_MATCH');
});

test('a genuinely unresolved URL remains failed even when another URL was inspected', () => {
  const observations = effectiveAcquisitionOutcomes([
    { requestedUrl: 'https://creator.example.com', surface: 'CREATOR_WEBSITES', outcome: 'INSPECTED_NO_MATCH' as const },
    { requestedUrl: 'https://blocked.example.com', surface: 'CREATOR_WEBSITES', outcome: 'ACQUISITION_FAILED' as const },
  ]);

  assert.equal(observations.length, 2);
  assert.ok(observations.some(item => item.outcome === 'INSPECTED_NO_MATCH'));
  assert.ok(observations.some(item => item.outcome === 'ACQUISITION_FAILED'));
});
