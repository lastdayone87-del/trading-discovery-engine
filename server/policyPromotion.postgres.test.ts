import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Promotion-gate tests for adaptive (CONTEXTUAL_BANDIT) policies. Only a
 * recorded PASS evaluation for the same policy may satisfy promotion to
 * APPROVED/CANARY; ABSTAIN, FAIL, missing, or other-policy evaluations must
 * fail closed with ADAPTIVE_POLICY_EVALUATION_REQUIRED. Fixture evaluations
 * are clearly-labeled test rows in the isolated test database (unique keys
 * per run); they exercise the gate logic only and promote nothing real.
 * Requires DATABASE_URL (CI secret or dedicated local DB); skipped otherwise.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

const CONFIG = {
  totalProviderBudget: 5,
  totalReviewBudget: 0,
  clusterCap: 1,
  curatedSearchFloor: 0,
  programFloors: {},
  actionCaps: {},
};

async function createBandit(
  createPolicy: (input: {
    policyKey: string;
    policyType: 'FIXED_BEST_FIRST' | 'CONTEXTUAL_BANDIT';
    configuration: Record<string, unknown>;
    actor: string;
  }) => Promise<{ id: string }>,
  tag: string
) {
  return createPolicy({
    policyKey: `test-promotion-${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: CONFIG,
    actor: 'test:policy-promotion',
  });
}

async function insertEvaluation(
  db: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  policyId: string,
  decision: 'PASS' | 'FAIL' | 'ABSTAIN',
  tag: string
) {
  await db.query(
    `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,dataset_cutoff,metrics,decision,reason_codes,artifact_checksum,evaluated_by)
     VALUES($1,$2,NULL,now(),$3,$4,$5,$6,'test:policy-promotion')`,
    [
      `test-promotion:${tag}:${decision}`,
      policyId,
      JSON.stringify({}),
      decision,
      JSON.stringify(['TEST_FIXTURE']),
      `test-checksum-${tag}-${decision}`,
    ]
  );
}

maybe('promotion requires a genuine recorded PASS evaluation', async t => {
  const { createPolicy, transitionPolicy } = await import('./portfolioAllocator');
  const { getDb } = await import('./dbCore');
  const db = await getDb();
  const tag = `${Date.now()}:${process.pid}`;
  const actor = 'test:policy-promotion';
  const key = (suffix: string) => `test-promotion:${tag}:${suffix}`;

  // No evaluation row at all: promotion fails closed.
  const bare = await createPolicy({
    policyKey: `test-promotion-bare:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: CONFIG,
    actor,
  });
  await assert.rejects(
    transitionPolicy({ id: bare.id, action: 'APPROVE', reason: 'test', idempotencyKey: key('bare'), actor: 'test:policy-promotion' }),
    /ADAPTIVE_POLICY_EVALUATION_REQUIRED/
  );

  // ABSTAIN evaluation: fails closed.
  const abstained = await createBandit(createPolicy, `abstain:${tag}`);
  await insertEvaluation(db, abstained.id, 'ABSTAIN', `abstain:${tag}`);
  await assert.rejects(
    transitionPolicy({ id: abstained.id, action: 'APPROVE', reason: 'test', idempotencyKey: key('abstain'), actor: 'test:policy-promotion' }),
    /ADAPTIVE_POLICY_EVALUATION_REQUIRED/
  );

  // FAIL evaluation: fails closed.
  const failed = await createBandit(createPolicy, `fail:${tag}`);
  await insertEvaluation(db, failed.id, 'FAIL', `fail:${tag}`);
  await assert.rejects(
    transitionPolicy({ id: failed.id, action: 'APPROVE', reason: 'test', idempotencyKey: key('fail'), actor: 'test:policy-promotion' }),
    /ADAPTIVE_POLICY_EVALUATION_REQUIRED/
  );

  // PASS evaluation for a DIFFERENT policy: fails closed.
  const other = await createBandit(createPolicy, `other:${tag}`);
  const target = await createBandit(createPolicy, `target:${tag}`);
  await insertEvaluation(db, other.id, 'PASS', `other:${tag}`);
  await assert.rejects(
    transitionPolicy({ id: target.id, action: 'APPROVE', reason: 'test', idempotencyKey: key('target'), actor: 'test:policy-promotion' }),
    /ADAPTIVE_POLICY_EVALUATION_REQUIRED/
  );

  // Genuine recorded PASS for the same policy: promotes DRAFT→APPROVED.
  await insertEvaluation(db, target.id, 'PASS', `target-pass:${tag}`);
  const promoted = await transitionPolicy({
    id: target.id,
    action: 'APPROVE',
    reason: 'test',
    idempotencyKey: key('target-pass'),
    actor: 'test:policy-promotion',
  });
  assert.equal(promoted.status, 'APPROVED');
});
