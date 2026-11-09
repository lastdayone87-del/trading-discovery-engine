import assert from 'node:assert/strict';
import test from 'node:test';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SERVER_PAGE = 'https://discord.com/servers/official-fortnite-322850917248663552';
const WIDGET = 'https://discord.com/widget?id=322850917248663552';

test('a Discord server-page channel link is crawled and its invite retained', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'h1-server-page',
    channelName: 'H1 Server Page',
    channelBio: 'No invite',
    channelLinks: [SERVER_PAGE],
    videoDescriptions: ['1', '2', '3', '4', '5'],
    externalFetchImpl: (async (input: any) => {
      calls.push(String(input));
      if (String(input) === SERVER_PAGE) {
        return html('<html><body><a href="https://discord.gg/fortnite">Join the server</a></body></html>');
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'fortnite');
  assert.equal(result.discordCandidates?.length, 1);
  assert.equal(result.discordCandidates?.[0]?.sourceSurface, 'CHANNEL_EXTERNAL_LINKS');
  const step = result.steps.find(item => item.step === 'DISCORD_SURFACES');
  assert.equal(step?.status, 'FOUND');
  assert.match(step?.details || '', /server page/i);
  assert.ok(result.acquisitionOutcomes?.some(item =>
    item.surface === 'CHANNEL_EXTERNAL_LINKS'
    && item.outcome === 'FOUND'
    && item.requestedUrl === SERVER_PAGE));
  assert.deepEqual(calls, [SERVER_PAGE]);
});

test('a Discord widget URL in the bio uses instant_invite and keeps bio attribution', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'h1-widget-bio',
    channelName: 'H1 Widget Bio',
    channelBio: `Join the community: ${WIDGET}`,
    channelLinks: [],
    videoDescriptions: ['1', '2', '3', '4', '5'],
    externalFetchImpl: (async (input: any) => {
      calls.push(String(input));
      if (String(input).includes('/widget.json')) {
        return json({ name: 'Trading Floor', instant_invite: 'https://discord.gg/widget-room' });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'widget-room');
  assert.equal(result.discordCandidates?.[0]?.sourceSurface, 'YOUTUBE_ABOUT');
  const step = result.steps.find(item => item.step === 'DISCORD_SURFACES');
  assert.equal(step?.status, 'FOUND');
  assert.equal(step?.inviteLocation, 'YOUTUBE_ABOUT', 'the displayed source must follow the retained candidate, not a fixed surface');
  assert.deepEqual(calls, ['https://discord.com/api/v10/guilds/322850917248663552/widget.json']);
});

test('the same invite from a server page and a widget collapses to one candidate', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'h1-duplicate',
    channelName: 'H1 Duplicate',
    channelBio: 'No invite',
    channelLinks: [SERVER_PAGE, WIDGET],
    videoDescriptions: ['1', '2', '3', '4', '5'],
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url === SERVER_PAGE) return html('<a href="https://discord.gg/shared-room">Join</a>');
      if (url.includes('/widget.json')) return json({ instant_invite: 'https://discord.com/invite/shared-room' });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'shared-room');
  assert.equal(result.discordCandidates?.length, 1);
  assert.deepEqual(calls, [SERVER_PAGE, 'https://discord.com/api/v10/guilds/322850917248663552/widget.json']);
  const step = result.steps.find(item => item.step === 'DISCORD_SURFACES');
  assert.equal(step?.status, 'FOUND');
  assert.match(step?.details || '', /2 Discord server\/widget surface URL/);
  assert.match(step?.details || '', /1 distinct candidate\(s\) retained/);
});

test('an absent Discord invite is a clean inspected negative', async () => {
  const result = await runChannelInspection({
    channelId: 'h1-absent',
    channelName: 'H1 Absent',
    channelBio: 'No invite',
    channelLinks: [SERVER_PAGE],
    videoDescriptions: ['1', '2', '3', '4', '5'],
    externalFetchImpl: (async (input: any) => {
      const url = String(input);
      if (url === SERVER_PAGE) return html('<html><body><div id="app"></div></body></html>');
      if (url.includes('/widget.json')) return json({ message: 'not enabled' }, 403);
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective, undefined);
  assert.equal(result.steps.find(item => item.step === 'DISCORD_SURFACES')?.status, 'NOT_FOUND');
  assert.ok(result.acquisitionOutcomes?.some(item =>
    item.surface === 'CHANNEL_EXTERNAL_LINKS'
    && item.outcome === 'INSPECTED_NO_MATCH'
    && item.retryable === false));
});

test('a transient Discord surface failure owns retry instead of a clean negative', async () => {
  const result = await runChannelInspection({
    channelId: 'h1-transient',
    channelName: 'H1 Transient',
    channelBio: 'No invite',
    channelLinks: [SERVER_PAGE],
    videoDescriptions: ['1', '2', '3', '4', '5'],
    externalFetchImpl: (async () => html('unavailable', 503)) as typeof fetch,
  });

  assert.equal(result.foundInvite, null);
  assert.equal(result.acquisitionStatus, 'ACQUISITION_FAILED');
  assert.ok(result.retryDirective, 'a failed Discord surface must own a durable retry directive');
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(result.steps.find(item => item.step === 'DISCORD_SURFACES')?.status, 'ERROR');
});

test('malformed and non-server Discord paths are never fetched as public surfaces', async () => {
  const calls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'h1-malformed',
    channelName: 'H1 Malformed',
    channelBio: 'No invite',
    channelLinks: [
      'https://discord.com/servers',
      'https://discord.com/servers/gaming',
      'https://discord.com/widget?id=abc',
      'https://discord.com/channels/1/2',
    ],
    videoDescriptions: ['1', '2', '3', '4', '5'],
    externalFetchImpl: (async (input: any) => {
      calls.push(String(input));
      return html('no invite');
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, null);
  assert.equal(result.steps.find(item => item.step === 'DISCORD_SURFACES')?.status, 'SKIPPED');
  assert.deepEqual(calls, []);
});
