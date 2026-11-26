import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectDiscordInviteCaseCollisions,
  mergeDiscordCandidates,
  makeDiscordCandidate,
} from './discordCandidates';

function candidate(code: string) {
  return makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    rawLocator: `https://discord.gg/${code}`,
    nativeInviteCode: code,
    normalizedLocator: `https://discord.gg/${code.toLowerCase()}`,
    extractionConfidence: 'EXPLICIT',
  });
}

test('detects distinct raw codes that share the lowercase canonical identity', () => {
  const collisions = detectDiscordInviteCaseCollisions([candidate('AbC123'), candidate('abc123'), candidate('AbC123')]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]?.canonicalCode, 'abc123');
  assert.deepEqual(collisions[0]?.codes.sort(), ['AbC123', 'abc123']);
});

test('detects case variants preserved in merged observations', () => {
  const merged = mergeDiscordCandidates([candidate('AbC123'), candidate('abc123')]);
  const collisions = detectDiscordInviteCaseCollisions(merged);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0]?.codes.sort(), ['AbC123', 'abc123']);
});

test('does not report ordinary duplicates or distinct codes', () => {
  assert.deepEqual(detectDiscordInviteCaseCollisions([candidate('SameCode'), candidate('SameCode')]), []);
  assert.deepEqual(detectDiscordInviteCaseCollisions([candidate('alpha'), candidate('beta')]), []);
});

test('current merge remains canonical-case-insensitive (documented limitation)', () => {
  // The registry is still keyed by the lowercase canonical code. Detection is
  // wired before admission; a schema-level case-preserving claim is required
  // to retain both variants end-to-end. This test pins the existing behavior
  // so the limitation cannot silently drift.
  const merged = mergeDiscordCandidates([candidate('AbC123'), candidate('abc123')]);
  assert.equal(merged.length, 1);
});
