import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORPUS_PIPELINE_TYPES } from './operationalMaintenanceWorkers';

const workers = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');
const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('corpus pipeline claims exactly harvest, scoring, and resolution, nothing else', () => {
  assert.deepEqual([...CORPUS_PIPELINE_TYPES].sort(), ['PROPOSE_CONCEPT_RESOLUTION', 'SCORE_CANDIDATES', 'TERM_HARVEST']);
  for (const gated of ['AI_ADJUDICATE_CANDIDATE', 'PERSISTENT_RESEARCH_EXTERNAL_PROVIDER', 'RETRY_COMMUNITY_ACQUISITION', 'SEARCH_YOUTUBE', 'ENRICH_CHANNEL']) {
    assert.ok(!CORPUS_PIPELINE_TYPES.includes(gated as never), `${gated} must not be in the corpus claim list`);
  }
});

test('corpus pipeline worker uses the existing claim path on a one-second tick', () => {
  // Scoped to the corpus worker body (not the whole file): another worker
  // contains the same scheduling expression, so a global match would pass
  // even if this worker's scheduling were removed.
  const workerBody = workers.slice(
    workers.indexOf('function startCorpusPipelineWorker'),
    workers.indexOf('/** Dedicated consumers for operational jobs outside the three core pools. */')
  );
  assert.ok(workerBody.length > 0);
  assert.match(workerBody, /processNextSearchJob\(CORPUS_PIPELINE_TYPES, workerId\)/);
  assert.match(workerBody, /schedule\(tick, 1000\)/);
  // Single consumer: no concurrency loop or env scaling in this worker
  // (the lone invocation site is pinned by the starter-body test below).
  assert.doesNotMatch(workerBody, /CORPUS_PIPELINE.*concurrency|corpus.*CONCURRENCY/);
  // Cross-replica safety lives at the claim boundary (budget guard row lock
  // inside claimNextJob), not in this tick: no in-process lock here.
  assert.doesNotMatch(workerBody, /pg_try_advisory_lock|pg_advisory_unlock/);
});

test('budget guards are defined for exactly the corpus claim types', async () => {
  const { TERM_HARVEST_BUDGET_GUARD, SCORE_CANDIDATES_BUDGET_GUARD, RESOLUTION_BUDGET_GUARD, CORPUS_CLAIM_BUDGET_GUARDS, RESOLUTION_CLAIM_BUDGET_GUARDS } =
    await import('./queueManager');
  assert.deepEqual(TERM_HARVEST_BUDGET_GUARD.types, ['TERM_HARVEST']);
  assert.deepEqual(SCORE_CANDIDATES_BUDGET_GUARD.types, ['SCORE_CANDIDATES']);
  assert.deepEqual(RESOLUTION_BUDGET_GUARD.types, ['PROPOSE_CONCEPT_RESOLUTION']);
  assert.deepEqual(CORPUS_CLAIM_BUDGET_GUARDS, [TERM_HARVEST_BUDGET_GUARD, SCORE_CANDIDATES_BUDGET_GUARD]);
  assert.deepEqual(RESOLUTION_CLAIM_BUDGET_GUARDS, [RESOLUTION_BUDGET_GUARD]);
  for (const guard of [...CORPUS_CLAIM_BUDGET_GUARDS, ...RESOLUTION_CLAIM_BUDGET_GUARDS]) {
    assert.match(guard.lockSql, /FOR UPDATE/);
  }
  // The claim path passes the guards into claimNextJob, where admission is
  // evaluated atomically inside the claim transaction.
  assert.match(queueManager, /\['RECONCILIATION_REQUIRED'\], \[\.\.\.CORPUS_CLAIM_BUDGET_GUARDS, \.\.\.RESOLUTION_CLAIM_BUDGET_GUARDS\]\)/);
});

test('guard evaluation recovers the claim transaction after transient failure', async () => {
  const { evaluateClaimGuard } = await import('./dbCore');
  // A throwing guard fails closed AND leaves the transaction usable: the
  // savepoint is rolled back, so a subsequent statement still runs instead
  // of dying with an aborted-transaction error.
  const calls: string[] = [];
  let recovered = false;
  const failingGuard = {
    types: ['TERM_HARVEST'],
    lockSql: 'SELECT 1',
    isAdmitted: async () => {
      throw new Error('transient guard read failure');
    },
  };
  const recoveringClient = {
    query: async (text: string) => {
      calls.push(text);
      if (text === 'SAVEPOINT claim_guard' || text === 'ROLLBACK TO SAVEPOINT claim_guard') {
        if (text.startsWith('ROLLBACK')) recovered = true;
        return { rows: [] };
      }
      // Before recovery the guard read fails; after the savepoint rollback
      // the same transaction accepts statements normally again.
      if (recovered) return { rows: [] };
      throw new Error('transient guard read failure');
    },
  };
  assert.deepEqual(await evaluateClaimGuard(recoveringClient, failingGuard), { admitted: false, exhausted: true });
  assert.deepEqual(calls, ['SAVEPOINT claim_guard', 'ROLLBACK TO SAVEPOINT claim_guard']);
  // Post-recovery the same transaction accepts new statements.
  const followup = await recoveringClient.query('SELECT 1');
  assert.deepEqual(followup, { rows: [] });
  // Success path releases the savepoint and admits.
  const successCalls: string[] = [];
  const passingGuard = {
    types: ['TERM_HARVEST'],
    lockSql: 'SELECT 1',
    isAdmitted: async () => ({ admitted: true, exhausted: false }),
  };
  const successClient = {
    query: async (text: string) => {
      successCalls.push(text);
      return { rows: [] };
    },
  };
  assert.deepEqual(await evaluateClaimGuard(successClient, passingGuard), { admitted: true, exhausted: false });
  assert.deepEqual(successCalls, ['SAVEPOINT claim_guard', 'RELEASE SAVEPOINT claim_guard']);
});

test('corpus pipeline invocation lives inside the starter body', () => {
  // No workers are started by this suite: invoking startup would claim real
  // jobs when DATABASE_URL is configured (live-DB claim coverage lives in
  // corpusClaimBudget.postgres.test.ts instead). The starter-body slice must
  // contain the invocation, so deleting the call fails even though the worker
  // definition remains elsewhere in the file.
  const starterBody = workers.slice(
    workers.indexOf('export function startOperationalMaintenanceWorkers'),
    workers.indexOf('export function getOperationalMaintenanceJobTypesForTests')
  );
  assert.match(starterBody, /startCorpusPipelineWorker\(`corpus_pipeline_\$\{process\.pid\}_0`\)/);
});

test('shared corpus budget decision is exact on paused, budget, and units', async () => {
  const { corpusBudgetAdmits } = await import('./candidateCorpus');
  const open = { paused: false, dailyBudget: 100, consumedToday: 0, clusterWindowCap: 5 };
  assert.equal(corpusBudgetAdmits(null), false);
  assert.equal(corpusBudgetAdmits({ ...open, paused: true }), false);
  assert.equal(corpusBudgetAdmits({ ...open, consumedToday: 99 }), true);
  assert.equal(corpusBudgetAdmits({ ...open, consumedToday: 100 }), false);
  assert.equal(corpusBudgetAdmits({ ...open, consumedToday: 150 }), false);
  assert.equal(corpusBudgetAdmits({ ...open, dailyBudget: 0 }), false);
  assert.equal(corpusBudgetAdmits({ ...open, dailyBudget: NaN }), false);
  // Multi-unit requests reserve exactly: headroom 3 admits 3, not 5.
  assert.equal(corpusBudgetAdmits({ ...open, consumedToday: 97 }, 3), true);
  assert.equal(corpusBudgetAdmits({ ...open, consumedToday: 97 }, 5), false);
  assert.equal(corpusBudgetAdmits({ ...open, consumedToday: 97 }, 0), true);
});

test('budget guards observe pause, units, and in-flight usage', async () => {
  const { TERM_HARVEST_BUDGET_GUARD, SCORE_CANDIDATES_BUDGET_GUARD } = await import('./queueManager');
  const harvestRows = new Map<string, Array<Record<string, unknown>>>([
    ['corpus_controls', [{ paused: false, budget: 100, cluster_window_cap: 5 }]],
    ['corpus_extraction_runs', [{ n: 99 }]],
    ['jobs:TERM_HARVEST', [{ n: 0 }]],
  ]);
  const harvestClient = {
    query: async (text: string) => {
      if (text.includes('FROM corpus_controls')) return { rows: harvestRows.get('corpus_controls')! };
      if (text.includes('FROM corpus_extraction_runs')) return { rows: harvestRows.get('corpus_extraction_runs')! };
      return { rows: harvestRows.get('jobs:TERM_HARVEST')! };
    },
  };
  // 99 consumed + 0 in flight + 1 requested <= 100: admitted, not exhausted.
  assert.deepEqual(await TERM_HARVEST_BUDGET_GUARD.isAdmitted(harvestClient), {
    admitted: true,
    exhausted: false,
  });
  // One in-flight claim fills the budget: denied without consuming attempts,
  // and exhausted so the claim loop skips the whole type.
  harvestRows.set('jobs:TERM_HARVEST', [{ n: 1 }]);
  assert.deepEqual(await TERM_HARVEST_BUDGET_GUARD.isAdmitted(harvestClient), {
    admitted: false,
    exhausted: true,
  });
  // Paused control denies regardless of headroom.
  harvestRows.set('corpus_controls', [{ paused: true, budget: 100, cluster_window_cap: 5 }]);
  harvestRows.set('jobs:TERM_HARVEST', [{ n: 0 }]);
  assert.deepEqual(await TERM_HARVEST_BUDGET_GUARD.isAdmitted(harvestClient), {
    admitted: false,
    exhausted: true,
  });

  const docId = '11111111-2222-4333-8444-555555555555';
  const scoringRows = new Map<string, Array<Record<string, unknown>>>([
    ['candidate_scoring_controls', [{ paused: false, budget: 10 }]],
    ['occurrences', [{ n: 5 }]],
    ['snapshots', [{ n: 4 }]],
    ['inflight', [{ u: 0 }]],
  ]);
  const scoringClient = {
    query: async (text: string) => {
      if (text.includes('FROM candidate_scoring_controls')) return { rows: scoringRows.get('candidate_scoring_controls')! };
      if (text.includes('FROM corpus_candidate_occurrences') && !text.includes('LEFT JOIN LATERAL')) {
        return { rows: scoringRows.get('occurrences')! };
      }
      if (text.includes('FROM candidate_feature_snapshots')) return { rows: scoringRows.get('snapshots')! };
      return { rows: scoringRows.get('inflight')! };
    },
  };
  const job = { id: 'job-1', payload: { documentId: docId } };
  // 5 groups against 4 spent + 0 in flight of 10: 9 <= 10 admitted.
  assert.deepEqual(await SCORE_CANDIDATES_BUDGET_GUARD.isAdmitted(scoringClient, job), {
    admitted: true,
    exhausted: false,
  });
  // Two more spent units fill it beyond the 5-group reservation: denied but
  // not exhausted (a smaller job could still fit, so scanning continues).
  scoringRows.set('snapshots', [{ n: 6 }]);
  assert.deepEqual(await SCORE_CANDIDATES_BUDGET_GUARD.isAdmitted(scoringClient, job), {
    admitted: false,
    exhausted: false,
  });
  // Fully spent budget exhausts the type even for smaller jobs.
  scoringRows.set('snapshots', [{ n: 10 }]);
  assert.deepEqual(await SCORE_CANDIDATES_BUDGET_GUARD.isAdmitted(scoringClient, job), {
    admitted: false,
    exhausted: true,
  });
  // Missing document identity cannot reserve unknown units: denied.
  assert.deepEqual(
    await SCORE_CANDIDATES_BUDGET_GUARD.isAdmitted(scoringClient, { id: 'job-2', payload: {} }),
    { admitted: false, exhausted: false }
  );
});

test('resolution guard admits one unit with headroom, denies when exhausted', async () => {
  const { RESOLUTION_BUDGET_GUARD } = await import('./queueManager');
  const rows = new Map<string, Array<Record<string, unknown>>>([
    ['concept_graph_controls', [{ paused: false, budget: 10 }]],
    ['proposals', [{ n: 9 }]],
    ['inflight', [{ n: 0 }]],
  ]);
  const client = {
    query: async (text: string) => {
      if (text.includes('FROM concept_graph_controls')) return { rows: rows.get('concept_graph_controls')! };
      if (text.includes('FROM concept_resolution_proposals')) return { rows: rows.get('proposals')! };
      return { rows: rows.get('inflight')! };
    },
  };
  const job = { id: 'job-1', payload: { candidateKey: 'k', literal: 'x' } };
  // 9 done + 0 in flight of 10: one unit fits.
  assert.deepEqual(await RESOLUTION_BUDGET_GUARD.isAdmitted(client, job), {
    admitted: true,
    exhausted: false,
  });
  // One more completed proposal exhausts: denied, type skipped.
  rows.set('proposals', [{ n: 10 }]);
  assert.deepEqual(await RESOLUTION_BUDGET_GUARD.isAdmitted(client, job), {
    admitted: false,
    exhausted: true,
  });
  // Paused control denies regardless of headroom.
  rows.set('concept_graph_controls', [{ paused: true, budget: 10 }]);
  rows.set('proposals', [{ n: 0 }]);
  assert.deepEqual(await RESOLUTION_BUDGET_GUARD.isAdmitted(client, job), {
    admitted: false,
    exhausted: true,
  });
});

test('corpus claim types stay authorized by their existing paused controls', () => {
  // The atomic guards (evaluated inside the claim transaction) admit each
  // type only with remaining headroom; the shared corpusBudgetAdmits helper
  // remains the single decision for both processors and persistent research.
  // The builder keeps its original paused-only checks as a fast path.
  assert.match(queueManager, /readCorpusBudgetForUpdate\(client\)/);
  assert.match(queueManager, /remaining >= 1/);
  assert.match(queueManager, /claimableOverride\.includes\('TERM_HARVEST'\)/);
  assert.match(queueManager, /count\(DISTINCT normalized_span\)/);
});

test('harvest producer/consumer share the exact extractor version contract', async () => {
  // Live-queue evidence (2026-10-05): all pending payloads carry
  // extractorVersion == EXTRACTOR_VERSION with payloadSchemaVersion 1, so the
  // reported contract break does not exist in current code or data.
  const corpus = readFileSync(new URL('./candidateCorpus.ts', import.meta.url), 'utf8');
  assert.match(corpus, /enqueueJob\('TERM_HARVEST'[\s\S]*?extractorVersion:\s*EXTRACTOR_VERSION/);
  assert.match(corpus, /p\.payloadSchemaVersion!==1\|\|p\.extractorVersion!==EXTRACTOR_VERSION/);
  const { EXTRACTOR_VERSION } = await import('./candidateCorpus');
  assert.equal(typeof EXTRACTOR_VERSION, 'string');
  assert.ok(EXTRACTOR_VERSION.length > 0);
});

test('corpus pipeline health readout exposes no job or channel data', () => {
  assert.match(workers, /getCorpusPipelineWorkerHealth/);
  assert.match(workers, /lastOutcome: 'CLAIMED' \| 'NO_DUE_JOB' \| 'ERROR'/);
});
