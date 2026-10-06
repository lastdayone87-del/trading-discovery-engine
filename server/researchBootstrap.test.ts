import test from 'node:test';
import assert from 'node:assert/strict';

test('bootstrap bounds validation accepts only tight bounded windows', async () => {
  const { validateBootstrapBounds } = await import('./persistentResearchController');
  assert.deepEqual(validateBootstrapBounds({}), {
    maxAssignments: 30,
    maxProviderCost: 3000,
    windowHours: 168,
  });
  assert.deepEqual(validateBootstrapBounds({ maxAssignments: 5, maxProviderCost: 500, windowHours: 24 }), {
    maxAssignments: 5,
    maxProviderCost: 500,
    windowHours: 24,
  });
  for (const bad of [
    { maxAssignments: 0 },
    { maxAssignments: 31 },
    { maxAssignments: 1.5 },
    { maxProviderCost: 0 },
    { maxProviderCost: -1 },
    { windowHours: 0 },
    { windowHours: 721 },
  ]) {
    assert.throws(() => validateBootstrapBounds(bad), /INVALID_BOOTSTRAP/);
  }
});

test('bootstrap starter requires an explicit reason and actor', async () => {
  const { startResearchBootstrapRun } = await import('./persistentResearchController');
  // A well-formed UUID that cannot exist; validation rejects before any DB use.
  const candidatePolicyId = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(
    startResearchBootstrapRun({ candidatePolicyId, reason: '', actor: 'test:bootstrap' }),
    /BOOTSTRAP_REASON_REQUIRED/
  );
  await assert.rejects(
    startResearchBootstrapRun({ candidatePolicyId, reason: '   ', actor: 'test:bootstrap' }),
    /BOOTSTRAP_REASON_REQUIRED/
  );
  await assert.rejects(
    startResearchBootstrapRun({ candidatePolicyId, reason: 'test', actor: '' }),
    /BOOTSTRAP_ACTOR_REQUIRED/
  );
  await assert.rejects(
    startResearchBootstrapRun({ candidatePolicyId, reason: 'test', actor: '   ' }),
    /BOOTSTRAP_ACTOR_REQUIRED/
  );
});

test('disarmed research control is detected without allocating', async () => {
  const { isResearchDisarmed } = await import('./persistentResearchController');
  assert.equal(isResearchDisarmed(null), true);
  assert.equal(isResearchDisarmed(undefined), true);
  assert.equal(
    isResearchDisarmed({ enabled: true, mode: 'CANARY', paused: false, kill_switch: false }),
    false
  );
  for (const control of [
    { enabled: false, mode: 'CANARY', paused: false, kill_switch: false },
    { enabled: true, mode: 'CANARY', paused: true, kill_switch: false },
    { enabled: true, mode: 'CANARY', paused: false, kill_switch: true },
    { enabled: true, mode: 'SHADOW', paused: false, kill_switch: false },
  ]) {
    assert.equal(isResearchDisarmed(control), true);
  }
});
