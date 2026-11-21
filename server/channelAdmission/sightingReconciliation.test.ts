import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcileAdmissionSightings } from './store';

function capture() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    },
  };
}

test('admission success marks the original discovery sighting persisted and classification-pending', async () => {
  const { calls, client } = capture();
  const count = await reconcileAdmissionSightings({
    candidateId: '11111111-1111-1111-1111-111111111111',
    channelId: 'UCabcdefghijklmnopqrstuv',
    status: 'ADMITTED',
    client,
  });
  assert.equal(count, 1);
  assert.equal(calls.length, 1);
  const [candidateId, channelId, persisted, funnel, country, trading, metadataJson] = calls[0].params as any[];
  assert.equal(candidateId, '11111111-1111-1111-1111-111111111111');
  assert.equal(channelId, 'UCabcdefghijklmnopqrstuv');
  assert.equal(persisted, true);
  assert.equal(funnel, 'CLASSIFICATION_PENDING');
  assert.equal(country, null);
  assert.equal(trading, null);
  assert.equal(JSON.parse(metadataJson).admissionStatus, 'ADMITTED');
  assert.match(calls[0].sql, /FROM semantic_admission_sightings s, target t/);
  assert.match(calls[0].sql, /cs\.was_known=false/);
  assert.match(calls[0].sql, /cs\.page_number IS NOT DISTINCT FROM s\.page_number/);
});

test('terminal admission rejection updates the sighting without claiming persistence', async () => {
  const { calls, client } = capture();
  await reconcileAdmissionSightings({
    candidateId: '22222222-2222-2222-2222-222222222222',
    channelId: 'UCabcdefghijklmnopqrstuv',
    status: 'REJECTED_COUNTRY',
    client,
  });
  const [, , persisted, funnel, country, trading] = calls[0].params as any[];
  assert.equal(persisted, false);
  assert.equal(funnel, 'COUNTRY_REJECTED');
  assert.equal(country, 'REJECTED');
  assert.equal(trading, 'UNCERTAIN');
});

test('non-terminal provider waits leave the sighting untouched', async () => {
  const { calls, client } = capture();
  const count = await reconcileAdmissionSightings({
    candidateId: '33333333-3333-3333-3333-333333333333',
    channelId: 'UCabcdefghijklmnopqrstuv',
    status: 'PROVIDER_DEFERRED',
    client,
  });
  assert.equal(count, 0);
  assert.equal(calls.length, 0);
});

test('pending admission verdicts defer and re-open the page instead of ending the run', () => {
  const queue = readFileSync(new URL('../queueManager.ts', import.meta.url), 'utf8');
  const pageStore = readFileSync(new URL('../autonomousPageStore.ts', import.meta.url), 'utf8');
  assert.match(queue, /if \(admissionGuard\.defer && searchPage\?\.nextPageToken\)/);
  assert.match(queue, /deferAutonomousRunForAdmission\(queryRunId, pageNumber/);
  // A provisional guard stop must not write the terminal contamination reason.
  const deferIndex = queue.indexOf('if (admissionGuard.defer && searchPage?.nextPageToken)');
  const terminalIndex = queue.indexOf("'ADMISSION_CONTAMINATION'", deferIndex);
  assert.ok(deferIndex > -1 && terminalIndex > deferIndex);
  assert.match(pageStore, /markAutonomousPageDeferredForAdmission/);
  assert.match(pageStore, /should_continue=true/);
  assert.match(pageStore, /deferred_reason='ADMISSION'/);
});

test('admitted channels reconcile only after the channel write succeeds', () => {
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const start = index.indexOf('async function markChannelAdmitted');
  const end = index.indexOf('async function enqueueClassificationAfterAdmission', start);
  const body = index.slice(start, end);
  assert.match(body, /UPDATE channels SET admitted_at/);
  assert.ok(body.indexOf('UPDATE channels SET admitted_at') < body.indexOf('reconcileAdmissionSightings'));
  assert.match(body, /reconcileAdmissionSightings\(\{/);
  // Rejections happen without a channel write, so the candidate store owns
  // their terminal projection.
  const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
  assert.match(store, /updated\.status !== 'ADMITTED'/);
  assert.match(store, /reconcileAdmissionSightings\(\{/);
});
