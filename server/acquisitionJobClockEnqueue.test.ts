import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { enqueueJob } from './dbCore';
import { ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV } from './acquisitionJobClockPolicy';

interface QueryRecord {
  sql: string;
  values?: unknown[];
}

function makeDb() {
  const queries: QueryRecord[] = [];
  return {
    queries,
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return {
        rowCount: 1,
        rows: [{
          id: 'job-1',
          type: 'RETRY_COMMUNITY_ACQUISITION',
          status: 'PENDING',
          payload: '{}',
          attempts: 0,
          max_attempts: 3,
          run_after: new Date().toISOString(),
          locked_by: null,
          locked_at: null,
          last_error: null,
          created_at: new Date().toISOString(),
        }],
      };
    },
  };
}

test('enqueue reopen bookkeeping is absent while the clock flag is off', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'false';
  try {
    const db = makeDb();
    await enqueueJob('RETRY_COMMUNITY_ACQUISITION', {}, {
      idempotencyKey: 'community-acquisition-retry:test',
      clientOverride: db,
    });
    const sql = db.queries[0]?.sql || '';
    assert.match(sql, /ON CONFLICT\(idempotency_key\) DO UPDATE SET/);
    assert.doesNotMatch(sql, /last_enqueued_at/);
    assert.doesNotMatch(sql, /reopen_generation/);
    assert.doesNotMatch(sql, /last_reopened_at/);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('enqueue records a reopen generation and enqueue clock when the flag is on', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const db = makeDb();
    await enqueueJob('RETRY_COMMUNITY_ACQUISITION', {}, {
      idempotencyKey: 'community-acquisition-retry:test',
      clientOverride: db,
    });
    const sql = db.queries[0]?.sql || '';
    assert.match(sql, /last_enqueued_at=CASE WHEN jobs\.status IN \('COMPLETED','FAILED'\) THEN now\(\)/);
    assert.match(sql, /reopen_generation=CASE WHEN jobs\.status IN \('COMPLETED','FAILED'\) THEN jobs\.reopen_generation\+1/);
    assert.match(sql, /last_reopened_at=CASE WHEN jobs\.status IN \('COMPLETED','FAILED'\) THEN now\(\)/);
    assert.doesNotMatch(sql, /first_enqueued_at=/);
    assert.doesNotMatch(sql, /first_transient_failure_at/);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('preventReopen never adds reopen bookkeeping even when the flag is on', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const db = makeDb();
    await enqueueJob('RETRY_COMMUNITY_ACQUISITION', {}, {
      idempotencyKey: 'community-acquisition-retry:test',
      preventReopen: true,
      clientOverride: db,
    });
    const sql = db.queries[0]?.sql || '';
    assert.doesNotMatch(sql, /last_enqueued_at/);
    assert.doesNotMatch(sql, /reopen_generation/);
    assert.doesNotMatch(sql, /last_reopened_at/);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('claim ordering uses the flag-gated queue column in both candidate queries', () => {
  const source = fs.readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/claimOrderByClause\(\)/g) || []).length, 2);
  assert.match(source, /reopenClockUpdateSql\(acquisitionJobClockV2Enabled\(\)\)/);
});
