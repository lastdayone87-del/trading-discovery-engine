import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  RenderedAdmissionGovernor,
  RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT_DEFAULT,
  RENDERED_ADMISSION_EMERGENCY_PER_HOUR_DEFAULT,
  RENDERED_ADMISSION_NOMINAL_PER_HOUR_DEFAULT,
  renderedAdmissionGovernorEnabled,
  resolveRenderedAdmissionConfig,
} from './renderedAdmissionGovernor';

function makeGovernor(
  overrides: Partial<{
    enabled: boolean;
    nominalPerHour: number;
    emergencyPerHour: number;
    discoveryFloorPct: number;
    windowMs: number;
  }> = {},
  clock: { now: number } = { now: 0 },
): RenderedAdmissionGovernor {
  return new RenderedAdmissionGovernor({
    enabled: true,
    nominalPerHour: 40,
    emergencyPerHour: 48,
    discoveryFloorPct: 35,
    windowMs: 60_000,
    ...overrides,
  }, () => clock.now);
}

test('governor defaults and environment precedence are bounded', () => {
  const production = resolveRenderedAdmissionConfig({ NODE_ENV: 'production' });
  assert.equal(production.enabled, true);
  assert.equal(production.nominalPerHour, RENDERED_ADMISSION_NOMINAL_PER_HOUR_DEFAULT);
  assert.equal(production.emergencyPerHour, RENDERED_ADMISSION_EMERGENCY_PER_HOUR_DEFAULT);
  assert.equal(production.discoveryFloorPct, RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT_DEFAULT);

  assert.equal(resolveRenderedAdmissionConfig({ NODE_ENV: 'test' }).enabled, false);
  assert.equal(
    renderedAdmissionGovernorEnabled({ NODE_ENV: 'production', NODE_TEST_CONTEXT: 'child' }),
    false,
  );
  assert.equal(renderedAdmissionGovernorEnabled({ RENDERED_ADMISSION_GOVERNOR_ENABLED: 'true' }), true);
  assert.equal(renderedAdmissionGovernorEnabled({ RENDERED_ADMISSION_GOVERNOR_ENABLED: 'false' }), false);

  const clamped = resolveRenderedAdmissionConfig({
    RENDERED_ADMISSION_NOMINAL_PER_HOUR: '0',
    RENDERED_ADMISSION_EMERGENCY_PER_HOUR: '12',
    RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT: '150',
  });
  assert.equal(clamped.nominalPerHour, 1);
  assert.equal(clamped.emergencyPerHour, 12);
  assert.equal(clamped.discoveryFloorPct, 100);

  const emergencyClamped = resolveRenderedAdmissionConfig({
    RENDERED_ADMISSION_NOMINAL_PER_HOUR: '48',
    RENDERED_ADMISSION_EMERGENCY_PER_HOUR: '12',
  });
  assert.equal(emergencyClamped.nominalPerHour, 48);
  assert.equal(emergencyClamped.emergencyPerHour, 48, 'emergency can never fall below nominal');

  const garbage = resolveRenderedAdmissionConfig({
    RENDERED_ADMISSION_NOMINAL_PER_HOUR: 'nope',
    RENDERED_ADMISSION_EMERGENCY_PER_HOUR: 'nope',
    RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT: 'nope',
  });
  assert.equal(garbage.nominalPerHour, RENDERED_ADMISSION_NOMINAL_PER_HOUR_DEFAULT);
  assert.equal(garbage.emergencyPerHour, RENDERED_ADMISSION_EMERGENCY_PER_HOUR_DEFAULT);
  assert.equal(garbage.discoveryFloorPct, RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT_DEFAULT);

  const blank = resolveRenderedAdmissionConfig({
    RENDERED_ADMISSION_NOMINAL_PER_HOUR: '',
    RENDERED_ADMISSION_EMERGENCY_PER_HOUR: '  ',
    RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT: '',
  });
  assert.equal(blank.nominalPerHour, RENDERED_ADMISSION_NOMINAL_PER_HOUR_DEFAULT);
  assert.equal(blank.emergencyPerHour, RENDERED_ADMISSION_EMERGENCY_PER_HOUR_DEFAULT);
  assert.equal(blank.discoveryFloorPct, RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT_DEFAULT);
});

test('governor enforces the nominal 40/hour cap and frees the window', () => {
  const clock = { now: 0 };
  const governor = makeGovernor({}, clock);
  const none = new Set<never>();

  for (let index = 0; index < 40; index++) {
    assert.equal(governor.admit('DISCOVERY', none).admitted, true, `admission ${index + 1}`);
  }
  const denied = governor.admit('DISCOVERY', none);
  assert.equal(denied.admitted, false);
  assert.equal(denied.reason, 'RATE_LIMIT');
  assert.equal(denied.limit, 40);
  assert.equal(denied.emergency, false);
  assert.equal(denied.retryAtMs, 60_000);

  clock.now = 60_001;
  assert.equal(governor.admit('DISCOVERY', none).admitted, true);
});

test('governor allows the 48/hour emergency allowance only with queued demand', () => {
  const clock = { now: 0 };
  const governor = makeGovernor({}, clock);
  const none = new Set<never>();
  const queued = new Set(['RETRY'] as const);

  for (let index = 0; index < 40; index++) governor.admit('DISCOVERY', none);

  // A solitary 41st request without queued demand is rate-limited at 40.
  const solitary = governor.admit('RETRY', none, false);
  assert.equal(solitary.admitted, false);
  assert.equal(solitary.reason, 'RATE_LIMIT');
  assert.equal(solitary.limit, 40);

  // The request's own queue wait is enough demand for the emergency allowance.
  const queuedAdmission = governor.admit('RETRY', none, true);
  assert.equal(queuedAdmission.admitted, true);
  assert.equal(queuedAdmission.emergency, true);
  assert.equal(queuedAdmission.limit, 48);

  for (let index = 0; index < 7; index++) {
    assert.equal(governor.admit('RETRY', queued).admitted, true);
  }
  const denied = governor.admit('RETRY', queued);
  assert.equal(denied.admitted, false);
  assert.equal(denied.limit, 48);
  assert.equal(denied.emergency, true);
  assert.equal(governor.snapshot().admissionsInWindow, 48);
});

test('rate-limit retry time uses the expiry that frees the selected limit', () => {
  const clock = { now: 0 };
  const governor = makeGovernor({}, clock);
  const none = new Set<never>();
  const queued = new Set(['RETRY'] as const);

  for (let index = 0; index < 26; index++) {
    governor.admit('RETRY', none, false);
    clock.now += 1_000;
  }
  for (let index = 0; index < 14; index++) {
    governor.admit('DISCOVERY', none, false);
    clock.now += 1_000;
  }
  // Fill the emergency window with discovery so the final retry sees the
  // nominal 40 limit again.
  for (let index = 0; index < 8; index++) {
    governor.admit('DISCOVERY', queued, true);
    clock.now += 1_000;
  }

  const denied = governor.admit('RETRY', none, false);
  assert.equal(denied.admitted, false);
  assert.equal(denied.reason, 'RATE_LIMIT');
  assert.equal(denied.limit, 40);
  // 48 admissions, nominal 40 -> the ninth-oldest (index 8, admitted at 8s)
  // must expire: 8s + 60s = 68s, not the oldest admission at 60s.
  assert.equal(denied.retryAtMs, 68_000);
});

test('governor strictly reserves 35% of the window for DISCOVERY', () => {
  const governor = makeGovernor();
  const none = new Set<never>();
  const queued = new Set(['RETRY'] as const);

  // 26 of 40 is the non-discovery cap even when no discovery request is
  // currently queued. The unused reserve is not reassigned.
  for (let index = 0; index < 26; index++) {
    assert.equal(governor.admit('RETRY', none).admitted, true, `retry ${index + 1}`);
  }
  const blocked = governor.admit('RETRY', none);
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, 'DISCOVERY_FLOOR');
  assert.equal(blocked.retryAtMs, 60_000, 'the oldest non-discovery reservation expiry');

  for (let index = 0; index < 14; index++) {
    assert.equal(governor.admit('DISCOVERY', none).admitted, true, `discovery ${index + 1}`);
  }
  assert.equal(governor.snapshot().admissionsInWindow, 40);
  assert.equal(governor.snapshot().discoverySharePct, 35);

  // The nominal window is full; emergency demand allows the five remaining
  // non-discovery slots up to the 48/hour cap's 31 non-discovery limit.
  const emergency = governor.admit('RETRY', queued);
  assert.equal(emergency.admitted, true);
  assert.equal(emergency.limit, 48);
  assert.equal(emergency.emergency, true);
});

test('governor tracks window expiry and exposes a bounded snapshot', () => {
  const clock = { now: 0 };
  const governor = makeGovernor({}, clock);
  governor.admit('DISCOVERY', new Set());
  assert.deepEqual(governor.snapshot(), {
    enabled: true,
    nominalPerHour: 40,
    emergencyPerHour: 48,
    discoveryFloorPct: 35,
    windowMs: 60_000,
    admissionsInWindow: 1,
    discoveryAdmissionsInWindow: 1,
    discoverySharePct: 100,
    nextExpiryAtMs: 60_000,
  });

  clock.now = 60_001;
  assert.deepEqual(governor.snapshot(), {
    enabled: true,
    nominalPerHour: 40,
    emergencyPerHour: 48,
    discoveryFloorPct: 35,
    windowMs: 60_000,
    admissionsInWindow: 0,
    discoveryAdmissionsInWindow: 0,
    discoverySharePct: null,
    nextExpiryAtMs: null,
  });
});

test('disabled governor admits without tracking', () => {
  const governor = makeGovernor({ enabled: false });
  for (let index = 0; index < 100; index++) {
    assert.equal(governor.admit('RETRY', new Set()).admitted, true);
  }
  assert.equal(governor.snapshot().admissionsInWindow, 0);
  assert.equal(governor.shouldReserveDiscovery(new Set(['DISCOVERY'])), false);
});

test('governor refunds a reservation that produced no crawl work', () => {
  const governor = makeGovernor({ nominalPerHour: 1, discoveryFloorPct: 0 });
  const admission = governor.admit('RETRY', new Set());
  assert.equal(admission.admitted, true);
  assert.ok(admission.admissionId !== null);
  assert.equal(governor.snapshot().admissionsInWindow, 1);

  assert.equal(governor.refund(admission.admissionId!), true);
  assert.equal(governor.snapshot().admissionsInWindow, 0);
  assert.equal(governor.refund(admission.admissionId!), false);
});

test('inspection lane is wired into every rendered fallback call', () => {
  const inspector = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.equal(
    (inspector.match(/admissionLane:channelData\.renderedAdmissionLane/g) || []).length,
    3,
    'messaging, website, and social rendered calls must carry the lane',
  );
  assert.equal(
    (inspector.match(/retryAt:rendered\.retryAt/g) || []).length,
    3,
    'rendered observations must carry the admission retry hint',
  );
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /renderedAdmissionLane: laneAttribution\.lane/);
  assert.match(
    queue,
    /probeDeferredDiscovery === true[\s\S]{0,800}lane: 'DISCOVERY'/,
    'deferred discovery replay must stay in the DISCOVERY lane',
  );
  const fallback = readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.match(fallback, /limits\.admissionLane \|\| 'UNKNOWN'/);
  assert.match(fallback, /retryAt,telemetry/, 'saturation result must carry the governor retry hint');
  assert.match(fallback, /renderedFallbackGate\.refund\(failedAdmissionId\)/);
  assert.match(fallback, /renderedCrawlStarted\(\{ inspectedPages, telemetry \}\)/);
});
