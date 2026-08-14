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

test('direct HTTP rechecks cannot bypass official ENRICHMENT quota admission', () => {
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.doesNotMatch(recheckRoute, /await triggerManualRecheck\(req\.params\.id/);
  assert.match(recheckRoute, /quota|Quota|gated|Gated/);
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
