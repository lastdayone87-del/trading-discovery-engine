import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Isolated end-to-end validation of the provisional research-bootstrap
 * lifecycle against a fresh PostgreSQL database:
 *
 *   bootstrap creation → bounded allocation (2 runs × 30) → real cycle driver
 *   → outcomes → effective samples → policy evaluation (genuine PASS) →
 *   governed promotion DRAFT→APPROVED→CANARY on that PASS → PASS-backed
 *   CANARY allocation (with pre-evidence CANARY refusal asserted first).
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
 * (recordDiscoveryOutcome), each action's 100 provider cost recorded exactly
 * once. Everything downstream of that boundary — allocation math, cycle
 * orchestration, usage accounting, evaluator statistics (unmodified ≥30
 * gate), promotion gates, canonical CANARY allocation — runs as production
 * code.
 *
 * Data design (no gate weakening): 30 high-yield + 30 low-yield actions.
 * Replay budgets use the fields the evaluator actually reads
 * (providerBudget/reviewBudget): the candidate replay (budget 3000) selects
 * exactly the 30 high-yield actions in deterministic utility order; the
 * baseline replay (budget 10000) selects all 60. Every allocated action
 * receives exactly one cost-bearing outcome row through the real ingestion
 * path, so support is genuine logged behavior, not fabrication.
 *
 * Promotion/CANARY boundary (explicitly preserved): the suite NEVER writes
 * portfolio_policy_evaluations. The persistent-research PASS evaluation is
 * genuine, and governed promotion consumes exactly that artifact (PASS with
 * non-null baseline for the promoted candidate). The CANARY status reached in
 * stage 5 purely to set up the pre-evidence refusal remains harness-only
 * setup; every status change after the PASS goes through transitionPolicy.
 * The PASS-evidence gate is genuinely exercised in both directions (rejected
 * before evidence, allocating after).
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
  providerBudget: 3000,
  totalReviewBudget: 0,
  reviewBudget: 0,
  clusterCap: 100,
  curatedSearchFloor: 0,
  programFloors: {},
  actionCaps: { SEARCH_YOUTUBE: 100 },
  explorationBasisPoints: 0,
};

const BASELINE_CONFIG = {
  totalProviderBudget: 10000,
  providerBudget: 10000,
  totalReviewBudget: 0,
  reviewBudget: 0,
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
    abortResearchBootstrapRun,
    runPersistentResearchCycle,
    evaluatePersistentResearchPolicy,
    allocateCanonical,
  } = await import('./persistentResearchController');
  const { createPolicy, transitionPolicy } = await import('./portfolioAllocator');
  const { recordDiscoveryOutcome } = await import('./persistentResearch');
  const tag = `e2e:${Date.now()}:${process.pid}`;
  const startedRunIds: string[] = [];
  const prevControl = (await database.query('SELECT * FROM research_control WHERE singleton=true'))
    .rows[0];
  assert.ok(prevControl, 'research_control singleton must exist');

  try {
    // ---- Stage 0: isolated gate + control plane setup (test-harness only). ----
    const table = await database.query(`SELECT to_regclass('research_bootstrap_runs') AS oid`);
    assert.ok(table.rows[0]?.oid, 'migrations must be applied to the dedicated test database');
    const preActive = await database.query(
      `SELECT count(*)::int AS n FROM research_bootstrap_runs WHERE status='ACTIVE'`
    );
    assert.equal(Number(preActive.rows[0]?.n || 0), 0, 'dedicated DB must start with no ACTIVE run');
    // Deterministic provider fixture: UPSERT (not DO NOTHING) so a
    // pre-existing row with any mode/cap cannot silently exclude the fixtures.
    await database.query(
      `INSERT INTO discovery_provider_registry(provider_key,provider_family,provider_kind,capabilities,quota_domain,mode,daily_cost_cap,updated_by)
       VALUES('youtube-search','youtube','RETRIEVAL','["SEARCH_YOUTUBE"]','youtube','ACTIVE',0,'test:research-e2e')
       ON CONFLICT(provider_key) DO UPDATE SET mode='ACTIVE', daily_cost_cap=0,
         capabilities='["SEARCH_YOUTUBE"]', updated_by='test:research-e2e'`
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
    // Single-clock harness rule: derive the evaluation window start from the
  // database timestamps themselves, plus a 1s buffer, so created_at <=
  // windowStart holds regardless of runner/database clock skew AND
  // microsecond truncation (the replay compares with millisecond ISO bounds).
  // The sleeps below guarantee every subsequent action/assignment/outcome
  // timestamp falls strictly inside the window.
  const windowStart = String(
    (
      await database.query(
        `SELECT (max(created_at) + interval '1 second')::text AS t FROM portfolio_policies WHERE id = ANY($1::uuid[])`,
        [[candidate.id, baseline.id]]
      )
    ).rows[0].t
  );
  await new Promise(resolve => setTimeout(resolve, 1200));

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
      startedRunIds.push(run.id);
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
      // Genuine outcomes through the real ingestion path. Each action's 100
      // provider cost is recorded exactly once: high-yield actions earn one
      // incremental outcome, low-yield actions log one non-incremental outcome.
      for (const assignment of got) {
        const high = highSet.has(String(assignment.action_id));
        await recordDiscoveryOutcome({
          outcomeKey: `test-e2e-outcome:${tag}:r${runIndex}:${String(assignment.action_id)}`,
          actionId: String(assignment.action_id),
          assignmentId: String(assignment.id),
          outcomeType: high ? 'UNIQUE_ENTITY' : 'KNOWN_ENTITY',
          incremental: high,
          providerCost: 100,
          reviewCost: 0,
          evidence: { e2e: true, run: runIndex },
          observedAt: new Date().toISOString(),
        });
      }
    }
    // First run must take the 30 high-yield actions (deterministic utility
    // order); the designed replay depends on it.
    const run0Actions = new Set(
      (await assignmentsOf(startedRunIds[0])).map(row => String(row.action_id))
    );
    assert.deepEqual(
      [...run0Actions].sort(),
      [...highSet].sort(),
      'run 0 must allocate exactly the 30 high-yield actions'
    );
    await new Promise(resolve => setTimeout(resolve, 1200));
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

    // ---- Stage 5: CANARY gate rejects BEFORE qualifying PASS evidence. ----
    // Harness-only status setup (labeled): the production status flip is what
    // is broken on main (see stage 7); the evidence gate below is genuinely
    // exercised — no PASS evaluation exists yet, so this must refuse.
    await database.query(`UPDATE portfolio_policies SET status='CANARY' WHERE id=$1`, [candidate.id]);
    await database.query(`UPDATE research_control SET active_policy_id=$1 WHERE singleton=true`, [
      candidate.id,
    ]);
    const preControl = (await database.query('SELECT * FROM research_control WHERE singleton=true'))
      .rows[0];
    await assert.rejects(
      allocateCanonical(preControl, 'CANARY', new Date().toISOString()),
      /EVALUATED_CANARY_POLICY_REQUIRED/
    );

    // ---- Stage 6: genuine policy evaluation (unmodified ≥30 gate). ----
    // Assertions are strong on purpose: an unconditional/bogus PASS cannot
    // satisfy the improvement interval, guardrails, and support requirements.
    const evaluation = (await evaluatePersistentResearchPolicy({
      policyId: candidate.id,
      baselinePolicyId: baseline.id,
      evaluationWindowStart: windowStart,
      datasetCutoff: cutoff,
      minimumAssignments: 30,
      actor: 'test:research-e2e',
    })) as unknown as {
      decision: string;
      metrics: {
        candidate: { effectiveSampleSize: number; unsupportedTargetActions: number };
        baseline: { effectiveSampleSize: number; unsupportedTargetActions: number };
        incrementalDifference: number;
        confidenceInterval: { lower: number; upper: number };
        segmentGuardrails: Record<string, { pass: boolean }>;
      };
    };
    // evaluatePersistentResearchPolicy returns the evaluation ROW: statistics
    // live under metrics; decision is top-level.
    const metrics = evaluation.metrics;
    assert.ok(metrics && metrics.candidate && metrics.baseline, 'evaluation must carry metrics');
    console.log(
      `E2E evaluation decision=${evaluation.decision} ` +
        `candidateN=${metrics.candidate.effectiveSampleSize} baselineN=${metrics.baseline.effectiveSampleSize} ` +
        `diff=${metrics.incrementalDifference} ci=[${metrics.confidenceInterval.lower},${metrics.confidenceInterval.upper}]`
    );
    assert.equal(evaluation.decision, 'PASS', 'designed data must genuinely PASS');
    assert.ok(metrics.candidate.effectiveSampleSize >= 30, 'candidate needs ≥30 effective samples');
    assert.ok(metrics.baseline.effectiveSampleSize >= 30, 'baseline needs ≥30 effective samples');
    assert.equal(metrics.candidate.unsupportedTargetActions, 0, 'no unsupported candidate actions');
    assert.equal(metrics.baseline.unsupportedTargetActions, 0, 'no unsupported baseline actions');
    assert.ok(metrics.incrementalDifference > 0, 'candidate must improve on baseline');
    assert.ok(
      metrics.confidenceInterval.lower > 0,
      'improvement confidence interval must exclude zero'
    );
    const guardrails = Object.values(metrics.segmentGuardrails || {});
    assert.ok(guardrails.length > 0, 'at least one segment guardrail must be evaluated');
    assert.ok(
      guardrails.every(entry => entry.pass),
      'every segment guardrail must pass'
    );

    // ---- Stage 7: governed promotion on the genuine PASS evaluation. ----
    // The bridge gate reads persistent_research_policy_evaluations for this
    // candidate (PASS + non-null baseline). Harness reset (labeled): APPROVE
    // is only a legal transition from DRAFT, so the stage-5 CANARY setup
    // returns to DRAFT first. No portfolio_policy_evaluations row is written.
    await database.query(`UPDATE portfolio_policies SET status='DRAFT' WHERE id=$1`, [candidate.id]);
    const approved = await transitionPolicy({
      id: candidate.id,
      action: 'APPROVE',
      reason: 'test e2e promotion on genuine PASS',
      idempotencyKey: `test-e2e-approve:${tag}`,
      actor: 'test:research-e2e',
    });
    assert.equal(approved.status, 'APPROVED', 'genuine PASS must promote DRAFT to APPROVED');
    const canaryPolicy = await transitionPolicy({
      id: candidate.id,
      action: 'CANARY',
      reason: 'test e2e canary advance on genuine PASS',
      idempotencyKey: `test-e2e-canary:${tag}`,
      actor: 'test:research-e2e',
    });
    assert.equal(canaryPolicy.status, 'CANARY', 'APPROVED policy with PASS must advance to CANARY');

    // ---- Stage 8: CANARY allocates with the GENUINE PASS evidence. ----
    // Status reached through the governed promotion path above (the only
    // direct status write left is the stage-5 negative setup). The delta
    // since the stage-5 refusal remains exactly the now-existing PASS
    // evaluation.
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
    void extraIds;
    const control = (await database.query('SELECT * FROM research_control WHERE singleton=true'))
      .rows[0];
    const canary = await allocateCanonical(control, 'CANARY', new Date().toISOString());
    assert.ok(canary.selected > 0, 'PASS-backed CANARY policy must allocate');
    assert.ok(
      canary.choices.length >= canary.selected && canary.selected <= 5,
      'per-cycle cap respected'
    );
  } finally {
    // Guaranteed teardown: terminalize any run this harness started (even on
    // interruption) and restore research_control, so the E2E is safe to rerun
    // against its dedicated database.
    const { abortResearchBootstrapRun } = await import('./persistentResearchController');
    for (const runId of startedRunIds) {
      await abortResearchBootstrapRun(runId, 'test:research-e2e', 'e2e teardown').catch(
        () => undefined
      );
    }
    await database.query(
      `UPDATE research_control SET enabled=$1, mode=$2, paused=$3, kill_switch=$4,
        daily_provider_cost_cap=$5, daily_review_cost_cap=$6, exploration_basis_points=$7,
        max_actions_per_cycle=$8, active_policy_id=$9 WHERE singleton=true`,
      [
        prevControl.enabled,
        prevControl.mode,
        prevControl.paused,
        prevControl.kill_switch,
        prevControl.daily_provider_cost_cap,
        prevControl.daily_review_cost_cap,
        prevControl.exploration_basis_points,
        prevControl.max_actions_per_cycle,
        prevControl.active_policy_id,
      ]
    );
  }
});
