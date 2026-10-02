import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateRouteStats,
  getRouteStats,
} from './dbCore';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

const SITE = 'apex-route-stats-postgres-test.example';
const PATTERN = 'apex-route-stats-postgres-test.example/p/{n}';

maybe('route stats accumulate per pattern and read back for offline learning', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  t.after(async () => {
    await db.query(`DELETE FROM domain_route_stats WHERE site_identity=$1`, [SITE]);
  });
  await db.query(`DELETE FROM domain_route_stats WHERE site_identity=$1`, [SITE]);
  assert.deepEqual(await getRouteStats(SITE), [], 'unknown site reads empty (never NO_DATA-shaped)');
  await accumulateRouteStats({ siteIdentity: SITE, routePattern: PATTERN, evidenceUnits: 0 });
  await accumulateRouteStats({ siteIdentity: SITE, routePattern: PATTERN, evidenceUnits: 2 });
  await accumulateRouteStats({ siteIdentity: SITE, routePattern: `${SITE}/about`, evidenceUnits: 0 });
  const stats = await getRouteStats(SITE);
  assert.equal(stats.length, 2, 'one row per route pattern');
  const route = stats.find(stat => stat.routePattern === PATTERN)!;
  assert.deepEqual([route.attempts, route.evidenceHits, route.evidenceUnits], [2, 1, 2]);
  assert.ok(route.lastObservedAt, 'last observation clock advances');
  // Pre-migration safety is structural: every domain-memory reader/writer
  // resolves 42P01 to an empty/quiet result instead of throwing. Verified
  // by code inspection (getRouteStats, accumulateRouteStats,
  // recordWeightSnapshot, approveWeightSnapshot, getApprovedWeights all
  // branch on error code 42P01); this test pins the query surface those
  // branches guard.
  const source = (await import('node:fs')).readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  for (const fn of ['accumulateRouteStats', 'getRouteStats', 'recordWeightSnapshot', 'approveWeightSnapshot', 'getApprovedWeights']) {
    const start = source.indexOf(`export async function ${fn}`);
    const end = source.indexOf('export async function', start + 1);
    const body = end > start ? source.slice(start, end) : source.slice(start);
    assert.ok(body.includes(`'42P01'`), `${fn} keeps its pre-migration guard`);
  }
});
