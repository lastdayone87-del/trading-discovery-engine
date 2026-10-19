/**
 * P3 candidate/cache lifecycle integrity regressions (report sections 6-7,
 * E1-E10). Every case is a confirmed leak from the 2026-10-19 investigation.
 *
 * Covered here:
 * - cache contradiction repair: a negative row that carries candidates is
 *   never reusable (E1);
 * - durable claim handshake: candidate-bearing rows are only reusable once
 *   admission committed; a crash between persist and claim forces recrawl
 *   (E2);
 * - same-owner recovery re-admits candidates for the recording channel only;
 *   cross-creator borrows stay candidate-free (E3);
 * - orphan drain: persisted-but-never-claimed candidates are re-admitted or
 *   removed as residue (E6);
 * - execution-scoped loser cleanup: exact candidate ids plus a DB-clock
 *   watermark, so historical rows are never collateral (E10);
 * - pending-work guard: RETRY_PENDING locators never project COMPLETED (E7).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSiteInspectionReusable,
  buildBorrowedSiteInspection,
  SITE_INSPECTION_CLAIM_STATUS,
  SITE_INSPECTION_FRESH_TTL_MS,
  SITE_INSPECTION_RETRYABLE_FAILURE_TTL_MS,
  type CachedSiteInspection,
} from './siteInspectionCache';
import { admitInspectionDiscordCandidates, drainOrphanDiscordCandidates, projectNotFoundAfterInspection } from './queueManager';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DiscordCandidate } from './discordCandidates';

const readSource = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

const cachedRow = (overrides: Partial<CachedSiteInspection> = {}): CachedSiteInspection => ({
  siteIdentity: 'unknown.example',
  identityTier: 'registrable-domain',
  canonicalUrl: 'https://unknown.example/join',
  finalUrl: 'https://unknown.example/join',
  outcome: 'FOUND',
  retryable: false,
  httpStatus: 200,
  failureClass: '',
  detail: '',
  payloadChecksum: null,
  candidates: [],
  observations: [],
  renderedCovered: false,
  lastObservedAt: new Date().toISOString(),
  sourceChannelId: 'chanA',
  claimStatus: SITE_INSPECTION_CLAIM_STATUS.CLAIMED,
  ...overrides,
});

const candidateRecord = (code: string) => ({
  candidateId: `cand-${code}`,
  nativeInviteCode: code,
  normalizedLocator: `https://discord.gg/${code}`,
  locatorType: 'NATIVE_INVITE',
});

test('E1: a negative cache row that carries candidates is never reused (contradiction repair)', () => {
  const now = Date.now();
  for (const outcome of ['INSPECTED_NO_MATCH', 'PARTIALLY_INSPECTED', 'ACQUISITION_FAILED']) {
    const row = cachedRow({ outcome, candidates: [candidateRecord('leaked')], lastObservedAt: new Date(now).toISOString() });
    assert.equal(isSiteInspectionReusable(row, now), false, `${outcome} with candidates must recrawl`);
  }
});

test('E2: FOUND rows with candidates are only reusable after the claim handshake commits', () => {
  const now = Date.now();
  for (const claimStatus of [undefined, null, SITE_INSPECTION_CLAIM_STATUS.NONE, SITE_INSPECTION_CLAIM_STATUS.PENDING]) {
    const row = cachedRow({ candidates: [candidateRecord('pending')], claimStatus: claimStatus as string | null | undefined });
    assert.equal(isSiteInspectionReusable(row, now), false, `claimStatus=${claimStatus} must not be reusable`);
  }
  for (const claimStatus of [SITE_INSPECTION_CLAIM_STATUS.CLAIMED, SITE_INSPECTION_CLAIM_STATUS.DISCARDED]) {
    const row = cachedRow({ candidates: [candidateRecord('committed')], claimStatus });
    assert.equal(isSiteInspectionReusable(row, now), true, `claimStatus=${claimStatus} is reusable`);
  }
});

test('E4: retryable/partial rows keep the short TTL; complete positives keep the long one', () => {
  const now = Date.now();
  const old = new Date(now - SITE_INSPECTION_RETRYABLE_FAILURE_TTL_MS - 60_000).toISOString();
  const longAgo = new Date(now - SITE_INSPECTION_FRESH_TTL_MS + 60_000).toISOString();
  assert.equal(isSiteInspectionReusable(cachedRow({ retryable: true, lastObservedAt: old }), now), false, 'stale retryable row recrawls');
  assert.equal(isSiteInspectionReusable(cachedRow({ outcome: 'PARTIALLY_INSPECTED', lastObservedAt: old }), now), false, 'stale partial row recrawls');
  assert.equal(isSiteInspectionReusable(cachedRow({ outcome: 'FOUND', retryable: false, lastObservedAt: longAgo }), now), true, 'complete positive stays fresh');
  assert.equal(isSiteInspectionReusable(cachedRow({ retryable: true, lastObservedAt: new Date(now - 60_000).toISOString() }), now), true, 'fresh retryable row is reusable');
});

test('E3: same-owner recovery re-admits candidates; cross-creator borrows stay candidate-free', () => {
  const row = cachedRow({ candidates: [candidateRecord('owneronly')], sourceChannelId: 'chanA' });
  const borrowerBase = { requestedUrl: 'https://unknown.example/join', surface: 'CREATOR_WEBSITES', required: false, observedAt: new Date().toISOString() };
  const sameOwner = buildBorrowedSiteInspection(row, { ...borrowerBase, channelId: 'chanA' });
  assert.equal(sameOwner.recoveredCandidates.length, 1, 'recording channel recovers its own candidates');
  assert.deepEqual(sameOwner.row.candidates, [], 'borrowed row is candidate-free by construction');
  const crossCreator = buildBorrowedSiteInspection(row, { ...borrowerBase, channelId: 'chanB' });
  assert.deepEqual(crossCreator.recoveredCandidates, [], 'cross-creator borrow never transfers candidates');
  const anonymous = buildBorrowedSiteInspection(row, borrowerBase);
  assert.deepEqual(anonymous.recoveredCandidates, []);
  const legacyRow = cachedRow({ candidates: [candidateRecord('legacyrow')], sourceChannelId: null });
  assert.deepEqual(buildBorrowedSiteInspection(legacyRow, { ...borrowerBase, channelId: 'chanA' }).recoveredCandidates, [], 'legacy rows without a recording channel recover nothing');
});

test('E10: loser cleanup runs on the DB clock with exact execution candidate ids', async () => {
  const ops: string[] = [];
  const deletes: Array<{ codes: string[]; ids: string[]; watermark: string }> = [];
  const deps = {
    persist: async () => { ops.push('persist'); },
    claim: async (items: Array<{ code: string }>) => {
      ops.push('claim');
      return items.map(item => ({ code: item.code, admitted: item.code === 'winner' }));
    },
    removeLosers: async (_channelId: string, codes: string[], ids: string[], watermark: string) => {
      ops.push('delete');
      deletes.push({ codes, ids, watermark });
      return codes.length;
    },
    executionNow: async () => { ops.push('now'); return '2026-10-19T00:00:00.000Z'; },
  };
  const candidates = [
    { candidateId: 'test:WINNER', nativeInviteCode: 'winner', rawLocator: 'discord.gg/winner', normalizedLocator: 'https://discord.gg/winner', locatorType: 'NATIVE_INVITE', sourceSurface: 'CREATOR_WEBSITES', extractionConfidence: 'EXPLICIT' },
    { candidateId: 'test:LOSER', nativeInviteCode: 'loser', rawLocator: 'discord.gg/loser', normalizedLocator: 'https://discord.gg/loser', locatorType: 'NATIVE_INVITE', sourceSurface: 'CREATOR_WEBSITES', extractionConfidence: 'EXPLICIT' },
  ] as DiscordCandidate[];
  const result = await admitInspectionDiscordCandidates(candidates, null, 'chanA', deps as never);
  assert.equal(result.discoveredInvite, 'winner');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(ops, ['now', 'persist', 'claim', 'delete'], 'DB clock read precedes persist; delete follows claim');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].codes, ['loser']);
  assert.deepEqual(deletes[0].ids, ['test:LOSER'], 'only execution-persisted candidate ids are deletable');
  assert.equal(deletes[0].watermark, '2026-10-19T00:00:00.000Z');
});

test('E10 (dbCore contract): deletion is bounded by exact candidate ids AND the DB-clock watermark', () => {
  const source = readSource('dbCore.ts');
  assert.match(source, /DELETE FROM discord_candidates WHERE channel_id=\$1 AND candidate_id=ANY\(\$4::text\[\]\) AND discovered_at>=\$3::timestamptz/);
  assert.match(source, /export async function getDbStatementNow\(\)/);
});

test('E6: orphan drain re-admits claimable orphans and removes foreign-owned residue', async () => {
  const orphans = [
    { candidateId: 'orphan-free', rawLocator: 'discord.gg/free', normalizedLocator: 'https://discord.gg/free', locatorType: 'NATIVE_INVITE', sourceSurface: 'CREATOR_WEBSITES', sourceUrl: 'https://site.example/', observations: [], canonicalCode: 'free', discoveredAt: '2026-10-18T00:00:00.000Z' },
    { candidateId: 'orphan-taken', rawLocator: 'discord.gg/taken', normalizedLocator: 'https://discord.gg/taken', locatorType: 'NATIVE_INVITE', sourceSurface: 'CREATOR_WEBSITES', sourceUrl: 'https://site.example/', observations: [], canonicalCode: 'taken', discoveredAt: '2026-10-18T00:00:01.000Z' },
  ];
  const removed: string[][] = [];
  const claims: string[] = [];
  const result = await drainOrphanDiscordCandidates('chanA', {
    claim: async (items: Array<{ code: string }>) => {
      claims.push(...items.map(item => item.code));
      return items.map(item => ({ code: item.code, admitted: item.code === 'free', firstChannelId: item.code === 'free' ? 'chanA' : 'chanB' }));
    },
    list: async () => orphans,
    removeOrphans: async (_channelId: string, ids: string[]) => { removed.push(ids); return ids.length; },
  } as never);
  assert.deepEqual(claims.sort(), ['free', 'taken']);
  assert.deepEqual(result.candidates.map(candidate => candidate.nativeInviteCode), ['free']);
  assert.equal(result.removed, 1);
  assert.deepEqual(removed, [['orphan-taken']], 'foreign-owned residue is deleted by exact id');
});

test('E6: drain is a no-op when no orphans exist', async () => {
  let claimCalls = 0;
  const result = await drainOrphanDiscordCandidates('chanA', {
    claim: async () => { claimCalls += 1; return []; },
    list: async () => [],
    removeOrphans: async () => 0,
  } as never);
  assert.deepEqual(result, { candidates: [], removed: 0 });
  assert.equal(claimCalls, 0);
});

test('E6 (contract): orphan predicate and drain wiring match the DB semantics', () => {
  const db = readSource('dbCore.ts');
  assert.match(db, /candidate_status='DISCOVERED' AND validation_status='NOT_STARTED' AND selected IS NOT TRUE/);
  assert.match(db, /export async function deleteOrphanDiscordCandidates/);
  const queue = readSource('queueManager.ts');
  // Drain runs after the admission claim so orphan rows can never be deleted
  // while the same execution still owns their codes.
  const claimIndex = queue.indexOf('await markSiteInspectionsClaimed(channel.channel_id).catch(()=>undefined);');
  const drainIndex = queue.indexOf('const orphanDrain=await drainOrphanDiscordCandidates(channel.channel_id).catch');
  assert.ok(claimIndex >= 0 && drainIndex > claimIndex, 'orphan drain follows the claim handshake');
  assert.match(queue, /event:'orphan_candidates_drained'/);
  assert.match(queue, /event:'orphan_candidate_residue_removed'/);
});

test('E7: a stored RETRY_PENDING locator never projects COMPLETED absence', async () => {
  const channel = {
    channel_id: 'chanA',
    channel_name: 'A',
    youtube_url: 'https://youtube.test/a',
    country: 'US',
    country_status: 'CONFIRMED',
    confidence_score: 1,
    discord_status: 'PENDING',
    scan_status: 'PENDING',
    scan_attempts: 2,
    discord_candidate_locator: 'https://discord.gg/pendingroom',
    discord_validation_status: 'RETRY_PENDING',
    discord_discovery_status: 'DISCOVERED_VALIDATION_FAILED',
  } as never;
  const enqueued: string[] = [];
  await projectNotFoundAfterInspection(
    channel,
    { retryDirective: { attempts: 1 } as never },
    { candidates: [], foundInvite: null } as never,
    true,
    async (channelId: string) => { enqueued.push(channelId); },
  );
  const updated = channel as Record<string, unknown>;
  assert.equal(updated.scan_status, 'FAILED', 'pending discovery work keeps the failure projection');
  assert.equal(updated.discord_validation_status, 'RETRY_PENDING');
  assert.equal(updated.discord_discovery_status, 'DISCOVERED_VALIDATION_FAILED');
  assert.notEqual(updated.scan_status, 'COMPLETED');
  assert.deepEqual(enqueued, ['chanA'], 'the durable retry job is preserved');
});

test('E7: a channel without pending work still projects clean absence', async () => {
  const channel = {
    channel_id: 'chanB',
    channel_name: 'B',
    youtube_url: 'https://youtube.test/b',
    country: 'US',
    country_status: 'CONFIRMED',
    confidence_score: 1,
    discord_status: 'PENDING',
    scan_status: 'PENDING',
    scan_attempts: 0,
    discord_candidate_locator: null,
    discord_validation_status: 'NOT_STARTED',
    discord_discovery_status: 'NOT_DISCOVERED',
  } as never;
  await projectNotFoundAfterInspection(channel, null, { candidates: [], foundInvite: null } as never, true, async () => undefined);
  const updated = channel as Record<string, unknown>;
  assert.equal(updated.scan_status, 'COMPLETED');
  assert.equal(updated.discord_status, 'NOT_FOUND');
  assert.equal(updated.discord_discovery_status, 'NOT_DISCOVERED');
});

test('P3 item 12: cache recovery writes an explicit audit row (best-effort) and LEGACY_UNCLASSIFIED visibility exists', () => {
  const inspector = readSource('inspector.ts');
  assert.match(inspector, /await recordDiscoveryRecoveryAudit\(\{/);
  assert.match(inspector, /source: 'CACHE'/);
  const db = readSource('dbCore.ts');
  assert.match(db, /INSERT INTO discovery_recovery_audit\(channel_id,source,site_identity,candidate_ids,candidate_count,detail\)/);
  assert.match(db, /export async function countLegacyUnclassifiedChannels\(\):Promise<number>/);
});
