import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Approval-path regression: DRAFT snapshots are never consumable; only an
 * explicit human approval flips DRAFT→APPROVED, exactly once, and only the
 * latest APPROVED snapshot serves. Run ONLY against the dedicated isolated
 * test database:
 *
 *   RESEARCH_BOOTSTRAP_TEST_DATABASE_URL=postgresql://... npx tsx --test server/domainWeightApproval.postgres.test.ts
 */
const dedicated = process.env.RESEARCH_BOOTSTRAP_TEST_DATABASE_URL;

test('domain weight approval tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicated) console.log('SKIP: set RESEARCH_BOOTSTRAP_TEST_DATABASE_URL to run domain approval tests.');
  assert.ok(true);
});

if (dedicated) process.env.DATABASE_URL = dedicated;
const maybe = dedicated ? test : test.skip;

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

maybe('DRAFT snapshots are unconsumable until explicitly approved, exactly once', async () => {
  const database: Db = await import('./dbCore').then(m => m.getDb());
  const { recordWeightSnapshot, approveWeightSnapshot, getApprovedWeights } = await import('./dbCore');
  const tag = `approval:${Date.now()}:${process.pid}`;
  const site = `test-site:${tag}`;
  const version = `test-version:${tag}`;
  assert.equal(await getApprovedWeights(site), null, 'no weights before any snapshot');
  await recordWeightSnapshot({
    version,
    siteIdentity: site,
    weights: { a: 1 },
    trainingWindow: {},
    metrics: {},
    codeVersion: 'test',
  });
  assert.equal(await getApprovedWeights(site), null, 'DRAFT snapshot must not serve');
  assert.equal(await approveWeightSnapshot(version, ''), false, 'blank approver refuses');
  assert.equal(await approveWeightSnapshot(version, 'test:human-approver'), true);
  const served = await getApprovedWeights(site);
  assert.equal(served?.version, version);
  assert.equal(await approveWeightSnapshot(version, 'test:second-approver'), false, 're-approval refuses');
  const status = (
    await database.query('SELECT status, approved_by FROM domain_weight_snapshots WHERE version=$1', [version])
  ).rows[0];
  assert.equal(status.status, 'APPROVED');
  assert.equal(status.approved_by, 'test:human-approver');
});
