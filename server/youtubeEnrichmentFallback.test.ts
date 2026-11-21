import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { adaptInnertubeVideosToRecentItems, shouldAttemptAdmissionPublicAbout } from './youtube';

test('InnerTube channel videos are adapted into the official playlist-item shape', () => {
  const adapted = adaptInnertubeVideosToRecentItems([
    { videoId: 'v1', title: 'NQ futures recap', description: 'Execution and risk.', publishedAt: '2026-11-20' },
    { videoId: 'v2', description: 'Title omitted by provider' },
    { videoId: '', title: 'No id' },
  ]);
  assert.equal(adapted.items.length, 2);
  assert.deepEqual(adapted.items[0], {
    id: { videoId: 'v1' },
    snippet: {
      title: 'NQ futures recap',
      description: 'Execution and risk.',
      publishedAt: '2026-11-20',
    },
  });
  // A provider response may omit the title but still carry a creator-authored
  // description; do not discard that evidence.
  assert.deepEqual(adapted.items[1], {
    id: { videoId: 'v2' },
    snippet: { title: '', description: 'Title omitted by provider' },
  });
});

test('public About is attempted only when bio or links are insufficient', () => {
  assert.equal(shouldAttemptAdmissionPublicAbout({ description: '', links: [] }), true);
  assert.equal(
    shouldAttemptAdmissionPublicAbout({ description: 'Share your videos with friends, family, and the world', links: ['https://a.example'] }),
    true,
  );
  assert.equal(shouldAttemptAdmissionPublicAbout({ description: 'Short bio', links: ['https://a.example'] }), false);
  assert.equal(
    shouldAttemptAdmissionPublicAbout({ description: 'A sufficiently descriptive creator bio.', links: ['https://a.example'] }),
    false,
  );
});

test('enrichment wires topicDetails, Innertube uploads fallback, and public About fallback', () => {
  const source = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.match(source, /part:'snippet,brandingSettings,statistics,contentDetails,topicDetails'/);
  assert.match(source, /parseChannelTopicDetails\(channel\)/);
  assert.match(source, /fetchChannelVideoDescriptionsViaInnertube\(channelId/);
  assert.match(source, /event: 'youtube_innertube_sample_unavailable'/);
  assert.match(source, /fetchPublicAboutEvidence\(`https:\/\/www\.youtube\.com\/channel\/\$\{channelId\}`\)/);
  assert.match(source, /fetchChannelAboutViaInnertube\(channelId\)/);
  assert.match(source, /channelTopics: parseChannelTopicDetails\(channel\)/);
  assert.match(source, /publicAboutCheckpoint !== undefined/);
  assert.match(source, /shouldAttemptAdmissionPublicAbout\(\{ description, links: extractedLinks \}\)/);
  assert.match(source, /hasMeaningfulCreatorText\(description\)/);
  assert.match(source, /evidenceAcquisitionFailure: evidenceAcquisitionFailure \|\| videoSampleFailure/);
});
