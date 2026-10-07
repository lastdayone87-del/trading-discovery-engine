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
  decision: 'PASS' | 'FAIL' | 'ABSTAIN',
  evaluatedAt?: string
) {
  await database.query(
    `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by,evaluated_at)
     VALUES($1,$2,$3,now()-interval '1 hour',now(),30,$4,$5,$6,$7,'test:promotion-gate',COALESCE($8::timestamptz,now()))`,
    [
      `test-promotion-eval:${tag}:${decision}:${evaluatedAt || 'now'}`,
      policyId,
      baselineId,
      JSON.stringify({}),
      decision,
      JSON.stringify([]),
      `test-checksum-${tag}`,
      evaluatedAt || null,
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

async function approveAs(
  transitionPolicy: (input: {
    id: string; action: 'APPROVE'; reason: string; idempotencyKey: string; actor: string;
  }) => Promise<{ status: string }>,
  database: Db,
  id: string,
  key: string
): Promise<{ ok: boolean; status: string }> {
  try {
    const result = await transitionPolicy({
      id,
      action: 'APPROVE',
      reason: 'test latest-semantics matrix',
      idempotencyKey: key,
      actor: 'test:promotion-gate',
    });
    return { ok: true, status: result.status };
  } catch (error) {
    assert.match(String((error as Error)?.message || error), /ADAPTIVE_POLICY_EVALUATION_REQUIRED/);
    return { ok: false, status: await statusOf(database, id) };
  }
}

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

maybe('only the latest evaluation for the candidate authorizes promotion', async () => {
  const database = await db();
  const { transitionPolicy } = await import('./portfolioAllocator');
  const base = `latest:${Date.now()}:${process.pid}`;
  const hour = 3600_000;
  const stamps = { old: new Date(Date.now() - 3 * hour).toISOString(), mid: new Date(Date.now() - 2 * hour).toISOString(), now: new Date(Date.now() - 1 * hour).toISOString() };

  async function candidateWithHistory(
    name: string,
    history: Array<{ decision: 'PASS' | 'FAIL' | 'ABSTAIN'; at: string; baseline: boolean }>
  ) {
    const candidate = await freshPolicy(database, `${base}:${name}`);
    const baseline = await freshPolicy(database, `${base}:${name}:base`);
    let seq = 0;
    for (const entry of history) {
      await seedEvaluation(
        database,
        `${base}:${name}:${seq++}`,
        candidate.id,
        entry.baseline ? baseline.id : null,
        entry.decision,
        entry.at
      );
    }
    return candidate;
  }

  // PASS only → allowed.
  const passOnly = await candidateWithHistory('pass-only', [{ decision: 'PASS', at: stamps.now, baseline: true }]);
  assert.deepEqual(
    await approveAs(transitionPolicy, database, passOnly.id, `test-latest-pass-only:${base}`),
    { ok: true, status: 'APPROVED' }
  );
  // PASS → FAIL → rejected (stale PASS must not authorize).
  const passFail = await candidateWithHistory('pass-fail', [
    { decision: 'PASS', at: stamps.mid, baseline: true },
    { decision: 'FAIL', at: stamps.now, baseline: true },
  ]);
  assert.deepEqual(
    await approveAs(transitionPolicy, database, passFail.id, `test-latest-pass-fail:${base}`),
    { ok: false, status: 'DRAFT' }
  );
  // PASS → ABSTAIN → rejected.
  const passAbstain = await candidateWithHistory('pass-abstain', [
    { decision: 'PASS', at: stamps.mid, baseline: true },
    { decision: 'ABSTAIN', at: stamps.now, baseline: true },
  ]);
  assert.deepEqual(
    await approveAs(transitionPolicy, database, passAbstain.id, `test-latest-pass-abstain:${base}`),
    { ok: false, status: 'DRAFT' }
  );
  // FAIL only → rejected; ABSTAIN only → rejected.
  for (const decision of ['FAIL', 'ABSTAIN'] as const) {
    const solo = await candidateWithHistory(`solo-${decision.toLowerCase()}`, [
      { decision, at: stamps.now, baseline: true },
    ]);
    assert.deepEqual(
      await approveAs(transitionPolicy, database, solo.id, `test-latest-solo:${base}:${decision}`),
      { ok: false, status: 'DRAFT' }
    );
  }
  // Latest PASS with older FAIL → allowed.
  const failPass = await candidateWithHistory('fail-pass', [
    { decision: 'FAIL', at: stamps.mid, baseline: true },
    { decision: 'PASS', at: stamps.now, baseline: true },
  ]);
  assert.deepEqual(
    await approveAs(transitionPolicy, database, failPass.id, `test-latest-fail-pass:${base}`),
    { ok: true, status: 'APPROVED' }
  );
  // Latest PASS without baseline → rejected (baselineless PASS never authorizes).
  const noBase = await candidateWithHistory('no-base', [
    { decision: 'FAIL', at: stamps.mid, baseline: true },
    { decision: 'PASS', at: stamps.now, baseline: false },
  ]);
  assert.deepEqual(
    await approveAs(transitionPolicy, database, noBase.id, `test-latest-no-base:${base}`),
    { ok: false, status: 'DRAFT' }
  );
});

maybe('duplicate transition_key across policies fails closed without silent audit skip', async () => {
  const database = await db();
  const { transitionPolicy } = await import('./portfolioAllocator');
  const tag = `conflict:${Date.now()}:${process.pid}`;
  const first = await freshPolicy(database, `${tag}:first`);
  const firstBase = await freshPolicy(database, `${tag}:first-base`);
  await seedEvaluation(database, `${tag}:first`, first.id, firstBase.id, 'PASS');
  const sharedKey = `test-promotion-shared:${tag}`;
  const ok = await transitionPolicy({ id: first.id, action: 'APPROVE', reason: 'test first with shared key', idempotencyKey: sharedKey, actor: 'test:promotion-gate' });
  assert.equal(ok.status, 'APPROVED');
  const second = await freshPolicy(database, `${tag}:second`);
  const secondBase = await freshPolicy(database, `${tag}:second-base`);
  await seedEvaluation(database, `${tag}:second`, second.id, secondBase.id, 'PASS');
  await assert.rejects(
    transitionPolicy({ id: second.id, action: 'APPROVE', reason: 'test second reuses shared key', idempotencyKey: sharedKey, actor: 'test:promotion-gate' }),
    /POLICY_TRANSITION_CONFLICT/
  );
  assert.equal(await statusOf(database, second.id), 'DRAFT');
});
