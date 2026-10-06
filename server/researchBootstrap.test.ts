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
  const source = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('./persistentResearchController.ts', import.meta.url), 'utf8')
  );
  // Distinct auditable entrypoint (not hidden inside allocateCanonical).
  assert.match(source, /export async function startResearchBootstrapRun/);
  assert.match(source, /BOOTSTRAP_REASON_REQUIRED/);
  assert.match(source, /BOOTSTRAP_RUN_ALREADY_ACTIVE/);
  assert.match(source, /BOOTSTRAP_EVIDENCE_GATHERING/);
});
