import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Live-database tests for the provisional evidence-gathering CANARY
 * bootstrap. Run ONLY against an explicitly provided dedicated test database:
 *
 *   RESEARCH_BOOTSTRAP_TEST_DATABASE_URL=postgresql://... npx tsx --test server/researchBootstrap.postgres.test.ts
 *
 * Without that variable every test below skips. When enabled, the suite
 * requires the dedicated database to hold no ACTIVE bootstrap run and then
 * uses unique per-test fixtures. `discovery_action_assignments` is
 * append-only (immutable trigger: UPDATE/DELETE raise), and assignment rows
 * FK-block their actions/programs, so NOTHING created here is deleted:
 * leftover fixture actions are retired to the terminal EXPIRED lifecycle
 * (invisible to future allocation) and assignments/programs/policies persist
 * under unique keys. Control rows are restored; every started run is aborted
 * in a t.after/finally so a failed test can never poison the database.
 */
const dedicated = process.env.RESEARCH_BOOTSTRAP_TEST_DATABASE_URL;

test('research bootstrap tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicated) {
    console.log(
      'SKIP: set RESEARCH_BOOTSTRAP_TEST_DATABASE_URL to a dedicated empty test database to run bootstrap tests.'
    );
  }
  assert.ok(true);
});

if (dedicated) process.env.DATABASE_URL = dedicated;
const maybe = dedicated ? test : test.skip;

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

async function db(): Promise<Db> {
  const { getDb } = await import('./dbCore');
  return getDb();
}

/** Dedicated-DB gate: migrations applied and no ACTIVE run that could leak between tests. */
async function assertBootstrapDbReady(database: Db) {
  const table = await database.query(`SELECT to_regclass('research_bootstrap_runs') AS oid`);
  assert.ok(table.rows[0]?.oid, 'research_bootstrap_runs missing: run migrations against the dedicated test database');
  const runs = await database.query(
    `SELECT count(*)::int AS n FROM research_bootstrap_runs WHERE status='ACTIVE'`
  );
  assert.equal(Number(runs.rows[0]?.n || 0), 0, 'refusing database with an ACTIVE bootstrap run');
  const control = await database.query('SELECT * FROM research_control WHERE singleton=true');
  assert.ok(control.rows.length, 'research_control singleton must exist');
}

const POLICY_CONFIG_BASE = {
  totalProviderBudget: 1000,
  totalReviewBudget: 100,
  clusterCap: 2,
  curatedSearchFloor: 0,
  actionCaps: {},
};
/**
 * Per-test configuration. portfolio_policies enforces a UNIQUE
 * configuration_checksum, and policies persist in the dedicated database, so
 * every test mints a distinct (zero-weight, allocation-inert) program floor.
 */
function policyConfigFor(tag: string) {
  return { ...POLICY_CONFIG_BASE, programFloors: { [`test:bootstrap:${tag}`]: 0 } };
}

async function ensureProgram(database: Db, tag: string): Promise<string> {
  const row = await database.query(
    `INSERT INTO research_programs(program_key,name,root_concept,mode,lifecycle,policy_version,scope,owner,objective,coverage_definition)
     VALUES($1,$2,$3,'SHADOW','PAUSED','persistent-research-controller-v1',$4,$5,$6,$7)
     ON CONFLICT(program_key) DO NOTHING RETURNING id`,
    [
      `test-bootstrap-program:${tag}`,
      `Bootstrap test program ${tag}`,
      'trading strategies',
      JSON.stringify({}),
      'test:research-bootstrap',
      JSON.stringify({}),
      JSON.stringify({}),
    ]
  );
  if (row.rows[0]) return String(row.rows[0].id);
  const existing = await database.query(`SELECT id FROM research_programs WHERE program_key=$1`, [
    `test-bootstrap-program:${tag}`,
  ]);
  return String(existing.rows[0].id);
}

async function ensureProvider(database: Db) {
  await database.query(
    `INSERT INTO discovery_provider_registry(provider_key,provider_family,provider_kind,capabilities,quota_domain,mode,daily_cost_cap,updated_by)
     VALUES('youtube-search','youtube','RETRIEVAL','["SEARCH_YOUTUBE"]','youtube','ACTIVE',100000,'test:research-bootstrap')
     ON CONFLICT(provider_key) DO NOTHING`
  );
}

async function saveControl(database: Db) {
  return (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
}

async function restoreControl(database: Db, prev: Record<string, any>) {
  await database.query(
    `UPDATE research_control SET enabled=$1, mode=$2, paused=$3, kill_switch=$4,
      daily_provider_cost_cap=$5, daily_review_cost_cap=$6, max_actions_per_cycle=$7, active_policy_id=$8 WHERE singleton=true`,
    [
      prev.enabled,
      prev.mode,
      prev.paused,
      prev.kill_switch,
      prev.daily_provider_cost_cap,
      prev.daily_review_cost_cap,
      prev.max_actions_per_cycle,
      prev.active_policy_id,
    ]
  );
}

async function armCanaryControl(database: Db, policyId: string | null) {
  await database.query(
    `UPDATE research_control SET enabled=true, mode='CANARY', paused=false, kill_switch=false,
      daily_provider_cost_cap=100000, daily_review_cost_cap=100000, max_actions_per_cycle=5,
      active_policy_id=$1 WHERE singleton=true`,
    [policyId]
  );
}

/** Retires leftover fixture actions to a terminal lifecycle (never eligible for allocation). */
async function retireFixtureActions(database: Db, tag: string) {
  await database.query(
    `UPDATE discovery_actions SET lifecycle='EXPIRED' WHERE action_key LIKE $1 AND lifecycle IN('PROPOSED','ALLOCATED')`,
    [`test-bootstrap-action:${tag}:%`]
  );
}

maybe('bootstrap run lifecycle is singleton, bounded, and abortable', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `lifecycle:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-policy:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id,
    maxAssignments: 5,
    maxProviderCost: 500,
    windowHours: 24,
    reason: 'test lifecycle',
    actor: 'test:research-bootstrap',
  });
  // Guaranteed cleanup: a failed assertion below must not leave an ACTIVE run behind.
  t.after(async () => {
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test cleanup').catch(
      () => undefined
    );
  });
  assert.equal(run.status, 'ACTIVE');
  assert.equal(Number(run.max_assignments), 5);
  // A second ACTIVE run is rejected by the singleton guard.
  await assert.rejects(
    startResearchBootstrapRun({
      candidatePolicyId: policy.id,
      maxAssignments: 5,
      maxProviderCost: 500,
      windowHours: 24,
      reason: 'test duplicate',
      actor: 'test:research-bootstrap',
    }),
    /BOOTSTRAP_RUN_ALREADY_ACTIVE/
  );
  const aborted = await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test done');
  assert.ok(aborted);
  assert.equal(aborted?.status, 'ABORTED');
  assert.equal(aborted?.aborted_by, 'test:research-bootstrap');
  assert.equal(aborted?.abort_reason, 'test done');
});

maybe('bootstrap starter rejects paused candidates', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `paused-start:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-paused:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  await database.query(`UPDATE portfolio_policies SET status='PAUSED' WHERE id=$1`, [policy.id]);
  try {
    await assert.rejects(
      startResearchBootstrapRun({
        candidatePolicyId: policy.id,
        maxAssignments: 5,
        maxProviderCost: 500,
        windowHours: 24,
        reason: 'test paused candidate',
        actor: 'test:research-bootstrap',
      }),
      /BOOTSTRAP_CANDIDATE_PAUSED/
    );
    // No run was created, but guard the singleton either way.
    const active = await database.query(
      `SELECT count(*)::int AS n FROM research_bootstrap_runs WHERE status='ACTIVE'`
    );
    assert.equal(Number(active.rows[0]?.n || 0), 0);
  } finally {
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [policy.id]);
    const strays = await database.query(
      `SELECT id FROM research_bootstrap_runs WHERE status='ACTIVE'`
    );
    for (const stray of strays.rows) {
      await abortResearchBootstrapRun(stray.id, 'test:research-bootstrap', 'test cleanup');
    }
  }
});

maybe('bootstrap allocates boundedly and auto-completes at its ceiling', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `alloc:${Date.now()}:${process.pid}`;
  await ensureProvider(database);
  const programId = await ensureProgram(database, tag);
  const policy = await createPolicy({
    policyKey: `test-bootstrap-alloc:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const actionIds: string[] = [];
  for (let index = 0; index < 4; index++) {
    const action = await database.query(
      `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
       VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,100,1,0,'persistent-research-controller-v1',now()+interval '14 days') RETURNING id`,
      [
        `test-bootstrap-action:${tag}:${index}`,
        programId,
        `bootstrap probe ${tag} ${index}`,
        JSON.stringify({ country: 'US', intent: 'strategy' }),
        JSON.stringify({}),
        JSON.stringify(['test']),
        `bootstrap-cluster:${tag}:${index}`,
      ]
    );
    actionIds.push(String(action.rows[0].id));
  }
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id,
    maxAssignments: 2,
    maxProviderCost: 3000,
    windowHours: 24,
    reason: 'test bounded allocation',
    actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test cleanup').catch(
      () => undefined
    );
  });
  const prevControl = await saveControl(database);
  await armCanaryControl(database, policy.id);
  try {
    const { allocateBootstrapAssignments } = await import('./persistentResearchController');
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    const first = await allocateBootstrapAssignments(control, new Date().toISOString(), run.id);
    assert.equal(first.allocated, 2);
    assert.equal(first.selected, 2);
    assert.equal(first.choices.length, 2);
    assert.ok(first.providerReserved > 0);
    assert.equal(first.completed, true);
    assert.equal(first.bootstrapRunId, run.id);
    assert.equal(first.bootstrapPolicyId, policy.id);
    // Ceiling reached (2 of 2): run auto-completed.
    const status = (
      await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])
    ).rows[0];
    assert.equal(status.status, 'COMPLETED');
    // Allocated actions moved out of PROPOSED with bootstrap-marked assignments.
    const states = (
      await database.query('SELECT lifecycle, count(*)::int AS n FROM discovery_actions WHERE id = ANY($1::uuid[]) GROUP BY 1', [
        actionIds,
      ])
    ).rows as Array<{ lifecycle: string; n: number }>;
    assert.equal(
      states.filter(row => row.lifecycle === 'ALLOCATED').reduce((n, row) => n + Number(row.n), 0),
      2
    );
    const marked = await database.query(
      `SELECT count(*)::int AS n FROM discovery_action_assignments
       WHERE context_snapshot->>'bootstrapRunId'=$1 AND selected=true AND reason_codes::jsonb ? 'BOOTSTRAP_EVIDENCE_GATHERING'`,
      [run.id]
    );
    assert.equal(Number(marked.rows[0]?.n || 0), 2);
    // A terminal run is idempotent: further allocation returns zero work, never throws.
    const control2 = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    const again = await allocateBootstrapAssignments(control2, new Date().toISOString(), run.id);
    assert.equal(again.allocated, 0);
    assert.equal(again.selected, 0);
    assert.equal(again.completed, true);
  } finally {
    await restoreControl(database, prevControl);
    await retireFixtureActions(database, tag);
  }
});

maybe('bootstrap aborts when the candidate policy is paused or the window expires', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `abort:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-abort:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const prevControl = await saveControl(database);
  await armCanaryControl(database, policy.id);
  try {
    const { allocateBootstrapAssignments } = await import('./persistentResearchController');
    // Case 1: policy paused after the run started aborts the run without allocating.
    const pausedRun = await startResearchBootstrapRun({
      candidatePolicyId: policy.id,
      maxAssignments: 5,
      maxProviderCost: 500,
      windowHours: 24,
      reason: 'test paused mid-run',
      actor: 'test:research-bootstrap',
    });
    t.after(async () => {
      await abortResearchBootstrapRun(pausedRun.id, 'test:research-bootstrap', 'test cleanup').catch(
        () => undefined
      );
    });
    await database.query(`UPDATE portfolio_policies SET status='PAUSED' WHERE id=$1`, [policy.id]);
    const armed = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    const pausedResult = await allocateBootstrapAssignments(armed, new Date().toISOString(), pausedRun.id);
    assert.equal(pausedResult.allocated, 0);
    assert.equal(pausedResult.completed, true);
    const pausedStatus = (
      await database.query(
        'SELECT status,aborted_by,abort_reason FROM research_bootstrap_runs WHERE id=$1',
        [pausedRun.id]
      )
    ).rows[0];
    assert.equal(pausedStatus.status, 'ABORTED');
    assert.equal(pausedStatus.aborted_by, 'system:research-controller');
    assert.match(pausedStatus.abort_reason, /ineligible/);
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [policy.id]);

    // Case 2: an expired ACTIVE run aborts (never COMPLETED, never resumed).
    const expiredRun = await startResearchBootstrapRun({
      candidatePolicyId: policy.id,
      maxAssignments: 5,
      maxProviderCost: 500,
      windowHours: 1,
      reason: 'test expiry',
      actor: 'test:research-bootstrap',
    });
    t.after(async () => {
      await abortResearchBootstrapRun(expiredRun.id, 'test:research-bootstrap', 'test cleanup').catch(
        () => undefined
      );
    });
    await database.query(
      `UPDATE research_bootstrap_runs SET expires_at=now()-interval '1 minute' WHERE id=$1`,
      [expiredRun.id]
    );
    const armed2 = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    const expiredResult = await allocateBootstrapAssignments(armed2, new Date().toISOString(), expiredRun.id);
    assert.equal(expiredResult.allocated, 0);
    assert.equal(expiredResult.completed, true);
    const expiredStatus = (
      await database.query(
        'SELECT status,abort_reason FROM research_bootstrap_runs WHERE id=$1',
        [expiredRun.id]
      )
    ).rows[0];
    assert.equal(expiredStatus.status, 'ABORTED');
    assert.match(expiredStatus.abort_reason, /expired/);
  } finally {
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [policy.id]).catch(
      () => undefined
    );
    await restoreControl(database, prevControl);
  }
});

maybe('normal CANARY allocation still requires a PASS-backed policy', async t => {
  const { createPolicy } = await import('./portfolioAllocator');
  const { allocateCanonical } = await import('./persistentResearchController');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `canary-gate:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-canary-gate:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  // Promote to CANARY status directly (the governed transition requires a
  // PASS evaluation, which is exactly what this policy lacks) and prove the
  // PRODUCTION allocator still rejects it.
  await database.query(`UPDATE portfolio_policies SET status='CANARY' WHERE id=$1`, [policy.id]);
  const prevControl = await saveControl(database);
  await armCanaryControl(database, policy.id);
  try {
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    await assert.rejects(
      allocateCanonical(control, 'CANARY', new Date().toISOString()),
      /EVALUATED_CANARY_POLICY_REQUIRED/
    );
  } finally {
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [policy.id]);
    await restoreControl(database, prevControl);
  }
});
