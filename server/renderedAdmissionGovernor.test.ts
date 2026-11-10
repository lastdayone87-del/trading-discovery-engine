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
});

test('governor enforces the nominal 40/hour cap and frees the window', () => {
  const clock = { now: 0 };
  const governor = makeGovernor({}, clock);
  const none = new Set<never>();

  for (let index = 0; index < 40; index++) {
    assert.equal(governor.admit('RETRY', none).admitted, true, `admission ${index + 1}`);
  }
  const denied = governor.admit('RETRY', none);
  assert.equal(denied.admitted, false);
  assert.equal(denied.reason, 'RATE_LIMIT');
  assert.equal(denied.limit, 40);
  assert.equal(denied.emergency, false);
  assert.equal(denied.retryAtMs, 60_000);

  clock.now = 60_001;
  assert.equal(governor.admit('RETRY', none).admitted, true);
});

test('governor allows the 48/hour emergency allowance only with queued demand', () => {
  const clock = { now: 0 };
  const governor = makeGovernor({}, clock);
  const none = new Set<never>();
  const queued = new Set(['RETRY'] as const);

  for (let index = 0; index < 40; index++) governor.admit('RETRY', none);

  const emergencyAdmission = governor.admit('RETRY', queued);
  assert.equal(emergencyAdmission.admitted, true);
  assert.equal(emergencyAdmission.emergency, true);
  assert.equal(emergencyAdmission.limit, 48);

  for (let index = 0; index < 7; index++) {
    assert.equal(governor.admit('RETRY', queued).admitted, true);
  }
  const denied = governor.admit('RETRY', queued);
  assert.equal(denied.admitted, false);
  assert.equal(denied.limit, 48);
  assert.equal(denied.emergency, true);
  assert.equal(governor.snapshot().admissionsInWindow, 48);
});

test('governor reserves DISCOVERY slots when discovery work is queued', () => {
  const governor = makeGovernor();
  const none = new Set<never>();
  const queued = new Set(['DISCOVERY'] as const);

  assert.equal(governor.admit('RETRY', none).admitted, true, 'no discovery demand means no reservation');

  const blocked = governor.admit('RETRY', queued);
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, 'DISCOVERY_FLOOR');

  assert.equal(governor.admit('DISCOVERY', queued).admitted, true);
  const stillBlocked = governor.admit('RETRY', queued);
  assert.equal(stillBlocked.admitted, false);
  assert.equal(stillBlocked.reason, 'DISCOVERY_FLOOR');

  assert.equal(governor.admit('DISCOVERY', queued).admitted, true);
  assert.equal(governor.admit('RETRY', queued).admitted, true);
  assert.equal(governor.snapshot().discoverySharePct, 50);
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

test('inspection lane is wired into every rendered fallback call', () => {
  const inspector = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.equal(
    (inspector.match(/admissionLane:channelData\.renderedAdmissionLane/g) || []).length,
    3,
    'messaging, website, and social rendered calls must carry the lane',
  );
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /renderedAdmissionLane: laneAttribution\.lane/);
  const fallback = readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.match(fallback, /limits\.admissionLane \|\| 'UNKNOWN'/);
});
