import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFrontierQueue,
  countFrontierQueue,
  upsertFrontierQueueItem,
  recordPageCoverage,
} from './dbCore';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

const SITE = 'apex-frontier-postgres-test.example';

maybe('frontier admission, priority order, and cap counting', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  t.after(async () => {
    await db.query(`DELETE FROM site_frontier WHERE site_identity=$1`, [SITE]);
    await db.query(`DELETE FROM page_coverage WHERE site_identity=$1`, [SITE]);
  });
  await db.query(`DELETE FROM site_frontier WHERE site_identity=$1`, [SITE]);
  await db.query(`DELETE FROM page_coverage WHERE site_identity=$1`, [SITE]);
  assert.deepEqual(await getFrontierQueue(SITE), []);
  assert.equal(await countFrontierQueue(SITE), 0);
  await upsertFrontierQueueItem({
    siteIdentity: SITE, urlKey: 'https://apex-frontier-postgres-test.example/low', url: 'https://apex-frontier-postgres-test.example/low',
    expectedValue: 1, nominatingSource: 'NAVIGATION', weightVersion: 'test-v1', scorerInputs: {}, decision: {},
  });
  await upsertFrontierQueueItem({
    siteIdentity: SITE, urlKey: 'https://apex-frontier-postgres-test.example/high', url: 'https://apex-frontier-postgres-test.example/high',
    expectedValue: 90, nominatingSource: 'SITEMAP', weightVersion: 'test-v1', scorerInputs: {}, decision: {},
  });
  const queue = await getFrontierQueue(SITE);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].url, 'https://apex-frontier-postgres-test.example/high', 'best expected value dequeues first');
  assert.equal(queue[0].state, 'QUEUED');
  assert.equal(await countFrontierQueue(SITE), 2);
});

maybe('page coverage appends terminal rows without rewriting history', async t => {
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  t.after(async () => {
    await db.query(`DELETE FROM page_coverage WHERE site_identity=$1`, [SITE]);
  });
  await db.query(`DELETE FROM page_coverage WHERE site_identity=$1`, [SITE]);
  await recordPageCoverage({
    siteIdentity: SITE, pageKey: 'https://apex-frontier-postgres-test.example/p', pageUrl: 'https://apex-frontier-postgres-test.example/p',
    terminalState: 'INSPECTED_NO_MATCH', acquisitionMethod: 'HTTP_STATIC', evidenceUnits: 0, policyVersion: 'test-v1',
  });
  await recordPageCoverage({
    siteIdentity: SITE, pageKey: 'https://apex-frontier-postgres-test.example/p', pageUrl: 'https://apex-frontier-postgres-test.example/p',
    terminalState: 'FOUND', acquisitionMethod: 'HTTP_STATIC', evidenceUnits: 1, policyVersion: 'test-v1',
  });
  const rows = await db.query(
    `SELECT terminal_state,evidence_units FROM page_coverage WHERE site_identity=$1 ORDER BY observed_at`,
    [SITE],
  );
  assert.equal(rows.rows.length, 2, 're-inspection appends instead of rewriting');
  assert.deepEqual(rows.rows.map(row => String(row.terminal_state)), ['INSPECTED_NO_MATCH', 'FOUND']);
});
