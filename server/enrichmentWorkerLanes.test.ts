import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMISSION_VERIFICATION_JOB_TYPE } from './channelAdmission/worker';
import { CLASSIFICATION_JOB_TYPE, resolveEnrichmentWorkerSplit } from './classificationDecoupling';
import { enrichmentWorkerLanes, startEnrichmentWorkerLanes } from './queueManager';

interface LaunchedLane {
  type: string;
  concurrency: number;
  extraClaimableTypes: string[];
  workerPrefix: string;
}

function launch(split: ReturnType<typeof resolveEnrichmentWorkerSplit>): LaunchedLane[] {
  const lanes: LaunchedLane[] = [];
  startEnrichmentWorkerLanes(split, (type, concurrency, extraClaimableTypes, workerPrefix) => {
    lanes.push({ type, concurrency, extraClaimableTypes, workerPrefix: workerPrefix || '' });
  });
  return lanes;
}

test('three-worker pool launches separate admission, classification, and ENRICH lanes', () => {
  const lanes = launch(resolveEnrichmentWorkerSplit(3, true));
  assert.deepEqual(lanes, [
    {
      type: 'ENRICH_CHANNEL',
      concurrency: 1,
      extraClaimableTypes: [ADMISSION_VERIFICATION_JOB_TYPE],
      workerPrefix: 'enrich_channel_admission',
    },
    {
      type: 'ENRICH_CHANNEL',
      concurrency: 1,
      extraClaimableTypes: [CLASSIFICATION_JOB_TYPE, 'PROCESS_DISCOVERED_CHANNEL'],
      workerPrefix: 'enrich_channel_classification',
    },
    {
      type: 'ENRICH_CHANNEL',
      concurrency: 1,
      extraClaimableTypes: [],
      workerPrefix: 'enrich_channel_backlog',
    },
  ]);
});

test('six-worker pool scales admission and classification lanes without sharing their types', () => {
  const lanes = launch(resolveEnrichmentWorkerSplit(6, true));
  assert.deepEqual(lanes.map(lane => [lane.workerPrefix, lane.concurrency]), [
    ['enrich_channel_admission', 2],
    ['enrich_channel_classification', 3],
    ['enrich_channel_backlog', 1],
  ]);
  for (const lane of lanes) {
    const hasAdmission = lane.extraClaimableTypes.includes(ADMISSION_VERIFICATION_JOB_TYPE);
    const hasClassification = lane.extraClaimableTypes.includes(CLASSIFICATION_JOB_TYPE);
    assert.ok(!(hasAdmission && hasClassification), `${lane.workerPrefix} must not claim both admission and classification`);
  }
});

test('one- and two-worker pools retain the shared fallback lane', () => {
  assert.deepEqual(launch(resolveEnrichmentWorkerSplit(1, true)), [{
    type: 'ENRICH_CHANNEL',
    concurrency: 1,
    extraClaimableTypes: [CLASSIFICATION_JOB_TYPE, ADMISSION_VERIFICATION_JOB_TYPE, 'PROCESS_DISCOVERED_CHANNEL'],
    workerPrefix: 'enrich_channel_shared',
  }]);
  assert.deepEqual(launch(resolveEnrichmentWorkerSplit(2, true)).map(lane => [lane.concurrency, lane.extraClaimableTypes]), [
    [1, [CLASSIFICATION_JOB_TYPE, ADMISSION_VERIFICATION_JOB_TYPE, 'PROCESS_DISCOVERED_CHANNEL']],
    [1, []],
  ]);
});

test('lane plan preserves the split total and omits zero lanes', () => {
  for (const total of [3, 4, 5, 6, 20]) {
    const split = resolveEnrichmentWorkerSplit(total, true);
    const lanes = enrichmentWorkerLanes(split);
    assert.equal(lanes.reduce((sum, lane) => sum + lane.concurrency, 0), total);
    assert.ok(lanes.every(lane => lane.concurrency > 0));
    assert.ok(lanes.some(lane => lane.extraClaimableTypes.includes(ADMISSION_VERIFICATION_JOB_TYPE)));
    assert.ok(lanes.some(lane => lane.extraClaimableTypes.includes(CLASSIFICATION_JOB_TYPE)));
    assert.ok(lanes.some(lane => lane.extraClaimableTypes.length === 0));
  }
});
