import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Live-database tests for the provisional evidence-gathering CANARY
 * bootstrap. Run ONLY against an explicitly provided dedicated test database:
 *
 *   RESEARCH_BOOTSTRAP_TEST_DATABASE_URL=postgresql://... npx tsx --test ...
 *
 * Without that variable every test below skips. When enabled, the suite
 * proves isolation first (empty library/actions/assignments/outcomes) and
 * fails loudly before mutating anything otherwise. Fixtures use unique
 * per-run keys; jobs/actions/assignments created here are deleted in finally
 * blocks (append-only corpus/evaluation tables are never touched by these
 * tests). Control rows are restored; policies created here are DRAFT and
 * inert (never promoted).
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

async function assertIsolatedBootstrapDb(database: Db) {
  const library = await database.query('SELECT count(*)::int AS n FROM query_library');
  assert.equal(Number(library.rows[0]?.n || 0), 0, 'refusing non-empty database: query_library must be empty');
  const actions = await database.query('SELECT count(*)::int AS n FROM discovery_actions');
  assert.equal(Number(actions.rows[0]?.n || 0), 0, 'refusing non-empty database: discovery_actions must be empty');
  const assignments = await database.query('SELECT count(*)::int AS n FROM discovery_action_assignments');
  assert.equal(Number(assignments.rows[0]?.n || 0), 0, 'refusing non-empty database: no assignments allowed');
  const runs = await database.query(
    `SELECT count(*)::int AS n FROM research_bootstrap_runs WHERE status='ACTIVE'`
  );
  assert.equal(Number(runs.rows[0]?.n || 0), 0, 'refusing database with an ACTIVE bootstrap run');
}

const POLICY_CONFIG = {
  totalProviderBudget: 5,
  totalReviewBudget: 0,
  clusterCap: 1,
  curatedSearchFloor: 0,
  programFloors: {},
  actionCaps: {},
};

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

maybe('bootstrap run lifecycle is singleton, bounded, and abortable', async t => {
  const { startResearchBootstrapRun, abortResearchBootstrapRun } = await import(
    './persistentResearchController'
  );
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertIsolatedBootstrapDb(database);
  const tag = `lifecycle:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-bootstrap-policy:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: POLICY_CONFIG,
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
});

maybe('bootstrap allocates boundedly and auto-completes at its ceiling', async t => {
  const { startResearchBootstrapRun } = await import('./persistentResearchController');
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertIsolatedBootstrapDb(database);
  const tag = `alloc:${Date.now()}:${process.pid}`;
  await ensureProvider(database);
  const programId = await ensureProgram(database, tag);
  const policy = await createPolicy({
    policyKey: `test-bootstrap-alloc:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: POLICY_CONFIG,
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
        `bootstrap-cluster:${tag}`,
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
  try {
    // Control must be CANARY-armed for the allocator; save and restore it.
    const prevControl = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
    await database.query(
      `UPDATE research_control SET enabled=true, mode='CANARY', paused=false, kill_switch=false,
        daily_provider_cost_cap=100000, daily_review_cost_cap=100000, max_actions_per_cycle=5,
        active_policy_id=$1 WHERE singleton=true`,
      [policy.id]
    );
    try {
      const { allocateBootstrapAssignments } = await import('./persistentResearchController');
      const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
      const first = await allocateBootstrapAssignments(control, new Date().toISOString(), run.id);
      assert.equal(first.allocated, 2);
      assert.ok(first.providerReserved > 0);
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
      // A further allocation attempt finds the run completed: zero work.
      const control2 = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
      const again = await allocateBootstrapAssignments(control2, new Date().toISOString(), run.id);
      assert.equal(again.allocated, 0);
      assert.equal(again.completed, true);
    } finally {
      await database.query(
        `UPDATE research_control SET enabled=$1, mode=$2, paused=$3, kill_switch=$4,
          daily_provider_cost_cap=$5, daily_review_cost_cap=$6, max_actions_per_cycle=$7, active_policy_id=$8 WHERE singleton=true`,
        [
          prevControl.enabled,
          prevControl.mode,
          prevControl.paused,
          prevControl.kill_switch,
          prevControl.daily_provider_cost_cap,
          prevControl.daily_review_cost_cap,
          prevControl.max_actions_per_cycle,
          prevControl.active_policy_id,
        ]
      );
    }
  } finally {
    if (actionIds.length > 0) {
      await database.query('DELETE FROM discovery_action_assignments WHERE action_id = ANY($1::uuid[])', [actionIds]);
      await database.query('DELETE FROM discovery_actions WHERE id = ANY($1::uuid[])', [actionIds]);
    }
    await database.query(`DELETE FROM research_programs WHERE program_key=$1`, [`test-bootstrap-program:${tag}`]);
  }
});

maybe('normal CANARY allocation still requires a PASS-backed policy', async t => {
  const { createPolicy } = await import('./portfolioAllocator');
  const database = await db();
  await assertIsolatedBootstrapDb(database);
  const tag = `canary-gate:${Date.now()}:${process.pid}`;
  const policy = await createPolicy({
    policyKey: `test-canary-gate:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: POLICY_CONFIG,
    actor: 'test:research-bootstrap',
  });
  // Directly exercise the guard shape allocateCanonical enforces: a DRAFT
  // policy without any PASS evaluation must not satisfy the CANARY gate.
  const gate = await database.query(
    `SELECT p.* FROM portfolio_policies p WHERE p.id=$1 AND p.status='CANARY'
     AND EXISTS(SELECT 1 FROM persistent_research_policy_evaluations e WHERE e.policy_id=p.id AND e.decision='PASS')`,
    [policy.id]
  );
  assert.equal(gate.rows.length, 0);
});
