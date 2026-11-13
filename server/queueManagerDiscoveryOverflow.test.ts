import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('classification-cap overflow is durably enqueued instead of running inline', () => {
  const start = source.indexOf("if (classificationAdmission(backpressure) === 'INLINE')");
  const end = source.indexOf('const config = resolveClassificationDecouplingConfig();', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /enqueueJob\('PROCESS_DISCOVERED_CHANNEL'/);
  assert.match(block, /preventCompletedReopen: true/);
  assert.match(block, /if \(queued\) return \{ outcome: classificationPendingOutcome\(raw, existing\), pending: true \};/);
  assert.match(block, /return \{ outcome: await inline\(\), pending: false \};/,
    'inline remains only as the enqueue-failure fallback');
});

test('overflow jobs run in the enrichment lane with admission already decided', () => {
  const start = source.indexOf("if(job.type==='PROCESS_DISCOVERED_CHANNEL')");
  assert.ok(start >= 0);
  const block = source.slice(start, start + 900);
  assert.match(block, /processDiscoveredChannelContained/);
  assert.match(block, /admissionBypass: true/);
  assert.match(block, /await completeJob\(job\.id\)/);
});

test('overflow jobs are claimable only by the enrichment pool', () => {
  assert.match(source, /claimableOverride\.includes\('PROCESS_DISCOVERED_CHANNEL'\)/);
  assert.match(source, /\[CLASSIFICATION_JOB_TYPE, ADMISSION_VERIFICATION_JOB_TYPE, 'PROCESS_DISCOVERED_CHANNEL'\]/);
});
