import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadinessState, launchAfterReadiness } from './startupLifecycle';

test('HTTP readiness has no provider or database dependency', () => {
  const readiness = createReadinessState();
  assert.deepEqual(readiness.snapshot(), { status: 'starting', readiness: 'not_ready' });
  readiness.markListening();
  assert.deepEqual(readiness.snapshot(), { status: 'ok', readiness: 'ready' });
});

test('HTTP 429, timeout, and synchronous provider failures cannot revoke readiness', async () => {
  const readiness = createReadinessState();
  readiness.markListening();
  const messages: unknown[][] = [];
  launchAfterReadiness([
    { name: 'youtube-429', run: async () => { throw Object.assign(new Error('quota exhausted'), { status: 429 }); } },
    { name: 'provider-timeout', run: async () => { throw new Error('provider timeout'); } },
    { name: 'provider-init', run: () => { throw new Error('provider unavailable'); } }
  ], { error: (...args: unknown[]) => { messages.push(args); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 3);
  assert.deepEqual(readiness.snapshot(), { status: 'ok', readiness: 'ready' });
});
