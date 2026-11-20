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

test('authoritative admission snapshot videos survive a stage-0 search-match context', () => {
  const input = normalizeFieldAwareInput({
    channel_id: 'UCsnapshot',
    channel_name: 'Precision Day Trading',
    description: 'Live scans, watchlists and trading education',
    country: 'United States',
    videos: [
      { id: 'v1', title: 'LIVE: Penny Stocks Small Cap Scanner', description: 'Live trading, watchlists and risk management' },
      { id: 'v2', title: 'LIVE: Small Cap Scanner', description: 'Live execution and trade recaps' }
    ],
    video_titles: ['LIVE: Penny Stocks Small Cap Scanner', 'LIVE: Small Cap Scanner'],
    video_descriptions: ['Live trading, watchlists and risk management', 'Live execution and trade recaps'],
    videoDescriptionsAuthoritative: true,
    enrichment_stage: 0,
    search_match_context: { type: 'CHANNEL', title: 'Precision Day Trading', description: 'Trading community' }
  } as any);
  assert.equal(input.videos?.length, 2);
  assert.deepEqual(input.video_titles, ['LIVE: Penny Stocks Small Cap Scanner', 'LIVE: Small Cap Scanner']);
  assert.deepEqual(input.video_descriptions, ['Live trading, watchlists and risk management', 'Live execution and trade recaps']);
});

test('non-authoritative stage-0 search-match videos still stay retrieval-only', () => {
  const input = normalizeFieldAwareInput({
    channel_id: 'UCretrieval',
    channel_name: 'Retrieval Candidate',
    description: '',
    country: 'Unknown',
    videos: [{ id: 'v1', title: 'Search-selected clip', description: 'Search snippet' }],
    video_titles: ['Search-selected clip'],
    video_descriptions: ['Search snippet'],
    videoDescriptionsAuthoritative: false,
    enrichment_stage: 0,
    search_match_context: { type: 'VIDEO', title: 'Search-selected clip', description: 'Search snippet' }
  } as any);
  assert.deepEqual(input.videos, []);
  assert.deepEqual(input.video_titles, []);
  assert.deepEqual(input.video_descriptions, []);
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
