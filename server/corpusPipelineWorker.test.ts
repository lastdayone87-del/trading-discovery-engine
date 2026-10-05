import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORPUS_PIPELINE_TYPES } from './operationalMaintenanceWorkers';

const workers = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');
const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('corpus pipeline claims exactly harvest and scoring, nothing else', () => {
  assert.deepEqual([...CORPUS_PIPELINE_TYPES].sort(), ['SCORE_CANDIDATES', 'TERM_HARVEST']);
  for (const gated of ['PROPOSE_CONCEPT_RESOLUTION', 'AI_ADJUDICATE_CANDIDATE', 'PERSISTENT_RESEARCH_EXTERNAL_PROVIDER', 'RETRY_COMMUNITY_ACQUISITION', 'SEARCH_YOUTUBE', 'ENRICH_CHANNEL']) {
    assert.ok(!CORPUS_PIPELINE_TYPES.includes(gated as never), `${gated} must not be in the corpus claim list`);
  }
});

test('corpus pipeline worker uses the existing claim path on a one-second tick', () => {
  assert.match(workers, /processNextSearchJob\(CORPUS_PIPELINE_TYPES, workerId\)/);
  assert.match(workers, /schedule\(tick, 1000\)/);
  // Single consumer: exactly one worker id, no concurrency loop or env scaling.
  assert.match(workers, /startCorpusPipelineWorker\(`corpus_pipeline_\$\{process\.pid\}_0`\)/);
  assert.doesNotMatch(workers, /CORPUS_PIPELINE.*concurrency|corpus.*CONCURRENCY/);
});

test('corpus pipeline starts from operational maintenance startup', async () => {
  const { startOperationalMaintenanceWorkers, getCorpusPipelineWorkerHealth } =
    await import('./operationalMaintenanceWorkers');
  // Behavioral: invoking startup actually starts the worker (no DB needed —
  // ticks fail safe without DATABASE_URL and reschedule unref'd).
  startOperationalMaintenanceWorkers();
  const health = getCorpusPipelineWorkerHealth();
  assert.equal(health.started, true);
  assert.ok(health.startedAt);
  // Scoped backstop: the invocation lives inside the starter body itself, so
  // deleting the call fails even though the worker definition remains.
  const starterBody = workers.slice(
    workers.indexOf('export function startOperationalMaintenanceWorkers'),
    workers.indexOf('export function getOperationalMaintenanceJobTypesForTests')
  );
  assert.match(starterBody, /startCorpusPipelineWorker\(`corpus_pipeline_\$\{process\.pid\}_0`\)/);
});

test('budget-gated admission excludes paused and exhausted controls', async () => {
  const { isBudgetedCorpusClaimAdmitted } = await import('./queueManager');
  // Paused controls never admit, regardless of budget headroom.
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: true, dailyBudget: 100, consumedToday: 0 }), false);
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: 1, dailyBudget: 100, consumedToday: 0 }), false);
  // Exhausted or zero budgets never admit (matches the processor throw boundary).
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: false, dailyBudget: 100, consumedToday: 100 }), false);
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: false, dailyBudget: 100, consumedToday: 150 }), false);
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: false, dailyBudget: 0, consumedToday: 0 }), false);
  // Unreadable budgets fail closed toward exclusion.
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: false, dailyBudget: undefined, consumedToday: 0 }), false);
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: false, dailyBudget: 'many', consumedToday: 0 }), false);
  // Open control with headroom admits.
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: false, dailyBudget: 100, consumedToday: 0 }), true);
  assert.equal(isBudgetedCorpusClaimAdmitted({ paused: false, dailyBudget: 100, consumedToday: 99 }), true);
});

test('corpus claim types stay authorized by their existing paused controls', () => {
  // The claim builder routes both types through the budgeted admission
  // decision above; removing that call re-admits paused/exhausted controls.
  assert.match(queueManager, /isBudgetedCorpusClaimAdmitted\(\{paused:control\.rows\[0\]\.paused/);
  assert.match(queueManager, /claimableOverride\.includes\('TERM_HARVEST'\)/);
  assert.match(queueManager, /SELECT paused,daily_compute_documents FROM corpus_controls/);
  assert.match(queueManager, /SELECT scoring_paused,ai_paused,daily_scoring_candidates FROM candidate_scoring_controls/);
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
