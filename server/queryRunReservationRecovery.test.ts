import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, reconcileTerminalQueryRunsForQuery } from './db';

const databaseUrl = process.env.PHASE4_POSTGRES_URL;

test('PART K PostgreSQL: terminal failed SEARCH_YOUTUBE job closes its stale active query run and releases the library reservation', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `part-k-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let jobId: string | undefined;
  let runId: string | undefined;
  try {
    queryId = (await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query)
       VALUES($1,'BE','EXPERIMENTAL','STOCKS',$1) RETURNING id`, [suffix]
    )).rows[0].id;
    await db.query(
      `UPDATE query_library
       SET reserved_at=now(),reserved_until=now()+interval '20 minutes',reserved_by=$2
       WHERE id=$1`, [queryId, `test:${suffix}`]
    );
    jobId = (await db.query(
      `INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key,status)
       VALUES('SEARCH_YOUTUBE',$1,20,3,$2,'FAILED') RETURNING id`,
      [JSON.stringify({ queryId, country: 'Belgium' }), `part-k-job:${suffix}`]
    )).rows[0].id;
    runId = (await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,provider_key,job_id)
       VALUES($1,'BE','automated_query','RUNNING','BASELINE','part-k','VIDEO','RELEVANCE','youtube-search',$2) RETURNING id`,
      [queryId, jobId]
    )).rows[0].id;
    await db.query(`UPDATE jobs SET attempts=max_attempts WHERE id=$1`, [jobId]);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const reconciled = await reconcileTerminalQueryRunsForQuery(client, queryId);
      await client.query('COMMIT');
      assert.equal(reconciled, 1);
    } finally {
      client.release();
    }

    const run = (await db.query(
      `SELECT status,completed_at,performance_details->>'failureKind' AS failure_kind
       FROM query_runs WHERE id=$1`, [runId]
    )).rows[0];
    assert.equal(run.status, 'FAILED');
    assert.ok(run.completed_at);
    assert.equal(run.failure_kind, 'ORPHANED_TERMINAL_JOB_FAILURE');
    const library = (await db.query(
      `SELECT reserved_at,reserved_until,reserved_by FROM query_library WHERE id=$1`, [queryId]
    )).rows[0];
    assert.equal(library.reserved_at, null);
    assert.equal(library.reserved_until, null);
    assert.equal(library.reserved_by, null);
  } finally {
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (jobId) await db.query('DELETE FROM jobs WHERE id=$1', [jobId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
    await db.end();
  }
});

test('PART K PostgreSQL: a non-terminal linked job does not get reconciled or release the reservation', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `part-k-live-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let jobId: string | undefined;
  let runId: string | undefined;
  try {
    queryId = (await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query)
       VALUES($1,'BE','EXPERIMENTAL','STOCKS',$1) RETURNING id`, [suffix]
    )).rows[0].id;
    await db.query(
      `UPDATE query_library SET reserved_at=now(),reserved_until=now()+interval '20 minutes',reserved_by=$2 WHERE id=$1`,
      [queryId, `test:${suffix}`]
    );
    jobId = (await db.query(
      `INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key,status)
       VALUES('SEARCH_YOUTUBE',$1,20,3,$2,'PENDING') RETURNING id`,
      [JSON.stringify({ queryId, country: 'Belgium' }), `part-k-live-job:${suffix}`]
    )).rows[0].id;
    runId = (await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,provider_key,job_id)
       VALUES($1,'BE','automated_query','RUNNING','BASELINE','part-k-live','VIDEO','RELEVANCE','youtube-search',$2) RETURNING id`,
      [queryId, jobId]
    )).rows[0].id;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const reconciled = await reconcileTerminalQueryRunsForQuery(client, queryId);
      await client.query('COMMIT');
      assert.equal(reconciled, 0);
    } finally {
      client.release();
    }

    const run = (await db.query('SELECT status FROM query_runs WHERE id=$1', [runId])).rows[0];
    assert.equal(run.status, 'RUNNING');
    const library = (await db.query('SELECT reserved_by FROM query_library WHERE id=$1', [queryId])).rows[0];
    assert.equal(library.reserved_by, `test:${suffix}`);
  } finally {
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (jobId) await db.query('DELETE FROM jobs WHERE id=$1', [jobId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
    await db.end();
  }
});

test('PART K unit: reconciliation only targets terminal failed linked jobs and preserves the reservation SQL boundary', async () => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const client = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql.includes('WITH orphaned')) return { rows: [{ id: 'run-1', query_id: 233 }] };
      return { rows: [] };
    }
  };
  assert.equal(await reconcileTerminalQueryRunsForQuery(client, 233), 1);
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /j\.type = 'SEARCH_YOUTUBE'/);
  assert.match(calls[0].sql, /j\.status = 'FAILED'/);
  assert.match(calls[0].sql, /j\.attempts >= j\.max_attempts/);
  assert.match(calls[0].sql, /qr\.status IN \('SCHEDULED','RUNNING','RETRYING'\)/);
  assert.match(calls[1].sql, /status='RELEASED'/);
  assert.match(calls[2].sql, /NOT EXISTS/);
});

test('PART K unit: no orphaned row produces no cleanup writes', async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    }
  };
  assert.equal(await reconcileTerminalQueryRunsForQuery(client, 233), 0);
  assert.equal(calls.length, 1);
});
