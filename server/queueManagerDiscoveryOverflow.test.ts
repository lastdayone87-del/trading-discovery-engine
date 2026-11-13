import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('classification-cap overflow is durably enqueued instead of running inline', () => {
  const start = source.indexOf("if (classificationAdmission(backpressure) === 'INLINE')");
  const end = source.indexOf('const config = resolveClassificationDecouplingConfig();', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /try \{[\s\S]*enqueueClassificationJobAtomic\(raw\.channelId/);
  assert.match(block, /jobType: 'PROCESS_DISCOVERED_CHANNEL'/);
  assert.match(block, /catch \(error\)/);
  assert.match(block, /preventCompletedReopen: true/);
  assert.match(block, /priority: 14/);
  assert.match(block, /queued\.reopen_blocked/);
  assert.match(block, /queued\.status === 'PENDING' \|\| queued\.status === 'PROCESSING'/);
  assert.match(block, /if \(queued && !queued\.reopen_blocked/);
  assert.match(block, /if \(queued === null\)[\s\S]{0,400}hasActiveClassificationJob\(raw\.channelId\)/);
  assert.match(block, /return \{ outcome: await inline\(\), pending: false \};/,
    'inline remains only as the enqueue-failure/terminal fallback');
});

test('overflow jobs run in the enrichment lane with admission already decided', () => {
  const start = source.indexOf("if(job.type==='PROCESS_DISCOVERED_CHANNEL')");
  assert.ok(start >= 0);
  const block = source.slice(start, start + 1800);
  assert.match(block, /assertCountryAllowed/);
  assert.match(block, /processDiscoveredChannelContained/);
  assert.match(block, /admissionBypass: true/);
  assert.match(block, /isRepairEligibleRetry\(job\)/);
  assert.match(block, /reconcileClassificationResult/);
  assert.match(block, /await completeJob\(job\.id\)/);
});

test('overflow jobs follow semantic availability and are claimable only by the enrichment pool', () => {
  assert.match(source, /enrichmentFullyClaimable[\s\S]{0,220}PROCESS_DISCOVERED_CHANNEL/);
  assert.match(source, /\[CLASSIFICATION_JOB_TYPE, ADMISSION_VERIFICATION_JOB_TYPE, 'PROCESS_DISCOVERED_CHANNEL'\]/);
});

test('overflow ownership and failure reconciliation are visible to recovery paths', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const recovery = readFileSync(new URL('./classificationResolutionRecovery.ts', import.meta.url), 'utf8');
  const monitoring = readFileSync(new URL('./classificationResolutionMonitoring.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /\[CLASSIFICATION_JOB_TYPE, 'PROCESS_DISCOVERED_CHANNEL'\]/);
  assert.match(dbCore, /deps\.jobType \|\| CLASSIFICATION_JOB_TYPE/);
  assert.match(recovery, /'CLASSIFY_DISCOVERED_CHANNEL','PROCESS_DISCOVERED_CHANNEL'/);
  assert.match(monitoring, /'CLASSIFY_DISCOVERED_CHANNEL','PROCESS_DISCOVERED_CHANNEL'/);
  assert.match(source, /job\.type === CLASSIFICATION_JOB_TYPE \|\| job\.type === 'PROCESS_DISCOVERED_CHANNEL'/);
});
