import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const workers = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');

const routeStart = server.indexOf("app.post('/api/channels/:id/recheck'");
const routeEnd = server.indexOf('// 6. Get country vocabularies', routeStart);
const recheckRoute = server.slice(routeStart, routeEnd);
const manualStart = queue.indexOf('export async function triggerManualRecheck');
const manualEnd = queue.indexOf('export interface SearchExecutionResult', manualStart);
const manualRecheck = queue.slice(manualStart, manualEnd);
const classifierStart = queue.indexOf('function classifyManualRecheckAcquisitionFailure');
const classifierEnd = queue.indexOf('/**\n * Triggers a manual re-scan', classifierStart);
const failureClassifier = queue.slice(classifierStart, classifierEnd);

test('direct HTTP rechecks cannot bypass official ENRICHMENT quota admission', () => {
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(recheckRoute, /await triggerManualRecheck\(req\.params\.id/);
  const reserve = manualRecheck.indexOf("reserveOfficialRecheckQuota('MANUAL_RECHECK'");
  const acquisition = manualRecheck.indexOf('fetchYouTubeChannelEnrichment');
  assert.ok(reserve >= 0 && acquisition > reserve);
  assert.match(manualRecheck, /quotaAlreadyReserved/);
  assert.match(manualRecheck, /finishQuotaReservation\('MANUAL_RECHECK'/);
});

test('manual acquisition failures do not mark every upstream exception retryable', () => {
  assert.ok(manualStart >= 0 && manualEnd > manualStart);
  const acquisition = manualRecheck.slice(
    manualRecheck.indexOf('fetchYouTubeChannelEnrichment'),
    manualRecheck.indexOf('freshCandidate.enrichmentStage')
  );
  assert.doesNotMatch(acquisition, /retryable:\s*true/);
  assert.match(acquisition, /errorClass|retryable/);
});

test('false-negative recovery maps only typed transient failures to attempt-free retries', () => {
  assert.match(workers, /result\.errorClass|typedTransient|TRANSIENT/);
  assert.doesNotMatch(workers, /errorClass:\s*retryable\s*\?\s*'TRANSIENT'/);
});

test('attempt-free recovery requires explicit upstream transient typing', () => {
  assert.ok(classifierStart >= 0 && classifierEnd > classifierStart);
  assert.match(failureClassifier, /error\?\.retryable === true/);
  assert.match(failureClassifier, /MANUAL_RECHECK_TRANSIENT_CLASSES\.has\(rawErrorClass\)/);
  assert.doesNotMatch(failureClassifier, /status === 429/);
  assert.doesNotMatch(failureClassifier, /MANUAL_RECHECK_TRANSIENT_CODES/);
  assert.doesNotMatch(failureClassifier, /temporar|cooling down|network failure|socket hang up/i);
});
