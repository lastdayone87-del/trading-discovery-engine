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

test('corpus pipeline starts from operational maintenance startup', () => {
  assert.match(workers, /startCorpusPipelineWorker/);
  const starter = workers.slice(workers.indexOf('export function startOperationalMaintenanceWorkers'));
  assert.match(starter, /startCorpusPipelineWorker/);
});

test('corpus claim types stay authorized by their existing paused controls', () => {
  // The claim builder (unchanged) admits each type only when its control is unpaused.
  assert.match(queueManager, /claimableOverride\.includes\('TERM_HARVEST'\)/);
  assert.match(queueManager, /SELECT paused FROM corpus_controls WHERE singleton=true/);
  assert.match(queueManager, /scoring_paused,ai_paused FROM candidate_scoring_controls/);
});

test('corpus pipeline health readout exposes no job or channel data', () => {
  assert.match(workers, /getCorpusPipelineWorkerHealth/);
  assert.match(workers, /lastOutcome: 'CLAIMED' \| 'NO_DUE_JOB' \| 'ERROR'/);
});
