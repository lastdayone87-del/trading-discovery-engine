import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuditChannelInput, buildAuditEvidenceInput, normalizeAuditVideos, validateAuditLabelRows } from './classificationAuditWorklist';

const item = {
  itemId: 'item-1',
  channelId: 'chan-1',
  channelName: 'Example Trader',
  country: 'United States',
  description: 'Forex and futures analysis.',
  videos: [
    { title: 'EURUSD analysis', description: 'Technical analysis and trade setup.' },
    { title: '   ', description: 'This row has no title and must not shift the next description.' },
    { title: 'Gold outlook', description: 'XAUUSD levels.' },
    'Older string-only video',
  ],
  links: ['https://example.com'],
};

test('audit video normalization drops title-less rows without shifting descriptions', () => {
  const videos = normalizeAuditVideos(item);
  assert.deepEqual(videos.map(video => video.title), ['EURUSD analysis', 'Gold outlook', 'Older string-only video']);
  assert.deepEqual(videos.map(video => video.description), ['Technical analysis and trade setup.', 'XAUUSD levels.', '']);
});

test('classifier input and operator evidence use the same normalized video documents', () => {
  const input = buildAuditChannelInput(item);
  const evidence = buildAuditEvidenceInput(item);
  assert.deepEqual(input.video_titles, evidence.videos.map(video => video.title));
  assert.deepEqual(input.video_descriptions, evidence.videos.map(video => video.description));
  assert.equal(input.videos?.length, 3);
  assert.equal(input.enrichment_stage, 1);
  assert.equal(input.videoDescriptionsAuthoritative, true);
  assert.equal(input.search_match_context, undefined);
  assert.deepEqual(input.external_links, ['https://example.com']);
});

test('the evidence snapshot is bounded without separating titles from descriptions', () => {
  const many = {
    ...item,
    videos: Array.from({ length: 30 }, (_, index) => ({
      title: `Video ${index}`,
      description: `Description ${index}`,
    })),
  };
  const evidence = buildAuditEvidenceInput(many);
  assert.equal(evidence.videos.length, 15);
  evidence.videos.forEach((video, index) => {
    assert.equal(video.title, `Video ${index}`);
    assert.equal(video.description, `Description ${index}`);
  });
});

test('an import is rejected before writes when any row is unknown, invalid, or duplicated', () => {
  const ids = new Set(['item-1', 'item-2']);
  assert.doesNotThrow(() => validateAuditLabelRows([
    { itemId: 'item-1', label: 'TRADING_CONFIRMED' },
    { itemId: 'item-2', label: 'NON_TRADING' },
  ], ids));
  assert.throws(() => validateAuditLabelRows([{ itemId: 'missing', label: 'TRADING_CONFIRMED' }], ids), /UNKNOWN_AUDIT_ITEM/);
  assert.throws(() => validateAuditLabelRows([{ itemId: 'item-1', label: 'MAYBE' }], ids), /INVALID_AUDIT_LABEL/);
  assert.throws(() => validateAuditLabelRows([
    { itemId: 'item-1', label: 'TRADING_CONFIRMED' },
    { itemId: 'item-1', label: 'NON_TRADING' },
  ], ids), /DUPLICATE_AUDIT_LABEL/);
});
