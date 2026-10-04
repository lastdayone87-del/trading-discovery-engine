import test from 'node:test';
import assert from 'node:assert/strict';
import { admitDiscordCandidates, discordInviteCodeOf, type DiscordCandidate } from './discordCandidates';

function cand(code: string, sourceUrl = 'https://example.com/'): DiscordCandidate {
  return {
    candidateId: `test:${code}`,
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CREATOR_WEBSITES',
    rawLocator: `https://discord.gg/${code}`,
    normalizedLocator: `https://discord.gg/${code}`,
    nativeInviteCode: code,
    sourceUrl,
    extractionConfidence: 'EXPLICIT',
  };
}

test('canonical code collapses URL forms and casing', () => {
  assert.equal(discordInviteCodeOf('ABC123'), 'abc123');
  assert.equal(discordInviteCodeOf('https://discord.gg/ABC123'), 'abc123');
  assert.equal(discordInviteCodeOf('https://discord.com/invite/ABC123'), 'abc123');
  assert.equal(discordInviteCodeOf('https://discord.gg/ABC123/'), 'abc123');
  assert.equal(discordInviteCodeOf('  https://discord.gg/AbC123?x=1  '), 'abc123');
  assert.equal(discordInviteCodeOf('https://dsc.gg/ABC123'), 'abc123');
  assert.equal(discordInviteCodeOf('https://discord.me/ABC123'), 'abc123');
  assert.equal(discordInviteCodeOf(''), null);
  assert.equal(discordInviteCodeOf(null), null);
  assert.equal(discordInviteCodeOf('a'), null);
  assert.equal(discordInviteCodeOf('hello world'), null);
  assert.equal(discordInviteCodeOf('abc123/'), null);
});

test('first global discovery is retained', () => {
  const r = admitDiscordCandidates([cand('ABC123')], null, new Set(['abc123']));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.discoveredInvite, 'ABC123');
  assert.equal(r.discardedCount, 0);
});

test('second and third creators discovering the same invite are discarded', () => {
  const second = admitDiscordCandidates([cand('ABC123', 'https://b.example/')], null, new Set());
  assert.equal(second.candidates.length, 0);
  assert.equal(second.discoveredInvite, null);
  assert.equal(second.discardedCount, 1);
  const third = admitDiscordCandidates([cand('ABC123', 'https://c.example/')], null, new Set());
  assert.equal(third.candidates.length, 0);
  assert.equal(third.discoveredInvite, null);
});

test('structured admission suppresses the legacy fallback for the same code', () => {
  // foundInvite alongside an admitted structured candidate must not create
  // a second legacy candidate for the same invite.
  const r = admitDiscordCandidates([cand('ABC123')], 'ABC123', new Set(['abc123']));
  assert.equal(r.candidates.length, 1);
  assert.ok(!r.candidates[0].candidateId.startsWith('legacy:'));
  assert.equal(r.discoveredInvite, 'ABC123');
  assert.equal(r.discardedCount, 0);
});

test('different URL forms and casings collapse to one admitted identity', () => {
  const r = admitDiscordCandidates(
    [cand('https://discord.com/invite/ABC123'), cand('https://discord.gg/abc123/')],
    null,
    new Set(['abc123']),
  );
  assert.equal(r.candidates.length, 2);
  assert.equal(r.discardedCount, 0);
});

test('foundInvite cannot resurrect a discarded duplicate', () => {
  const r = admitDiscordCandidates([], 'ABC123', new Set());
  assert.equal(r.candidates.length, 0);
  assert.equal(r.discoveredInvite, null);
  assert.equal(r.discardedCount, 0);
});

test('foundInvite for an unknown invite keeps the legacy path', () => {
  const r = admitDiscordCandidates([], 'NEWCODE', new Set(['newcode']));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.discoveredInvite, 'NEWCODE');
});

test('unparseable values fail open to legacy behavior', () => {
  const weird = { ...cand('okcode1'), nativeInviteCode: 'not an invite!!' };
  const r = admitDiscordCandidates([weird], null, new Set());
  assert.equal(r.candidates.length, 1);
  const legacy = admitDiscordCandidates([], 'some free text', new Set());
  assert.equal(legacy.candidates.length, 1);
});

test('mixed batch keeps admitted and drops duplicates independently', () => {
  const r = admitDiscordCandidates([cand('NEW1'), cand('OLD1')], null, new Set(['new1']));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].nativeInviteCode, 'NEW1');
  assert.equal(r.discoveredInvite, 'NEW1');
  assert.equal(r.discardedCount, 1);
});

test('legacy nativeInviteCode carries the case-preserved code, never a URL', () => {
  const r = admitDiscordCandidates([], 'https://discord.gg/AbC123', new Set(['abc123']));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].nativeInviteCode, 'AbC123');
  assert.equal(r.candidates[0].normalizedLocator, 'https://discord.gg/abc123');
  assert.equal(r.candidates[0].rawLocator, 'https://discord.gg/AbC123');
});

test('choke ordering is persist, claim, delete losers, then validate exactly once', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');
  const persistIdx = source.indexOf('if(preProvisional.length)await persistDiscordCandidates(');
  assert.ok(persistIdx >= 0, 'provisional persist exists');
  const claimIdx = source.indexOf('await claimDiscordInvites([', persistIdx);
  assert.ok(claimIdx > persistIdx, 'claim follows persist');
  const deleteIdx = source.indexOf('await deleteDiscordCandidates(', claimIdx);
  assert.ok(deleteIdx > claimIdx, 'loser delete follows claim');
  const validateIdx = source.indexOf('await validateDiscordInvite(', deleteIdx);
  assert.ok(validateIdx > deleteIdx, 'validation runs last, on winners only');
  assert.equal(source.split('await claimDiscordInvites(').length - 1, 2, 'structured batch claim plus conditional legacy claim');
});

test('legacy claim runs only when nothing was admitted (no parking)', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');
  const anchor = source.indexOf('if(!preAdmission.candidates.length&&preFoundCode&&!preClaimSources.has(preFoundCode)){');
  assert.ok(anchor >= 0, 'conditional legacy claim exists');
  const persistIdx = source.indexOf('await persistDiscordCandidates(channel.channel_id,[{candidateId:legacyFallback', anchor);
  assert.ok(persistIdx > anchor, 'legacy row persisted before its claim');
  const claimIdx = source.indexOf('await claimDiscordInvites([{code:preFoundCode', persistIdx);
  assert.ok(claimIdx > persistIdx, 'legacy claim follows its persist');
  const deleteIdx = source.indexOf('await deleteDiscordCandidates(channel.channel_id,[preFoundCode]);', claimIdx);
  assert.ok(deleteIdx > claimIdx, 'lost legacy claim is cleaned up');
});

test('reconcile and validation share one admitted inspection view', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');
  assert.match(source, /reconcileDiscordDiscoveryFromInspection\(channel, admittedInspection,/);
});

test('foundInvite naming an unevaluated code is claimed, not suppressed', () => {
  // Structured candidates all discarded, but the trail foundInvite names a
  // different, unknown code: it must be admitted (legacy path), not dropped
  // merely because its siblings lost.
  const structured = [
    { candidateId: 'x', locatorType: 'NATIVE_INVITE', sourceSurface: 'CREATOR_WEBSITES', rawLocator: 'https://discord.gg/OLD1', normalizedLocator: 'https://discord.gg/old1', nativeInviteCode: 'OLD1', extractionConfidence: 'EXPLICIT' },
  ];
  const r = admitDiscordCandidates(structured as DiscordCandidate[], 'NEW2', new Set(['new2']));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.discoveredInvite, 'NEW2');
  assert.equal(r.discardedCount, 1);
});

test('duplicate-only inspection preserves an already-validated Discord state', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');
  const gateIdx = source.indexOf('if (!hasInspectionFailure && !hasCandidate && !alreadyValidatedDiscord) {');
  assert.ok(gateIdx >= 0, 'validated-success guard exists on the duplicate-only absence projection');
});
