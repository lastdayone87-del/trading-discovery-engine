import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression coverage for the promotion bridge: BANDIT promotion reads the
 * genuine persistent-research evaluation artifact
 * (persistent_research_policy_evaluations decision='PASS' with a non-null
 * baseline for the candidate being promoted). The dead
 * portfolio_policy_evaluations table is never consulted and never written.
 *
 * Fixture rows below exercise the GATE's read path only (matrix over
 * decision/baseline/policy match); the genuine evaluator→PASS path is proven
 * end-to-end by researchBootstrap.e2e.postgres.test.ts. Run ONLY against the
 * dedicated isolated test database:
 *
 *   RESEARCH_BOOTSTRAP_TEST_DATABASE_URL=postgresql://... npx tsx --test server/policyPromotion.postgres.test.ts
 */
const dedicated = process.env.RESEARCH_BOOTSTRAP_TEST_DATABASE_URL;

test('promotion gate tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicated) {
    console.log(
      'SKIP: set RESEARCH_BOOTSTRAP_TEST_DATABASE_URL to a dedicated test database to run the promotion gate tests.'
    );
  }
  assert.ok(true);
});

if (dedicated) process.env.DATABASE_URL = dedicated;
const maybe = dedicated ? test : test.skip;

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

const BASE_CONFIG = {
  totalProviderBudget: 100,
  totalReviewBudget: 10,
  clusterCap: 2,
  curatedSearchFloor: 0,
  actionCaps: {},
};

async function db(): Promise<Db> {
  const { getDb } = await import('./dbCore');
  return getDb();
}

async function freshPolicy(database: Db, tag: string) {
  const { createPolicy } = await import('./portfolioAllocator');
  return createPolicy({
    policyKey: `test-promotion-policy:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: { ...BASE_CONFIG, programFloors: { [`test:promotion:${tag}`]: 0 } },
    actor: 'test:promotion-gate',
  });
}

async function seedEvaluation(
  database: Db,
  tag: string,
  policyId: string,
  baselineId: string | null,
  decision: 'PASS' | 'FAIL' | 'ABSTAIN'
) {
  await database.query(
    `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by)
     VALUES($1,$2,$3,now()-interval '1 hour',now(),30,$4,$5,$6,$7,'test:promotion-gate')`,
    [
      `test-promotion-eval:${tag}:${decision}`,
      policyId,
      baselineId,
      JSON.stringify({}),
      decision,
      JSON.stringify([]),
      `test-checksum-${tag}`,
    ]
  );
}

async function statusOf(database: Db, id: string): Promise<string> {
  return (
    await database.query('SELECT status FROM portfolio_policies WHERE id=$1', [id])
  ).rows[0].status as string;
}

maybe('genuine PASS with baseline promotes DRAFT to APPROVED', async () => {
  const database = await db();
  const { transitionPolicy } = await import('./portfolioAllocator');
  const tag = `pass:${Date.now()}:${process.pid}`;
  const candidate = await freshPolicy(database, tag);
  const baseline = await freshPolicy(database, `base:${tag}`);
  await seedEvaluation(database, tag, candidate.id, baseline.id, 'PASS');
  const promoted = await transitionPolicy({
    id: candidate.id,
    action: 'APPROVE',
    reason: 'test genuine pass promotes',
    idempotencyKey: `test-promotion-approve:${tag}`,
    actor: 'test:promotion-gate',
  });
  assert.equal(promoted.status, 'APPROVED');
  assert.equal(await statusOf(database, candidate.id), 'APPROVED');
});

maybe('FAIL, ABSTAIN, and missing evaluations fail closed', async () => {
  const database = await db();
  const { transitionPolicy } = await import('./portfolioAllocator');
  for (const decision of ['FAIL', 'ABSTAIN'] as const) {
    const tag = `${decision.toLowerCase()}:${Date.now()}:${process.pid}:${Math.random()}`;
    const candidate = await freshPolicy(database, tag);
    const baseline = await freshPolicy(database, `base:${tag}`);
    await seedEvaluation(database, tag, candidate.id, baseline.id, decision);
    await assert.rejects(
      transitionPolicy({
        id: candidate.id,
        action: 'APPROVE',
        reason: `test ${decision} refuses`,
        idempotencyKey: `test-promotion-${tag}`,
        actor: 'test:promotion-gate',
      }),
      /ADAPTIVE_POLICY_EVALUATION_REQUIRED/
    );
    assert.equal(await statusOf(database, candidate.id), 'DRAFT');
  }
  const tag = `missing:${Date.now()}:${process.pid}`;
  const unevaluated = await freshPolicy(database, tag);
  await assert.rejects(
    transitionPolicy({
      id: unevaluated.id,
      action: 'APPROVE',
      reason: 'test missing evaluation refuses',
      idempotencyKey: `test-promotion-${tag}`,
      actor: 'test:promotion-gate',
    }),
    /ADAPTIVE_POLICY_EVALUATION_REQUIRED/
  );
  assert.equal(await statusOf(database, unevaluated.id), 'DRAFT');
});

maybe('PASS for another policy or without baseline fails closed', async () => {
  const database = await db();
  const { transitionPolicy } = await import('./portfolioAllocator');
  const tag = `other:${Date.now()}:${process.pid}`;
  const candidate = await freshPolicy(database, tag);
  const other = await freshPolicy(database, `other:${tag}`);
  const baseline = await freshPolicy(database, `base:${tag}`);
  await seedEvaluation(database, tag, other.id, baseline.id, 'PASS');
  await assert.rejects(
    transitionPolicy({
      id: candidate.id,
      action: 'APPROVE',
      reason: 'test other-policy pass refuses',
      idempotencyKey: `test-promotion-${tag}`,
      actor: 'test:promotion-gate',
    }),
    /ADAPTIVE_POLICY_EVALUATION_REQUIRED/
  );
  assert.equal(await statusOf(database, candidate.id), 'DRAFT');
  const noBaselineTag = `nobase:${Date.now()}:${process.pid}`;
  const noBaseline = await freshPolicy(database, noBaselineTag);
  await seedEvaluation(database, noBaselineTag, noBaseline.id, null, 'PASS');
  await assert.rejects(
    transitionPolicy({
      id: noBaseline.id,
      action: 'APPROVE',
      reason: 'test baselineless pass refuses',
      idempotencyKey: `test-promotion-${noBaselineTag}`,
      actor: 'test:promotion-gate',
    }),
    /ADAPTIVE_POLICY_EVALUATION_REQUIRED/
  );
  assert.equal(await statusOf(database, noBaseline.id), 'DRAFT');
});

maybe('APPROVED policy with genuine PASS advances to CANARY', async () => {
  const database = await db();
  const { transitionPolicy } = await import('./portfolioAllocator');
  const tag = `canary:${Date.now()}:${process.pid}`;
  const candidate = await freshPolicy(database, tag);
  const baseline = await freshPolicy(database, `base:${tag}`);
  await seedEvaluation(database, tag, candidate.id, baseline.id, 'PASS');
  await transitionPolicy({
    id: candidate.id,
    action: 'APPROVE',
    reason: 'test approve then canary',
    idempotencyKey: `test-promotion-approve:${tag}`,
    actor: 'test:promotion-gate',
  });
  const canary = await transitionPolicy({
    id: candidate.id,
    action: 'CANARY',
    reason: 'test canary advance',
    idempotencyKey: `test-promotion-canary:${tag}`,
    actor: 'test:promotion-gate',
  });
  assert.equal(canary.status, 'CANARY');
});

maybe('non-evaluated transitions and CANARY singleton behave correctly', async () => {
  const database = await db();
  const { transitionPolicy } = await import('./portfolioAllocator');
  const tag = `matrix:${Date.now()}:${process.pid}`;
  // FIXED_BEST_FIRST policies carry no evaluation requirement.
  const { createPolicy } = await import('./portfolioAllocator');
  const fixed = await createPolicy({
    policyKey: `test-matrix-fixed:${tag}`,
    policyType: 'FIXED_BEST_FIRST',
    configuration: { ...BASE_CONFIG, programFloors: { [`test:matrix:fixed:${tag}`]: 0 } },
    actor: 'test:promotion-gate',
  });
  const approvedFixed = await transitionPolicy({
    id: fixed.id,
    action: 'APPROVE',
    reason: 'test fixed approve needs no eval',
    idempotencyKey: `test-matrix-fixed-approve:${tag}`,
    actor: 'test:promotion-gate',
  });
  assert.equal(approvedFixed.status, 'APPROVED');
  // BANDIT PAUSE/ROLLBACK need no evaluation; PAUSED can return to CANARY only with PASS.
  const bandit = await createPolicy({
    policyKey: `test-matrix-bandit:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: { ...BASE_CONFIG, programFloors: { [`test:matrix:bandit:${tag}`]: 0 } },
    actor: 'test:promotion-gate',
  });
  await assert.rejects(
    transitionPolicy({
      id: bandit.id,
      action: 'PAUSE',
      reason: 'test invalid draft pause',
      idempotencyKey: `test-matrix-bandit-pause:${tag}`,
      actor: 'test:promotion-gate',
    }),
    /INVALID_POLICY_TRANSITION/
  );
  const banditBase = await freshPolicy(database, `banditbase:${tag}`);
  await seedEvaluation(database, `bandit:${tag}`, bandit.id, banditBase.id, 'PASS');
  await transitionPolicy({
    id: bandit.id,
    action: 'APPROVE',
    reason: 'test bandit approve',
    idempotencyKey: `test-matrix-bandit-approve:${tag}`,
    actor: 'test:promotion-gate',
  });
  const paused = await transitionPolicy({
    id: bandit.id,
    action: 'PAUSE',
    reason: 'test approved pause needs no eval',
    idempotencyKey: `test-matrix-bandit-pause2:${tag}`,
    actor: 'test:promotion-gate',
  });
  assert.equal(paused.status, 'PAUSED');
  const retired = await transitionPolicy({
    id: bandit.id,
    action: 'ROLLBACK',
    reason: 'test paused rollback retires',
    idempotencyKey: `test-matrix-bandit-rollback:${tag}`,
    actor: 'test:promotion-gate',
  });
  assert.equal(retired.status, 'RETIRED');
  // Second CANARY pauses the first (singleton invariant).
  const first = await freshPolicy(database, `first:${tag}`);
  const firstBase = await freshPolicy(database, `firstbase:${tag}`);
  await seedEvaluation(database, `first:${tag}`, first.id, firstBase.id, 'PASS');
  await transitionPolicy({
    id: first.id,
    action: 'APPROVE',
    reason: 'test first approve',
    idempotencyKey: `test-matrix-first-approve:${tag}`,
    actor: 'test:promotion-gate',
  });
  await transitionPolicy({
    id: first.id,
    action: 'CANARY',
    reason: 'test first canary',
    idempotencyKey: `test-matrix-first-canary:${tag}`,
    actor: 'test:promotion-gate',
  });
  const second = await freshPolicy(database, `second:${tag}`);
  const secondBase = await freshPolicy(database, `secondbase:${tag}`);
  await seedEvaluation(database, `second:${tag}`, second.id, secondBase.id, 'PASS');
  await transitionPolicy({
    id: second.id,
    action: 'APPROVE',
    reason: 'test second approve',
    idempotencyKey: `test-matrix-second-approve:${tag}`,
    actor: 'test:promotion-gate',
  });
  await transitionPolicy({
    id: second.id,
    action: 'CANARY',
    reason: 'test second canary pauses first',
    idempotencyKey: `test-matrix-second-canary:${tag}`,
    actor: 'test:promotion-gate',
  });
  assert.equal(await statusOf(database, second.id), 'CANARY');
  assert.equal(await statusOf(database, first.id), 'PAUSED');
  const canaryCount = (
    await database.query(`SELECT count(*)::int AS n FROM portfolio_policies WHERE status='CANARY'`)
  ).rows[0];
  assert.equal(Number(canaryCount.n), 1, 'at most one CANARY policy may exist');
});
