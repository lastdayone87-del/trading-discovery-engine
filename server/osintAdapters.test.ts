import assert from 'node:assert/strict';
import test from 'node:test';
import { isOsintAdapterPermitted, P5_OSINT_ADAPTERS } from './osintAdapters';

test('osint adapters are enumerated stubs with safe defaults', () => {
  assert.equal(P5_OSINT_ADAPTERS.length, 2);
  for (const adapter of P5_OSINT_ADAPTERS) {
    assert.ok(adapter.timeoutMs <= 30000);
    assert.ok(adapter.maxRequests >= 1 && adapter.maxRequests <= 100);
  }
});

test('osint gate is fail-closed', () => {
  assert.equal(isOsintAdapterPermitted({ tosReviewed: true, registryCanary: true, explicitlyEnabled: true }), true);
  assert.equal(isOsintAdapterPermitted({ tosReviewed: false, registryCanary: true, explicitlyEnabled: true }), false);
  assert.equal(isOsintAdapterPermitted({ tosReviewed: true, registryCanary: false, explicitlyEnabled: true }), false);
  assert.equal(isOsintAdapterPermitted({ tosReviewed: true, registryCanary: true, explicitlyEnabled: false }), false);
});

test('osint stubs fetch nothing', async () => {
  const controller = new AbortController();
  for (const adapter of P5_OSINT_ADAPTERS) {
    assert.deepEqual(await adapter.fetch(controller.signal), []);
  }
});
