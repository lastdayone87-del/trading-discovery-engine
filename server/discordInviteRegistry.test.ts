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

test('different URL forms map to the same code and stay admitted when owned', () => {
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

test('flow delegates once to the choke helper and validates its output', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');
  assert.equal(
    source.split('await admitInspectionDiscordCandidates(structuredCandidates,inspection.foundInvite,channel.channel_id)').length - 1,
    1,
    'single choke delegation per inspection',
  );
  assert.match(source, /admittedInspection=\{\.\.\.inspection,discordCandidates:chokeAdmission\.candidates,foundInvite:chokeAdmission\.discoveredInvite\};/);
});

test('legacy foundInvite is persisted, claimed, and admitted when structured loses', async () => {
  const { admitInspectionDiscordCandidates } = await import('./queueManager');
  const calls: Array<{ op: string; arg: unknown }> = [];
  const mkCand = (code: string) => ({
    candidateId: `test:${code}`,
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CREATOR_WEBSITES',
    rawLocator: `https://discord.gg/${code}`,
    normalizedLocator: `https://discord.gg/${code.toLowerCase()}`,
    nativeInviteCode: code,
    sourceUrl: `https://owner.example/${code}`,
    extractionConfidence: 'EXPLICIT',
  });
  const deps = {
    persist: async (channelId: string, candidates: unknown[]) => {
      calls.push({ op: 'persist', arg: (candidates as Array<{ candidateId: string }>).map(c => c.candidateId) });
    },
    claim: async (items: Array<{ code: string }>) => {
      calls.push({ op: 'claim', arg: items.map(i => i.code) });
      return items.map(i => ({ code: i.code, admitted: true, firstChannelId: 'chanX' }));
    },
    removeLosers: async (channelId: string, codes: string[], onlyNewerThan?: string) => {
      calls.push({ op: 'delete', arg: codes });
      assert.ok(typeof onlyNewerThan === 'string' && !Number.isNaN(Date.parse(onlyNewerThan)), 'loser delete carries a provisional watermark');
      assert.ok(Date.parse(onlyNewerThan as string) <= Date.now(), 'watermark predates the delete');
      return codes.length;
    },
  };
  // Structured OLD1 loses globally, but the trail foundInvite names an
  // unevaluated NEW2: legacy path persists, claims, and admits it.
  const ownedByOther = {
    persist: deps.persist,
    claim: async (items: Array<{ code: string }>) => {
      calls.push({ op: 'claim', arg: items.map(i => i.code) });
      return items.map(i => i.code === 'new2'
        ? { code: i.code, admitted: true, firstChannelId: 'chanX' }
        : { code: i.code, admitted: false, firstChannelId: 'chanOther' });
    },
    removeLosers: deps.removeLosers,
  };
  const result = await admitInspectionDiscordCandidates([mkCand('OLD1')] as never, 'NEW2', 'chanX', ownedByOther as never);
  assert.deepEqual(calls.map(c => c.op), ['persist', 'claim', 'persist', 'claim', 'delete']);
  assert.deepEqual(result.candidates.map(c => (c as { nativeInviteCode: string }).nativeInviteCode), ['NEW2']);
  assert.equal(result.discoveredInvite, 'NEW2');
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

test('choke invokes persist, claim, delete in order with correct payloads', async () => {
  const { admitInspectionDiscordCandidates } = await import('./queueManager');
  const calls: Array<{ op: string; arg: unknown }> = [];
  const mkCand = (code: string) => ({
    candidateId: `test:${code}`,
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CREATOR_WEBSITES',
    rawLocator: `https://discord.gg/${code}`,
    normalizedLocator: `https://discord.gg/${code.toLowerCase()}`,
    nativeInviteCode: code,
    sourceUrl: `https://owner.example/${code}`,
    extractionConfidence: 'EXPLICIT',
  });
  const deps = {
    persist: async (channelId: string, candidates: unknown[]) => {
      calls.push({ op: 'persist', arg: (candidates as Array<{ candidateId: string }>).map(c => c.candidateId) });
    },
    claim: async (items: Array<{ code: string }>) => {
      calls.push({ op: 'claim', arg: items.map(i => i.code) });
      return items.map(i => ({ code: i.code, admitted: i.code !== 'old1', firstChannelId: i.code !== 'old1' ? 'chanX' : 'chanOther' }));
    },
    removeLosers: async (channelId: string, codes: string[]) => {
      calls.push({ op: 'delete', arg: codes });
      return codes.length;
    },
  };
  const result = await admitInspectionDiscordCandidates(
    [mkCand('NEW1'), mkCand('OLD1')] as never,
    null,
    'chanX',
    deps as never,
  );
  assert.deepEqual(calls.map(c => c.op), ['persist', 'claim', 'delete']);
  assert.deepEqual(result.candidates.map(c => (c as { nativeInviteCode: string }).nativeInviteCode), ['NEW1']);
  assert.equal(result.discoveredInvite, 'NEW1');
  const deleteCall = calls.find(c => c.op === 'delete');
  assert.deepEqual(deleteCall?.arg, ['old1']);
});

test('choke claims legacy foundInvite only when nothing admitted', async () => {
  const { admitInspectionDiscordCandidates } = await import('./queueManager');
  const claimed: string[][] = [];
  const deps = {
    persist: async () => undefined,
    claim: async (items: Array<{ code: string }>) => {
      claimed.push(items.map(i => i.code));
      return items.map(i => ({ code: i.code, admitted: true, firstChannelId: 'chanX' }));
    },
    removeLosers: async () => 0,
  };
  // Structured admitted: foundInvite code must NOT be claimed (no parking).
  await admitInspectionDiscordCandidates(
    [{ candidateId: 'x', locatorType: 'NATIVE_INVITE', sourceSurface: 'CREATOR_WEBSITES', rawLocator: 'https://discord.gg/NEW1', normalizedLocator: 'https://discord.gg/new1', nativeInviteCode: 'NEW1', extractionConfidence: 'EXPLICIT' }] as never,
    'OTHER2',
    'chanX',
    deps as never,
  );
  assert.deepEqual(claimed, [['new1']]);
});
