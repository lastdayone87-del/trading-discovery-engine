import test from 'node:test';
import assert from 'node:assert/strict';
// Telemetry-chain coverage: every retrieval outcome persists its
// provider_call_events row (success, failure, empty), continuation pages are
// attributed per page, and a telemetry persistence failure is observable yet
// never converts a successful retrieval into a provider failure.
import {
  executeInnertubeRetrievalPage,
  fetchChannelVideoDescriptionsViaInnertube,
  resetInnertubeCooldownForTests,
  resetInnertubePacingForTests,
  setInnertubeEmitSinkForTests,
  setInnertubeSessionFactoryForTests,
} from './youtubeInnertubeProvider';

/** provider_call_events.id is UUID PRIMARY KEY: PostgreSQL rejects anything
 * else with "invalid input syntax for type uuid". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertPersistableUuid(id: unknown): void {
  assert.equal(typeof id, 'string', 'telemetry id must be a string');
  assert.match(String(id), UUID_RE, `telemetry id must be a valid UUID for provider_call_events.id, got: ${String(id).slice(0, 120)}`);
  assert.ok(!String(id).includes('adhoc:'), 'semantic request identity must not leak into the UUID primary key');
}

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

test('retrieval telemetry uses a UUID primary key and preserves semantic attribution', async () => {
  setup();
  const emitted = trackEmitted();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({ channels: [{ author: { id: UC, name: 'Desk' } }], has_continuation: false }),
  }));
  try {
    await executeInnertubeRetrievalPage(baseRequest());
    assert.equal(emitted.length, 1);
    const event = emitted[0];
    assertPersistableUuid(event.id);
    // Semantic attribution stays in its existing fields — never in the UUID.
    assert.equal(event.requestId, 'run-telemetry-1:youtube-innertube:channel:p1');
    assert.equal(event.runId, 'run-telemetry-1');
    assert.equal(event.jobId, 'job-1');
    assert.equal(event.provider, 'youtube-innertube');
    assert.equal(event.operation, 'search');
    assert.equal(event.requestMetadata.innertubePage, '1');
    assert.equal(event.requestMetadata.innertubeLane, 'CHANNEL');
  } finally {
    teardown();
  }
});

test('retrieval failure telemetry uses a UUID primary key', async () => {
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
    assertPersistableUuid(emitted[0].id);
    assert.equal(emitted[0].requestId, 'run-telemetry-1:youtube-innertube:channel:p1');
    assert.equal(emitted[0].runId, 'run-telemetry-1');
  } finally {
    teardown();
  }
});

test('channel-descriptions telemetry uses a UUID primary key and preserves channel attribution', async () => {
  setup();
  const emitted = trackEmitted();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => {
      throw new Error('unused');
    },
    getChannel: async () => ({
      getVideos: async () => ({ videos: [{ content_id: 'vid1' }] }),
    }),
    getBasicInfo: async () => ({ basic_info: { short_description: 'A real description' } }),
  }));
  try {
    const result = await fetchChannelVideoDescriptionsViaInnertube(UC, { maxVideos: 5, jobId: 'job-desc-1' });
    assert.equal(result.items.length, 1);
    assert.equal(emitted.length, 1);
    const event = emitted[0];
    assertPersistableUuid(event.id);
    assert.equal(event.provider, 'youtube-innertube');
    assert.equal(event.operation, 'channel-video-descriptions');
    assert.equal(event.requestId, `adhoc:youtube-innertube:channel-descriptions:${UC}`);
    assert.equal(event.jobId, 'job-desc-1');
    assert.equal(event.requestMetadata.channelId, UC);
  } finally {
    teardown();
  }
});
