import test from 'node:test';
import assert from 'node:assert/strict';
// Telemetry-chain coverage: every retrieval outcome persists its
// provider_call_events row (success, failure, empty), continuation pages are
// attributed per page, and a telemetry persistence failure is observable yet
// never converts a successful retrieval into a provider failure.
import {
  executeInnertubeRetrievalPage,
  resetInnertubeCooldownForTests,
  resetInnertubePacingForTests,
  setInnertubeEmitSinkForTests,
  setInnertubeSessionFactoryForTests,
} from './youtubeInnertubeProvider';

const UC = 'UCabcdefghijklmnopqrstuv';

type Emitted = Record<string, any>;

function trackEmitted(sink?: (event: Emitted) => Promise<void>) {
  const emitted: Emitted[] = [];
  setInnertubeEmitSinkForTests(async (event) => {
    emitted.push(event as unknown as Emitted);
    await sink?.(event as unknown as Emitted);
  });
  return emitted;
}

function baseRequest(overrides: Record<string, any> = {}) {
  return {
    query: 'scalping',
    country: 'US',
    lane: 'CHANNEL',
    cursor: null,
    ordering: 'RELEVANCE',
    queryRunId: 'run-telemetry-1',
    jobId: 'job-1',
    ...overrides,
  } as any;
}

function setup() {
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '0';
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
}

function teardown() {
  setInnertubeEmitSinkForTests(null);
  setInnertubeSessionFactoryForTests(null);
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
}

test('successful retrieval persists a SUCCESS event with run/page attribution', async () => {
  setup();
  const emitted = trackEmitted();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({ channels: [{ author: { id: UC, name: 'Desk' } }], has_continuation: false }),
  }));
  try {
    const page = await executeInnertubeRetrievalPage(baseRequest());
    assert.equal(page.channels.length, 1);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].provider, 'youtube-innertube');
    assert.equal(emitted[0].operation, 'search');
    assert.equal(emitted[0].runId, 'run-telemetry-1');
    assert.equal(emitted[0].status, 'SUCCESS');
    assert.equal(emitted[0].actualCost, 0);
    assert.equal(emitted[0].requestMetadata.innertubePage, '1');
    assert.equal(emitted[0].requestMetadata.innertubeLane, 'CHANNEL');
  } finally {
    teardown();
  }
});

test('failed retrieval persists a failure event and still throws the provider error', async () => {
  setup();
  const emitted = trackEmitted();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => {
      throw new Error('fetch failed: network down');
    },
  }));
  try {
    await assert.rejects(executeInnertubeRetrievalPage(baseRequest()));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].provider, 'youtube-innertube');
    assert.equal(emitted[0].status, 'TRANSIENT_ERROR');
    assert.equal(emitted[0].errorClass, 'TRANSIENT');
    assert.equal(emitted[0].runId, 'run-telemetry-1');
  } finally {
    teardown();
  }
});

test('empty results emit SUCCESS (distinguishable from failure), not an error', async () => {
  setup();
  const emitted = trackEmitted();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({ channels: [], has_continuation: false }),
  }));
  try {
    const page = await executeInnertubeRetrievalPage(baseRequest());
    assert.equal(page.channels.length, 0);
    assert.equal(page.rawResultCount, 0);
    assert.equal(page.nextPageToken, null);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].status, 'SUCCESS');
  } finally {
    teardown();
  }
});

test('telemetry persist failure is observable but retrieval still succeeds', async () => {
  setup();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(' '));
  };
  const emitted = trackEmitted(async () => {
    throw new Error('ledger unavailable');
  });
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({ channels: [{ author: { id: UC, name: 'Desk' } }], has_continuation: false }),
  }));
  try {
    // A telemetry outage must never convert a good retrieval into a failure.
    const page = await executeInnertubeRetrievalPage(baseRequest());
    assert.equal(page.channels.length, 1);
    assert.equal(page.channels[0].channelId, UC);
    // The sink was attempted (and failed); the failure was logged observably.
    assert.equal(emitted.length, 1);
    assert.ok(
      errors.some(line => line.includes('innertube_telemetry_persist_failed') && line.includes('run-telemetry-1')),
      `expected observable telemetry failure log, saw: ${errors.join(' | ').slice(0, 300)}`
    );
  } finally {
    console.error = originalError;
    teardown();
  }
});

test('continuation pages are attributed per page number', async () => {
  setup();
  const emitted = trackEmitted();
  const page2 = { channels: [{ author: { id: UC, name: 'Desk Two' } }], has_continuation: false };
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({
      channels: [{ author: { id: UC, name: 'Desk' } }],
      has_continuation: true,
      getContinuation: async () => page2,
    }),
  }));
  try {
    const first = await executeInnertubeRetrievalPage(baseRequest({ cursor: null }));
    assert.equal(first.nextPageToken, '2');
    const second = await executeInnertubeRetrievalPage(baseRequest({ cursor: '2' }));
    assert.equal(second.channels[0].channelName, 'Desk Two');
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].requestMetadata.innertubePage, '1');
    assert.equal(emitted[1].requestMetadata.innertubePage, '2');
    assert.ok(emitted.every(item => item.runId === 'run-telemetry-1' && item.status === 'SUCCESS'));
  } finally {
    teardown();
  }
});
