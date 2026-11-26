import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDiscordCandidates } from './discordCandidates';

function codes(text: string): string[] {
  return extractDiscordCandidates(text)
    .map(candidate => candidate.nativeInviteCode)
    .filter((code): code is string => typeof code === 'string');
}

test('decodes bounded Base64 invite payloads', () => {
  assert.deepEqual(codes('token aHR0cHM6Ly9kaXNjb3JkLmdnL0JBU0U2NA=='), ['BASE64']);
});

test('decodes ROT13 invite payloads', () => {
  // ROT13 of https://discord.gg/ROT13 (the host also rotates: gg -> tt)
  assert.deepEqual(codes('uggcf://qvfpbeq.tt/EBG13'), ['ROT13']);
});

test('decodes double-encoded percent, unicode, entity and dot forms', () => {
  assert.deepEqual(codes('discord%252Egg%252FDOUBLE'), ['DOUBLE']);
  assert.deepEqual(codes('https://discord\\u002egg/UNICODE'), ['UNICODE']);
  assert.deepEqual(codes('discord&period;gg/PERIOD'), ['PERIOD']);
  assert.deepEqual(codes('discord dot gg/DOT'), ['DOT']);
});

test('does not invent invites from arbitrary Base64 or rotated text', () => {
  assert.deepEqual(codes('aGVsbG8gd29ybGQgaGVsbG8='), []);
  assert.deepEqual(codes('This is ordinary prose without a community URL.'), []);
  // `qvfpbeq` is the rotated "discord" marker, so this exercises the ROT13
  // negative path rather than skipping the decoder entirely.
  assert.deepEqual(codes('qvfpbeq vf abg na vaivgr'), []);
});

test('decodes UTF-8 Base64 payloads containing an invite', () => {
  const encoded = Buffer.from('Присоединяйтесь https://discord.gg/UTF8BASE64', 'utf8').toString('base64');
  assert.deepEqual(codes(`token ${encoded}`), ['UTF8BASE64']);
});

test('preserves case across decoded variants', () => {
  assert.deepEqual(codes('token aHR0cHM6Ly9kaXNjb3JkLmdnL01peGVkQ2FzZQ=='), ['MixedCase']);
});

test('rejoins bounded tag-fragmented invite text', () => {
  assert.deepEqual(codes('<p>Join disc<span>ord</span>.gg/TAGSPLIT</p>'), ['TAGSPLIT']);
  assert.deepEqual(codes('<p>Join discord<span>.gg</span>/TAGDOT</p>'), ['TAGDOT']);
});

test('block-level markup between host and path is not a protected invite', () => {
  assert.deepEqual(codes('discord.gg<div>/NOTACODE</div>'), []);
});

test('inline void tags and closing tags in protected links are rejoined', () => {
  assert.deepEqual(codes('discord.gg<br />/BRTAG'), ['BRTAG']);
  assert.deepEqual(codes('discord.gg<span>/</span>CLOSEDTAG'), ['CLOSEDTAG']);
});
