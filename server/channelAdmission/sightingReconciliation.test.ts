import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcileAdmissionSightings, replayAdmissionOutcomesForPage } from './store';
import { markChannelAdmitted } from './index';

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
  assert.match(calls[0].sql, /cs\.funnel_outcome='NEEDS_REVIEW' AND cs\.metadata->>'sightingOutcomeSource'='ADMISSION'/);
});

test('ambiguous admission is also persisted and classification-pending', async () => {
  const { calls, client } = capture();
  await reconcileAdmissionSightings({
    candidateId: '44444444-4444-4444-4444-444444444444',
    channelId: 'UCabcdefghijklmnopqrstuv',
    status: 'ADMITTED_AMBIGUOUS',
    client,
  });
  const [, , persisted, funnel] = calls[0].params as any[];
  assert.equal(persisted, true);
  assert.equal(funnel, 'CLASSIFICATION_PENDING');
  assert.equal(JSON.parse(calls[0].params![6] as string).admissionStatus, 'ADMITTED_AMBIGUOUS');
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

test('page-scoped replay repairs verdicts that landed before sighting insertion', async () => {
  const { calls, client } = capture();
  const count = await replayAdmissionOutcomesForPage({
    queryRunId: '55555555-5555-5555-5555-555555555555',
    pageNumber: 3,
    client,
  });
  assert.equal(count, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params?.slice(0, 2), ['55555555-5555-5555-5555-555555555555', 3]);
  const sql = calls[0].sql;
  assert.match(sql, /WITH scoped AS MATERIALIZED/);
  assert.match(sql, /FROM semantic_admission_candidates c[\s\S]*FOR SHARE/);
  assert.match(sql, /lc\.status IN \(/);
  assert.match(sql, /'ADMITTED','ADMITTED_AMBIGUOUS','REJECTED_COUNTRY','REJECTED_UNRELATED'/);
  assert.match(sql, /cs\.metadata->>'admissionStatus' IS DISTINCT FROM lc\.status/);
  assert.match(sql, /cs\.funnel_outcome='NEEDS_REVIEW' AND cs\.metadata->>'sightingOutcomeSource'='ADMISSION'/);
  assert.match(sql, /s\.result_rank IS NULL OR s\.result_rank=cs\.result_rank/);
  // The final UPDATE must re-check the predicate after a possible lock wait;
  // the CTE check alone can observe a stale pre-classification snapshot.
  assert.ok((sql.match(/cs\.funnel_outcome IS NULL/g) || []).length >= 2);
  assert.ok((sql.match(/sightingOutcomeSource'='ADMISSION/g) || []).length >= 2);
});

test('markChannelAdmitted writes the channel first, then reconciles the sighting', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id FROM semantic_admission_candidates')) {
        return { rows: [{ id: '66666666-6666-6666-6666-666666666666' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  await markChannelAdmitted({
    channelId: 'UCabcdefghijklmnopqrstuv',
    decisionId: 'decision-1',
    status: 'ADMITTED',
  }, client);
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /UPDATE channels SET admitted_at/);
  assert.match(calls[1].sql, /SELECT id FROM semantic_admission_candidates/);
  assert.match(calls[2].sql, /UPDATE channel_sightings cs/);
  assert.equal(calls[2].params?.[0], '66666666-6666-6666-6666-666666666666');
  assert.equal(calls[2].params?.[1], 'UCabcdefghijklmnopqrstuv');
  assert.equal(calls[2].params?.[2], true);
});

test('a failed candidate lookup fails admission instead of silently skipping reconciliation', async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes('SELECT id FROM semantic_admission_candidates')) throw new Error('lookup failed');
      return { rows: [], rowCount: 1 };
    },
  };
  await assert.rejects(
    markChannelAdmitted({
      channelId: 'UCabcdefghijklmnopqrstuv',
      decisionId: 'decision-1',
      status: 'ADMITTED',
    }, client),
    /lookup failed/,
  );
});

test('pending admission verdicts defer only continuable pages and never write contamination', () => {
  const queue = readFileSync(new URL('../queueManager.ts', import.meta.url), 'utf8');
  const pageStore = readFileSync(new URL('../autonomousPageStore.ts', import.meta.url), 'utf8');
  const deferStart = queue.indexOf('const admissionPagePending');
  const deferReturn = queue.indexOf('return true;', deferStart);
  assert.ok(deferStart > -1 && deferReturn > deferStart, 'admission defer branch must exist');
  const deferBlock = queue.slice(deferStart, deferReturn);
  assert.match(deferBlock, /admissionPageOutcomes\?\.pending/);
  assert.match(deferBlock, /continuationEnabled/);
  assert.match(deferBlock, /decision\.shouldContinue === true/);
  assert.doesNotMatch(deferBlock, /ADMISSION_CONTAMINATION/);
  const terminalIndex = queue.indexOf("'ADMISSION_CONTAMINATION'", deferReturn);
  assert.ok(terminalIndex > deferReturn, 'terminal contamination must only follow the provisional return');
  assert.match(queue, /admissionGuard\.stop && !admissionGuard\.defer/);
  assert.match(pageStore, /markAutonomousPageDeferredForAdmission/);
  assert.match(pageStore, /AND should_continue=true/);
  assert.match(pageStore, /AND stopping_reason IS NULL/);
  assert.match(pageStore, /deferred_reason='ADMISSION'/);
});

test('the resume boundary waits for page-level settlement and re-applies the guard', () => {
  const queue = readFileSync(new URL('../queueManager.ts', import.meta.url), 'utf8');
  const gate = queue.indexOf("lastObservation?.deferredReason === 'ADMISSION'");
  const settle = queue.indexOf('getAdmissionPageOutcomes(run.runId, run.pagesCompleted)', gate);
  const replay = queue.indexOf('replayPageAdmissionOutcomesSafe(run.runId, run.pagesCompleted, true)', settle);
  const guard = queue.indexOf('settledGuard.stop && !settledGuard.defer', replay);
  assert.ok(
    gate > -1 && settle > gate && replay > settle && guard > replay,
    'resume boundary must settle, replay, then re-apply the guard in order',
  );
  assert.match(queue, /Number\(pageOutcomes\.pending \|\| 0\) > 0/);
  assert.match(queue, /getAutonomousPageSettledGuardMetrics\(run\.runId, run\.pagesCompleted\)/);
  assert.match(queue, /priorZeroQualityPages: priorState\.v2Streaks\.lowValue/);
  assert.match(
    queue,
    /recordAutonomousPage\(pageObservation\);[\s\S]*replayPageAdmissionOutcomesSafe\(queryRunId, pageNumber, true\)/,
  );
});
