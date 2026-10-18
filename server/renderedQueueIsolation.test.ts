import test from 'node:test';
import assert from 'node:assert/strict';
import { Configuration, RequestQueue, type Request } from 'crawlee';
import {
  captureRenderedQueueLifecycleListeners,
  dropIsolatedRenderedQueue,
  openIsolatedRenderedRequestQueue,
  reclaimRenderedQueueLifecycleListeners,
  renderedQueueLifecycleEmitter,
  type RenderedQueueLifecycleEmitter,
} from './browserCommunityFallback';

// No-browser regression coverage for per-crawl RequestQueue isolation.
// Production proved repeat crawls of already-handled seed URLs resolve with
// zero requests/pages through the shared default persisted queue; these tests
// pin the isolation semantics with real Crawlee queues on throwaway
// pure-memory storage (persistStorage:false — never the repo ./storage,
// never a browser). They also pin the listener-reclamation lifecycle: Crawlee
// 3.18 registers anonymous process-wide `migrating`/`aborting` listeners for
// every RequestQueue instance and never removes them, so dropped per-crawl
// queues (and their ~16 MB RequestDeduplicationCache) stayed retained until
// the process hit its heap limit. Reclamation must remove exactly the
// listeners added during one serialized crawl and nothing else.

function isolatedTestConfig() {
  return { config: new Configuration({ persistStorage: false }) };
}

async function markHandled(queue: RequestQueue, url: string): Promise<void> {
  const added = await queue.addRequest({ url });
  assert.ok(added.requestId);
  await queue.markRequestHandled({ id: added.requestId!, uniqueKey: added.uniqueKey!, url } as Request);
}

async function fetchSoon(queue: RequestQueue): Promise<unknown> {
  // Freshly added requests can take a moment to become fetchable (storage
  // consistency delay); poll briefly instead of asserting timing behavior.
  for (let i = 0; i < 100; i++) {
    const next = await queue.fetchNextRequest();
    if (next) return next;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

/** Minimal in-memory stand-in for Crawlee's process-wide AsyncEventEmitter,
 * used to pin the capture/reclaim contract without touching real storages. */
function createTestEmitter(
  seed: Record<string, unknown[]> = {},
): RenderedQueueLifecycleEmitter & { add(event: string, listener: unknown): void } {
  const registry = new Map<string, unknown[]>(
    Object.entries(seed).map(([event, listeners]) => [event, [...listeners]]),
  );
  return {
    listeners: (event: string) => [...(registry.get(event) ?? [])],
    off: (event: string, listener: unknown) => {
      registry.set(event, (registry.get(event) ?? []).filter(candidate => candidate !== listener));
      return undefined;
    },
    add: (event: string, listener: unknown) => {
      registry.set(event, [...(registry.get(event) ?? []), listener]);
    },
  };
}

test('shared queue reproduces the production skip: handled URL is not redispatched', async () => {
  const { config } = isolatedTestConfig();
  // Production shares one default queue per process (StorageManager cache).
  // Crawl 1 dispatches and handles the seed; crawl 2 finds nothing to fetch:
  // the handled request is filtered at fetch time, so the run resolves with
  // zero requests and zero errors — the exact production signature.
  const shared = await RequestQueue.open('shared-repro', { config });
  await markHandled(shared, 'https://repeat.example/community');
  assert.equal(await shared.fetchNextRequest(), null);
  // Control: the same URL on a queue where it was never handled IS fetchable.
  const control = await RequestQueue.open('shared-repro-control', { config });
  await control.addRequest({ url: 'https://repeat.example/community' });
  assert.ok(await fetchSoon(control));
  await shared.drop().catch(() => undefined);
  await control.drop().catch(() => undefined);
});

test('separate isolated queues dispatch the same URL in every invocation', async (t) => {
  const { config } = isolatedTestConfig();
  // Crawl invocation 1 handles the seed...
  const first = await RequestQueue.open('rendered-community-call-1', { config });
  await markHandled(first, 'https://retry.example/invite');
  await first.drop().catch(() => undefined);
  // ...retry invocation 2 (fresh isolated queue) dispatches it again.
  const second = await RequestQueue.open('rendered-community-call-2', { config });
  const readded = await second.addRequest({ url: 'https://retry.example/invite' });
  assert.equal(readded.wasAlreadyHandled, false);
  assert.ok(await fetchSoon(second));
  await second.drop().catch(() => undefined);
});

test('duplicate requests stay deduplicated within one crawl invocation', async (t) => {
  const { config } = isolatedTestConfig();
  const queue = await RequestQueue.open('rendered-community-single', { config });
  await queue.addRequest({ url: 'https://dup.example/page' });
  const duplicate = await queue.addRequest({ url: 'https://dup.example/page' });
  assert.equal(duplicate.wasAlreadyPresent, true);
  await queue.drop().catch(() => undefined);
});

test('queue opener mints a unique name per invocation', async () => {
  const seen: string[] = [];
  const fakeOpen = async (name: string) => {
    seen.push(name);
    return { drop: async () => undefined };
  };
  const first = await openIsolatedRenderedRequestQueue(fakeOpen);
  const second = await openIsolatedRenderedRequestQueue(fakeOpen);
  assert.match(first.name, /^rendered-community-[0-9a-z-]+$/);
  assert.notEqual(first.name, second.name);
  assert.equal(seen.length, 2);
});

test('crawler uses a per-invocation named queue, always drops it, and reclaims its listeners', async () => {
  // Wiring contract: construction receives an explicitly opened queue; a
  // finally guarantees best-effort drop on every path so named queues cannot
  // accumulate in storage; the process-wide listener ledger is captured
  // before opening and reclaimed after the drop so the dropped queue graph
  // (including Crawlee's ~16 MB RequestDeduplicationCache per instance) does
  // not stay retained by anonymous EventManager listeners.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /openIsolatedRenderedRequestQueue\(\(name\) => RequestQueue\.open\(name\)\)/);
  assert.match(source, /requestQueue: isolated\.queue,/);
  assert.match(source, /await dropIsolatedRenderedQueue\(isolated\.queue, isolated\.name\)/);
  const captureIndex = source.indexOf('captureRenderedQueueLifecycleListeners(queueEventEmitter)');
  const openIndex = source.indexOf('openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name))');
  const dropIndex = source.indexOf('await dropIsolatedRenderedQueue(isolated.queue, isolated.name)');
  const reclaimIndex = source.indexOf('reclaimRenderedQueueLifecycleListeners(queueEventEmitter, queueListenerLedger)');
  assert.ok(captureIndex >= 0, 'listener ledger capture is wired');
  assert.ok(openIndex >= 0 && captureIndex < openIndex, 'ledger capture precedes opening the queue');
  assert.ok(dropIndex >= 0 && reclaimIndex >= 0 && dropIndex < reclaimIndex, 'listener reclamation follows the queue drop');
});

test('cleanup failure is observable without changing the crawl result', async () => {
  // A failing drop() must emit one bounded warning (queue name + redacted
  // cause, never raw secrets) while resolving normally so the settled crawl
  // result is preserved.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    const result = await dropIsolatedRenderedQueue(
      { drop: async () => { throw new Error('storage locked for https://ops:s3cret@proxy:8080 queue token=abc123'); } },
      'rendered-community-test-1',
    );
    assert.equal(result, undefined);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Isolated request queue cleanup failed for rendered-community-test-1/);
  assert.doesNotMatch(warnings[0], /s3cret/);
  assert.doesNotMatch(warnings[0], /abc123/);
});

test('cleanup failure with an Error object preserves the redacted message', async () => {
  // Drop rejections are Error objects, not strings: the warning must carry
  // the redacted message rather than degrading to "unknown storage error".
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await dropIsolatedRenderedQueue(
      { drop: async () => { throw new Error('storage locked for https://ops:s3cret@proxy:8080'); } },
      'rendered-community-test-1b',
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /storage locked/);
  assert.doesNotMatch(warnings[0], /s3cret/);
  assert.doesNotMatch(warnings[0], /unknown storage error/);
});

test('successful cleanup emits no signal', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await dropIsolatedRenderedQueue({ drop: async () => undefined }, 'rendered-community-test-2');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0);
});

test('listener reclamation removes only listeners added since capture', () => {
  const preExistingMigrating = () => undefined;
  const emitter = createTestEmitter({ migrating: [preExistingMigrating] });
  const ledger = captureRenderedQueueLifecycleListeners(emitter);
  const firstMigrating = () => undefined;
  const secondMigrating = () => undefined;
  const firstAborting = () => undefined;
  // One queue construction adds two `migrating` and one `aborting` listener
  // (RequestProvider + RequestQueueV2 constructors, Crawlee 3.18).
  emitter.add('migrating', firstMigrating);
  emitter.add('migrating', secondMigrating);
  emitter.add('aborting', firstAborting);
  assert.equal(reclaimRenderedQueueLifecycleListeners(emitter, ledger), 3);
  assert.deepEqual(emitter.listeners('migrating'), [preExistingMigrating]);
  assert.deepEqual(emitter.listeners('aborting'), []);
  // Idempotent: a second pass finds nothing new to remove.
  assert.equal(reclaimRenderedQueueLifecycleListeners(emitter, ledger), 0);
});

test('listener capture and reclamation degrade to a no-op without the emitter shape', () => {
  // A future Crawlee whose EventManager no longer exposes a compatible
  // emitter must not break crawls: capture records nothing, reclamation
  // removes nothing, and a compatible events object is still detected.
  assert.equal(renderedQueueLifecycleEmitter(undefined), undefined);
  assert.equal(renderedQueueLifecycleEmitter({ events: {} }), undefined);
  const ledger = captureRenderedQueueLifecycleListeners(undefined);
  assert.equal(reclaimRenderedQueueLifecycleListeners(undefined, ledger), 0);
  const events = createTestEmitter({});
  assert.equal(renderedQueueLifecycleEmitter({ events }), events);
});

test('drop failure still warrants listener reclamation (queue graph must not stay retained)', async () => {
  const emitter = createTestEmitter({});
  const ledger = captureRenderedQueueLifecycleListeners(emitter);
  emitter.add('migrating', () => undefined);
  emitter.add('aborting', () => undefined);
  emitter.add('aborting', () => undefined);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await dropIsolatedRenderedQueue({ drop: async () => { throw new Error('disk full'); } }, 'rendered-community-test-4');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(reclaimRenderedQueueLifecycleListeners(emitter, ledger), 3);
  assert.deepEqual(emitter.listeners('migrating'), []);
  assert.deepEqual(emitter.listeners('aborting'), []);
});

test('crawlee 3.18: queue construction registers process-wide lifecycle listeners (upstream contract)', async () => {
  // Pins the upstream behavior the reclamation compensates for. If this fails
  // after a Crawlee upgrade, re-verify the leak (see
  // reclaimRenderedQueueLifecycleListeners) before changing the cleanup.
  const { config } = isolatedTestConfig();
  const emitter = renderedQueueLifecycleEmitter(config.getEventManager());
  assert.ok(emitter, 'Crawlee EventManager exposes the process-wide emitter');
  const queue = await RequestQueue.open('rendered-community-contract', { config });
  assert.ok(emitter.listeners('migrating').length > 0, 'queue construction registers migrating listeners');
  assert.ok(emitter.listeners('aborting').length > 0, 'queue construction registers aborting listeners');
  await queue.drop().catch(() => undefined);
});

test('repeated serialized crawl lifecycles do not accumulate queue listeners', async () => {
  const { config } = isolatedTestConfig();
  const emitter = renderedQueueLifecycleEmitter(config.getEventManager());
  assert.ok(emitter, 'Crawlee EventManager exposes the process-wide emitter');
  const ledger = captureRenderedQueueLifecycleListeners(emitter);
  const baseline = {
    migrating: emitter.listeners('migrating').length,
    aborting: emitter.listeners('aborting').length,
  };
  for (let cycle = 1; cycle <= 5; cycle++) {
    const isolated = await openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name, { config }));
    await isolated.queue.addRequest({ url: `https://cycle.example/page-${cycle}` });
    await dropIsolatedRenderedQueue(isolated.queue, isolated.name);
    reclaimRenderedQueueLifecycleListeners(emitter, ledger);
  }
  assert.equal(emitter.listeners('migrating').length, baseline.migrating);
  assert.equal(emitter.listeners('aborting').length, baseline.aborting);
});

test('reclaimed lifecycles keep cross-crawl isolation: stale handled state does not survive', async () => {
  const { config } = isolatedTestConfig();
  const emitter = renderedQueueLifecycleEmitter(config.getEventManager());
  assert.ok(emitter, 'Crawlee EventManager exposes the process-wide emitter');
  const ledger = captureRenderedQueueLifecycleListeners(emitter);
  const seed = 'https://retry-reclaimed.example/invite';
  // Crawl invocation 1 handles the seed on its isolated queue...
  const first = await openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name, { config }));
  await markHandled(first.queue, seed);
  await dropIsolatedRenderedQueue(first.queue, first.name);
  reclaimRenderedQueueLifecycleListeners(emitter, ledger);
  // ...retry invocation 2 dispatches it again: reclamation must not resurrect
  // the shared-queue skip, and no listener survives the lifecycle.
  const second = await openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name, { config }));
  const readded = await second.queue.addRequest({ url: seed });
  assert.equal(readded.wasAlreadyHandled, false);
  assert.ok(await fetchSoon(second.queue));
  await dropIsolatedRenderedQueue(second.queue, second.name);
  reclaimRenderedQueueLifecycleListeners(emitter, ledger);
  assert.equal(emitter.listeners('migrating').length, 0);
  assert.equal(emitter.listeners('aborting').length, 0);
});
