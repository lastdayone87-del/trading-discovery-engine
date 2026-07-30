import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadinessState, launchAfterReadiness } from './startupLifecycle';
import fs from 'node:fs';

test('HTTP readiness requires the database but has no provider dependency', () => {
  const readiness = createReadinessState();
  assert.deepEqual(readiness.snapshot(), { status: 'starting', readiness: 'not_ready', database: 'initializing' });
  readiness.markDatabaseReady();
  assert.deepEqual(readiness.snapshot(), { status: 'ok', readiness: 'ready', database: 'ready' });
});

test('HTTP 429, timeout, and synchronous provider failures cannot revoke readiness', async () => {
  const readiness = createReadinessState();
  readiness.markDatabaseReady();
  const messages: unknown[][] = [];
  launchAfterReadiness([
    { name: 'youtube-429', run: async () => { throw Object.assign(new Error('quota exhausted'), { status: 429 }); } },
    { name: 'provider-timeout', run: async () => { throw new Error('provider timeout'); } },
    { name: 'provider-init', run: () => { throw new Error('provider unavailable'); } }
  ], { error: (...args: unknown[]) => { messages.push(args); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 3);
  assert.deepEqual(readiness.snapshot(), { status: 'ok', readiness: 'ready', database: 'ready' });
});

test('durable consumers are not gated by diagnostic database reads', () => {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const listener = source.slice(source.indexOf("app.listen(PORT"));
  const workerStart = listener.indexOf('startSearchWorkers();');
  const schedulerStart = listener.indexOf('startAutonomousDiscoveryScheduler();');
  const diagnosticGate = listener.indexOf('Promise.all([getSchemaInfo(), getQueueStatus()])');
  assert.ok(workerStart >= 0 && workerStart < diagnosticGate);
  assert.ok(schedulerStart >= 0 && schedulerStart < diagnosticGate);
});
