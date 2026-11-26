import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESERVED_DISCORD_ROUTE_CODES,
  candidateFromNativeInvite,
  extractDiscordCandidates,
} from './discordCandidates';
import { validateDiscordInvite } from './discordValidator';

function codes(text: string): string[] {
  return extractDiscordCandidates(text)
    .map(candidate => candidate.nativeInviteCode)
    .filter((code): code is string => typeof code === 'string');
}

// Discord's live invite API serves these as real invites. They were in the old
// reserved list and were silently discarded before validation.
const VALID_CONFIRMED_CODES = [
  'channels',
  'store',
  'download',
  'api',
  'widget',
  'terms',
  'privacy',
  'before',
  'after',
  'next',
  'index',
  'home',
  'about',
  'contact',
  'support',
  'template',
];

test('valid confirmed invite codes are retained for live validation', () => {
  for (const code of VALID_CONFIRMED_CODES) {
    assert.deepEqual(codes(`Join https://discord.gg/${code}`), [code], code);
    assert.deepEqual(codes(`Join https://discord.com/invite/${code}`), [code], code);
  }
});

test('structural Discord application routes remain excluded', () => {
  for (const code of RESERVED_DISCORD_ROUTE_CODES) {
    assert.deepEqual(codes(`https://discord.gg/${code}`), [], code);
  }
  assert.equal(candidateFromNativeInvite({
    nativeInviteCode: 'login',
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
  }), null);
});

test('admitted codes reach live validation instead of being rejected as reserved', async () => {
  const fetched: string[] = [];
  for (const code of ['store', 'channels', 'support', 'template']) {
    const result = await validateDiscordInvite(code, {
      maxAttempts: 1,
      retryDelayMs: 0,
      emitProviderEvent: async () => {},
      fetchImpl: (async (input) => {
        fetched.push(String(input));
        return new Response(JSON.stringify({ code: 10006, message: 'Unknown Invite' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    assert.notEqual(result.operationalOutcome, 'INVALID_LOCATOR', code);
    assert.ok(fetched.at(-1)?.includes(`/invites/${code}`), code);
  }
});

test('structural routes are still rejected before any Discord request', async () => {
  let calls = 0;
  const result = await validateDiscordInvite('login', {
    maxAttempts: 1,
    emitProviderEvent: async () => {},
    fetchImpl: (async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(result.operationalOutcome, 'INVALID_LOCATOR');
  assert.equal(calls, 0);
});

test('the reserved route set is deliberately narrow and documented', () => {
  assert.deepEqual([...RESERVED_DISCORD_ROUTE_CODES].sort(), [
    'branding',
    'faq',
    'guilds',
    'invite',
    'jobs',
    'login',
    'nitro',
    'oauth2',
    'prev',
    'register',
  ]);
});
