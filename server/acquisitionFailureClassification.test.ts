import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquisitionEvidenceFromError,
  acquisitionEvidenceFromObservations,
  classifyAcquisitionFailure,
  classifyWorkStartedEvidence,
} from './acquisitionFailureClassification';

function failure(message: string, fields: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), fields);
}

test('quota and key-cap failures are capacity waits', () => {
  const quota = classifyAcquisitionFailure(failure('allocation exhausted', { code: 'QUOTA_ALLOCATION_EXHAUSTED' }));
  assert.equal(quota.failureClass, 'CAPACITY');
  assert.equal(quota.reason, 'QUOTA_ALLOCATION');
  assert.equal(quota.existingCapacityLease, true);

  const keyCap = classifyAcquisitionFailure(failure('key cap', { code: 'YOUTUBE_KEY_CAP_EXCEEDED' }));
  assert.equal(keyCap.failureClass, 'CAPACITY');
  assert.equal(keyCap.reason, 'YOUTUBE_KEY_CAP');
  assert.equal(keyCap.existingCapacityLease, true);

  const enrichment = classifyAcquisitionFailure(failure('ENRICHMENT YouTube quota allocation is exhausted'));
  assert.equal(enrichment.failureClass, 'CAPACITY');
  assert.equal(enrichment.reason, 'QUOTA_ALLOCATION');
  assert.equal(enrichment.existingCapacityLease, true);
});

test('wrapped provider quota is capacity even when the legacy predicate misses it', () => {
  const persistedMarker = classifyAcquisitionFailure(
    failure('YOUTUBE_QUOTA_EXCEEDED: Provider rate limit reached.', { code: 'YOUTUBE_QUOTA_EXCEEDED' }),
  );
  assert.equal(persistedMarker.failureClass, 'CAPACITY');
  assert.equal(persistedMarker.reason, 'QUOTA_ALLOCATION');
  assert.equal(persistedMarker.existingCapacityLease, false, 'this mismatch is the shadow evidence');

  const wrapped = classifyAcquisitionFailure(
    failure('Provider rate limit reached.', {
      code: 'RATE_LIMIT',
      quotaExceeded: true,
      providerReasons: ['quotaExceeded'],
    }),
  );
  assert.equal(wrapped.failureClass, 'CAPACITY');
  assert.equal(wrapped.reason, 'QUOTA_ALLOCATION');
  assert.equal(wrapped.evidence.quotaSignal, true);
  assert.equal(wrapped.existingCapacityLease, false);
});

test('community admission deferrals are capacity and keep their saturation reason', () => {
  const deferred = classifyAcquisitionFailure(
    failure('Community acquisition deferred: BROWSER_RUNTIME_UNAVAILABLE', {
      code: 'BROWSER_RUNTIME_UNAVAILABLE',
      retryable: true,
    }),
  );
  assert.equal(deferred.failureClass, 'CAPACITY');
  assert.equal(deferred.reason, 'COMMUNITY_CAPACITY_DEFERRAL');
  assert.equal(deferred.existingCapacityLease, true);

  const saturated = classifyAcquisitionFailure(
    failure('Community acquisition deferred: RENDERED_FALLBACK_SATURATED, RENDERED_FALLBACK_SATURATED', {
      code: 'BROWSER_RUNTIME_UNAVAILABLE',
      retryable: true,
    }),
  );
  assert.equal(saturated.failureClass, 'CAPACITY');
  assert.equal(saturated.reason, 'BROWSER_GATE_SATURATION');
  assert.equal(saturated.existingCapacityLease, true);

  const bareSaturation = classifyAcquisitionFailure(
    failure('RENDERED_FALLBACK_SATURATED', { code: 'RENDERED_FALLBACK_SATURATED', retryable: true }),
  );
  assert.equal(bareSaturation.failureClass, 'CAPACITY');
  assert.equal(bareSaturation.reason, 'BROWSER_GATE_SATURATION');
  assert.equal(bareSaturation.existingCapacityLease, true);

  const admission = classifyAcquisitionFailure(
    failure('admission unavailable', { code: 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE', retryable: true }),
  );
  assert.equal(admission.failureClass, 'CAPACITY');
  assert.equal(admission.reason, 'CAPACITY_ADMISSION_UNAVAILABLE');
  assert.equal(admission.existingCapacityLease, true);
});

test('browser runtime failures are split from capacity and record the legacy predicate', () => {
  const retryable = classifyAcquisitionFailure(
    failure('browser launch failed', { code: 'BROWSER_LAUNCH_FAILED', retryable: true }),
  );
  assert.equal(retryable.failureClass, 'BROWSER_RUNTIME');
  assert.equal(retryable.reason, 'BROWSER_RUNTIME');
  assert.equal(retryable.existingCapacityLease, true);
  assert.equal(retryable.evidence.browserFailureClass, 'BROWSER_LAUNCH_FAILED');

  const raw = classifyAcquisitionFailure(
    failure('browserType.launch: Timeout 15000ms exceeded'),
  );
  assert.equal(raw.failureClass, 'BROWSER_RUNTIME');
  assert.equal(raw.existingCapacityLease, false, 'a raw browser text has no legacy lease code');

  const missingBinary = classifyAcquisitionFailure(
    failure("executable doesn't exist at /ms-playwright/chromium", { code: 'BROWSER_BINARY_MISSING' }),
  );
  assert.equal(missingBinary.failureClass, 'BROWSER_RUNTIME');
  assert.equal(missingBinary.evidence.browserFailureClass, 'BROWSER_BINARY_MISSING');
});

test('a browser failure after real work is a genuine failure in the shadow split', () => {
  const classification = classifyAcquisitionFailure(
    failure('browser process exited', { code: 'BROWSER_LAUNCH_FAILED', retryable: true }),
    { pagesInspected: 2, requestsStarted: 4, redirectsFollowed: 1 },
  );
  assert.equal(classification.failureClass, 'GENUINE_FAILURE');
  assert.equal(classification.reason, 'BROWSER_RUNTIME_WORK_STARTED');
  assert.equal(classification.workStartedEvidence, 'PROVEN_STARTED');
  assert.equal(classification.existingCapacityLease, true, 'legacy still leases it; the shadow exposes the gap');

  const provenUnstarted = classifyAcquisitionFailure(
    failure('browser process exited', { code: 'BROWSER_LAUNCH_FAILED', retryable: true }),
    { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 },
  );
  assert.equal(provenUnstarted.failureClass, 'BROWSER_RUNTIME');
  assert.equal(provenUnstarted.workStartedEvidence, 'PROVEN_UNSTARTED');
});

test('genuine retryable and terminal failures stay in the genuine bucket', () => {
  const network = classifyAcquisitionFailure(failure('socket hang up', { code: 'ECONNRESET' }));
  assert.equal(network.failureClass, 'GENUINE_FAILURE');
  assert.equal(network.reason, 'RETRYABLE_INFRASTRUCTURE');
  assert.equal(network.existingCapacityLease, false);

  const status = classifyAcquisitionFailure(failure('upstream unavailable', { status: 503 }));
  assert.equal(status.failureClass, 'GENUINE_FAILURE');
  assert.equal(status.reason, 'RETRYABLE_INFRASTRUCTURE');

  const terminal = classifyAcquisitionFailure(failure('not found', { status: 404 }));
  assert.equal(terminal.failureClass, 'GENUINE_FAILURE');
  assert.equal(terminal.reason, 'TERMINAL_OR_UNCLASSIFIED');

  const primitive = classifyAcquisitionFailure('plain failure');
  assert.equal(primitive.failureClass, 'GENUINE_FAILURE');
  assert.equal(primitive.reason, 'TERMINAL_OR_UNCLASSIFIED');
});

test('nested causes are read without throwing', () => {
  const nested = Object.assign(new Error('wrapper'), {
    cause: { code: 'QUOTA_ALLOCATION_EXHAUSTED', message: 'nested quota' },
  });
  const classification = classifyAcquisitionFailure(nested);
  assert.equal(classification.failureClass, 'CAPACITY');
  assert.equal(classification.reason, 'QUOTA_ALLOCATION');
  assert.equal(classification.existingCapacityLease, true);

  assert.doesNotThrow(() => classifyAcquisitionFailure(null));
  assert.doesNotThrow(() => classifyAcquisitionFailure(undefined));
  assert.doesNotThrow(() => classifyAcquisitionFailure({ code: 42, message: {} }));
});

test('work-started evidence proves a start from any positive counter but needs all three for zero', () => {
  assert.equal(classifyWorkStartedEvidence(undefined), 'UNKNOWN');
  assert.equal(classifyWorkStartedEvidence({}), 'UNKNOWN');
  assert.equal(classifyWorkStartedEvidence({ pagesInspected: 0 }), 'UNKNOWN');
  // A present positive counter proves execution began even when the other
  // counters are missing; discarding it would hide a post-work crash.
  assert.equal(classifyWorkStartedEvidence({ pagesInspected: 1 }), 'PROVEN_STARTED');
  assert.equal(classifyWorkStartedEvidence({ requestsStarted: 2 }), 'PROVEN_STARTED');
  assert.equal(classifyWorkStartedEvidence({ redirectsFollowed: 1 }), 'PROVEN_STARTED');
  assert.equal(
    classifyWorkStartedEvidence({ pagesInspected: 1, requestsStarted: undefined, redirectsFollowed: 0 }),
    'PROVEN_STARTED',
  );
  assert.equal(
    classifyWorkStartedEvidence({ pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 }),
    'PROVEN_UNSTARTED',
  );
  assert.equal(
    classifyWorkStartedEvidence({ pagesInspected: 0, requestsStarted: 0, redirectsFollowed: undefined }),
    'UNKNOWN',
  );
  assert.equal(
    classifyWorkStartedEvidence({ pagesInspected: -1, requestsStarted: 0, redirectsFollowed: 0 }),
    'UNKNOWN',
  );
  // Malformed counters must never coerce to a zero and manufacture
  // PROVEN_UNSTARTED.
  for (const malformed of ['', '0', false, true, [], {}, Number.NaN, Infinity]) {
    assert.equal(
      classifyWorkStartedEvidence({
        pagesInspected: malformed as never,
        requestsStarted: 0,
        redirectsFollowed: 0,
      }),
      'UNKNOWN',
      `malformed counter ${String(malformed)} must stay UNKNOWN`,
    );
  }
});

test('evidence can be read from an error, its telemetry envelope, or its direct counters', () => {
  assert.deepEqual(acquisitionEvidenceFromError({ pagesInspected: 1 }), {
    pagesInspected: 1,
    requestsStarted: undefined,
    redirectsFollowed: undefined,
  });
  assert.deepEqual(
    acquisitionEvidenceFromError({ telemetry: { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 } }),
    { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 },
  );
  assert.deepEqual(
    acquisitionEvidenceFromError({ acquisitionEvidence: { pagesInspected: 2 } }),
    { pagesInspected: 2, requestsStarted: undefined, redirectsFollowed: undefined },
  );
  assert.equal(acquisitionEvidenceFromError(new Error('no evidence')), undefined);
  assert.equal(acquisitionEvidenceFromError(null), undefined);
});

test('inspection observations aggregate counters without hiding unknown rows', () => {
  assert.equal(acquisitionEvidenceFromObservations(undefined), undefined);
  assert.equal(acquisitionEvidenceFromObservations([]), undefined);

  assert.deepEqual(
    acquisitionEvidenceFromObservations([
      { telemetry: { pagesInspected: 2, requestsStarted: 5, redirectsFollowed: 1 } },
      { telemetry: { pagesInspected: 1, requestsStarted: 3, redirectsFollowed: 0 } },
    ]),
    { pagesInspected: 3, requestsStarted: 8, redirectsFollowed: 1 },
  );
  assert.equal(
    classifyWorkStartedEvidence(acquisitionEvidenceFromObservations([
      { telemetry: { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 } },
      { telemetry: { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 } },
    ])),
    'PROVEN_UNSTARTED',
  );

  // A missing row makes the zero total untrustworthy, but an observed positive
  // counter still proves work started.
  assert.deepEqual(
    acquisitionEvidenceFromObservations([
      { telemetry: { pagesInspected: 1, requestsStarted: undefined, redirectsFollowed: 0 } },
      { telemetry: undefined },
    ]),
    { pagesInspected: 1 },
  );
  assert.equal(
    classifyWorkStartedEvidence(acquisitionEvidenceFromObservations([
      { telemetry: { pagesInspected: 0, requestsStarted: undefined, redirectsFollowed: 0 } },
      { telemetry: undefined },
    ])),
    'UNKNOWN',
  );
});
