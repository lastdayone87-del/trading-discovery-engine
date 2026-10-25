import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KEY_CAP_REFUSAL_EVENT_PRUNE_BATCH,
  KEY_CAP_REFUSAL_EVENT_RETENTION_DAYS,
  PRUNE_KEY_CAP_REFUSAL_EVENTS_SQL,
  RECORD_KEY_CAP_REFUSAL_SQL,
  logKeyCapRefusalAccountingFailure,
  pruneYouTubeKeyCapRefusalEvents,
  recordYouTubeKeyCapRefusal,
  recordYouTubeKeyCapRefusalSafe,
  readYouTubeKeyCapRefusalKeyCounts,
  readYouTubeKeyCapRefusalSummary,
  type KeyCapRefusalQueryClient,
} from './quotaKeyCapRefusals';

const input = {
  quotaDay: '2026-10-20',
  operationId: 'cap:search:op-1',
  keyFingerprint: 'fp-1',
  projectedUnits: 9000,
  requestUnits: 100,
  capUnits: 9000,
};

test('record refusal uses one idempotent statement and parses the counter', async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client: KeyCapRefusalQueryClient = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: [{ refusals: '3', inserted: true }], rowCount: 1 };
    },
  };
  const result = await recordYouTubeKeyCapRefusal(client, input);
  assert.deepEqual(result, { inserted: true, refusals: 3 });
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /ON CONFLICT \(quota_day, operation_id\) DO NOTHING/);
  assert.match(queries[0].text, /refusals = youtube_key_cap_refusal_counters\.refusals \+ 1/);
  assert.deepEqual(queries[0].values, [
    '2026-10-20', 'cap:search:op-1', 'fp-1', 9000, 100, 9000,
  ]);
  assert.match(RECORD_KEY_CAP_REFUSAL_SQL, /EXISTS\(SELECT 1 FROM inserted\) AS inserted/);
});

test('duplicate delivery returns inserted=false without a second increment', async () => {
  const client: KeyCapRefusalQueryClient = {
    query: async () => ({ rows: [{ refusals: '3', inserted: false }], rowCount: 1 }),
  };
  assert.deepEqual(await recordYouTubeKeyCapRefusal(client, input), { inserted: false, refusals: 3 });
});

test('invalid refusal input is rejected before touching the database', async () => {
  let queried = false;
  const client: KeyCapRefusalQueryClient = {
    query: async () => { queried = true; return { rows: [] }; },
  };
  await assert.rejects(recordYouTubeKeyCapRefusal(client, { ...input, requestUnits: 0 }), /INVALID_KEY_CAP_REFUSAL_INPUT/);
  await assert.rejects(recordYouTubeKeyCapRefusal(client, { ...input, quotaDay: '2026-10-20T00:00:00Z' }), /INVALID_KEY_CAP_REFUSAL_INPUT/);
  await assert.rejects(recordYouTubeKeyCapRefusal(client, { ...input, keyFingerprint: '' }), /INVALID_KEY_CAP_REFUSAL_INPUT/);
  assert.equal(queried, false);
});

test('safe recorder swallows database and validation failures', async () => {
  const original = console.error;
  console.error = () => undefined;
  try {
    const broken: KeyCapRefusalQueryClient = {
      query: async () => { throw new Error('db unavailable'); },
    };
    assert.equal(await recordYouTubeKeyCapRefusalSafe(broken, input), false);
    assert.equal(await recordYouTubeKeyCapRefusalSafe(broken, { ...input, capUnits: 0 }), false);
  } finally {
    console.error = original;
  }
});

test('accounting failures emit a structured event instead of disappearing', async () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (line?: unknown) => { lines.push(String(line)); };
  try {
    const broken: KeyCapRefusalQueryClient = {
      query: async () => { throw new Error('db unavailable'); },
    };
    assert.equal(await recordYouTubeKeyCapRefusalSafe(broken, input), false);
    logKeyCapRefusalAccountingFailure(new Error('commit failed'), {
      branch: 'enforced-reservation',
      quotaDay: '2026-10-20',
      operationId: 'cap:test:log',
    });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 2);
  const safe = JSON.parse(lines[0]);
  assert.equal(safe.event, 'youtube_key_cap_refusal_accounting_failed');
  assert.equal(safe.branch, 'safe');
  assert.equal(safe.quotaDay, '2026-10-20');
  assert.match(safe.message, /db unavailable/);
  const shadow = JSON.parse(lines[1]);
  assert.equal(shadow.branch, 'enforced-reservation');
  assert.equal(shadow.operationId, 'cap:test:log');
  assert.match(shadow.message, /commit failed/);
});

test('event retention is bounded and the counter table is never pruned', async () => {
  assert.equal(KEY_CAP_REFUSAL_EVENT_RETENTION_DAYS, 30);
  assert.equal(KEY_CAP_REFUSAL_EVENT_PRUNE_BATCH, 5_000);
  assert.match(PRUNE_KEY_CAP_REFUSAL_EVENTS_SQL, /DELETE FROM youtube_key_cap_refusal_events/);
  assert.doesNotMatch(PRUNE_KEY_CAP_REFUSAL_EVENTS_SQL, /youtube_key_cap_refusal_counters/);
  assert.match(PRUNE_KEY_CAP_REFUSAL_EVENTS_SQL, /LIMIT \$2/);

  let text = '';
  let values: unknown[] | undefined;
  const client: KeyCapRefusalQueryClient = {
    query: async (sql, params) => {
      text = sql;
      values = params;
      return { rows: [], rowCount: 7 };
    },
  };
  assert.equal(await pruneYouTubeKeyCapRefusalEvents(client, 30, 1_000), 7);
  assert.match(text, /DELETE FROM youtube_key_cap_refusal_events/);
  assert.deepEqual(values, [30, 1_000]);

  // Invalid retention/batch settings fall back to the safe defaults.
  assert.equal(await pruneYouTubeKeyCapRefusalEvents(client, 0, 0), 7);
  assert.deepEqual(values, [KEY_CAP_REFUSAL_EVENT_RETENTION_DAYS, KEY_CAP_REFUSAL_EVENT_PRUNE_BATCH]);
});

test('summary and per-key reads normalize bigint strings and empty results', async () => {
  const summaryClient: KeyCapRefusalQueryClient = {
    query: async () => ({
      rows: [{ quota_day: '2026-10-20', refusals: '12', keys: 3, last_refused_at: '2026-10-20T19:00:00.000Z' }],
    }),
  };
  assert.deepEqual(await readYouTubeKeyCapRefusalSummary(summaryClient, '2026-10-20'), {
    quotaDay: '2026-10-20',
    refusals: 12,
    keys: 3,
    lastRefusedAt: '2026-10-20T19:00:00.000Z',
  });

  const emptyClient: KeyCapRefusalQueryClient = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await readYouTubeKeyCapRefusalSummary(emptyClient, '2026-10-21'), {
    quotaDay: '2026-10-21', refusals: 0, keys: 0, lastRefusedAt: null,
  });

  const keyClient: KeyCapRefusalQueryClient = {
    query: async () => ({
      rows: [{
        key_fingerprint: 'fp-1', refusals: '2', projected_units_max: 9001,
        last_request_units: 100, first_refused_at: '2026-10-20T18:00:00.000Z',
        last_refused_at: '2026-10-20T19:00:00.000Z',
      }],
    }),
  };
  assert.deepEqual(await readYouTubeKeyCapRefusalKeyCounts(keyClient, '2026-10-20'), [{
    keyFingerprint: 'fp-1',
    refusals: 2,
    projectedUnitsMax: 9001,
    lastRequestUnits: 100,
    firstRefusedAt: '2026-10-20T18:00:00.000Z',
    lastRefusedAt: '2026-10-20T19:00:00.000Z',
  }]);
});
