import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_INSPECTED_VIDEO_DESCRIPTIONS, orderVideoDescriptionsForInspection } from './inspector';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';

const noInvite = (index: number) => `Recent upload ${index + 1}: market recap with no community link.`;
const withInvite = (code: string) => `Join the desk: https://discord.gg/${code}`;

test('H3 inspects the full ten-description sample, not only the first five', async () => {
  const descriptions = Array.from({ length: 10 }, (_, index) =>
    index === 6 ? withInvite('seventh-description') : noInvite(index));
  const result = await runChannelInspection({
    channelId: 'h3-late-seventh',
    channelName: 'H3 Late Seventh',
    channelBio: 'No invite',
    channelLinks: [],
    videoDescriptions: descriptions,
  });

  assert.equal(MAX_INSPECTED_VIDEO_DESCRIPTIONS, 10);
  assert.equal(result.foundInvite, 'seventh-description');
  const step = result.steps.find(item => item.step === 'VIDEO_DESCRIPTIONS');
  assert.equal(step?.status, 'FOUND');
  assert.match(step?.details || '', /Scanning 10 recent video descriptions\./);
});

test('H3 inspects an invite in the tenth description', async () => {
  const descriptions = Array.from({ length: 10 }, (_, index) =>
    index === 9 ? withInvite('tenth-description') : noInvite(index));
  const result = await runChannelInspection({
    channelId: 'h3-tenth',
    channelName: 'H3 Tenth',
    channelBio: 'No invite',
    channelLinks: [],
    videoDescriptions: descriptions,
  });

  assert.equal(result.foundInvite, 'tenth-description');
});

test('H3 inspects the tenth authoritative description', async () => {
  const recentVideoDescriptions = Array.from({ length: 10 }, (_, index) => ({
    videoId: `video-${index + 1}`,
    description: index === 9 ? withInvite('authoritative-tenth') : noInvite(index),
  }));
  const result = await runChannelInspection({
    channelId: 'h3-authoritative-tenth',
    channelName: 'H3 Authoritative Tenth',
    channelBio: 'No invite',
    channelLinks: [],
    videoDescriptions: recentVideoDescriptions.map(item => item.description),
    videoDescriptionsAuthoritative: true,
    recentVideoDescriptions,
  });

  assert.equal(result.foundInvite, 'authoritative-tenth');
});

test('H3 filters empty and duplicate descriptions before the bounded scan', async () => {
  const result = await runChannelInspection({
    channelId: 'h3-dedupe',
    channelName: 'H3 Dedupe',
    channelBio: 'No invite',
    channelLinks: [],
    videoDescriptions: [
      '',
      '   ',
      'Same recap without an invite.',
      'Same recap without an invite.',
      withInvite('deduped-room'),
    ],
  });

  assert.equal(result.foundInvite, 'deduped-room');
  const step = result.steps.find(item => item.step === 'VIDEO_DESCRIPTIONS');
  assert.equal(step?.status, 'FOUND');
  assert.match(step?.details || '', /Scanning 2 recent video descriptions\./);
});

test('H3 keeps the ten-description bound when more descriptions are supplied', async () => {
  const descriptions = Array.from({ length: 11 }, (_, index) =>
    index === 10 ? withInvite('outside-sample') : noInvite(index));
  const result = await runChannelInspection({
    channelId: 'h3-eleven',
    channelName: 'H3 Eleven',
    channelBio: 'No invite',
    channelLinks: [],
    videoDescriptions: descriptions,
  });

  assert.equal(result.foundInvite, null);
  const step = result.steps.find(item => item.step === 'VIDEO_DESCRIPTIONS');
  assert.equal(step?.status, 'NOT_FOUND');
  assert.match(step?.details || '', /Scanning 10 recent video descriptions/);
  assert.match(step?.details || '', /\(11 available; newest authoritative descriptions are prioritized\)/);
});

test('H3 skips cleanly when every supplied description is empty', async () => {
  const result = await runChannelInspection({
    channelId: 'h3-empty',
    channelName: 'H3 Empty',
    channelBio: 'No invite',
    channelLinks: [],
    videoDescriptions: ['', '   ', '\n\t'],
  });

  assert.equal(result.foundInvite, null);
  assert.equal(result.steps.find(item => item.step === 'VIDEO_DESCRIPTIONS')?.status, 'SKIPPED');
});

test('H3 channel-sampled top-ups outrank preloaded snippets in the ten slots', () => {
  const channelSampled = [
    'api upload 1', 'api upload 2', 'api upload 3', 'api upload 4', 'api upload 5',
    'keyless top-up 6', 'keyless top-up 7', 'keyless top-up 8', 'keyless top-up 9', 'keyless top-up 10',
  ];
  const preloaded = ['preloaded snippet 1', 'preloaded snippet 2', 'preloaded snippet 3', 'preloaded snippet 4', 'preloaded snippet 5'];
  const ordered = orderVideoDescriptionsForInspection(channelSampled, preloaded);
  assert.deepEqual(ordered.slice(0, MAX_INSPECTED_VIDEO_DESCRIPTIONS), channelSampled);
  assert.deepEqual(ordered.slice(MAX_INSPECTED_VIDEO_DESCRIPTIONS), preloaded);
});

test('H3 ordering trims, drops empty values, and dedupes while preserving order', () => {
  assert.deepEqual(
    orderVideoDescriptionsForInspection(
      ['  first  ', '', 'second'],
      ['second', '   ', 'third'],
    ),
    ['first', 'second', 'third'],
  );
});
