import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Isolated end-to-end validation of the provisional research-bootstrap
 * lifecycle against a fresh PostgreSQL database:
 *
 *   bootstrap creation → bounded allocation (2 runs × 30) → real cycle driver
 *   → outcomes → effective samples → policy evaluation (genuine PASS) →
 *   promotion attempt (fail-closed on main) → normal CANARY operation.
 *
 * Run ONLY with an explicitly provided dedicated test database:
 *
 *   RESEARCH_E2E_TEST_DATABASE_URL=postgresql://... npx tsx --test server/researchBootstrap.e2e.postgres.test.ts
 *
 * Without that variable the suite skips. It never touches production: all
 * fixtures use unique keys in the isolated database.
 *
 * Controlled boundary (clearly identified): provider NETWORK execution is NOT
 * exercised — no test credentials exist and production quota must never be
 * spent. Instead PROPOSED actions are seeded directly with realistic costs
 * (provider 100 / review 0, SEARCH_YOUTUBE via an ACTIVE registry provider in
 * a serving mode), and outcomes flow through the REAL ingestion path
 * (recordDiscoveryOutcome). Everything downstream of that boundary —
 * allocation math, cycle orchestration, usage accounting, evaluator
 * statistics (unmodified ≥30 gate), promotion gates, canonical CANARY
 * allocation — runs as production code.
 *
 * Data design (no gate weakening): 30 high-yield + 30 low-yield actions.
 * The candidate replay selects exactly the 30 high-yield actions
 * (deterministic utility order + exact budget); the baseline replay selects
 * all 60. Every allocated action receives ≥1 outcome row through the real
 * ingestion path, so support is genuine logged behavior, not fabrication.
 */
const dedicated = process.env.RESEARCH_E2E_TEST_DATABASE_URL;

test('research bootstrap E2E requires a dedicated database (skipped otherwise)', () => {
  if (!dedicated) {
    console.log(
      'SKIP: set RESEARCH_E2E_TEST_DATABASE_URL to a dedicated empty test database to run the bootstrap E2E.'
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

const CANDIDATE_CONFIG = {
  totalProviderBudget: 3000,
  totalReviewBudget: 0,
  clusterCap: 100,
  curatedSearchFloor: 0,
  programFloors: {},
  actionCaps: { SEARCH_YOUTUBE: 100 },
  explorationBasisPoints: 0,
};

const BASELINE_CONFIG = {
  totalProviderBudget: 10000,
  totalReviewBudget: 0,
  clusterCap: 100,
  curatedSearchFloor: 0,
  programFloors: {},
  actionCaps: { SEARCH_YOUTUBE: 100 },
  explorationBasisPoints: 0,
};

maybe('bootstrap-to-CANARY lifecycle works end to end on isolated infrastructure', async () => {
  const database = await db();
  const {
    startResearchBootstrapRun,
    runPersistentResearchCycle,
    evaluatePersistentResearchPolicy,
    allocateCanonical,
  } = await import('./persistentResearchController');
  const { createPolicy, transitionPolicy } = await import('./portfolioAllocator');
  const { recordDiscoveryOutcome } = await import('./persistentResearch');
  const tag = `e2e:${Date.now()}:${process.pid}`;

  // ---- Stage 0: isolated gate + control plane setup (test-harness only). ----
  const table = await database.query(`SELECT to_regclass('research_bootstrap_runs') AS oid`);
  assert.ok(table.rows[0]?.oid, 'migrations must be applied to the dedicated test database');
  const preActive = await database.query(
    `SELECT count(*)::int AS n FROM research_bootstrap_runs WHERE status='ACTIVE'`
  );
  assert.equal(Number(preActive.rows[0]?.n || 0), 0, 'dedicated DB must start with no ACTIVE run');
  await database.query(
    `INSERT INTO discovery_provider_registry(provider_key,provider_family,provider_kind,capabilities,quota_domain,mode,daily_cost_cap,updated_by)
     VALUES('youtube-search','youtube','RETRIEVAL','[\"SEARCH_YOUTUBE\"]','youtube','ACTIVE',0,'test:research-e2e')
     ON CONFLICT(provider_key) DO NOTHING`
  );
  const programId = String(
    (
      await database.query(
        `INSERT INTO research_programs(program_key,name,root_concept,mode,lifecycle,policy_version,scope,owner,objective,coverage_definition)
         VALUES($1,$2,$3,'SHADOW','PAUSED','persistent-research-controller-v1',$4,$5,$6,$7)
         ON CONFLICT(program_key) DO NOTHING RETURNING id`,
        [
          `test-e2e-program:${tag}`,
          `E2E program ${tag}`,
          'trading strategies',
          JSON.stringify({}),
          'test:research-e2e',
          JSON.stringify({}),
          JSON.stringify({}),
        ]
      )
    ).rows[0]?.id ||
      (
        await database.query(`SELECT id FROM research_programs WHERE program_key=$1`, [
          `test-e2e-program:${tag}`,
        ])
      ).rows[0].id
  );
  await database.query(
    `UPDATE research_control SET enabled=true, mode='CANARY', paused=false, kill_switch=false,
      daily_provider_cost_cap=100000, daily_review_cost_cap=100000,
      exploration_basis_points=0, max_actions_per_cycle=5, active_policy_id=NULL WHERE singleton=true`
  );

  // ---- Stage 1: candidate + baseline policies (both predate the window). ----
  const candidate = await createPolicy({
    policyKey: `test-e2e-candidate:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: { ...CANDIDATE_CONFIG, programFloors: { [`test:e2e:candidate:${tag}`]: 0 } },
    actor: 'test:research-e2e',
  });
  const baseline = await createPolicy({
    policyKey: `test-e2e-baseline:${tag}`,
    policyType: 'CONTEXTUAL_BANDIT',
    configuration: { ...BASELINE_CONFIG, programFloors: { [`test:e2e:baseline:${tag}`]: 0 } },
    actor: 'test:research-e2e',
  });
  const windowStart = new Date().toISOString();

  // ---- Stage 2: seed 30 high-yield + 30 low-yield PROPOSED actions. ----
  // Controlled provider-generation boundary (see header): realistic action
  // rows; the network call itself is not exercised.
  const highIds: string[] = [];
  const lowIds: string[] = [];
  for (let index = 0; index < 60; index++) {
    const high = index < 30;
    const row = await database.query(
      `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
       VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,$8,$8,$8,0.5,100,0,0,'persistent-research-controller-v1',now()+interval '14 days') RETURNING id`,
      [
        `test-e2e-action:${tag}:${index}`,
        programId,
        `e2e probe ${tag} ${index}`,
        JSON.stringify({ country: 'US', language: 'en', intent: 'strategy' }),
        JSON.stringify({}),
        JSON.stringify(['test']),
        `e2e-cluster:${tag}:${index}`,
        high ? 10 : 0.1,
      ]
    );
    (high ? highIds : lowIds).push(String(row.rows[0].id));
  }

  // ---- Stage 3: two bounded bootstrap runs via the REAL cycle driver. ----
  async function assignmentsOf(runId: string): Promise<Array<{ id: string; action_id: string }>> {
    return (
      await database.query(
        `SELECT id, action_id FROM discovery_action_assignments WHERE context_snapshot->>'bootstrapRunId'=$1 AND selected=true`,
        [runId]
      )
    ).rows as Array<{ id: string; action_id: string }>;
  }
  const highSet = new Set(highIds);
  for (let runIndex = 0; runIndex < 2; runIndex++) {
    const run = await startResearchBootstrapRun({
      candidatePolicyId: candidate.id,
      maxAssignments: 30,
      maxProviderCost: 3000,
      windowHours: 24,
      reason: `test e2e run ${runIndex}`,
      actor: 'test:research-e2e',
    });
    assert.equal(run.status, 'ACTIVE');
    for (let cycle = 0; cycle < 6; cycle++) {
      const result = await runPersistentResearchCycle(
        `test-e2e:${tag}:r${runIndex}c${cycle}`,
        new Date().toISOString()
      );
      assert.equal(result.status, 'COMPLETED', `cycle r${runIndex}c${cycle} must complete`);
    }
    const got = await assignmentsOf(run.id);
    assert.equal(got.length, 30, `run ${runIndex} must allocate exactly its 30-action ceiling`);
    const status = (
      await database.query('SELECT status FROM research_bootstrap_runs WHERE id=$1', [run.id])
    ).rows[0];
    assert.equal(status.status, 'COMPLETED', `run ${runIndex} must auto-complete at its ceiling`);
    // Genuine outcomes through the real ingestion path: high-yield actions
    // earn incremental rewards, low-yield actions log non-incremental evidence.
    let outcomeSeq = 0;
    for (const assignment of got) {
      const outcomes = highSet.has(String(assignment.action_id))
        ? [
            { type: 'UNIQUE_ENTITY', incremental: true },
            { type: 'QUALITY_CREATOR', incremental: true },
          ]
        : [{ type: 'KNOWN_ENTITY', incremental: false }];
      for (const outcome of outcomes) {
        await recordDiscoveryOutcome({
          outcomeKey: `test-e2e-outcome:${tag}:r${runIndex}:${outcomeSeq++}`,
          actionId: String(assignment.action_id),
          assignmentId: String(assignment.id),
          outcomeType: outcome.type,
          incremental: outcome.incremental,
          providerCost: 0,
          reviewCost: 0,
          evidence: { e2e: true, run: runIndex },
          observedAt: new Date().toISOString(),
        });
      }
    }
  }
  const cutoff = new Date().toISOString();

  // ---- Stage 4: lifecycle integrity (cycles attributed to the candidate). ----
  const attributed = await database.query(
    `SELECT count(*)::int AS n FROM persistent_research_cycles WHERE policy_id=$1 AND status='COMPLETED'`,
    [candidate.id]
  );
  assert.ok(
    Number(attributed.rows[0]?.n || 0) >= 12,
    'all 12 bootstrap cycles must be attributed to the candidate policy'
  );

  // ---- Stage 5: genuine policy evaluation (unmodified ≥30 gate). ----
  const evaluation = await evaluatePersistentResearchPolicy({
    policyId: candidate.id,
    baselinePolicyId: baseline.id,
    evaluationWindowStart: windowStart,
    datasetCutoff: cutoff,
    minimumAssignments: 30,
    actor: 'test:research-e2e',
  });
  const metrics = (evaluation as { metrics?: { candidate?: { effectiveSampleSize?: number }; baseline?: { effectiveSampleSize?: number } } }).metrics;
  console.log(
    `E2E evaluation decision=${(evaluation as { decision?: string }).decision} ` +
      `candidateN=${metrics?.candidate?.effectiveSampleSize} baselineN=${metrics?.baseline?.effectiveSampleSize}`
  );
  assert.equal((evaluation as { decision?: string }).decision, 'PASS', 'designed data must genuinely PASS');
  assert.ok(Number(metrics?.candidate?.effectiveSampleSize || 0) >= 30);
  assert.ok(Number(metrics?.baseline?.effectiveSampleSize || 0) >= 30);

  // ---- Stage 6: promotion fails closed on main (structural gap, documented). ----
  // NOTHING writes portfolio_policy_evaluations, and transitionPolicy reads a
  // nonexistent status column there (pre-#506): promotion must refuse rather
  // than partially promote.
  await assert.rejects(
    transitionPolicy({
      id: candidate.id,
      action: 'APPROVE',
      reason: 'test e2e promotion attempt',
      idempotencyKey: `test-e2e-approve:${tag}`,
      actor: 'test:research-e2e',
    })
  );
  const stillDraft = (
    await database.query('SELECT status FROM portfolio_policies WHERE id=$1', [candidate.id])
  ).rows[0];
  assert.equal(stillDraft.status, 'DRAFT', 'failed promotion must leave the policy DRAFT');

  // ---- Stage 7: normal CANARY operation with the GENUINE PASS evaluation. ----
  // Harness-only setup (labeled): the production status flip is broken on
  // main (see stage 6), so the test sets CANARY status directly to exercise
  // the PASS gate itself — which genuinely rejects without the evaluation.
  await database.query(`UPDATE portfolio_policies SET status='CANARY' WHERE id=$1`, [candidate.id]);
  await database.query(`UPDATE research_control SET active_policy_id=$1 WHERE singleton=true`, [
    candidate.id,
  ]);
  const extraIds: string[] = [];
  for (let index = 0; index < 5; index++) {
    const row = await database.query(
      `INSERT INTO discovery_actions(action_key,program_id,action_type,provider_key,normalized_target,context,provenance,source_family_ids,depth,cluster_key,expected_incremental_creators,expected_information_gain,expected_coverage_gain,uncertainty,provider_cost,review_cost,overlap_penalty,policy_version,expires_at)
       VALUES($1,$2,'SEARCH_YOUTUBE','youtube-search',$3,$4,$5,$6,0,$7,5,5,5,0.5,100,0,0,'persistent-research-controller-v1',now()+interval '14 days') RETURNING id`,
      [
        `test-e2e-canary-action:${tag}:${index}`,
        programId,
        `e2e canary probe ${tag} ${index}`,
        JSON.stringify({ country: 'US', language: 'en', intent: 'strategy' }),
        JSON.stringify({}),
        JSON.stringify(['test']),
        `e2e-canary-cluster:${tag}:${index}`,
      ]
    );
    extraIds.push(String(row.rows[0].id));
  }
  const control = (await database.query('SELECT * FROM research_control WHERE singleton=true')).rows[0];
  const canary = await allocateCanonical(control, 'CANARY', new Date().toISOString());
  assert.ok(canary.selected > 0, 'PASS-backed CANARY policy must allocate');
  assert.ok(
    canary.choices.length >= canary.selected && canary.selected <= 5,
    'per-cycle cap respected'
  );
  // Direct allocator path also proven (same gate, no cycle wrapper).
});
