import assert from 'node:assert/strict';
import test from 'node:test';
import { creatorLevelCountryEvidence } from './countryValidator';
import { normalizeFieldAwareInput } from './tradingRelevanceClassifier';

test('country attribution ignores retrieval-selected market and instrument titles', () => {
  const evidence = creatorLevelCountryEvidence({
    channelName: 'Academy by SMI',
    description: '',
    videoTitles: ['SMI Analyse Switzerland CHF Swiss Market Index'],
    externalLinks: []
  });
  assert.deepEqual(evidence.videoTitles, []);
  // The ambiguous retrieval token is intentionally removed from creator-level
  // country evidence as well. The remaining generic identity words must not
  // become independent geographic evidence.
  assert.equal(evidence.aboutBio.trim(), '');
});

test('creator-level country evidence still preserves independent channel metadata', () => {
  const evidence = creatorLevelCountryEvidence({
    channelName: 'Market Desk',
    description: 'Independent trader based in Zürich, Switzerland',
    videoTitles: ['Unrelated retrieval-selected title'],
    locationTag: 'CH',
    externalLinks: ['https://example.ch', 'https://instagram.com/zurichtrader']
  });
  assert.equal(evidence.officialCountry, 'CH');
  assert.match(evidence.aboutBio, /Zürich/);
  assert.deepEqual(evidence.officialWebsiteLinks, ['https://example.ch']);
  assert.deepEqual(evidence.verifiedSocialLinks, ['https://instagram.com/zurichtrader']);
  assert.deepEqual(evidence.videoTitles, []);
});

test('initial search-match documents remain provenance and are not promoted to independent video evidence', () => {
  const input = normalizeFieldAwareInput({
    channel_id: 'UCexample',
    channel_name: 'SMI TV',
    description: '',
    country: 'Switzerland',
    video_titles: ['SMI Analyse Switzerland'],
    video_descriptions: ['Swiss Market Index SMI trading'],
    enrichment_stage: 0,
    search_match_context: { type: 'VIDEO', title: 'SMI Analyse Switzerland', description: 'Swiss Market Index SMI trading' }
  } as any);
  assert.deepEqual(input.videos, []);
  assert.deepEqual(input.video_titles, []);
  assert.deepEqual(input.video_descriptions, []);
  assert.equal(input.search_match_context?.title, 'SMI Analyse Switzerland');
});

test('post-enrichment creator videos remain eligible as independent evidence', () => {
  const input = normalizeFieldAwareInput({
    channel_id: 'UCexample',
    channel_name: 'Real Trading Creator',
    description: 'Futures trader and educator',
    country: 'Germany',
    videos: [
      { id: 'v1', title: 'DAX futures trade review', description: 'Execution and risk management' },
      { id: 'v2', title: 'Order flow lesson', description: 'Footprint analysis' }
    ],
    enrichment_stage: 1,
    search_match_context: { type: 'VIDEO', title: 'DAX trading' }
  } as any);
  assert.equal(input.videos?.length, 2);
  assert.deepEqual(input.video_titles, ['DAX futures trade review', 'Order flow lesson']);
});
