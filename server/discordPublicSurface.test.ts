import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireDiscordPublicSurface,
  discordPublicSurfaceFor,
  widgetJsonUrl,
  type DiscordPublicSurfaceRef,
} from './discordPublicSurface';
import { normalizeExternalUrl } from './inspector';

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const serverSurface = (): DiscordPublicSurfaceRef => ({
  kind: 'SERVER_PAGE',
  guildId: '322850917248663552',
  canonicalUrl: 'https://discord.com/servers/official-fortnite-322850917248663552',
});

const widgetSurface = (): DiscordPublicSurfaceRef => ({
  kind: 'WIDGET',
  guildId: '322850917248663552',
  canonicalUrl: 'https://discord.com/widget?id=322850917248663552',
});

test('parses Discord server-directory URL variants and canonicalizes the host', () => {
  assert.deepEqual(
    discordPublicSurfaceFor('https://discord.com/servers/official-fortnite-322850917248663552'),
    {
      kind: 'SERVER_PAGE',
      guildId: '322850917248663552',
      canonicalUrl: 'https://discord.com/servers/official-fortnite-322850917248663552',
    },
  );
  assert.deepEqual(
    discordPublicSurfaceFor('https://www.discordapp.com/servers/322850917248663552/'),
    {
      kind: 'SERVER_PAGE',
      guildId: '322850917248663552',
      canonicalUrl: 'https://discord.com/servers/322850917248663552',
    },
  );
  assert.deepEqual(
    discordPublicSurfaceFor('https://discord.com/servers/valorant-679875946597056683#top'),
    {
      kind: 'SERVER_PAGE',
      guildId: '679875946597056683',
      canonicalUrl: 'https://discord.com/servers/valorant-679875946597056683',
    },
  );
});

test('parses widget URL variants and drops presentation-only query keys', () => {
  assert.deepEqual(discordPublicSurfaceFor('https://discord.com/widget?id=322850917248663552&theme=dark'), {
    kind: 'WIDGET',
    guildId: '322850917248663552',
    canonicalUrl: 'https://discord.com/widget?id=322850917248663552',
  });
  assert.deepEqual(discordPublicSurfaceFor('https://discordapp.com/widget?server_id=322850917248663552'), {
    kind: 'WIDGET',
    guildId: '322850917248663552',
    canonicalUrl: 'https://discord.com/widget?id=322850917248663552',
  });
  assert.equal(widgetJsonUrl('322850917248663552'), 'https://discord.com/api/v10/guilds/322850917248663552/widget.json');
});

test('rejects non-surface Discord paths and malformed guild ids', () => {
  for (const raw of [
    'https://discord.com/servers',
    'https://discord.com/servers/gaming',
    'https://discord.com/servers/2024',
    'https://discord.com/widget',
    'https://discord.com/widget?id=abc',
    'https://discord.com/widget?id=123',
    'https://discord.com/channels/322850917248663552/456',
    'https://discord.com/invite/abc123',
    'https://discord.gg/abc123',
    'https://example.com/servers/322850917248663552',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(discordPublicSurfaceFor(raw), null, raw);
  }
});

test('crawler normalization admits only the new Discord surface shapes', () => {
  assert.equal(
    normalizeExternalUrl('https://discord.com/servers/official-fortnite-322850917248663552')?.kind,
    'DISCORD',
  );
  assert.equal(
    normalizeExternalUrl('https://discord.com/widget?id=322850917248663552&theme=light')?.kind,
    'DISCORD',
  );
  assert.equal(normalizeExternalUrl('https://discord.gg/abc123'), null);
  assert.equal(normalizeExternalUrl('https://discord.com/channels/1/2'), null);
  assert.equal(normalizeExternalUrl('https://discord.com/servers/gaming'), null);
});

test('server page HTML exposes a native invite candidate', async () => {
  const calls: string[] = [];
  const result = await acquireDiscordPublicSurface({
    surface: serverSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async (input: any, init?: RequestInit) => {
      calls.push(String(input));
      assert.equal(init?.redirect, 'follow');
      return html('<html><body><a href="https://discord.gg/fortnite">Join</a></body></html>');
    }) as typeof fetch,
  });
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.candidates[0]?.nativeInviteCode, 'fortnite');
  assert.equal(result.candidates[0]?.sourceSurface, 'CHANNEL_EXTERNAL_LINKS');
  assert.equal(result.requestsStarted, 1);
  assert.equal(result.pagesInspected, 1);
  assert.deepEqual(calls, [serverSurface().canonicalUrl]);
});

test('widget JSON instant_invite becomes a native candidate', async () => {
  const result = await acquireDiscordPublicSurface({
    surface: widgetSurface(),
    sourceSurface: 'CREATOR_WEBSITES',
    fetchImpl: (async (input: any) => {
      assert.equal(String(input), widgetJsonUrl(widgetSurface().guildId));
      return json({ name: 'Trading Floor', instant_invite: 'https://discord.com/invite/room123' });
    }) as typeof fetch,
  });
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.candidates[0]?.nativeInviteCode, 'room123');
  assert.equal(result.candidates[0]?.sourceSurface, 'CREATOR_WEBSITES');
  assert.equal(result.requestsStarted, 1);
  assert.equal(result.pagesInspected, 0);
});

test('server page without a static invite falls back to the public widget', async () => {
  const calls: string[] = [];
  const result = await acquireDiscordPublicSurface({
    surface: serverSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async (input: any) => {
      calls.push(String(input));
      if (String(input).includes('/widget.json')) return json({ instant_invite: 'https://discord.gg/widget-room' });
      return html('<html><body><div id="app"></div></body></html>');
    }) as typeof fetch,
  });
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.candidates[0]?.nativeInviteCode, 'widget-room');
  assert.equal(result.requestsStarted, 2);
  assert.equal(result.pagesInspected, 1);
  assert.equal(calls.length, 2);
});

test('an absent invite is a clean inspected negative, not a retry', async () => {
  const result = await acquireDiscordPublicSurface({
    surface: serverSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async (input: any) => {
      if (String(input).includes('/widget.json')) return json({}, 403);
      return html('<html><body><div id="app"></div></body></html>');
    }) as typeof fetch,
  });
  assert.equal(result.outcome, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryable, false);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.requestsStarted, 2);
});

test('a disabled widget is a clean negative', async () => {
  const result = await acquireDiscordPublicSurface({
    surface: widgetSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async () => json({ message: 'not enabled' }, 403)) as typeof fetch,
  });
  assert.equal(result.outcome, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryable, false);
});

test('transient widget failures remain retryable uncertainty', async () => {
  const result = await acquireDiscordPublicSurface({
    surface: widgetSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async () => json({}, 503)) as typeof fetch,
  });
  assert.equal(result.outcome, 'ACQUISITION_FAILED');
  assert.equal(result.retryable, true);
  assert.equal(result.failureClass, 'TRANSIENT_HTTP');
});

test('a confirmed server-page 404 is non-retryable; other failures are retryable', async () => {
  const notFound = await acquireDiscordPublicSurface({
    surface: serverSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async () => html('gone', 404)) as typeof fetch,
  });
  assert.equal(notFound.outcome, 'ACQUISITION_FAILED');
  assert.equal(notFound.retryable, false);
  assert.equal(notFound.failureClass, 'HTTP_ERROR');

  const blocked = await acquireDiscordPublicSurface({
    surface: serverSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async () => html('blocked', 403)) as typeof fetch,
  });
  assert.equal(blocked.outcome, 'ACQUISITION_FAILED');
  assert.equal(blocked.retryable, true);
});

test('network and malformed-response failures are retryable uncertainty', async () => {
  const network = await acquireDiscordPublicSurface({
    surface: widgetSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch,
  });
  assert.equal(network.outcome, 'ACQUISITION_FAILED');
  assert.equal(network.retryable, true);
  assert.equal(network.failureClass, 'NETWORK_FAILURE');

  const malformed = await acquireDiscordPublicSurface({
    surface: widgetSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  assert.equal(malformed.outcome, 'ACQUISITION_FAILED');
  assert.equal(malformed.retryable, true);
  assert.equal(malformed.failureClass, 'MALFORMED_RESPONSE');
});

test('duplicate invite links inside one server page collapse to one candidate', async () => {
  const result = await acquireDiscordPublicSurface({
    surface: serverSurface(),
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    fetchImpl: (async () => html(
      '<a href="https://discord.gg/fortnite">one</a>'
      + '<a href="https://discord.com/invite/fortnite">two</a>',
    )) as typeof fetch,
  });
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.nativeInviteCode, 'fortnite');
});
