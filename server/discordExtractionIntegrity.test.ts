/**
 * P1 extraction-integrity regressions (report section 4).
 *
 * Confirmed defects encoded here:
 * - host-boundary leak: `example.com/discord.gg/x`, `notdiscord.gg/x`,
 *   `evil-discord.gg/x` were extracted as invites (false positives);
 * - punctuation/prose accepted as codes (`abc123.`);
 * - entity/dot obfuscation and alternative hosts were missed or mishandled;
 * - shortener redirects to a Discord invite had to keep working;
 * - unparseable bare legacy values (prose, fragments) must never become
 *   candidates.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractDiscordCandidates,
  discordInviteCodeOf,
  sanitizeDiscordInviteCode,
  buildLegacyDiscordCandidate,
} from './discordCandidates';
import { crawlExternalLinks } from './inspector';

const codeOf = (text: string) => extractDiscordCandidates(text, 'CREATOR_WEBSITES').map(candidate => candidate.nativeInviteCode);

const html = (body: string, url?: string) => {
  const response = new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
};

test('host boundary: embedded discord.gg paths, lookalike hosts, and word fragments are not invites', () => {
  for (const input of [
    'https://notdiscord.gg/room123',
    'https://evil-discord.gg/room123',
    'https://example.com/discord.gg/room123',
    'https://snapchat.com/add/discord.gg/room123',
  ]) {
    assert.deepEqual(codeOf(input), [], input);
  }
});

test('legitimate invite forms keep working: path depth, fragments, punctuation, zero-width characters', () => {
  assert.deepEqual(codeOf('contact discord.gg/room123.'), ['room123'], 'trailing punctuation does not leak into the code');
  assert.deepEqual(codeOf('https://discord.gg/room123\u200B'), ['room123'], 'zero-width format characters are stripped');
  assert.deepEqual(codeOf('https://discord.gg/room123/extra'), ['room123']);
  assert.deepEqual(codeOf('https://discord.gg/room123#frag'), ['room123']);
  assert.equal(discordInviteCodeOf('discord.gg/Room123'), 'room123', 'canonicalization lowercases');
});

test('codes are restricted to the invite alphabet: punctuation and prose are rejected', () => {
  assert.equal(sanitizeDiscordInviteCode('abc123.'), null, 'punctuation never becomes part of a code');
  assert.equal(sanitizeDiscordInviteCode('a'), null, 'single-character codes are rejected');
  assert.equal(sanitizeDiscordInviteCode('ab'), 'ab');
  assert.equal(sanitizeDiscordInviteCode('Room_123-xyz'), 'Room_123-xyz');
  assert.deepEqual(codeOf('The room is RealTradingRoom'), [], 'bare prose is not a candidate');
  assert.equal(discordInviteCodeOf('The room is RealTradingRoom'), null, 'prose never canonicalizes into a code');
});

test('unparseable bare legacy foundInvite values never become candidates', () => {
  assert.equal(buildLegacyDiscordCandidate('join our community today', null), null);
  assert.equal(buildLegacyDiscordCandidate('', 'abc'), null);
  const parsed = buildLegacyDiscordCandidate('discord.gg/legacyroom', discordInviteCodeOf('discord.gg/legacyroom'));
  assert.equal(parsed?.nativeInviteCode, 'legacyroom');
  assert.equal(parsed?.normalizedLocator, 'https://discord.gg/legacyroom');
});

test('entity and dot obfuscation decode to real invites; obfuscation never invents codes', () => {
  assert.deepEqual(codeOf('Join discord&#46;gg/entityroom'), ['entityroom']);
  assert.deepEqual(codeOf('Join discord[.]gg/dotroom'), ['dotroom']);
  assert.deepEqual(codeOf('Join discord\uFF0Egg/dotroom'), [], 'full-width dot is not decoded into a host');
});

test('alternative invite hosts remain eligible references (resolved by following the redirect)', () => {
  for (const host of ['dsc.gg', 'discord.me', 'discord.io']) {
    const candidates = extractDiscordCandidates(`Join https://${host}/altroom`, 'CREATOR_WEBSITES');
    assert.equal(candidates.length, 1, host);
    assert.equal(candidates[0].locatorType, 'ALTERNATIVE_REDIRECT', host);
  }
});

test('shortener destinations are followed and their invites extracted (bit.ly / dsc.gg / discord.me)', async () => {
  for (const host of ['bit.ly', 'dsc.gg', 'discord.me']) {
    const target = `https://${host}/xYz123`;
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://creator.test/') return html(`<a href="${target}">Join our Discord</a>`);
      if (url === target) return html('Join https://discord.gg/shortenerroom');
      return html('no invite');
    }) as typeof fetch;
    const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fetchImpl);
    assert.ok(calls.includes(target), `${host} destination is fetched`);
    assert.equal(result.outcome, 'FOUND', host);
    assert.deepEqual(result.candidates.map(candidate => candidate.nativeInviteCode), ['shortenerroom'], host);
  }
});

test('extracted candidates always carry a canonical invite code or are dropped', () => {
  const candidates = extractDiscordCandidates(
    'Join discord.gg/goodroom or visit example.com/discord.gg/fakeroom or the site itself',
    'CREATOR_WEBSITES',
  );
  assert.deepEqual(candidates.map(candidate => candidate.nativeInviteCode), ['goodroom']);
  for (const candidate of candidates) assert.ok(candidate.nativeInviteCode, 'no code-less candidates enter the pipeline');
});
