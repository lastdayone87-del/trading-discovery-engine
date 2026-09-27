import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSiteInspections,
  upsertSiteInspection,
  recordCreatorSiteLinks,
  pruneSiteInspections,
} from './dbCore';

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

maybe('site_inspections carries no creator column by schema', async () => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='site_inspections'`);
  const names = cols.rows.map(r => String(r.column_name));
  assert.ok(names.includes('site_identity'), 'cache keyed by site identity');
  assert.equal(names.some(name => /channel|creator/.test(name)), false, 'no creator attribution column may exist on the global cache');
});
