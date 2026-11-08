import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACQUISITION_LANES,
  ACQUISITION_OUTCOMES,
  acquisitionLaneForJobType,
  isConclusiveExternalBlock,
  sanitizeAcquisitionAttribution,
  summarizeAcquisitionInspection,
  type AcquisitionLaneInspection,
} from './acquisitionLaneTaxonomy';
import {
  acquisitionLaneTelemetryEnabled,
  recordAcquisitionInspectionEvent,
  recordAcquisitionLaneEvent,
} from './acquisitionLaneTelemetry';
import {
  BULK_ENQUEUE_TRANSACTION_WARNING_THRESHOLD,
  BulkEnqueueGuardError,
  admitBulkEnqueue,
  resolveBulkEnqueueGuardConfig,
  resetBulkEnqueueGuardForTests,
  withBulkEnqueueTransaction,
} from './acquisitionBulkEnqueueGuard';
import {
  operationsTelemetrySnapshot,
  resetOperationsTelemetry,
} from './operationsTelemetry';
import { safeCrawlerTelemetry } from './crawlerTelemetry';

test.beforeEach(() => {
  resetOperationsTelemetry();
  resetBulkEnqueueGuardForTests();
});

test('lane taxonomy is closed and maps durable job types without silent drift', () => {
  assert.deepEqual([...ACQUISITION_LANES], ['DISCOVERY', 'ENRICHMENT', 'RETRY', 'MANUAL', 'MAINTENANCE', 'UNKNOWN']);
  assert.equal(acquisitionLaneForJobType('SEARCH_YOUTUBE'), 'DISCOVERY');
  assert.equal(acquisitionLaneForJobType('ENRICH_CHANNEL'), 'ENRICHMENT');
  assert.equal(acquisitionLaneForJobType('RETRY_COMMUNITY_ACQUISITION'), 'RETRY');
  assert.equal(acquisitionLaneForJobType('MANUAL_SEARCH_PAGE'), 'MANUAL');
  assert.equal(acquisitionLaneForJobType('TERM_HARVEST'), 'MAINTENANCE');
  assert.equal(acquisitionLaneForJobType('FUTURE_UNMAPPED_JOB'), 'UNKNOWN');
});

test('attribution sanitizer drops unknown lanes and bounds every field', () => {
  assert.equal(sanitizeAcquisitionAttribution({ lane: 'NOT_A_LANE' }), undefined);
  assert.equal(sanitizeAcquisitionAttribution(null), undefined);
  const sanitized = sanitizeAcquisitionAttribution({
    lane: 'RETRY',
    jobType: `  ${'x'.repeat(200)}  `,
    jobId: 'job-1',
    channelId: 'chan-1',
    slicePass: -3,
    workRemaining: 1_000_000,
  });
  assert.ok(sanitized);
  assert.equal(sanitized.lane, 'RETRY');
  assert.equal(sanitized.jobType!.length, 96);
  assert.equal(sanitized.jobId, 'job-1');
  assert.equal(sanitized.channelId, 'chan-1');
  assert.equal(sanitized.slicePass, undefined);
  assert.equal(sanitized.workRemaining, 999999);
});

test('never executed is reserved for no work signal', () => {
  assert.equal(summarizeAcquisitionInspection({ inspection: null }).outcome, 'NEVER_EXECUTED');
  assert.equal(
    summarizeAcquisitionInspection({ inspection: { acquisitionStatus: 'INCONCLUSIVE' } }).outcome,
    'INCONCLUSIVE',
  );
  assert.equal(
    summarizeAcquisitionInspection({
      inspection: { acquisitionOutcomes: [{ required: true, outcome: 'INSPECTED_NO_MATCH', telemetry: { requestsStarted: 1 } }] },
    }).outcome,
    'INCONCLUSIVE',
    'a started request alone cannot certify a clean no-match',
  );
  assert.equal(
    summarizeAcquisitionInspection({
      inspection: { acquisitionOutcomes: [{ required: true, outcome: 'INSPECTED_NO_MATCH', telemetry: { pagesInspected: 1 } }] },
    }).outcome,
    'INSPECTED_NO_MATCH',
  );
});

test('acquired and external blocking require affirmative evidence', () => {
  const found = summarizeAcquisitionInspection({
    inspection: { acquisitionOutcomes: [{ required: true, outcome: 'FOUND' }] },
  });
  assert.equal(found.outcome, 'ACQUIRED');

  const bareFailure = summarizeAcquisitionInspection({
    inspection: {
      acquisitionOutcomes: [{ required: true, outcome: 'ACQUISITION_FAILED', retryable: false, failureClass: 'HTTP_403' }],
    },
  });
  assert.equal(bareFailure.outcome, 'ACQUISITION_FAILED');
  assert.equal(isConclusiveExternalBlock({ outcome: 'ACQUISITION_FAILED', retryable: false, failureClass: 'HTTP_403' }), false);

  const confirmedBlock = summarizeAcquisitionInspection({
    inspection: {
      acquisitionOutcomes: [{ required: true, outcome: 'ACQUISITION_FAILED', retryable: false, failureClass: 'LOGIN_WALL' }],
    },
  });
  assert.equal(confirmedBlock.outcome, 'EXTERNALLY_BLOCKED');

  const staticTerminal = summarizeAcquisitionInspection({
    inspection: {
      acquisitionOutcomes: [{ required: true, outcome: 'ACQUISITION_FAILED', retryable: false, staticTerminalNotFound: true }],
    },
  });
  assert.equal(staticTerminal.outcome, 'EXTERNALLY_BLOCKED');
});

test('capacity and browser-runtime waits never masquerade as acquisition failures', () => {
  const capacity = summarizeAcquisitionInspection({
    retryDirective: { code: 'RENDERED_FALLBACK_SATURATED', retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE' },
  });
  assert.equal(capacity.outcome, 'CAPACITY_DEFERRED');
  assert.equal(capacity.capacityEvent, 'RENDERED_FALLBACK_SATURATED');

  const runtimeWait = summarizeAcquisitionInspection({
    retryDirective: { code: 'BROWSER_RUNTIME_UNAVAILABLE', retryReason: 'BROWSER_RUNTIME_UNAVAILABLE' },
  });
  assert.equal(runtimeWait.outcome, 'RUNTIME_UNAVAILABLE');

  const runtimeAfterStart = summarizeAcquisitionInspection({
    retryDirective: { code: 'BROWSER_RUNTIME_UNAVAILABLE', retryReason: 'BROWSER_RUNTIME_UNAVAILABLE' },
    inspection: { acquisitionOutcomes: [{ required: true, outcome: 'INSPECTED_NO_MATCH', telemetry: { requestsStarted: 1 } }] },
  });
  assert.equal(runtimeAfterStart.outcome, 'INCONCLUSIVE');

  const infrastructure = summarizeAcquisitionInspection({
    inspection: {
      acquisitionOutcomes: [{ required: true, outcome: 'ACQUISITION_FAILED', retryable: false, failureClass: 'BROWSER_LAUNCH_FAILED' }],
    },
  });
  assert.equal(infrastructure.outcome, 'RUNTIME_UNAVAILABLE');

  const quotaCapacity = summarizeAcquisitionInspection({
    retryDirective: { code: 'YOUTUBE_KEY_CAP_EXCEEDED', reason: 'YOUTUBE_KEY_CAP_EXCEEDED' },
  });
  assert.equal(quotaCapacity.outcome, 'CAPACITY_DEFERRED');
});

test('retryable work remaining is counted without inventing clean outcomes', () => {
  const partial = summarizeAcquisitionInspection({
    inspection: {
      acquisitionOutcomes: [{
        required: true,
        outcome: 'PARTIALLY_INSPECTED',
        retryable: true,
        surface: 'OTHER',
        requestedUrl: 'https://example.com/community',
      }],
    },
  });
  assert.equal(partial.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(partial.workRemaining, 1);
  assert.equal(partial.signals.retryOwningObservations, 1);
});

test('lane telemetry flag is default-off and the writer never touches the database when off', async () => {
  assert.equal(acquisitionLaneTelemetryEnabled({}), false);
  assert.equal(acquisitionLaneTelemetryEnabled({ ACQUISITION_LANE_TELEMETRY_ENABLED: 'true' }), true);

  let queries = 0;
  const written = await recordAcquisitionLaneEvent({
    attribution: { lane: 'DISCOVERY', channelId: 'chan-1', jobId: 'job-1' },
    outcome: 'INSPECTED_NO_MATCH',
    summary: {
      pagesInspected: 2,
      requestsStarted: 3,
      gateWaitMs: 1200,
      workRemaining: 0,
      signals: {
        observations: 1,
        requiredObservations: 1,
        foundObservations: 0,
        failedObservations: 0,
        partialObservations: 0,
        inspectedNoMatchObservations: 1,
        retryOwningObservations: 0,
        infrastructureFailureObservations: 0,
        conclusiveBlockObservations: 0,
        processedObservations: 1,
      },
    },
  }, {
    enabled: () => false,
    query: async () => { queries += 1; return undefined; },
  });
  assert.equal(written, false);
  assert.equal(queries, 0);
  const snapshot = operationsTelemetrySnapshot();
  assert.equal(snapshot.acquisitionLaneEventsTotal.DISCOVERY.INSPECTED_NO_MATCH, 1);
  assert.equal(snapshot.acquisitionLanePagesInspectedTotal.DISCOVERY, 2);
  assert.equal(snapshot.acquisitionLaneGateWaitMsTotal.DISCOVERY, 1200);
  assert.equal(snapshot.acquisitionLaneGateWaitMaxMs.DISCOVERY, 1200);
});

test('lane telemetry writer appends one bounded row when enabled', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const written = await recordAcquisitionLaneEvent({
    attribution: { lane: 'RETRY', channelId: 'chan-2', jobId: 'job-2', jobType: 'RETRY_COMMUNITY_ACQUISITION', slicePass: 1 },
    outcome: 'ACQUIRED',
    summary: {
      pagesInspected: 1,
      requestsStarted: 1,
      workRemaining: 0,
      signals: {
        observations: 1,
        requiredObservations: 1,
        foundObservations: 1,
        failedObservations: 0,
        partialObservations: 0,
        inspectedNoMatchObservations: 0,
        retryOwningObservations: 0,
        infrastructureFailureObservations: 0,
        conclusiveBlockObservations: 0,
        processedObservations: 1,
      },
    },
    detail: { note: 'bounded', ignored: { nested: true }, ['bad key']: 'x' },
  }, {
    enabled: () => true,
    query: async (sql, values) => { calls.push({ sql, values }); return undefined; },
  });
  assert.equal(written, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO acquisition_lane_events/);
  assert.match(calls[0].sql, /ON CONFLICT\(event_key\) DO NOTHING/);
  assert.equal(calls[0].values[1], 'RETRY');
  assert.equal(calls[0].values[2], 'ACQUIRED');
  assert.equal(calls[0].values[5], 'chan-2');
  assert.equal(calls[0].values[6], 1);
  const detail = JSON.parse(String(calls[0].values[12]));
  assert.equal(detail.note, 'bounded');
  assert.equal(detail.ignored, undefined, 'nested detail values are dropped');
  assert.equal(detail.observations, 1);
  assert.equal(detail.processedObservations, 1);
});

test('inspection wrapper returns the summary even when persistence is off', async () => {
  const summary = await recordAcquisitionInspectionEvent({
    attribution: { lane: 'MANUAL', channelId: 'chan-3' },
    channelId: 'chan-3',
    inspection: { acquisitionStatus: 'INCONCLUSIVE' },
  }, { enabled: () => false });
  assert.equal(summary?.outcome, 'INCONCLUSIVE');
});

test('bulk enqueue warning is always on above the fixed threshold', async () => {
  const config = { enabled: false, maxPerTransaction: 1000, maxPerHour: 1000 };
  await withBulkEnqueueTransaction('warning-test', async () => {
    for (let index = 0; index < BULK_ENQUEUE_TRANSACTION_WARNING_THRESHOLD + 1; index += 1) {
      const decision = admitBulkEnqueue({ label: 'warning-test', now: 1_000 + index, config });
      assert.equal(decision.allowed, true);
    }
  });
  assert.equal(operationsTelemetrySnapshot().bulkEnqueueWarningsTotal, 1);
});

test('bulk enqueue guard caps one logical transaction only when enabled', async () => {
  const config = { enabled: true, maxPerTransaction: 2, maxPerHour: 100 };
  const decisions: boolean[] = [];
  await withBulkEnqueueTransaction('cap-test', async () => {
    for (let index = 0; index < 3; index += 1) {
      decisions.push(admitBulkEnqueue({ now: 1_000 + index, config }).allowed);
    }
  });
  assert.deepEqual(decisions, [true, true, false]);
  assert.equal(operationsTelemetrySnapshot().bulkEnqueueGuardBlocksTotal.transaction, 1);
});

test('bulk enqueue guard treats a shared database client as one transaction', () => {
  const client = {};
  const config = { enabled: true, maxPerTransaction: 1, maxPerHour: 100 };
  assert.equal(admitBulkEnqueue({ client, now: 1, config }).allowed, true);
  const blocked = admitBulkEnqueue({ client, now: 2, config });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.kind, 'transaction');
  // A different client is a different transaction.
  assert.equal(admitBulkEnqueue({ client: {}, now: 3, config }).allowed, true);
});

test('bulk enqueue hourly cap blocks a process-wide burst when enabled', () => {
  const config = { enabled: true, maxPerTransaction: 10, maxPerHour: 2 };
  assert.equal(admitBulkEnqueue({ now: 1_000, config }).allowed, true);
  assert.equal(admitBulkEnqueue({ now: 2_000, config }).allowed, true);
  const blocked = admitBulkEnqueue({ now: 3_000, config });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.kind, 'hour');
});

test('bulk guard config parsing is bounded and default-off', () => {
  assert.deepEqual(resolveBulkEnqueueGuardConfig({}), {
    enabled: false,
    maxPerTransaction: 250,
    maxPerHour: 500,
  });
  assert.deepEqual(resolveBulkEnqueueGuardConfig({
    ACQUISITION_BULK_ENQUEUE_GUARD_ENABLED: 'true',
    ACQUISITION_BULK_ENQUEUE_MAX_PER_TRANSACTION: '0',
    ACQUISITION_BULK_ENQUEUE_MAX_PER_HOUR: '9999999',
  }), {
    enabled: true,
    maxPerTransaction: 1,
    maxPerHour: 1_000_000,
  });
});

test('typed guard errors are explicit, never silent drops', () => {
  const error = new BulkEnqueueGuardError('hour', 500);
  assert.equal(error.code, 'BULK_ENQUEUE_HOURLY_CAP_EXCEEDED');
  assert.equal(error.kind, 'hour');
  assert.match(error.message, /500 acquisition jobs/);
});

test('crawler telemetry persists bounded lane attribution and gate wait', () => {
  const telemetry = safeCrawlerTelemetry({
    mode: 'RENDERED',
    pagesInspected: 1,
    acquisitionLane: 'ENRICHMENT',
    acquisitionJobType: 'ENRICH_CHANNEL',
    acquisitionSlicePass: 1,
    acquisitionWorkRemaining: 3,
    gateWaitMs: 120_000,
  });
  assert.ok(telemetry);
  assert.equal(telemetry.acquisitionLane, 'ENRICHMENT');
  assert.equal(telemetry.acquisitionJobType, 'ENRICH_CHANNEL');
  assert.equal(telemetry.acquisitionSlicePass, 1);
  assert.equal(telemetry.acquisitionWorkRemaining, 3);
  assert.equal(telemetry.gateWaitMs, 120_000);

  const invalid = safeCrawlerTelemetry({
    mode: 'STATIC',
    acquisitionLane: 'NOT_REAL',
    gateWaitMs: 999_999_999,
  });
  assert.ok(invalid);
  assert.equal(invalid.acquisitionLane, undefined);
  assert.equal(invalid.gateWaitMs, 86_400_000);
});

test('migration 168 is additive, closed-taxonomy, and append-only', async () => {
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('./db/migrations/168_acquisition_lane_telemetry.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.acquisition_lane_events/);
  assert.match(migration, /event_key TEXT NOT NULL UNIQUE/);
  for (const lane of ACQUISITION_LANES) assert.match(migration, new RegExp(`'${lane}'`));
  for (const outcome of ACQUISITION_OUTCOMES) assert.match(migration, new RegExp(`'${outcome}'`));
  assert.match(migration, /BEFORE UPDATE OR DELETE ON public\.acquisition_lane_events/);
  assert.match(migration, /ACQUISITION_LANE_EVENT_IMMUTABLE/);
  assert.match(migration, /jsonb_typeof\(detail\) = 'object'/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.(jobs|external_acquisition_observations|channels)/);
  assert.doesNotMatch(migration, /UPDATE\s+public\.acquisition_lane_events|DELETE\s+FROM\s+public\.acquisition_lane_events/i);
});

test('inspection classification covers the full outcome vocabulary', () => {
  const outcomes = new Set<string>();
  const cases: AcquisitionLaneInspection[] = [
    { acquisitionOutcomes: [{ required: true, outcome: 'FOUND' }] },
    { acquisitionOutcomes: [{ required: true, outcome: 'INSPECTED_NO_MATCH', telemetry: { pagesInspected: 1 } }] },
    { acquisitionOutcomes: [{ required: true, outcome: 'PARTIALLY_INSPECTED', retryable: true }] },
    { acquisitionOutcomes: [{ required: true, outcome: 'ACQUISITION_FAILED', failureClass: 'LOGIN_WALL' }] },
    { acquisitionOutcomes: [{ required: true, outcome: 'ACQUISITION_FAILED', failureClass: 'HTTP_403' }] },
    { acquisitionOutcomes: [{ required: true, outcome: 'ACQUISITION_FAILED', failureClass: 'BROWSER_LAUNCH_FAILED' }] },
  ];
  for (const inspection of cases) outcomes.add(summarizeAcquisitionInspection({ inspection }).outcome);
  outcomes.add(summarizeAcquisitionInspection({ retryDirective: { code: 'RENDERED_FALLBACK_SATURATED' } }).outcome);
  outcomes.add(summarizeAcquisitionInspection({ retryDirective: { code: 'BROWSER_RUNTIME_UNAVAILABLE', retryReason: 'BROWSER_RUNTIME_UNAVAILABLE' } }).outcome);
  outcomes.add(summarizeAcquisitionInspection({ inspection: null }).outcome);
  outcomes.add(summarizeAcquisitionInspection({ inspection: { acquisitionStatus: 'INCONCLUSIVE' } }).outcome);
  assert.deepEqual([...outcomes].sort(), [...ACQUISITION_OUTCOMES].sort());
});
