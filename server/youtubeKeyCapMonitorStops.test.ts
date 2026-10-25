import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KEY_CAP_MONITOR_STOP_PERSIST_ATTEMPTS,
  READ_KEY_CAP_MONITOR_STOP_SQL,
  RECORD_KEY_CAP_MONITOR_STOP_SQL,
  readKeyCapMonitorStop,
  recordKeyCapMonitorStop,
  recordKeyCapMonitorStopWithRetry,
  type MonitorStopQueryClient,
} from './youtubeKeyCapMonitorStops';

const row = {
  quota_day: '2026-10-26',
  reason: 'CAP_EVENTS',
  detail: 'cap_exceeded=501',
  stopped_at: '2026-10-26T08:00:00.000Z',
};

test('durable monitor stop reads and normalizes the first stop for a day', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client: MonitorStopQueryClient = {
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [row] };
    },
  };
  assert.deepEqual(await readKeyCapMonitorStop(client, '2026-10-26'), {
    quotaDay: '2026-10-26',
    reason: 'CAP_EVENTS',
    detail: 'cap_exceeded=501',
    stoppedAt: '2026-10-26T08:00:00.000Z',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /FROM youtube_key_cap_monitor_stops/);
  assert.deepEqual(calls[0].values, ['2026-10-26']);
  assert.match(READ_KEY_CAP_MONITOR_STOP_SQL, /WHERE quota_day = \$1/);
});

test('durable monitor stop insert is first-writer-wins', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  let insert = true;
  const client: MonitorStopQueryClient = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes('INSERT INTO youtube_key_cap_monitor_stops')) {
        return { rows: insert ? [row] : [] };
      }
      return { rows: [row] };
    },
  };
  const at = new Date('2026-10-26T08:00:00.000Z');
  const inserted = await recordKeyCapMonitorStop(client, {
    quotaDay: '2026-10-26',
    reason: 'CAP_EVENTS',
    detail: 'cap_exceeded=501',
    at,
  });
  assert.deepEqual(inserted, {
    quotaDay: '2026-10-26',
    reason: 'CAP_EVENTS',
    detail: 'cap_exceeded=501',
    stoppedAt: '2026-10-26T08:00:00.000Z',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ['2026-10-26', 'CAP_EVENTS', 'cap_exceeded=501', at.toISOString()]);
  assert.match(RECORD_KEY_CAP_MONITOR_STOP_SQL, /ON CONFLICT \(quota_day\) DO NOTHING/);

  // A concurrent monitor already recorded the first stop: read it back rather
  // than replacing the reason or timestamp the runner may already have seen.
  calls.length = 0;
  insert = false;
  const existing = await recordKeyCapMonitorStop(client, {
    quotaDay: '2026-10-26',
    reason: 'CAP_UNAVAILABLE',
    detail: 'different reason',
    at: new Date('2026-10-26T09:00:00.000Z'),
  });
  assert.deepEqual(existing, {
    quotaDay: '2026-10-26',
    reason: 'CAP_EVENTS',
    detail: 'cap_exceeded=501',
    stoppedAt: '2026-10-26T08:00:00.000Z',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /FROM youtube_key_cap_monitor_stops/);
});

test('durable stop persistence retries transient failures before exiting', async () => {
  assert.equal(KEY_CAP_MONITOR_STOP_PERSIST_ATTEMPTS, 5);
  let inserts = 0;
  const client: MonitorStopQueryClient = {
    query: async (text) => {
      if (text.includes('INSERT INTO youtube_key_cap_monitor_stops')) {
        inserts += 1;
        if (inserts < 3) throw new Error('transient database failure');
        return { rows: [row] };
      }
      return { rows: [row] };
    },
  };
  const result = await recordKeyCapMonitorStopWithRetry(client, {
    quotaDay: '2026-10-26',
    reason: 'CAP_EVENTS',
    detail: 'cap_exceeded=501',
    at: new Date('2026-10-26T08:00:00.000Z'),
  }, { attempts: 5, delayMs: () => 0 });
  assert.equal(inserts, 3);
  assert.equal(result.reason, 'CAP_EVENTS');
});

test('durable stop persistence surfaces the final error after bounded retries', async () => {
  let calls = 0;
  const client: MonitorStopQueryClient = {
    query: async () => {
      calls += 1;
      throw new Error('database unavailable');
    },
  };
  await assert.rejects(
    recordKeyCapMonitorStopWithRetry(client, {
      quotaDay: '2026-10-26',
      reason: 'CAP_UNAVAILABLE',
      detail: 'cap_unavailable=4',
      at: new Date('2026-10-26T08:00:00.000Z'),
    }, { attempts: 3, delayMs: () => 0 }),
    /database unavailable/,
  );
  assert.equal(calls, 3);
});

test('durable monitor stop rejects invalid rows and reasons', async () => {
  const invalidRow: MonitorStopQueryClient = {
    query: async () => ({ rows: [{ ...row, reason: 'HEALTH_FAILURE' }] }),
  };
  await assert.rejects(readKeyCapMonitorStop(invalidRow, '2026-10-26'), /INVALID_KEY_CAP_MONITOR_STOP/);

  const invalidDate: MonitorStopQueryClient = {
    query: async () => ({ rows: [{ ...row, stopped_at: 'not-a-date' }] }),
  };
  await assert.rejects(readKeyCapMonitorStop(invalidDate, '2026-10-26'), /INVALID_KEY_CAP_MONITOR_STOP/);

  let queried = false;
  const client: MonitorStopQueryClient = {
    query: async () => { queried = true; return { rows: [] }; },
  };
  await assert.rejects(
    recordKeyCapMonitorStop(client, {
      quotaDay: '2026-10-26',
      reason: 'HEALTH_FAILURE' as never,
      detail: 'x',
      at: new Date(),
    }),
    /INVALID_KEY_CAP_MONITOR_STOP/,
  );
  assert.equal(queried, false);
});
