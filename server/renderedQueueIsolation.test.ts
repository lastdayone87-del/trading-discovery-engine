import test from 'node:test';
import assert from 'node:assert/strict';
import { Configuration, RequestQueue, type Request } from 'crawlee';
import {
  beginRenderedQueueLifecycle,
  captureRenderedQueueLifecycleListeners,
  dropIsolatedRenderedQueue,
  endRenderedQueueLifecycle,
  finalizeRenderedQueueLifecycle,
  openIsolatedRenderedRequestQueue,
  reclaimRenderedQueueLifecycleListeners,
  renderedQueueLifecycleEmitter,
  withRenderedQueueLifecycleLock,
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
// listeners added during one crawl, and the lifecycle lock must keep
// overlapping crawls (env concurrency 2) from cross-removing each other's
// listeners.

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

test('crawler uses a per-invocation named queue and shared lifecycle bookkeeping', async () => {
  // Wiring contract: construction receives an explicitly opened queue; the
  // finally drops it and ends the shared lifecycle on every path so named
  // queues cannot accumulate in storage and dropped queue graphs (including
  // Crawlee's ~16 MB RequestDeduplicationCache per instance) do not stay
  // retained by anonymous EventManager listeners. The crawl itself is not
  // serialized: begin/end only guard baseline capture and last-crawl cleanup.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /openIsolatedRenderedRequestQueue\(open\)/);
  assert.match(source, /requestQueue: isolated\.queue,/);
  assert.match(source, /await dropIsolatedRenderedQueue\(queue, name\)/);
  assert.doesNotMatch(source, /isolated = await openIsolatedRenderedRequestQueue\(/,
    'the crawl opens through the lifecycle helper, never directly');
  const beginCall = source.match(/const lifecycleHandle = await beginRenderedQueueLifecycle\(([\s\S]*?)\);/);
  assert.ok(beginCall, 'the crawl opens its queue through beginRenderedQueueLifecycle');
  assert.match(beginCall[1], /queueEventEmitter/);
  assert.match(beginCall[1], /\(name\) => RequestQueue\.open\(name\)/);
  const assignmentIndex = source.indexOf('isolated = { name: lifecycleHandle.name, queue: lifecycleHandle.queue };');
  assert.ok(assignmentIndex >= 0, 'the opened queue is the one assigned to the crawl');
  const ownershipIndex = source.indexOf('ownedQueueListeners = lifecycleHandle.ownedListeners;');
  assert.ok(ownershipIndex > assignmentIndex, 'the crawl retains the helper\'s owned listener set');
  const requestQueueIndex = source.indexOf('requestQueue: isolated.queue,');
  assert.ok(requestQueueIndex > assignmentIndex, 'the crawler uses the lifecycle-opened queue');
  const endCall = source.match(/await endRenderedQueueLifecycle\(([\s\S]*?)\);/);
  assert.ok(endCall, 'the crawl ends its lifecycle in the finally');
  assert.match(endCall[1], /ownedQueueListeners/,
    'cleanup uses this crawl\'s owned listener set');
  assert.match(endCall[1], /isolated\?\.queue/);
  assert.match(endCall[1], /isolated\?\.name/);
  const beginIndex = source.indexOf('const lifecycleHandle = await beginRenderedQueueLifecycle(');
  const endIndex = source.indexOf('await endRenderedQueueLifecycle(');
  assert.ok(beginIndex >= 0 && assignmentIndex > beginIndex && requestQueueIndex > assignmentIndex,
    'queue construction and use follow the lifecycle begin');
  assert.ok(endIndex > requestQueueIndex, 'lifecycle end runs after the queue is used');
  assert.doesNotMatch(source, /gateAdmittedAtMs\) => withRenderedQueueLifecycleLock\(async \(\) => \{/,
    'the full crawl must not be serialized by the lifecycle lock');
});

test('total-budget clock starts at the browser-lease grant, not gate admission or lifecycle bookkeeping', async () => {
  // Regression guard: neither begin/end bookkeeping nor gate/lease capacity
  // waits may consume the crawl's total budget. The clock starts when the
  // browser slot is actually granted (inside withBrowserRuntimeLease), so a
  // queued second crawl on a degraded host never launches with an expired
  // budget that would skip page inspection.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /renderedFallbackGate\.run(?:<[^>]+>)?\(\(gateAdmittedAtMs\) => \(async \(\) => \{/);
  assert.match(source, /let startedAt = gateAdmittedAtMs;/);
  assert.match(source, /await withBrowserRuntimeLease\(\(\) => \{/);
  assert.match(source, /startedAt = Date\.now\(\);/);
  assert.match(source, /await operation\(Date\.now\(\)\);/);
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

test('lifecycle finalizer reclaims listeners even when the queue drop fails', async () => {
  // Drives the exact exported finalizer the crawl finally calls: the drop
  // rejects (bounded warning only — see dropIsolatedRenderedQueue) and
  // listener reclamation still runs, so a failed drop cannot retain the queue
  // graph.
  const emitter = createTestEmitter({});
  const ledger = captureRenderedQueueLifecycleListeners(emitter);
  emitter.add('migrating', () => undefined);
  emitter.add('aborting', () => undefined);
  emitter.add('aborting', () => undefined);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  let reclaimed = 0;
  try {
    reclaimed = await finalizeRenderedQueueLifecycle({
      queue: { drop: async () => { throw new Error('disk full'); } },
      name: 'rendered-community-test-4',
      emitter,
      ledger,
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(reclaimed, 3);
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
  const baseline = {
    migrating: emitter.listeners('migrating').length,
    aborting: emitter.listeners('aborting').length,
  };
  const ledger = captureRenderedQueueLifecycleListeners(emitter);
  try {
    const queue = await RequestQueue.open('rendered-community-contract', { config });
    assert.ok(emitter.listeners('migrating').length > baseline.migrating, 'queue construction registers migrating listeners');
    assert.ok(emitter.listeners('aborting').length > baseline.aborting, 'queue construction registers aborting listeners');
    await queue.drop().catch(() => undefined);
  } finally {
    // drop() does not unregister the anonymous listeners the constructor
    // added; reclaim them so this test does not retain the dropped queue graph
    // even for its own lifetime (same reclamation the production finally uses).
    reclaimRenderedQueueLifecycleListeners(emitter, ledger);
  }
  assert.equal(emitter.listeners('migrating').length, baseline.migrating, 'contract test leaves no migrating listeners behind');
  assert.equal(emitter.listeners('aborting').length, baseline.aborting, 'contract test leaves no aborting listeners behind');
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

test('lifecycle lock serializes overlapping crawls and reclaims exactly each queue listeners', async () => {
  // Safety for RENDERED_FALLBACK_CONCURRENCY=2: even if the gate admits two
  // crawls, the queue lifecycle lock keeps capture-through-reclamation
  // atomic, so each crawl reclaims exactly the listeners its own queue added.
  const { config } = isolatedTestConfig();
  const emitter = renderedQueueLifecycleEmitter(config.getEventManager());
  assert.ok(emitter, 'Crawlee EventManager exposes the process-wide emitter');
  const sequence: string[] = [];
  let active = 0;
  let maxActive = 0;
  const simulateCrawl = (tag: string, holdMs: number) => withRenderedQueueLifecycleLock(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const ledger = captureRenderedQueueLifecycleListeners(emitter);
      const isolated = await openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name, { config }));
      sequence.push(`${tag}:opened`);
      await new Promise(resolve => setTimeout(resolve, holdMs));
      const reclaimed = await finalizeRenderedQueueLifecycle({
        queue: isolated.queue,
        name: isolated.name,
        emitter,
        ledger,
      });
      assert.equal(reclaimed, 3, `${tag} reclaims exactly its own three listeners`);
      sequence.push(`${tag}:finalized`);
    } finally {
      active--;
    }
  });
  await Promise.all([simulateCrawl('a', 60), simulateCrawl('b', 20)]);
  assert.equal(maxActive, 1, 'queue lifecycles never overlap');
  assert.deepEqual(sequence, ['a:opened', 'a:finalized', 'b:opened', 'b:finalized']);
  assert.equal(emitter.listeners('migrating').length, 0);
  assert.equal(emitter.listeners('aborting').length, 0);
});

test('overlapping crawls reclaim exactly their own queue listeners independently', async () => {
  const baselineListener = () => undefined;
  const firstListener = () => undefined;
  const secondListener = () => undefined;
  const emitter = createTestEmitter({ migrating: [baselineListener] });
  const openWith = (listener: () => void) => async (name: string) => {
    emitter.add('migrating', listener);
    return { name, drop: async () => undefined };
  };
  const first = await beginRenderedQueueLifecycle(emitter, openWith(firstListener));
  const second = await beginRenderedQueueLifecycle(emitter, openWith(secondListener));
  assert.deepEqual(emitter.listeners('migrating'), [baselineListener, firstListener, secondListener]);
  try {
    assert.equal(await endRenderedQueueLifecycle(emitter, first.ownedListeners), 1,
      'the first crawl removes only its own listener');
    assert.deepEqual(emitter.listeners('migrating'), [baselineListener, secondListener],
      'the still-live second crawl keeps its listener');
  } finally {
    assert.equal(await endRenderedQueueLifecycle(emitter, second.ownedListeners), 1,
      'the second crawl removes its own listener');
    assert.deepEqual(emitter.listeners('migrating'), [baselineListener]);
  }
});

test('unsynchronized reclamation would cross-remove a live queue (race documented, prevented by the lock)', async () => {
  const { config } = isolatedTestConfig();
  const emitter = renderedQueueLifecycleEmitter(config.getEventManager());
  assert.ok(emitter, 'Crawlee EventManager exposes the process-wide emitter');
  const total = () => emitter.listeners('migrating').length + emitter.listeners('aborting').length;
  assert.equal(total(), 0);
  // Crawl A captures the empty baseline and opens its queue...
  const ledgerA = captureRenderedQueueLifecycleListeners(emitter);
  const first = await openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name, { config }));
  // ...then crawl B opens its queue while A is still live (what env
  // concurrency 2 would allow without the lifecycle lock).
  const ledgerB = captureRenderedQueueLifecycleListeners(emitter);
  const second = await openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name, { config }));
  const bothLive = total();
  assert.ok(bothLive > 0, 'queue construction registered process-wide listeners');
  // A finishing would remove everything added after its capture — including
  // B's still-live listeners — hence the lifecycle lock.
  const removedByA = reclaimRenderedQueueLifecycleListeners(emitter, ledgerA);
  assert.equal(removedByA, bothLive, 'A removes B listeners as well without serialization');
  assert.equal(total(), 0, 'B is left live without its lifecycle handlers');
  assert.equal(reclaimRenderedQueueLifecycleListeners(emitter, ledgerB), 0);
  await dropIsolatedRenderedQueue(first.queue, first.name).catch(() => undefined);
  await dropIsolatedRenderedQueue(second.queue, second.name).catch(() => undefined);
});
