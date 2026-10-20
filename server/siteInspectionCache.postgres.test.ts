import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSiteInspections,
  upsertSiteInspection,
  recordCreatorSiteLinks,
  pruneSiteInspections,
  markSiteInspectionsClaimed,
  markSiteInspectionsDiscarded,
} from './dbCore';
import { buildBorrowedSiteInspection } from './siteInspectionCache';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

const SITE = 'apex-postgres-test.example';
const CHANNEL_A = 'UCpostgresaaaaaaaaaaaaaaaaaa';
const CHANNEL_B = 'UCpostgresbbbbbbbbbbbbbbbbb';

maybe('site inspections upsert, read back, and converge across writers', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  t.after(async () => {
    await db.query(`DELETE FROM creator_site_links WHERE site_identity=$1`, [SITE]);
    await db.query(`DELETE FROM site_inspections WHERE site_identity=$1`, [SITE]);
  });
  await db.query(`DELETE FROM site_inspections WHERE site_identity=$1`, [SITE]);
  assert.deepEqual(await getSiteInspections([SITE]), [], 'absent before first crawl');
  await upsertSiteInspection({
    siteIdentity: SITE, identityTier: 'A', identityBasis: 'test',
    canonicalUrl: `https://${SITE}/`, outcome: 'FOUND', retryable: false,
    candidates: [{ candidateId: 'c1' }], observations: [{ outcome: 'FOUND' }],
    renderedCovered: false, provenance: {},
  });
  const first = await getSiteInspections([SITE]);
  assert.equal(first.length, 1);
  assert.equal(first[0].siteIdentity, SITE);
  assert.equal(first[0].outcome, 'FOUND');
  assert.equal(first[0].observedCount, 1);
  assert.deepEqual(first[0].candidates, [{ candidateId: 'c1' }]);
  // A concurrent first crawl converges: last writer wins, count advances.
  await upsertSiteInspection({
    siteIdentity: SITE, identityTier: 'A', identityBasis: 'test',
    canonicalUrl: `https://${SITE}/`, outcome: 'INSPECTED_NO_MATCH', retryable: false,
    candidates: [], observations: [{ outcome: 'INSPECTED_NO_MATCH' }],
    renderedCovered: true, provenance: {},
  });
  const second = await getSiteInspections([SITE]);
  assert.equal(second[0].observedCount, 2);
  assert.equal(second[0].renderedCovered, true);
  assert.equal(await getSiteInspections([]).then(rows => rows.length), 0, 'empty input reads nothing');
});

maybe('cross-writer pending claims keep each channel unclaimed invite recoverable', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  const CROSS_SITE = 'apex-cross-writer-pending.example';
  const cleanup = async () => {
    await db.query(`DELETE FROM site_inspections WHERE site_identity=$1`, [CROSS_SITE]);
  };
  await cleanup();
  t.after(cleanup);
  const candidateA = { candidateId: 'candidate-a', nativeInviteCode: 'alphaRoom', sourceSurface: 'CREATOR_WEBSITES' };
  const candidateB = { candidateId: 'candidate-b', nativeInviteCode: 'betaRoom', sourceSurface: 'CREATOR_WEBSITES' };
  await upsertSiteInspection({
    siteIdentity: CROSS_SITE, identityTier: 'A', identityBasis: 'test',
    canonicalUrl: `https://${CROSS_SITE}/`, outcome: 'FOUND', retryable: false,
    candidates: [candidateA], observations: [{ outcome: 'FOUND' }],
    renderedCovered: false, sourceChannelId: CHANNEL_A, claimStatus: 'PENDING', provenance: {},
  });
  await upsertSiteInspection({
    siteIdentity: CROSS_SITE, identityTier: 'A', identityBasis: 'test',
    canonicalUrl: `https://${CROSS_SITE}/`, outcome: 'FOUND', retryable: false,
    candidates: [candidateB], observations: [{ outcome: 'FOUND' }],
    renderedCovered: false, sourceChannelId: CHANNEL_B, claimStatus: 'PENDING', provenance: {},
  });
  let [row] = await getSiteInspections([CROSS_SITE]);
  assert.equal(row.claimStatus, 'PENDING');
  assert.deepEqual(Object.keys(row.pendingClaims || {}).sort(), [CHANNEL_A, CHANNEL_B].sort());
  assert.deepEqual((row.pendingClaims?.[CHANNEL_A] || []).map(c => c.candidateId), ['candidate-a']);
  assert.deepEqual((row.pendingClaims?.[CHANNEL_B] || []).map(c => c.candidateId), ['candidate-b']);
  const borrower = (channelId: string) => ({
    requestedUrl: `https://${CROSS_SITE}/`,
    surface: 'CREATOR_WEBSITES',
    required: true,
    observedAt: new Date().toISOString(),
    channelId,
  });
  assert.deepEqual(
    buildBorrowedSiteInspection(row, borrower(CHANNEL_A)).recoveredCandidates.map(c => c.candidateId),
    ['candidate-a'],
    'the first channel recovers only its own invite after the second writer',
  );
  assert.deepEqual(
    buildBorrowedSiteInspection(row, borrower(CHANNEL_B)).recoveredCandidates.map(c => c.candidateId),
    ['candidate-b'],
    'the second channel recovers its own invite',
  );
  // A admits: only A's pending entry finalizes; B's evidence stays PENDING.
  await markSiteInspectionsClaimed(CHANNEL_A, ['candidate-a']);
  [row] = await getSiteInspections([CROSS_SITE]);
  assert.equal(row.claimStatus, 'PENDING');
  assert.equal(row.pendingClaims?.[CHANNEL_A], undefined);
  assert.deepEqual((row.pendingClaims?.[CHANNEL_B] || []).map(c => c.candidateId), ['candidate-b']);
  // B loses every claim: row becomes terminal DISCARDED and drops the stale
  // candidate payload, making the site reusable instead of endlessly pending.
  await markSiteInspectionsDiscarded(CHANNEL_B, ['candidate-b']);
  [row] = await getSiteInspections([CROSS_SITE]);
  assert.equal(row.claimStatus, 'DISCARDED');
  assert.deepEqual(row.pendingClaims, {});
  assert.deepEqual(row.candidates, []);
});

maybe('same-channel seed writes merge unclaimed candidates instead of replacing them', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  const SAME_CHANNEL_SITE = 'apex-same-channel-pending.example';
  const cleanup = async () => {
    await db.query(`DELETE FROM site_inspections WHERE site_identity=$1`, [SAME_CHANNEL_SITE]);
  };
  await cleanup();
  t.after(cleanup);
  const candidateOne = { candidateId: 'candidate-one', nativeInviteCode: 'oneRoom', sourceSurface: 'CREATOR_WEBSITES' };
  const candidateTwo = { candidateId: 'candidate-two', nativeInviteCode: 'twoRoom', sourceSurface: 'CREATOR_WEBSITES' };
  const writeSeed = (candidates: Array<Record<string, unknown>>) => upsertSiteInspection({
    siteIdentity: SAME_CHANNEL_SITE, identityTier: 'A', identityBasis: 'test',
    canonicalUrl: `https://${SAME_CHANNEL_SITE}/`, outcome: 'FOUND', retryable: false,
    candidates, observations: [{ outcome: 'FOUND' }],
    renderedCovered: false, sourceChannelId: CHANNEL_A, claimStatus: 'PENDING', provenance: {},
  });
  await writeSeed([candidateOne]);
  await writeSeed([candidateTwo]);
  await writeSeed([candidateTwo]);
  let [row] = await getSiteInspections([SAME_CHANNEL_SITE]);
  assert.equal(row.claimStatus, 'PENDING');
  assert.deepEqual(
    (row.pendingClaims?.[CHANNEL_A] || []).map(c => c.candidateId),
    ['candidate-one', 'candidate-two'],
    'both seeds are recoverable and duplicate candidate ids collapse to the newest copy',
  );
  assert.deepEqual(
    buildBorrowedSiteInspection(row, {
      requestedUrl: `https://${SAME_CHANNEL_SITE}/`,
      surface: 'CREATOR_WEBSITES',
      required: true,
      observedAt: new Date().toISOString(),
      channelId: CHANNEL_A,
    }).recoveredCandidates.map(c => c.candidateId),
    ['candidate-one', 'candidate-two'],
  );
  await markSiteInspectionsClaimed(CHANNEL_A, ['candidate-one', 'candidate-two']);
  [row] = await getSiteInspections([SAME_CHANNEL_SITE]);
  assert.equal(row.claimStatus, 'CLAIMED');
  assert.deepEqual(row.pendingClaims, {});
  assert.deepEqual(row.candidates, []);
});

maybe('an empty incoming intent array never erases cached root community evidence', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  const INTENT_SITE = 'apex-intent-preserve.example';
  t.after(async () => {
    await db.query(`DELETE FROM site_inspections WHERE site_identity=$1`, [INTENT_SITE]);
  });
  await db.query(`DELETE FROM site_inspections WHERE site_identity=$1`, [INTENT_SITE]);
  const intent = {
    communityPlatform: 'WHOP', communityUrl: 'https://www.whop.com/creator',
    intent: 'PAID', paidSignals: ['price'], privateSignals: [], observedAt: new Date().toISOString(),
    sourcePageUrl: `https://${INTENT_SITE}/`, extractionConfidence: 'EXPLICIT',
  };
  await upsertSiteInspection({
    siteIdentity: INTENT_SITE, identityTier: 'A', identityBasis: 'test',
    canonicalUrl: `https://${INTENT_SITE}/`, outcome: 'FOUND', retryable: false,
    candidates: [], observations: [{ outcome: 'FOUND' }], communityIntents: [intent],
    renderedCovered: false, provenance: {},
  });
  await upsertSiteInspection({
    siteIdentity: INTENT_SITE, identityTier: 'A', identityBasis: 'test',
    canonicalUrl: `https://${INTENT_SITE}/`, outcome: 'INSPECTED_NO_MATCH', retryable: false,
    candidates: [], observations: [{ outcome: 'INSPECTED_NO_MATCH' }], communityIntents: [],
    renderedCovered: false, provenance: {},
  });
  const preserved = await getSiteInspections([INTENT_SITE]);
  assert.equal(preserved[0].communityIntents?.length, 1, 'empty refresh preserves the lender root intent');
  assert.equal((preserved[0].communityIntents?.[0] as { intent?: string }).intent, 'PAID');
  // A non-empty fresh intent still replaces the stale evidence.
  await upsertSiteInspection({
    siteIdentity: INTENT_SITE, identityTier: 'A', identityBasis: 'test',
    canonicalUrl: `https://${INTENT_SITE}/`, outcome: 'INSPECTED_NO_MATCH', retryable: false,
    candidates: [], observations: [{ outcome: 'INSPECTED_NO_MATCH' }],
    communityIntents: [{ ...intent, communityUrl: 'https://www.skool.com/creator', intent: 'UNKNOWN' }],
    renderedCovered: false, provenance: {},
  });
  const replaced = await getSiteInspections([INTENT_SITE]);
  assert.equal(replaced[0].communityIntents?.length, 1);
  assert.equal((replaced[0].communityIntents?.[0] as { communityUrl?: string }).communityUrl, 'https://www.skool.com/creator');
});

maybe('creator associations record per creator without touching site rows', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  t.after(async () => {
    await db.query(`DELETE FROM creator_site_links WHERE site_identity=$1`, [SITE]);
  });
  await db.query(`DELETE FROM creator_site_links WHERE site_identity=$1`, [SITE]);
  await recordCreatorSiteLinks(CHANNEL_A, [{ siteIdentity: SITE, sourceSurface: 'CREATOR_WEBSITES', sourceUrl: `https://${SITE}/a` }]);
  await recordCreatorSiteLinks(CHANNEL_B, [{ siteIdentity: SITE, sourceSurface: 'CREATOR_WEBSITES', sourceUrl: `https://${SITE}/b` }]);
  await recordCreatorSiteLinks(CHANNEL_A, [{ siteIdentity: SITE, sourceSurface: 'CREATOR_WEBSITES', sourceUrl: `https://${SITE}/a` }]);
  const rows = await db.query(`SELECT channel_id, source_url FROM creator_site_links WHERE site_identity=$1 ORDER BY channel_id`, [SITE]);
  assert.deepEqual(rows.rows.map(r => r.channel_id), [CHANNEL_A, CHANNEL_B], 'both creators associated independently');
  assert.equal(rows.rows.length, 2, 'repeat association is idempotent, not duplicated');
});

maybe('site prune removes only rows older than retention', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  const OLD = 'apex-prune-old-test.example';
  const FRESH = 'apex-prune-fresh-test.example';
  t.after(async () => {
    await db.query(`DELETE FROM site_inspections WHERE site_identity IN ($1,$2)`, [OLD, FRESH]);
  });
  for (const site of [OLD, FRESH]) {
    await db.query(`DELETE FROM site_inspections WHERE site_identity=$1`, [site]);
    await upsertSiteInspection({
      siteIdentity: site, identityTier: 'A', identityBasis: 'test',
      canonicalUrl: `https://${site}/`, outcome: 'FOUND', retryable: false,
      candidates: [], observations: [], renderedCovered: false, provenance: {},
    });
  }
  await db.query(`UPDATE site_inspections SET last_observed_at=now()-interval '61 days', first_observed_at=now()-interval '61 days' WHERE site_identity=$1`, [OLD]);
  const pruned = await pruneSiteInspections(60 * 24 * 60 * 60_000);
  assert.ok(pruned >= 1, 'stale row pruned');
  assert.deepEqual((await getSiteInspections([OLD])).length, 0);
  assert.equal((await getSiteInspections([FRESH])).length, 1, 'fresh row survives');
});

maybe('prune removes obsolete links with expired inspections and keeps current associations', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  const OLD = 'apex-prune-link-old.example';
  const FRESH = 'apex-prune-link-fresh.example';
  const STALE_ORPHAN = 'apex-prune-link-stale-orphan.example';
  const CURRENT_ORPHAN = 'apex-prune-link-current-orphan.example';
  const ALL = [OLD, FRESH, STALE_ORPHAN, CURRENT_ORPHAN];
  t.after(async () => {
    await db.query(`DELETE FROM creator_site_links WHERE site_identity = ANY($1)`, [ALL]);
    await db.query(`DELETE FROM site_inspections WHERE site_identity = ANY($1)`, [ALL]);
  });
  for (const site of ALL) {
    await db.query(`DELETE FROM creator_site_links WHERE site_identity=$1`, [site]);
    await db.query(`DELETE FROM site_inspections WHERE site_identity=$1`, [site]);
  }
  for (const site of [OLD, FRESH]) {
    await upsertSiteInspection({
      siteIdentity: site, identityTier: 'A', identityBasis: 'test',
      canonicalUrl: `https://${site}/`, outcome: 'FOUND', retryable: false,
      candidates: [], observations: [], renderedCovered: false, provenance: {},
    });
  }
  await recordCreatorSiteLinks(CHANNEL_A, [
    { siteIdentity: OLD, sourceSurface: 'CREATOR_WEBSITES', sourceUrl: `https://${OLD}/` },
    { siteIdentity: FRESH, sourceSurface: 'CREATOR_WEBSITES', sourceUrl: `https://${FRESH}/` },
    { siteIdentity: STALE_ORPHAN, sourceSurface: 'CREATOR_WEBSITES', sourceUrl: `https://${STALE_ORPHAN}/` },
    { siteIdentity: CURRENT_ORPHAN, sourceSurface: 'CREATOR_WEBSITES', sourceUrl: `https://${CURRENT_ORPHAN}/` },
  ]);
  await db.query(`UPDATE site_inspections SET last_observed_at=now()-interval '61 days' WHERE site_identity=$1`, [OLD]);
  await db.query(`UPDATE creator_site_links SET last_seen=now()-interval '61 days' WHERE site_identity IN ($1,$2)`, [OLD, STALE_ORPHAN]);
  const pruned = await pruneSiteInspections(60 * 24 * 60 * 60_000);
  assert.ok(pruned >= 1, 'expired inspection pruned');
  const remaining = await db.query(`SELECT site_identity FROM creator_site_links WHERE site_identity = ANY($1)`, [ALL]);
  const leftovers = remaining.rows.map(r => String(r.site_identity)).sort();
  assert.deepEqual(leftovers, [CURRENT_ORPHAN, FRESH].sort(), 'obsolete links removed with their inspections; current links remain');
  const second = await pruneSiteInspections(60 * 24 * 60 * 60_000);
  assert.equal(second, 0, 'repeated pruning is idempotent');
  const again = await db.query(`SELECT site_identity FROM creator_site_links WHERE site_identity = ANY($1)`, [ALL]);
  assert.deepEqual(again.rows.map(r => String(r.site_identity)).sort(), leftovers, 'repeat run deletes nothing further');
});

maybe('site_inspections carries no borrower ownership attribution column', async () => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='site_inspections'`);
  const names = cols.rows.map(r => String(r.column_name));
  assert.ok(names.includes('site_identity'), 'cache keyed by site identity');
  // The global cache must never carry a borrower/owner attribution column:
  // ownership is re-inferred per borrower, never inherited from the cache.
  assert.equal(names.some(name => name === 'channel_id' || name === 'creator_id' || name === 'owner_channel_id'), false, 'no ownership attribution column may exist on the global cache');
  // Recording provenance is the one explicit, nullable exception. It exists
  // only for the claim handshake and same-owner candidate recovery; a borrower
  // whose channel differs never receives the recording channel's candidates.
  const provenance = await db.query(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name='site_inspections' AND column_name='source_channel_id'`);
  assert.equal(provenance.rows.length, 1, 'recording provenance exists for claim handshake + same-owner recovery');
  assert.equal(provenance.rows[0].is_nullable, 'YES', 'provenance is nullable (legacy rows recover nothing)');
});
