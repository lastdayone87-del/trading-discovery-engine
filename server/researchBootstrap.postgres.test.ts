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
  // Allocation selects from every PROPOSED action in the database, so any
  // leftover (interrupted test, manual data) would silently change what the
  // allocation assertions cover. Retired fixtures use EXPIRED; PROPOSED means
  // pollution: fail loudly instead of testing the wrong candidate pool.
  const proposed = await database.query(
    `SELECT count(*)::int AS n FROM discovery_actions WHERE lifecycle='PROPOSED'`
  );
  assert.equal(Number(proposed.rows[0]?.n || 0), 0, 'refusing database with PROPOSED actions: clear or retire leftovers first');
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
      daily_provider_cost_cap=$5, daily_review_cost_cap=$6, max_actions_per_cycle=$7, active_policy_id=$8,
      exploration_basis_points=$9, bootstrap_armed=false, bootstrap_run_id=NULL, bootstrap_armed_by=NULL,
      bootstrap_armed_reason=NULL, bootstrap_armed_at=NULL WHERE singleton=true`,
    [
      prev.enabled,
      prev.mode,
      prev.paused,
      prev.kill_switch,
      prev.daily_provider_cost_cap,
      prev.daily_review_cost_cap,
      prev.max_actions_per_cycle,
      prev.active_policy_id,
      prev.exploration_basis_points,
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

async function fundControlCaps(database: Db) {
  await database.query(
    `UPDATE research_control SET daily_provider_cost_cap=100000, daily_review_cost_cap=100000,
      max_actions_per_cycle=5, exploration_basis_points=0, active_policy_id=NULL WHERE singleton=true`
  );
}

async function armRun(
  configureBootstrapArming: (input: { runId: string; actor: string; reason: string }) => Promise<unknown>,
  runId: string
): Promise<void> {
  await configureBootstrapArming({ runId, actor: 'test:research-bootstrap', reason: 'test arm' });
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
  await fundControlCaps(database);
  try {
    const { allocateBootstrapAssignments, configureBootstrapArming } = await import(
      './persistentResearchController'
    );
    await armRun(configureBootstrapArming, run.id);
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
  await fundControlCaps(database);
  try {
    const { allocateBootstrapAssignments, configureBootstrapArming } = await import(
      './persistentResearchController'
    );
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
    // Arm while eligible, THEN pause: the allocator (not the arm) must observe
    // the mid-run ineligibility and abort without allocating.
    await armRun(configureBootstrapArming, pausedRun.id);
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
    // Arm while still valid, then simulate expiry without violating the
    // table CHECK (expires_at must stay within (starts_at, starts_at +
    // 30 days]): shift the whole window into the past.
    await armRun(configureBootstrapArming, expiredRun.id);
    await database.query(
      `UPDATE research_bootstrap_runs SET starts_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' WHERE id=$1`,
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

maybe('bootstrap arming is explicit, budgeted, and fenced', async t => {
  const { startResearchBootstrapRun, configureBootstrapArming, disarmBootstrapControl } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `arm:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-arm:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const prevControl = await saveControl(database);
  try {
    const run = await startResearchBootstrapRun({
      candidatePolicyId: policy.id,
      maxAssignments: 2,
      maxProviderCost: 500,
      windowHours: 24,
      reason: 'test arming',
      actor: 'test:research-bootstrap',
    });
    t.after(async () => {
      const { abortResearchBootstrapRun } = await import('./persistentResearchController');
      await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test cleanup').catch(
        () => undefined
      );
    });
    // Insufficient provider cap refuses without consuming the run.
    await assert.rejects(
      configureBootstrapArming({ runId: run.id, actor: 'test:research-bootstrap', reason: `test poor:${tag}` }),
      /BOOTSTRAP_ARM_INSUFFICIENT_BUDGET/
    );
    const stillActive = (
      await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])
    ).rows[0];
    assert.equal(stillActive.status, 'ACTIVE');
    // Fund the caps (budget setup, still disarmed) then arm.
    await database.query(
      `UPDATE research_control SET daily_provider_cost_cap=100000, daily_review_cost_cap=100000,
        max_actions_per_cycle=5, exploration_basis_points=0 WHERE singleton=true`
    );
    const armed = await configureBootstrapArming({
      runId: run.id,
      actor: 'test:research-bootstrap',
      reason: `test arm:${tag}`,
    });
    assert.equal(armed.enabled, true);
    assert.equal(armed.mode, 'CANARY');
    assert.equal(armed.paused, false);
    assert.equal(armed.kill_switch, false);
    assert.equal(armed.bootstrap_armed, true);
    assert.equal(String(armed.bootstrap_run_id), run.id);
    // Double arming conflicts.
    await assert.rejects(
      configureBootstrapArming({ runId: run.id, actor: 'test:research-bootstrap', reason: `test again:${tag}` }),
      /BOOTSTRAP_ARM_CONFLICT/
    );
    // Manual disarm aborts the run and returns control to dormant.
    const disarmed = await disarmBootstrapControl('test:research-bootstrap', `test disarm:${tag}`);
    assert.ok(disarmed);
    assert.equal(disarmed?.enabled, false);
    assert.equal(disarmed?.bootstrap_armed, false);
    const runStatus = (
      await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])
    ).rows[0];
    assert.equal(runStatus.status, 'ABORTED');
    // Configuration events audit the arm and the disarm — run-specific
    // reasons, so stale events from other runs cannot satisfy this.
    for (const reason of [`test arm:${tag}`, `test disarm:${tag}`]) {
      const events = await database.query(
        `SELECT configuration_version, reason FROM research_configuration_events WHERE actor='test:research-bootstrap' AND reason=$1`,
        [reason]
      );
      assert.equal(events.rows.length, 1, `exactly one event for ${reason}`);
    }
  } finally {
    await restoreControl(database, prevControl);
  }
});

maybe('control-plane CANARY arming also requires the latest evaluation to be PASS', async t => {
  const { configurePersistentResearch } = await import('./persistentResearch');
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `control-gate:${Date.now()}:${process.pid}`;
  const candidate = await createPolicy({
    policyKey: `test-control-gate:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  await database.query(`UPDATE portfolio_policies SET status='CANARY' WHERE id=$1`, [candidate.id]);
  const prevControl = await saveControl(database);
  try {
    async function tryArm() {
      const version = (
        await database.query('SELECT configuration_version FROM research_control WHERE singleton=true')
      ).rows[0].configuration_version;
      return configurePersistentResearch({
        expectedVersion: Number(version),
        enabled: true,
        mode: 'CANARY',
        paused: false,
        killSwitch: false,
        dailyProviderCostCap: 100000,
        dailyReviewCostCap: 100000,
        explorationBasisPoints: 2000,
        maxActionsPerCycle: 5,
        activePolicyId: candidate.id,
        actor: 'test:research-bootstrap',
        reason: 'test control latest gate',
      });
    }
    // No evaluation at all: refuses.
    await assert.rejects(tryArm(), /EVALUATED_CANARY_POLICY_REQUIRED/);
    // Stale PASS superseded by FAIL: refuses.
    await database.query(
      `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by,evaluated_at)
       VALUES($1,$2,$3,now()-interval '3 hours',now(),30,$4,'PASS',$5,$6,'test:research-bootstrap',now()-interval '2 hours')`,
      [
        `test-control-gate:${tag}:pass`,
        candidate.id,
        candidate.id,
        JSON.stringify({}),
        JSON.stringify([]),
        `test-checksum-${tag}-pass`,
      ]
    );
    await database.query(
      `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by,evaluated_at)
       VALUES($1,$2,$3,now()-interval '3 hours',now(),30,$4,'FAIL',$5,$6,'test:research-bootstrap',now()-interval '1 hour')`,
      [
        `test-control-gate:${tag}:fail`,
        candidate.id,
        candidate.id,
        JSON.stringify({}),
        JSON.stringify([]),
        `test-checksum-${tag}-fail`,
      ]
    );
    await assert.rejects(tryArm(), /EVALUATED_CANARY_POLICY_REQUIRED/);
    // Newer PASS restores eligibility.
    await database.query(
      `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by,evaluated_at)
       VALUES($1,$2,$3,now()-interval '3 hours',now(),30,$4,'PASS',$5,$6,'test:research-bootstrap',now())`,
      [
        `test-control-gate:${tag}:pass2`,
        candidate.id,
        candidate.id,
        JSON.stringify({}),
        JSON.stringify([]),
        `test-checksum-${tag}-pass2`,
      ]
    );
    const armed = await tryArm();
    assert.equal(armed.mode, 'CANARY');
  } finally {
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [candidate.id]);
    await restoreControl(database, prevControl);
  }
});

maybe('bootstrap allocation refuses without a fenced arm', async t => {
  const { startResearchBootstrapRun, allocateBootstrapAssignments } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `nofence:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-nofence:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const prevControl = await saveControl(database);
  // Fully armed-looking control but no fence: allocation must still refuse.
  await database.query(
    `UPDATE research_control SET enabled=true, mode='CANARY', paused=false, kill_switch=false,
      daily_provider_cost_cap=100000, daily_review_cost_cap=100000, max_actions_per_cycle=5,
      active_policy_id=NULL WHERE singleton=true`
  );
  const armedSnapshot = (
    await database.query('SELECT * FROM research_control WHERE singleton=true')
  ).rows[0];
  try {
    const run = await startResearchBootstrapRun({
      candidatePolicyId: policy.id,
      maxAssignments: 2,
      maxProviderCost: 500,
      windowHours: 24,
      reason: 'test unfenced allocation',
      actor: 'test:research-bootstrap',
    });
    try {
      const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
      const result = await allocateBootstrapAssignments(control, new Date().toISOString(), run.id);
      assert.equal(result.allocated, 0);
      assert.equal(result.completed, true);
      const status = (
        await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])
      ).rows[0];
      assert.equal(status.status, 'ABORTED');
      // The unrelated armed control must be exactly unchanged: no reset, no
      // version bump, no fence side effects.
      const afterControl = (
        await database.query('SELECT * FROM research_control WHERE singleton=true')
      ).rows[0];
      assert.deepEqual(
        { ...afterControl, updated_at: null },
        { ...armedSnapshot, updated_at: null },
        'normal CANARY control untouched by unfenced abort'
      );
    } finally {
      const { abortResearchBootstrapRun } = await import('./persistentResearchController');
      await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test cleanup').catch(
        () => undefined
      );
    }
  } finally {
    await restoreControl(database, prevControl);
  }
});

maybe('concurrent arm, allocate, and disarm serialize without deadlock', async t => {
  const { startResearchBootstrapRun, configureBootstrapArming, disarmBootstrapControl, allocateBootstrapAssignments } =
    await import('./persistentResearchController');
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `race:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-race:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  await ensureProvider(database);
  const programId = await ensureProgram(database, tag);
  for (let index = 0; index < 4; index++) {
    await database.query(
      `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
       VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,10,0,0,'persistent-research-controller-v1',now()+interval '14 days')`,
      [
        `test-bootstrap-action:${tag}:${index}`,
        programId,
        `race probe ${tag} ${index}`,
        JSON.stringify({ country: 'US', intent: 'strategy' }),
        JSON.stringify({}),
        JSON.stringify(['test']),
        `race-cluster:${tag}:${index}`,
      ]
    );
  }
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id,
    maxAssignments: 4,
    maxProviderCost: 1000,
    windowHours: 24,
    reason: `test race:${tag}`,
    actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    const { abortResearchBootstrapRun } = await import('./persistentResearchController');
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', `test cleanup:${tag}`).catch(
      () => undefined
    );
  });
  try {
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    const cutoff = new Date().toISOString();
    // Overlapping arm / allocate / disarm: lock order (control → run →
    // policy) must serialize them; no deadlock, no lost run.
    const outcomes = await Promise.allSettled([
      configureBootstrapArming({ runId: run.id, actor: 'test:research-bootstrap', reason: `test race-arm:${tag}` }),
      allocateBootstrapAssignments(control, cutoff, run.id),
      disarmBootstrapControl('test:research-bootstrap', `test race-disarm:${tag}`),
      allocateBootstrapAssignments(control, cutoff, run.id),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        assert.doesNotMatch(
          String(outcome.reason?.message || outcome.reason),
          /deadlock/i,
          'concurrent bootstrap operations must serialize, never deadlock'
        );
      }
    }
    // Coherent end state: either the run is terminal with the fence cleared,
    // or it is ACTIVE with the fence still bound to it and control armed.
    const endRun = (await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id]))
      .rows[0];
    const endControl = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    if (endRun.status === 'ACTIVE') {
      assert.equal(endControl.bootstrap_armed, true);
      assert.equal(String(endControl.bootstrap_run_id), run.id);
      assert.equal(endControl.enabled, true);
    } else {
      assert.equal(endControl.bootstrap_armed, false, 'terminal run must not hold an armed control');
    }
  } finally {
    await restoreControl(database, prevControl);
    await retireFixtureActions(database, tag);
  }
});

maybe('expired fence never authorizes canonical allocation from a stale snapshot', async t => {
  const { startResearchBootstrapRun, allocateResearch } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `stale:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-stale:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id,
    maxAssignments: 2,
    maxProviderCost: 500,
    windowHours: 1,
    reason: `test stale:${tag}`,
    actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    const { abortResearchBootstrapRun } = await import('./persistentResearchController');
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', `test cleanup:${tag}`).catch(
      () => undefined
    );
  });
  try {
    const { configureBootstrapArming } = await import('./persistentResearchController');
    await configureBootstrapArming({ runId: run.id, actor: 'test:research-bootstrap', reason: `test stale-arm:${tag}` });
    // Expire the window, then dispatch with a deliberately stale armed snapshot.
    await database.query(
      `UPDATE research_bootstrap_runs SET starts_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' WHERE id=$1`,
      [run.id]
    );
    const staleControl = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    assert.equal(staleControl.bootstrap_armed, true);
    const before = (
      await database.query('SELECT count(*)::int AS n FROM discovery_action_assignments')
    ).rows[0];
    const result = await allocateResearch(staleControl, 'CANARY', new Date().toISOString());
    assert.equal(result.selected, 0, 'no allocation after fence expiry');
    assert.equal((result.choices as unknown[]).length, 0, 'no candidates after fence expiry');
    const after = (
      await database.query('SELECT count(*)::int AS n FROM discovery_action_assignments')
    ).rows[0];
    assert.equal(Number(after.n), Number(before.n), 'no assignments created after fence expiry');
    const status = (
      await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])
    ).rows[0];
    assert.equal(status.status, 'ABORTED');
  } finally {
    await restoreControl(database, prevControl);
  }
});

maybe('allocation cannot commit against a concurrently paused candidate', async t => {
  const { startResearchBootstrapRun, configureBootstrapArming, allocateBootstrapAssignments } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const { getDb } = await import('./dbCore');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `pauserace:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-pauserace:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  await ensureProvider(database);
  const programId = await ensureProgram(database, tag);
  await database.query(
    `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
     VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,10,0,0,'persistent-research-controller-v1',now()+interval '14 days')`,
    [
      `test-bootstrap-action:${tag}:0`,
      programId,
      `pause race probe ${tag}`,
      JSON.stringify({ country: 'US', intent: 'strategy' }),
      JSON.stringify({}),
      JSON.stringify(['test']),
      `pauserace-cluster:${tag}`,
    ]
  );
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id,
    maxAssignments: 2,
    maxProviderCost: 500,
    windowHours: 24,
    reason: `test pauserace:${tag}`,
    actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    const { abortResearchBootstrapRun } = await import('./persistentResearchController');
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', `test cleanup:${tag}`).catch(
      () => undefined
    );
  });
  try {
    await configureBootstrapArming({ runId: run.id, actor: 'test:research-bootstrap', reason: `test pauserace-arm:${tag}` });
    // Hold the policy row lock and start allocation: it must block at the
    // policy lock (control → run → policy order) instead of racing ahead.
    const holder = await (await getDb()).connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT * FROM portfolio_policies WHERE id=$1 FOR UPDATE`, [policy.id]);
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    let settled = false;
    const pending = allocateBootstrapAssignments(control, new Date().toISOString(), run.id).then(
      result => {
        settled = true;
        return result;
      }
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(settled, false, 'allocator must wait on the held policy lock');
    // Pause and release atomically in the holder transaction: no interleaving
    // is possible between the release and the pause, so the allocator must
    // observe PAUSED and abort without allocating.
    await holder.query(`UPDATE portfolio_policies SET status='PAUSED' WHERE id=$1`, [policy.id]);
    await holder.query('COMMIT');
    holder.release();
    const result = await pending;
    assert.equal(result.allocated, 0, 'no allocation against a paused candidate');
    const status = (
      await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])
    ).rows[0];
    assert.equal(status.status, 'ABORTED');
    const assignments = await database.query(
      `SELECT count(*)::int AS n FROM discovery_action_assignments WHERE context_snapshot->>'bootstrapRunId'=$1 AND selected=true`,
      [run.id]
    );
    assert.equal(Number(assignments.rows[0]?.n || 0), 0, 'no selected assignments committed');
  } finally {
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [policy.id]).catch(
      () => undefined
    );
    await restoreControl(database, prevControl);
    await retireFixtureActions(database, tag);
  }
});

maybe('bootstrap termination never overwrites a newer normal configuration', async t => {
  const { startResearchBootstrapRun, configureBootstrapArming, allocateBootstrapAssignments, configurePersistentResearch } = await import(
    './persistentResearchController'
  ).then(async controller => ({ ...(controller as object), configurePersistentResearch: (await import('./persistentResearch')).configurePersistentResearch }) as typeof import('./persistentResearchController') & { configurePersistentResearch: typeof import('./persistentResearch').configurePersistentResearch });
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `versionfence:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-versionfence:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id,
    maxAssignments: 1,
    maxProviderCost: 500,
    windowHours: 24,
    reason: `test versionfence:${tag}`,
    actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    const { abortResearchBootstrapRun } = await import('./persistentResearchController');
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', `test cleanup:${tag}`).catch(
      () => undefined
    );
  });
  try {
    await configureBootstrapArming({ runId: run.id, actor: 'test:research-bootstrap', reason: `test versionfence-arm:${tag}` });
    // Operator installs a newer normal configuration (paused CANARY with new
    // caps): version advances, fence columns untouched by the governed route.
    const armed = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    await configurePersistentResearch({
      expectedVersion: Number(armed.configuration_version),
      enabled: true,
      mode: 'CANARY',
      paused: true,
      killSwitch: true,
      dailyProviderCostCap: 424242,
      dailyReviewCostCap: 434343,
      explorationBasisPoints: 2000,
      maxActionsPerCycle: 5,
      actor: 'test:research-bootstrap',
      reason: `test versionfence-reconfigure:${tag}`,
    });
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    const result = await allocateBootstrapAssignments(control, new Date().toISOString(), run.id);
    assert.equal(result.allocated, 0);
    const status = (
      await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])
    ).rows[0];
    assert.equal(status.status, 'ABORTED');
    const after = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    // Newer operator configuration preserved exactly; only the stale fence clears.
    assert.equal(after.paused, true, 'operator pause preserved');
    assert.equal(Number(after.daily_provider_cost_cap), 424242, 'operator caps preserved');
    assert.equal(Number(after.daily_review_cost_cap), 434343, 'operator review caps preserved');
    assert.equal(after.bootstrap_armed, false, 'stale fence cleared');
    assert.equal(after.bootstrap_run_id, null);
  } finally {
    await restoreControl(database, prevControl);
  }
});

maybe('materialization stops when the control is not serving', async t => {
  const { materializePlaylists, materializeFeaturedChannels } = await import(
    './persistentResearchController'
  );
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `matgate:${Date.now()}:${process.pid}`;
  await ensureProvider(database);
  const programId = await ensureProgram(database, tag);
  const actionId = String(
    (
      await database.query(
        `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
         VALUES($1,$2,'INSPECT_PLAYLIST','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,10,0,0,'persistent-research-controller-v1',now()+interval '14 days') RETURNING id`,
        [
          `test-matgate-action:${tag}`,
          programId,
          `matgate probe ${tag}`,
          JSON.stringify({ country: 'US', intent: 'strategy' }),
          JSON.stringify({}),
          JSON.stringify(['test']),
          `matgate-cluster:${tag}`,
        ]
      )
    ).rows[0].id
  );
  // Allocate it without provenance that could enqueue (missing frontier
  // action/country): even an armed control must not reach the provider here.
  await database.query(`UPDATE discovery_actions SET lifecycle='ALLOCATED' WHERE id=$1`, [actionId]);
  try {
    const prevControl = await saveControl(database);
    try {
      // Dormant control: materializers must return 0 without touching state.
      const playlists = await materializePlaylists(new Date().toISOString());
      assert.equal(playlists, 0);
      const featured = await materializeFeaturedChannels(new Date().toISOString());
      assert.equal(featured, 0);
      const lifecycle = (
        await database.query('SELECT lifecycle FROM discovery_actions WHERE id=$1', [actionId])
      ).rows[0];
      assert.equal(lifecycle.lifecycle, 'ALLOCATED', 'no state change while disarmed');
    } finally {
      await restoreControl(database, prevControl);
    }
  } finally {
    await database.query(`UPDATE discovery_actions SET lifecycle='EXPIRED' WHERE id=$1`, [actionId]);
  }
});

maybe('CANARY allocation requires latest evaluation PASS with baseline (stale PASS refused)', async t => {
  const { createPolicy } = await import('./portfolioAllocator');
  const { allocateCanonical } = await import('./persistentResearchController');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `alloc-latest:${Date.now()}:${process.pid}`;
  const candidate = await createPolicy({
    policyKey: `test-alloc-latest:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const baseline = await createPolicy({
    policyKey: `test-alloc-latest-base:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(`base:${tag}`),
    actor: 'test:research-bootstrap',
  });
  await database.query(`UPDATE portfolio_policies SET status='CANARY' WHERE id=$1`, [candidate.id]);
  const prevControl = await saveControl(database);
  await armCanaryControl(database, candidate.id);
  try {
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    // Stale PASS superseded by FAIL must refuse allocation even though a PASS exists.
    await database.query(
      `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by,evaluated_at) VALUES($1,$2,$3,now()-interval '3 hours',now(),30,$4,'PASS',$5,$6,'test:research-bootstrap',now()-interval '2 hours')`,
      [`test-alloc-latest:${tag}:pass`, candidate.id, baseline.id, JSON.stringify({}), JSON.stringify([]), `cs-${tag}-pass`]
    );
    await database.query(
      `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by,evaluated_at) VALUES($1,$2,$3,now()-interval '3 hours',now(),30,$4,'FAIL',$5,$6,'test:research-bootstrap',now()-interval '1 hour')`,
      [`test-alloc-latest:${tag}:fail`, candidate.id, baseline.id, JSON.stringify({}), JSON.stringify([]), `cs-${tag}-fail`]
    );
    await assert.rejects(allocateCanonical(control, 'CANARY', new Date().toISOString()), /EVALUATED_CANARY_POLICY_REQUIRED/);
    // Newer PASS restores allocation eligibility.
    await database.query(
      `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by,evaluated_at) VALUES($1,$2,$3,now()-interval '3 hours',now(),30,$4,'PASS',$5,$6,'test:research-bootstrap',now())`,
      [`test-alloc-latest:${tag}:pass2`, candidate.id, baseline.id, JSON.stringify({}), JSON.stringify([]), `cs-${tag}-pass2`]
    );
    const ok = await allocateCanonical(control, 'CANARY', new Date().toISOString());
    assert.equal(ok.policyId, candidate.id);
  } finally {
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [candidate.id]);
    await restoreControl(database, prevControl);
  }
});

maybe('control lease is not stealable by a concurrent same-owner cycle', async t => {
  const { acquireLease, releaseLease } = await import('./persistentResearchController');
  const database = await db();
  await assertBootstrapDbReady(database);
  const owner = `test-lease-owner:${Date.now()}:${process.pid}`;
  const first = await acquireLease(owner, 120);
  assert.ok(first, 'first acquire holds the lease');
  try {
    // Same owner re-request while the lease is live must fail closed: the
    // previous holder keeps its token and overlapping cycles cannot start.
    assert.equal(await acquireLease(owner, 120), null);
    assert.equal(await acquireLease(`${owner}:other`, 120), null);
  } finally {
    await releaseLease(first as string, { test: 'lease-steal' });
  }
  const after = await acquireLease(`${owner}:other`, 120);
  assert.ok(after, 'lease acquirable after release');
  await releaseLease(after as string, { test: 'lease-steal' });
});

maybe('ceiling completion defers disarm until the batch materializes, then settles without orphans', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun, allocateBootstrapAssignments, configureBootstrapArming, settleCeilingBootstrap } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `ceiling-settle:${Date.now()}:${process.pid}`;
  await ensureProvider(database);
  const programId = await ensureProgram(database, tag);
  const policy = await createPolicy({
    policyKey: `test-ceiling-settle:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  for (let index = 0; index < 2; index++) {
    await database.query(
      `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
       VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,100,1,0,'persistent-research-controller-v1',now()+interval '14 days')`,
      [
        `test-bootstrap-action:${tag}:${index}`,
        programId,
        `ceiling settle probe ${tag} ${index}`,
        JSON.stringify({ country: 'US', intent: 'strategy' }),
        JSON.stringify({}),
        JSON.stringify(['test']),
        `ceiling-settle-cluster:${tag}:${index}`,
      ]
    );
  }
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id,
    maxAssignments: 2,
    maxProviderCost: 3000,
    windowHours: 24,
    reason: 'test ceiling settle',
    actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test cleanup').catch(() => undefined);
  });
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  try {
    await armRun(configureBootstrapArming, run.id);
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    const result = await allocateBootstrapAssignments(control, new Date().toISOString(), run.id);
    assert.equal(result.allocated, 2);
    assert.equal(result.completed, true);
    // Disarm is deferred: the fence is still held so materializers stay serving.
    const fenced = (await database.query('SELECT bootstrap_armed, bootstrap_run_id FROM research_control WHERE singleton=true')).rows[0];
    assert.equal(fenced.bootstrap_armed, true);
    assert.equal(String(fenced.bootstrap_run_id), run.id);
    // Settle (as runPersistentResearchCycle does after materialization):
    // leftovers re-enter the pool, fence releases, newer config untouched.
    await settleCeilingBootstrap(run.id, true);
    const states = (
      await database.query(`SELECT lifecycle, count(*)::int AS n FROM discovery_actions WHERE action_key LIKE $1 GROUP BY 1`, [`test-bootstrap-action:${tag}:%`])
    ).rows as Array<{ lifecycle: string; n: number }>;
    assert.equal(states.filter(row => row.lifecycle === 'ALLOCATED').reduce((n, row) => n + Number(row.n), 0), 0);
    assert.equal(states.filter(row => row.lifecycle === 'EXPIRED').reduce((n, row) => n + Number(row.n), 0), 2);
    const released = (await database.query('SELECT bootstrap_armed FROM research_control WHERE singleton=true')).rows[0];
    assert.equal(released.bootstrap_armed, false);
  } finally {
    await restoreControl(database, prevControl);
    await retireFixtureActions(database, tag);
  }
});

maybe('allocation from a stale control snapshot cannot authorize CANARY work', async t => {
  const { createPolicy } = await import('./portfolioAllocator');
  const { allocateCanonical } = await import('./persistentResearchController');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `stale-ctrl:${Date.now()}:${process.pid}`;
  const candidate = await createPolicy({
    policyKey: `test-stale-ctrl:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const baseline = await createPolicy({
    policyKey: `test-stale-ctrl-base:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(`base:${tag}`),
    actor: 'test:research-bootstrap',
  });
  await database.query(`UPDATE portfolio_policies SET status='CANARY' WHERE id=$1`, [candidate.id]);
  await database.query(
    `INSERT INTO persistent_research_policy_evaluations(evaluation_key,policy_id,baseline_policy_id,evaluation_window_start,dataset_cutoff,minimum_assignments,metrics,decision,reason_codes,artifact_checksum,evaluated_by,evaluated_at) VALUES($1,$2,$3,now()-interval '3 hours',now(),30,$4,'PASS',$5,$6,'test:research-bootstrap',now()-interval '1 hour')`,
    [`test-stale-ctrl:${tag}:pass`, candidate.id, baseline.id, JSON.stringify({}), JSON.stringify([]), `cs-${tag}`]
  );
  const prevControl = await saveControl(database);
  await armCanaryControl(database, candidate.id);
  const staleSnapshot = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
  try {
    // Concurrent operator pause lands after the snapshot was taken (any governed
    // mutation bumps configuration_version, so the stale snapshot is detected).
    await database.query(`UPDATE research_control SET paused=true, configuration_version=configuration_version+1 WHERE singleton=true`);
    await assert.rejects(
      allocateCanonical(staleSnapshot, 'CANARY', new Date().toISOString()),
      /RESEARCH_CONTROL_STALE/
    );
    // Configuration drift (any concurrent reconfig) is also fail-closed.
    await database.query(`UPDATE research_control SET paused=false, daily_provider_cost_cap=1, configuration_version=configuration_version+1 WHERE singleton=true`);
    await assert.rejects(
      allocateCanonical(staleSnapshot, 'CANARY', new Date().toISOString()),
      /RESEARCH_CONTROL_STALE/
    );
  } finally {
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [candidate.id]);
    await restoreControl(database, prevControl);
  }
});

maybe('stale settlement for a terminal run never disarms a newer armed run', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun, configureBootstrapArming, settleCeilingBootstrap } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `stalesettle:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-stale-settle:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const runA = await startResearchBootstrapRun({
    candidatePolicyId: policy.id, maxAssignments: 2, maxProviderCost: 3000, windowHours: 24,
    reason: 'test stale settle A', actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    await abortResearchBootstrapRun(runA.id, 'test:research-bootstrap', 'test cleanup').catch(() => undefined);
  });
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  let runBId: string | null = null;
  try {
    await armRun(configureBootstrapArming, runA.id);
    // A reaches a terminal state and releases the fence through the normal path.
    await abortResearchBootstrapRun(runA.id, 'test:research-bootstrap', 'test terminate A');
    // B arms on the released control.
    runBId = String((await startResearchBootstrapRun({
      candidatePolicyId: policy.id, maxAssignments: 2, maxProviderCost: 3000, windowHours: 24,
      reason: 'test stale settle B', actor: 'test:research-bootstrap',
    })).id);
    await armRun(configureBootstrapArming, runBId as string);
    // A late/duplicate settlement for terminal A executes after B armed.
    const settled = await settleCeilingBootstrap(runA.id, true);
    assert.equal(settled, false, 'stale settlement must not act on another run fence');
    const fence = (await database.query('SELECT bootstrap_armed, bootstrap_run_id FROM research_control WHERE singleton=true')).rows[0];
    assert.equal(fence.bootstrap_armed, true, 'B fence must remain armed');
    assert.equal(String(fence.bootstrap_run_id), runBId as string, 'fence must still belong to B');
    assert.equal((await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [runBId])).rows[0].status, 'ACTIVE', 'B must remain ACTIVE');
  } finally {
    if (runBId) await abortResearchBootstrapRun(runBId, 'test:research-bootstrap', 'test cleanup').catch(() => undefined);
    await restoreControl(database, prevControl);
  }
});

maybe('bootstrap materialization stops once bootstrap authority is lost', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun, configureBootstrapArming, allocateBootstrapAssignments, disarmBootstrapControl, materializeCycleBatch } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `matrace:${Date.now()}:${process.pid}`;
  await ensureProvider(database);
  const programId = await ensureProgram(database, tag);
  const policy = await createPolicy({
    policyKey: `test-mat-race:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  await database.query(
    `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
     VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,100,1,0,'persistent-research-controller-v1',now()+interval '14 days')`,
    [
      `test-bootstrap-action:${tag}:0`,
      programId,
      `mat race probe ${tag}`,
      JSON.stringify({ country: 'US', intent: 'strategy' }),
      JSON.stringify({}),
      JSON.stringify(['test']),
      `mat-race-cluster:${tag}`,
    ]
  );
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id, maxAssignments: 5, maxProviderCost: 5000, windowHours: 24,
    reason: 'test mat race', actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test cleanup').catch(() => undefined);
  });
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  try {
    await armRun(configureBootstrapArming, run.id);
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    const alloc = await allocateBootstrapAssignments(control, new Date().toISOString(), run.id);
    assert.equal(alloc.allocated, 1);
    // Authority held: batch materialization runs (nothing consumable here, zeros, no provider work).
    const held = await materializeCycleBatch({ bootstrapRunId: run.id, cutoff: new Date().toISOString() });
    assert.deepEqual(held, { materialized: 0, featuredMaterialized: 0, corpusMaterialized: 0, externalMaterialized: 0 });
    // Authority lost mid-flight: nothing may begin afterwards.
    await disarmBootstrapControl('test:research-bootstrap', 'test race disarm');
    const lost = await materializeCycleBatch({ bootstrapRunId: run.id, cutoff: new Date().toISOString() });
    assert.deepEqual(lost, { materialized: 0, featuredMaterialized: 0, corpusMaterialized: 0, externalMaterialized: 0 });
    const lifecycle = (await database.query(`SELECT lifecycle FROM discovery_actions WHERE action_key=$1`, [`test-bootstrap-action:${tag}:0`])).rows[0];
    assert.equal(lifecycle.lifecycle, 'ALLOCATED', 'no bootstrap-owned work continues after authority loss');
  } finally {
    await restoreControl(database, prevControl);
    await retireFixtureActions(database, tag);
  }
});

maybe('disarm cannot commit while a bootstrap materialization holds authority', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun, configureBootstrapArming, disarmBootstrapControl } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const { getDb } = await import('./dbCore');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `lockrace:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-lock-race:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id, maxAssignments: 2, maxProviderCost: 3000, windowHours: 24,
    reason: 'test lock race', actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test cleanup').catch(() => undefined);
  });
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  const pool = await getDb();
  const holder = await pool.connect();
  try {
    await armRun(configureBootstrapArming, run.id);
    // Simulate a materialization row holding bootstrap authority: lock the
    // control row exactly as holdBootstrapRowAuthority does, then race a real
    // disarm against it. The disarm must block until authority is released,
    // so a check-then-disarm-then-enqueue interleaving cannot commit.
    await holder.query('BEGIN');
    await holder.query(`SELECT * FROM research_control WHERE singleton=true FOR UPDATE`);
    let disarmed = false;
    const racing = disarmBootstrapControl('test:research-bootstrap', 'test racing disarm').then(
      result => { disarmed = true; return result; }
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(disarmed, false, 'disarm must block while row authority is held');
    await holder.query('ROLLBACK');
    const released = await racing;
    assert.equal(disarmed, true, 'disarm proceeds once authority is released');
    assert.ok(released, 'disarm commits after the holder releases');
    const fence = (await database.query('SELECT bootstrap_armed FROM research_control WHERE singleton=true')).rows[0];
    assert.equal(fence.bootstrap_armed, false);
  } finally {
    try { await holder.query('ROLLBACK'); } catch { /* already settled */ }
    holder.release();
    await restoreControl(database, prevControl);
  }
});

maybe('terminal settlement failure cannot report a clean completed cycle', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun, configureBootstrapArming, runPersistentResearchCycle } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertBootstrapDbReady(database);
  const tag = `settlefail:${Date.now()}:${process.pid}`;
  await ensureProvider(database);
  const programId = await ensureProgram(database, tag);
  const policy = await createPolicy({
    policyKey: `test-settle-fail:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: policyConfigFor(tag),
    actor: 'test:research-bootstrap',
  });
  await database.query(
    `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
     VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,1,1,1,0.5,100,1,0,'persistent-research-controller-v1',now()+interval '14 days')`,
    [
      `test-bootstrap-action:${tag}:0`,
      programId,
      `settle fail probe ${tag}`,
      JSON.stringify({ country: 'US', intent: 'strategy' }),
      JSON.stringify({}),
      JSON.stringify(['test']),
      `settle-fail-cluster:${tag}`,
    ]
  );
  const run = await startResearchBootstrapRun({
    candidatePolicyId: policy.id, maxAssignments: 1, maxProviderCost: 5000, windowHours: 24,
    reason: 'test settle fail', actor: 'test:research-bootstrap',
  });
  t.after(async () => {
    await abortResearchBootstrapRun(run.id, 'test:research-bootstrap', 'test cleanup').catch(() => undefined);
  });
  const prevControl = await saveControl(database);
  await fundControlCaps(database);
  const owner = `test-settle-fail:${tag}`;
  try {
    await armRun(configureBootstrapArming, run.id);
    // Force terminal settlement to fail: settling retires the untouched
    // ceiling batch to EXPIRED, so a temporary CHECK ban on that transition
    // makes the settlement transaction abort. Nothing else in the cycle
    // writes EXPIRED, so only the settlement step can trip this.
    await database.query(`ALTER TABLE discovery_actions DROP CONSTRAINT IF EXISTS test_settle_fail_ck`);
    await database.query(`ALTER TABLE discovery_actions ADD CONSTRAINT test_settle_fail_ck CHECK (lifecycle <> 'EXPIRED')`);
    await assert.rejects(
      runPersistentResearchCycle(owner, new Date().toISOString()),
      /check constraint/i
    );
    // The cycle must not report clean completion with an uncleared fence.
    const cycle = (
      await database.query(`SELECT status FROM persistent_research_cycles WHERE lease_owner=$1 ORDER BY started_at DESC LIMIT 1`, [owner])
    ).rows[0];
    assert.equal(cycle.status, 'FAILED', 'settlement failure must fail the cycle, not complete it');
    const fence = (await database.query('SELECT bootstrap_armed, bootstrap_run_id FROM research_control WHERE singleton=true')).rows[0];
    assert.equal(fence.bootstrap_armed, true, 'uncleaned fence must stay visible, not silently dropped');
    assert.equal(String(fence.bootstrap_run_id), run.id);
    assert.equal((await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])).rows[0].status, 'COMPLETED');
  } finally {
    await database.query(`ALTER TABLE discovery_actions DROP CONSTRAINT IF EXISTS test_settle_fail_ck`);
    await restoreControl(database, prevControl);
    await retireFixtureActions(database, tag);
  }
});
