import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
const ingestionPipeline = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const reviewStore = readFileSync(new URL('./reviewStore.ts', import.meta.url), 'utf8');
const channelAdmission = readFileSync(new URL('./channelAdmission/index.ts', import.meta.url), 'utf8');

test('ordinary channel upserts refuse to downgrade a confirmed trading row', () => {
  const start = dbCore.indexOf('export async function upsertChannelWithResult');
  const end = dbCore.indexOf('\n/** Compatibility wrapper', start);
  const source = dbCore.slice(start, end);
  assert.ok(start >= 0 && end > start, 'upsertChannelWithResult must exist');
  assert.match(source, /isConfirmedTradingDowngrade/);
  assert.match(source, /lockedTradingStatus: locked\.trading_status/);
  assert.match(source, /incomingTradingStatus: channel\.trading_status/);
  assert.match(source, /await client\.query\('COMMIT'\);\s*return false;/);
});

test('stale classification outcomes report the authoritative confirmed row', () => {
  assert.match(ingestionPipeline, /function confirmedTradingOutcome/);
  assert.match(ingestionPipeline, /const nonTradingWritten = await upsertChannelWithResult/);
  assert.match(ingestionPipeline, /const withheldWritten = await upsertChannelWithResult/);
  assert.match(ingestionPipeline, /const uncertainWritten = await upsertChannelWithResult/);
  assert.match(ingestionPipeline, /return confirmedTradingOutcome\(authoritative\)/);
});

test('classification jobs defer to the pipeline and reconcile from the durable row', () => {
  const start = queueManager.indexOf('export async function processClassificationJob');
  const end = queueManager.indexOf('\nexport async function', start + 10);
  const source = queueManager.slice(start, end);
  assert.match(source, /processChannelThroughPipeline/);
  assert.match(source, /const channel = await getChannelById\(channelId\) \|\| outcome\.channelRecord/);
});

test('manual recheck and post-approval enrichment refresh community evidence without reclassifying confirmed trading', () => {
  const start = queueManager.indexOf('export async function triggerManualRecheck');
  const end = queueManager.indexOf('\nexport interface SearchExecutionResult', start);
  const source = queueManager.slice(start, end);
  assert.match(source, /channel\.trading_status === 'TRADING_CONFIRMED'/);
  assert.match(source, /inspectAndValidateChannel\(channel, freshCandidate/);
  assert.match(source, /Confirmed trading classification preserved/);
});

test('direct operator manual recheck is the audited correction path for confirmed creators', () => {
  const start = queueManager.indexOf('export async function triggerManualRecheck');
  const end = queueManager.indexOf('\nexport interface SearchExecutionResult', start);
  const source = queueManager.slice(start, end);
  assert.match(source, /const explicitOperatorCorrection = !attribution\?\.jobType/);
  assert.match(source, /SET LOCAL app\.force_review_rescan='on'/);
  assert.match(source, /trading_status='UNCERTAIN'/);
  assert.match(source, /scan_status='ENRICHMENT_PENDING'/);
});

test('operator admission rejection cannot silently no-op on a confirmed row', () => {
  assert.match(channelAdmission, /CONFIRMED_TRADING_REVIEW_REQUIRED/);
});

test('audited review actions are the only direct-SQL escape from a confirmed row', () => {
  assert.match(reviewStore, /if \(input\.action !== 'APPROVE'\)/);
  assert.match(reviewStore, /SET LOCAL app\.force_review_rescan='on'/);
});
