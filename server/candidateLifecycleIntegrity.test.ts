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
  hasSameOwnerPendingCandidates,
  SITE_INSPECTION_CLAIM_STATUS,
  SITE_INSPECTION_FRESH_TTL_MS,
  SITE_INSPECTION_RETRYABLE_FAILURE_TTL_MS,
  type CachedSiteInspection,
} from './siteInspectionCache';
import { admitInspectionDiscordCandidates, detectPendingDiscoveryWork, drainOrphanDiscordCandidates, inspectionClickOffsetForRetry, LOCATOR_PENDING_PROJECTION_LIMIT, nextDiscordDuplicateOwnerChannelId, persistCommunityRetryClickOffsets, projectNotFoundAfterInspection } from './queueManager';
import { nextRenderedClickOffsets } from './inspector';
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

test('E2: no-admission and all-losing executions finalize cache rows as DISCARDED', () => {
  const queue = readSource('queueManager.ts');
  assert.match(queue, /const executedCandidateIds=\[\.\.\.new Set\(structuredCandidates\.map\(candidate=>candidate\.candidateId\)\.filter\(Boolean\)\)\]/);
  assert.match(queue, /if\(chokeAdmission\.candidates\.length\)await markSiteInspectionsClaimed\(channel\.channel_id,executedCandidateIds\)/);
  assert.match(queue, /else await markSiteInspectionsDiscarded\(channel\.channel_id,executedCandidateIds\)/);
  const db = readSource('dbCore.ts');
  assert.match(db, /terminalStatus: 'CLAIMED' \| 'DISCARDED'/);
  assert.match(db, /!hasPending && terminalStatus === 'DISCARDED' \? \[\] : rowCandidates/);
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

test('E3: per-channel pending map keeps recovery correct after another writer', () => {
  const row = cachedRow({
    sourceChannelId: 'chanB',
    candidates: [candidateRecord('bravo')],
    claimStatus: SITE_INSPECTION_CLAIM_STATUS.PENDING,
    pendingClaims: {
      chanA: [candidateRecord('alpha')],
      chanB: [candidateRecord('bravo')],
    },
  });
  assert.equal(hasSameOwnerPendingCandidates(row, 'chanA'), true, 'the first writer still owns its unclaimed candidate');
  assert.equal(hasSameOwnerPendingCandidates(row, 'chanB'), true, 'the later writer owns its own pending candidate');
  assert.equal(hasSameOwnerPendingCandidates(row, 'chanC'), false, 'a third creator never inherits either candidate');
  assert.deepEqual(
    buildBorrowedSiteInspection(row, { requestedUrl: 'https://unknown.example/join', surface: 'CREATOR_WEBSITES', required: false, observedAt: new Date().toISOString(), channelId: 'chanA' }).recoveredCandidates.map(c => c.candidateId),
    ['cand-alpha'],
  );
  const onlyOther = cachedRow({
    sourceChannelId: 'chanA',
    candidates: [candidateRecord('alpha')],
    claimStatus: SITE_INSPECTION_CLAIM_STATUS.PENDING,
    pendingClaims: { chanA: [candidateRecord('alpha')] },
  });
  assert.equal(hasSameOwnerPendingCandidates(onlyOther, 'chanB'), false, 'a pending map for another channel suppresses the legacy fallback');
  const inspector = readSource('inspector.ts');
  assert.match(inspector, /const sameOwnerRecovery = hasSameOwnerPendingCandidates\(seedCachedRow, channelData\.channelId\);/);
  const legacy = cachedRow({
    sourceChannelId: 'chanA',
    candidates: [candidateRecord('legacy')],
    claimStatus: SITE_INSPECTION_CLAIM_STATUS.PENDING,
  });
  assert.equal(hasSameOwnerPendingCandidates(legacy, 'chanA'), true, 'legacy rows keep single-owner recovery');
  assert.equal(hasSameOwnerPendingCandidates({ ...legacy, claimStatus: SITE_INSPECTION_CLAIM_STATUS.DISCARDED }, 'chanA'), false, 'terminal rows are never replayed');
});

test('E3: same-owner recovery re-admits candidates only after the claim handshake; cross-creator borrows stay candidate-free', () => {
  const pendingRow = cachedRow({
    candidates: [candidateRecord('owneronly')],
    sourceChannelId: 'chanA',
    claimStatus: SITE_INSPECTION_CLAIM_STATUS.PENDING,
  });
  assert.equal(isSiteInspectionReusable(pendingRow, Date.now()), false, 'PENDING candidates are not borrowed coverage');
  const row = { ...pendingRow, claimStatus: SITE_INSPECTION_CLAIM_STATUS.CLAIMED };
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

test('E3: same-owner recovery never treats a PENDING candidate row as completed coverage', () => {
  const inspector = readSource('inspector.ts');
  assert.match(inspector, /const canBorrowRecovered = seedReusable && seedCovered/);
  assert.match(inspector, /if \(canBorrowRecovered\) \{[\s\S]*?acquisitionOutcomes\.push\(\.\.\.borrowed\.observations/);
  assert.match(inspector, /recoveredCandidates\.length[\s\S]*?PENDING rows are deliberately non-reusable/);
});

test('E10: loser cleanup runs on the DB clock with exact execution candidate ids', async () => {
  const ops: string[] = [];
  const deletes: Array<{ codes: string[]; ids: string[]; watermark: string }> = [];
  const deps = {
    persist: async () => { ops.push('persist'); },
    claim: async (items: Array<{ code: string }>) => {
      ops.push('claim');
      return items.map(item => ({ code: item.code, admitted: item.code === 'winner', firstChannelId: item.code === 'winner' ? 'chanA' : 'chanB' }));
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
  assert.deepEqual(result.discardedOwnerChannelIds, ['chanB'], 'the owner id is retained as provenance only');
  assert.equal(result.candidates.some(candidate => candidate.nativeInviteCode === 'loser'), false, 'the duplicate-owned code never enters the admitted set');
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

test('duplicate ownership provenance stores only the owner channel id, never the invite code or assignment', () => {
  const queue = readSource('queueManager.ts');
  assert.match(queue, /channel\.discord_duplicate_owner_channel_id = nextDiscordDuplicateOwnerChannelId\(\{/);
  assert.match(queue, /discardedOwnerChannelIds/);
  const db = readSource('dbCore.ts');
  assert.match(db, /discord_duplicate_owner_channel_id: row\.discord_duplicate_owner_channel_id \|\| null/);
  assert.match(db, /discord_duplicate_owner_channel_id=excluded\.discord_duplicate_owner_channel_id/);
  assert.match(db, /if\(args\.discordStatus==='INVITE_OWNED_BY_ANOTHER_CHANNEL'\)clauses\.push\('discord_duplicate_owner_channel_id IS NOT NULL'\)/);
  assert.match(readSource('../src/components/ResultsTable.tsx'), /INVITE_OWNED_BY_ANOTHER_CHANNEL/);
  const migrations = readSource('db/migrations/149_discovery_integrity_state.sql');
  assert.match(migrations, /ADD COLUMN IF NOT EXISTS discord_duplicate_owner_channel_id TEXT/);
  assert.doesNotMatch(queue, /discord_invite\s*=\s*chokeAdmission\.discarded/);
});

test('cache-only scans preserve duplicate-owner provenance until fresh processed evidence clears it', () => {
  const borrowed = [{
    surface: 'CREATOR_WEBSITES' as const,
    outcome: 'INSPECTED_NO_MATCH' as const,
    siteCacheHit: true,
    telemetry: { pagesInspected: 1, requestsStarted: 0, redirectsFollowed: 0 },
  }];
  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: [],
    previousOwnerChannelId: 'owner-old',
    observations: borrowed,
  }), 'owner-old', 'cache-only coverage cannot prove the duplicate disappeared');

  const failedFresh = [{
    surface: 'CREATOR_WEBSITES' as const,
    outcome: 'ACQUISITION_FAILED' as const,
    telemetry: { pagesInspected: 0, requestsStarted: 1, redirectsFollowed: 0 },
  }];
  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: [],
    previousOwnerChannelId: 'owner-old',
    observations: failedFresh,
  }), 'owner-old', 'a failed fresh run cannot establish absence');

  const freshClean = [{
    surface: 'CREATOR_WEBSITES' as const,
    outcome: 'INSPECTED_NO_MATCH' as const,
    telemetry: { pagesInspected: 1, requestsStarted: 1, redirectsFollowed: 0 },
  }];
  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: [],
    previousOwnerChannelId: 'owner-old',
    observations: freshClean,
  }), null, 'fresh processed evidence clears stale provenance');

  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: ['owner-new'],
    previousOwnerChannelId: 'owner-old',
    observations: borrowed,
  }), 'owner-new', 'a fresh duplicate replaces the saved owner even on a mostly cached scan');
});

test('duplicate-owner provenance requires aggregate seed completeness before clearing', () => {
  const found = {
    surface: 'CREATOR_WEBSITES' as const,
    outcome: 'FOUND' as const,
    telemetry: { pagesInspected: 1, requestsStarted: 1, redirectsFollowed: 0 },
  };
  const freshClean = {
    surface: 'SOCIAL_PROFILES' as const,
    outcome: 'INSPECTED_NO_MATCH' as const,
    telemetry: { pagesInspected: 1, requestsStarted: 1, redirectsFollowed: 0 },
  };
  const failed = {
    surface: 'SOCIAL_PROFILES' as const,
    outcome: 'ACQUISITION_FAILED' as const,
    telemetry: { pagesInspected: 0, requestsStarted: 1, redirectsFollowed: 0 },
  };
  const partial = {
    surface: 'CREATOR_WEBSITES' as const,
    outcome: 'PARTIALLY_INSPECTED' as const,
    telemetry: { pagesInspected: 1, requestsStarted: 1, redirectsFollowed: 0 },
  };
  const cached = {
    surface: 'SOCIAL_PROFILES' as const,
    outcome: 'INSPECTED_NO_MATCH' as const,
    siteCacheHit: true,
    telemetry: { pagesInspected: 1, requestsStarted: 1, redirectsFollowed: 0 },
  };
  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: [],
    previousOwnerChannelId: 'owner-old',
    observations: [found, failed],
  }), 'owner-old', 'one successful seed cannot clear while another failed seed could still contain the duplicate');
  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: [],
    previousOwnerChannelId: 'owner-old',
    observations: [found, partial],
  }), 'owner-old', 'a partial seed preserves provenance');
  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: [],
    previousOwnerChannelId: 'owner-old',
    observations: [found, cached],
  }), 'owner-old', 'a cached seed preserves provenance even next to a fresh FOUND seed');
  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: [],
    previousOwnerChannelId: 'owner-old',
    observations: [found, freshClean],
  }), null, 'all relevant seeds complete with no duplicate: provenance clears');
  assert.equal(nextDiscordDuplicateOwnerChannelId({
    discardedOwnerChannelIds: [],
    previousOwnerChannelId: 'owner-old',
    observations: [{ ...found, surface: 'CHANNEL_EXTERNAL_LINKS' }, failed],
  }), 'owner-old', 'non-website observations do not count as absence evidence');
});

test('gap retries advance only by controls actually examined', () => {
  assert.equal(inspectionClickOffsetForRetry(0), 0, 'initial inspection starts at the first window');
  assert.equal(inspectionClickOffsetForRetry(0, { isRetryOwnedReacquire: true }), 0, 'a retry without recorded progress reuses the first window');
  assert.equal(inspectionClickOffsetForRetry(10, { isRetryOwnedReacquire: true }), 0, 'durable job attempts never override per-seed progress');
  assert.equal(inspectionClickOffsetForRetry(10, { isRetryOwnedReacquire: false }), 10, 'non-retry scans keep their channel offset');

  const failedBeforeClick = nextRenderedClickOffsets(undefined, [
    { requestedUrl: 'https://creator.test/', telemetry: { clicksStarted: 0 } },
  ]);
  assert.deepEqual(failedBeforeClick, {}, 'a failure before any control keeps the same window');
  assert.deepEqual(nextRenderedClickOffsets(failedBeforeClick, [
    { requestedUrl: 'https://creator.test/', telemetry: { clicksStarted: 0 } },
  ]), {}, 'repeated pre-click failures never invent progress');
  assert.deepEqual(nextRenderedClickOffsets(undefined, [
    { requestedUrl: 'https://creator.test/', telemetry: { clicksStarted: 3 } },
    { requestedUrl: 'https://other.test/', telemetry: { clicksStarted: 0 } },
  ]), { 'https://creator.test/': 3 }, 'only a seed that actually clicked advances');
  assert.deepEqual(nextRenderedClickOffsets({ 'https://creator.test/': 4 }, [
    { requestedUrl: 'https://creator.test/', telemetry: { clicksStarted: 4 } },
  ]), { 'https://creator.test/': 8 }, 'the next retry starts after the window already examined');
  assert.deepEqual(nextRenderedClickOffsets(undefined, [
    { requestedUrl: 'https://creator.test/', telemetry: { clicksStarted: 9 } },
  ]), { 'https://creator.test/': 4 }, 'multi-page click totals advance at most one page window');
  const queue = readSource('queueManager.ts');
  assert.match(queue, /scanAttempts: inspectionClickOffsetForRetry\(channel\.scan_attempts, executionMarker\)/);
  assert.match(queue, /clickOffsets: executionMarker\?\.isRetryOwnedReacquire \? resolveInspectionClickOffsets\(executionMarker\.clickOffsets\) : undefined/);
  assert.match(readSource('inspector.ts'), /clickOffset:renderedClickOffsetForSeed\(item\.url\)/);
});

test('processing retry jobs persist click progress for their remaining attempts', async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  await persistCommunityRetryClickOffsets('job-click', { 'https://creator.test/': 4 }, {
    query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1 }; },
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /COALESCE\(payload->'clickOffsets','\{\}'::jsonb\) \|\| \$2::jsonb/);
  assert.deepEqual(JSON.parse(String(queries[0].params?.[1])), { 'https://creator.test/': 4 });
  await persistCommunityRetryClickOffsets('job-click', {}, {
    query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1 }; },
  });
  assert.equal(queries.length, 1, 'empty progress never clears the existing payload map');
  assert.match(readSource('queueManager.ts'), /persistCommunityRetryClickOffsets\(executionMarker\.jobId,inspection\.nextClickOffsets\)/);
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
  assert.deepEqual(result.discardedOwnerChannelIds, ['chanB'], 'foreign owner survives the orphan row deletion as provenance');
  assert.deepEqual(removed, [['orphan-taken']], 'foreign-owned residue is deleted by exact id');
});

test('E6: orphan drain preserves the original invite casing and ownership evidence', async () => {
  const removed: string[][] = [];
  const claims: string[] = [];
  const result = await drainOrphanDiscordCandidates('chanA', {
    claim: async (items: Array<{ code: string }>) => {
      claims.push(...items.map(item => item.code));
      return items.map(item => ({ code: item.code, admitted: true, firstChannelId: 'chanA' }));
    },
    list: async () => [{
      candidateId: 'orphan-cased',
      rawLocator: 'https://discord.gg/G2YjkcCgY',
      normalizedLocator: 'https://discord.gg/g2yjkccgy',
      locatorType: 'NATIVE_INVITE',
      sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
      sourceUrl: 'https://youtube.test/channel/about',
      observations: [{ sourceSurface: 'CHANNEL_EXTERNAL_LINKS', sourceUrl: 'https://youtube.test/channel/about', rawLocator: 'https://discord.gg/G2YjkcCgY', extractionConfidence: 'EXPLICIT' }],
      canonicalCode: 'g2yjkccgy',
      discoveredAt: '2026-10-18T00:00:00.000Z',
    }],
    removeOrphans: async (_channelId: string, ids: string[]) => { removed.push(ids); return ids.length; },
  } as never);
  assert.deepEqual(claims, ['g2yjkccgy'], 'the registry claim uses the canonical lowercase key');
  assert.equal(result.candidates[0]?.nativeInviteCode, 'G2YjkcCgY', 'validation keeps the case-sensitive code');
  assert.equal(result.candidates[0]?.ownershipStatus, 'CREATOR_OWNED');
  assert.deepEqual(removed, []);
  assert.deepEqual(result.discardedOwnerChannelIds, []);
});

test('E6: drain is a no-op when no orphans exist', async () => {
  let claimCalls = 0;
  const result = await drainOrphanDiscordCandidates('chanA', {
    claim: async () => { claimCalls += 1; return []; },
    list: async () => [],
    removeOrphans: async () => 0,
  } as never);
  assert.deepEqual(result, { candidates: [], removed: 0, discardedOwnerChannelIds: [] });
  assert.equal(claimCalls, 0);
});

test('E6 (contract): orphan predicate and drain wiring match the DB semantics', () => {
  const db = readSource('dbCore.ts');
  assert.match(db, /candidate_status='DISCOVERED' AND validation_status='NOT_STARTED' AND selected IS NOT TRUE/);
  assert.match(db, /export async function deleteOrphanDiscordCandidates/);
  const queue = readSource('queueManager.ts');
  // Drain runs after the admission claim so orphan rows can never be deleted
  // while the same execution still owns their codes.
  const claimIndex = queue.indexOf('await markSiteInspectionsClaimed(channel.channel_id,executedCandidateIds).catch');
  const drainIndex = queue.indexOf('const orphanDrain=await drainOrphanDiscordCandidates(channel.channel_id).catch');
  assert.ok(claimIndex >= 0 && drainIndex > claimIndex, 'orphan drain follows the claim handshake');
  assert.match(db, /export async function markSiteInspectionsClaimed\(channelId: string, admittedCandidateIds: string\[\] = \[\]\)/);
  assert.match(db, /export async function markSiteInspectionsDiscarded\(channelId: string, discardedCandidateIds: string\[\] = \[\]\)/);
  assert.match(db, /export async function markSiteInspectionsRejected\(channelId: string, rejectedCandidateIds: string\[\] = \[\]\)/);
  assert.match(db, /coverageBorrowable: false/);
  assert.match(db, /discardedReason: 'COUNTRY_REJECTED'/);
  assert.match(db, /provenance=CASE WHEN \$5::jsonb='\{\}'::jsonb THEN provenance/);
  assert.match(queue, /markSiteInspectionsRejected\(channel\.channel_id,rejectedCandidateIds\)/);
  assert.match(db, /pending_claims/);
  assert.match(queue, /event:'orphan_candidates_drained'/);
  assert.match(queue, /event:'orphan_candidate_residue_removed'/);
  const provenanceIndex = queue.indexOf('channel.discord_duplicate_owner_channel_id = nextDiscordDuplicateOwnerChannelId');
  assert.ok(provenanceIndex > drainIndex, 'provenance is projected after the orphan drain contributes foreign owners');
  assert.match(queue, /discardedOwnerChannelIds:\[\.\.\.new Set\(\[\.\.\.chokeAdmission\.discardedOwnerChannelIds,\.\.\.orphanDrain\.discardedOwnerChannelIds\]\)\]/);
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

test('E7: FAILED_OPERATIONAL is terminal and never reopens pending work', async () => {
  const channel = {
    channel_id: 'chan-terminal',
    channel_name: 'Terminal',
    youtube_url: 'https://youtube.test/terminal',
    country: 'US',
    country_status: 'CONFIRMED',
    confidence_score: 1,
    discord_status: 'UNCERTAIN',
    scan_status: 'FAILED',
    scan_attempts: 5,
    discord_candidate_locator: 'https://discord.gg/terminalroom',
    discord_validation_status: 'FAILED_OPERATIONAL',
    discord_discovery_status: 'DISCOVERED_VALIDATION_FAILED',
  } as never;
  const enqueued: string[] = [];
  await projectNotFoundAfterInspection(
    channel,
    { acquisitionOutcomes: [] },
    { candidates: [], foundInvite: null } as never,
    true,
    async (channelId: string) => { enqueued.push(channelId); },
  );
  const updated = channel as Record<string, unknown>;
  assert.equal(updated.scan_status, 'COMPLETED');
  assert.equal(updated.discord_validation_status, 'FAILED_OPERATIONAL');
  assert.deepEqual(enqueued, [], 'an exhausted terminal verdict schedules no retry');
});

test('E7: NOT_STARTED locator work without an inspection directive still gets a durable job', async () => {
  const channel = {
    channel_id: 'chan-pending',
    channel_name: 'Pending',
    youtube_url: 'https://youtube.test/pending',
    country: 'US',
    country_status: 'CONFIRMED',
    confidence_score: 1,
    discord_status: 'PENDING',
    scan_status: 'PENDING',
    scan_attempts: 1,
    discord_candidate_locator: 'https://discord.gg/pendingroom',
    discord_validation_status: 'NOT_STARTED',
    discord_discovery_status: 'DISCOVERED_VALIDATION_FAILED',
  } as never;
  const directives: unknown[] = [];
  await projectNotFoundAfterInspection(
    channel,
    { acquisitionOutcomes: [] },
    { candidates: [], foundInvite: null } as never,
    true,
    async (_channelId: string, directive?: unknown) => { directives.push(directive); },
  );
  assert.equal((channel as Record<string, unknown>).scan_status, 'FAILED');
  assert.equal((channel as Record<string, unknown>).scan_attempts, 2, 'the locator pending pass consumes one durable attempt');
  assert.equal(directives.length, 1, 'pending locator work owns a retry job');
  assert.equal((directives[0] as { attemptFree?: boolean }).attemptFree, false, 'a fallback pending directive is not capacity-attempt-free');
  assert.equal((directives[0] as { code?: string }).code, 'COMMUNITY_ACQUISITION_REQUIRED');
});

test('E7: locator-only pending work is bounded and falls through to a terminal failure', async () => {
  const channel = {
    channel_id: 'chan-exhausted-locator',
    channel_name: 'Exhausted locator',
    youtube_url: 'https://youtube.test/exhausted',
    country: 'US',
    country_status: 'CONFIRMED',
    confidence_score: 1,
    discord_status: 'PENDING',
    scan_status: 'PENDING',
    scan_attempts: LOCATOR_PENDING_PROJECTION_LIMIT,
    discord_candidate_locator: 'https://discord.gg/stale-room',
    discord_validation_status: 'RETRY_PENDING',
    discord_discovery_status: 'DISCOVERED_VALIDATION_FAILED',
  } as never;
  const enqueued: string[] = [];
  await projectNotFoundAfterInspection(
    channel,
    { acquisitionOutcomes: [] },
    { candidates: [], foundInvite: null } as never,
    true,
    async (channelId: string) => { enqueued.push(channelId); },
  );
  const updated = channel as Record<string, unknown>;
  assert.equal(updated.scan_status, 'COMPLETED', 'the bounded pass reaches the normal absence projection');
  assert.equal(updated.discord_validation_status, 'FAILED_OPERATIONAL', 'the stale locator becomes a terminal operational verdict');
  assert.deepEqual(enqueued, [], 'an exhausted locator no longer re-arms the retry job');
});

test('E7: an exhausted locator is terminal even when a legacy serving selection is established', async () => {
  const channel = {
    channel_id: 'chan-exhausted-established',
    channel_name: 'Exhausted locator with serving invite',
    youtube_url: 'https://youtube.test/exhausted-established',
    country: 'US',
    country_status: 'CONFIRMED',
    confidence_score: 1,
    discord_status: 'ACTIVE',
    discord_invite: 'https://discord.gg/stale-room',
    scan_status: 'FAILED',
    scan_attempts: LOCATOR_PENDING_PROJECTION_LIMIT,
    discord_candidate_locator: 'https://discord.gg/stale-room',
    discord_validation_status: 'RETRY_PENDING',
    discord_discovery_status: 'NOT_DISCOVERED',
  } as never;
  const enqueued: string[] = [];
  await projectNotFoundAfterInspection(
    channel,
    { acquisitionOutcomes: [] },
    { candidates: [], foundInvite: null } as never,
    true,
    async (channelId: string) => { enqueued.push(channelId); },
  );
  const updated = channel as Record<string, unknown>;
  assert.equal(updated.scan_status, 'COMPLETED', 'the channel reaches a verdict instead of re-arming');
  assert.equal(updated.discord_validation_status, 'FAILED_OPERATIONAL', 'the exhausted locator work is terminal even with an established selection');
  assert.equal(updated.discord_status, 'ACTIVE', 'the established serving projection is preserved');
  assert.equal(updated.discord_invite, 'https://discord.gg/stale-room', 'the live invite is preserved');
  assert.deepEqual(enqueued, [], 'an exhausted locator no longer re-arms the retry job');
  // A later pass must not recreate locator-unvalidated pending work from the
  // reset scan attempts, which was the unverdictable retry cycle.
  await projectNotFoundAfterInspection(
    channel,
    { acquisitionOutcomes: [] },
    { candidates: [], foundInvite: null } as never,
    true,
    async (channelId: string) => { enqueued.push(channelId); },
  );
  assert.deepEqual(enqueued, [], 'the terminal verdict survives the scan-attempt reset');
  assert.equal((channel as Record<string, unknown>).scan_attempts, 0);
});

test('E7: pending detection uses community-surface retry semantics, not raw required/retryable flags', () => {
  const youtubeUpstreamFailure = detectPendingDiscoveryWork(
    { discord_candidate_locator: null, discord_validation_status: 'NOT_STARTED', discord_discovery_status: 'NOT_DISCOVERED' },
    {
      acquisitionOutcomes: [{
        surface: 'YOUTUBE_ABOUT',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        required: true,
        failureClass: 'YOUTUBE_ABOUT_ACQUISITION_FAILED',
      }],
    },
  );
  assert.deepEqual(youtubeUpstreamFailure, { pending: false, reasons: [] }, 'upstream YouTube failures do not fabricate Discord retry work');
  const websiteFailure = detectPendingDiscoveryWork(
    { discord_candidate_locator: null, discord_validation_status: 'NOT_STARTED', discord_discovery_status: 'NOT_DISCOVERED' },
    {
      acquisitionOutcomes: [{
        surface: 'CREATOR_WEBSITES',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        required: true,
        failureClass: 'RENDERED_TIMEOUT',
      }],
    },
  );
  assert.deepEqual(websiteFailure, { pending: true, reasons: ['required-retryable-observation'] }, 'a required community failure still preserves pending work');
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
  assert.match(db, /classifyDiscoveryVisibility\(\{/, 'the pure classifier feeds the channel projection');
  assert.match(db, /discovery_visibility: classifyDiscoveryVisibility/);
  // The main /api/channels listing is the dashboard projection: it must
  // select both classification inputs and route rows through the same
  // visibility helper as the single-channel endpoint.
  assert.match(db, /inspection_trail,subscriber_count/);
  assert.match(db, /FROM discord_candidates dc WHERE dc\.channel_id=channels\.channel_id\) candidate_count/);
  assert.match(db, /items:page\.rows\.map\(rowToChannelWithDiscoveryVisibility\)/);
  assert.match(db, /legacyUnclassifiedChannels:Number\(row\.legacy_unclassified_channels\|\|0\)/);
  const ui = readSource('../src/components/ResultsTable.tsx');
  assert.match(ui, /data-testid="legacy-unclassified"/);
  assert.match(ui, /c\.discovery_visibility === 'LEGACY_UNCLASSIFIED'/);
});
