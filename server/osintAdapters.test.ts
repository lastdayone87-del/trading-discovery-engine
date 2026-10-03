import assert from 'node:assert/strict';
import test from 'node:test';
import { isOsintAdapterPermitted, P5_OSINT_ADAPTERS, registerOsintAdapter, resolveOsintAdapter } from './osintAdapters';

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

test('contract stubs resolve by sourceId; unknown sources and bad registrations fail closed', () => {
  assert.equal(resolveOsintAdapter('broker-interviews-stub')?.sourceFamily, 'EDUCATOR_DIRECTORY');
  assert.equal(resolveOsintAdapter('BROKER-INTERVIEWS-STUB')?.sourceFamily, 'EDUCATOR_DIRECTORY');
  assert.equal(resolveOsintAdapter('event-speakers-stub')?.sourceFamily, 'PUBLICATION');
  assert.equal(resolveOsintAdapter('no-such-source'), null);
  assert.equal(resolveOsintAdapter(''), null);
  assert.throws(() => registerOsintAdapter({ sourceId: '  ', fetch: async () => [] } as never), /OSINT_ADAPTER_REGISTRATION_INVALID/);
  assert.throws(() => registerOsintAdapter(null as never), /OSINT_ADAPTER_REGISTRATION_INVALID/);
});

test('gated runner denies before fetch and permits only fully-evidenced gates', async () => {
  const { runGatedOsintAdapter } = await import('./externalOsint');
  let fetched = 0;
  registerOsintAdapter({
    sourceId: 'test-counting-source',
    sourceFamily: 'EDUCATOR_DIRECTORY',
    timeoutMs: 1000,
    maxRequests: 5,
    maxCost: 0,
    retry: { attempts: 0, backoffMs: 0 },
    fetch: async () => {
      fetched += 1;
      return [];
    },
  });
  assert.equal(resolveOsintAdapter('test-counting-source')?.sourceId, 'test-counting-source');
  const unknown = await runGatedOsintAdapter('missing-source', { tosReviewed: true, registryCanary: true, explicitlyEnabled: true });
  assert.deepEqual({ permitted: unknown.permitted, reason: unknown.reasonCode, degraded: unknown.degraded }, {
    permitted: false,
    reason: 'OSINT_ADAPTER_UNKNOWN_SOURCE',
    degraded: true,
  });
  const closed = await runGatedOsintAdapter('test-counting-source', { tosReviewed: true, registryCanary: false, explicitlyEnabled: true });
  assert.equal(closed.permitted, false);
  assert.equal(closed.reasonCode, 'OSINT_ADAPTER_GATE_CLOSED');
  assert.equal(fetched, 0);
  const open = await runGatedOsintAdapter('test-counting-source', { tosReviewed: true, registryCanary: true, explicitlyEnabled: true });
  assert.equal(open.permitted, true);
  assert.equal(open.reasonCode, 'OSINT_ADAPTER_PERMITTED');
  assert.equal(fetched, 1);
  assert.deepEqual(open.observations, []);
});
