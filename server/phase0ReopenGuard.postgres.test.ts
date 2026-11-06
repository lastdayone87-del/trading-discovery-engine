import test from 'node:test';
import assert from 'node:assert/strict';
import { claimNextJob, enqueueJob, getDb, markCommunityInspectionStarted } from './dbCore';
import { ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV } from './acquisitionJobClockPolicy';

// These tests toggle the database-wide job_reopen_guard_config row. They only
// run in the dedicated Phase 0 reopen-guard workflow so a shared test database
// used by unrelated PostgreSQL suites never observes the guard enabled.
//
// The opt-in variable also selects the connection: enabling the suite must
// never mutate whatever DATABASE_URL happened to be inherited from the shell.
const dedicatedDatabaseUrl = process.env.PHASE0_REOPEN_GUARD_TEST_DATABASE_URL;
if (dedicatedDatabaseUrl) process.env.DATABASE_URL = dedicatedDatabaseUrl;
const enabled = Boolean(dedicatedDatabaseUrl);
const maybe = enabled ? test : test.skip;

const RETRY_TYPE = 'RETRY_COMMUNITY_ACQUISITION';
const ENRICH_TYPE = 'ENRICH_CHANNEL';

interface Fixture {
  id: string;
  channelId: string;
  key: string;
}

async function resetGuard(db: any): Promise<void> {
  await db.query(
    `UPDATE job_reopen_guard_config
        SET enabled=false,max_reopens_per_30d=6,updated_at=now()
      WHERE singleton`,
  );
}

async function insertTerminalJob(
  db: any,
  type: string,
  status = 'COMPLETED',
  channelIdOverride?: string,
): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const key = `phase0-reopen-guard-${suffix}`;
  const channelId = channelIdOverride || `UCphase0${suffix}`;
  const inserted = await db.query(
    `INSERT INTO jobs(
       type,payload,priority,max_attempts,status,attempts,run_after,
       reopen_generation,idempotency_key
     ) VALUES(
       $1,$2::jsonb,1000000000,3,$3,3,now()-interval '1 minute',0,$4
     )
     RETURNING id`,
    [type, JSON.stringify({ channelId }), status, key],
  );
  return { id: inserted.rows[0].id, channelId, key };
}

async function cleanup(db: any, fixture: Fixture): Promise<void> {
  await db.query(`DELETE FROM job_reopen_events WHERE job_id=$1`, [fixture.id]);
  await db.query(`DELETE FROM job_attempts WHERE job_id=$1`, [fixture.id]);
  await db.query(`DELETE FROM jobs WHERE id=$1`, [fixture.id]);
}

async function waitForWaitingAdvisoryLock(db: any, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await db.query(
      `SELECT count(*)::int AS waiting
         FROM pg_locks
        WHERE locktype='advisory' AND NOT granted`,
    );
    if (Number(waiting.rows[0]?.waiting || 0) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('second reopen never blocked on the channel advisory lock');
}

async function reopen(db: any, fixture: Fixture, type = RETRY_TYPE): Promise<{ status: string; generation: number }> {
  const returned = await enqueueJob(
    type,
    { channelId: fixture.channelId },
    {
      idempotencyKey: fixture.key,
      priority: 1_000_000_000,
      maxAttempts: 3,
      clientOverride: db,
    },
  );
  const row = (await db.query(
    `SELECT status,reopen_generation FROM jobs WHERE id=$1`,
    [fixture.id],
  )).rows[0];
  return { status: returned.status, generation: Number(row.reopen_generation) };
}

maybe('a reopen records prior status and keeps generation-scoped attempt history', async t => {
  delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  const db = await getDb();
  await resetGuard(db);
  const fixture = await insertTerminalJob(db, ENRICH_TYPE);
  t.after(async () => {
    await cleanup(db, fixture);
    await resetGuard(db);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });

  await db.query(
    `INSERT INTO job_attempts(job_id,attempt_number,generation,status,finished_at)
     VALUES($1,1,0,'COMPLETED',now())`,
    [fixture.id],
  );

  // The clock flag is intentionally off here: the trigger must maintain reopen
  // identity even on the legacy path.
  const first = await reopen(db, fixture, ENRICH_TYPE);
  assert.equal(first.status, 'PENDING');
  assert.equal(first.generation, 1);

  const afterReopen = (await db.query(
    `SELECT status,reopen_generation,reopened_from_status,last_reopened_at
       FROM jobs WHERE id=$1`,
    [fixture.id],
  )).rows[0];
  assert.equal(afterReopen.status, 'PENDING');
  assert.equal(afterReopen.reopen_generation, 1);
  assert.equal(afterReopen.reopened_from_status, 'COMPLETED');
  assert.ok(afterReopen.last_reopened_at);

  const event = (await db.query(
    `SELECT outcome,prior_status,prior_generation,next_generation,reason
       FROM job_reopen_events WHERE job_id=$1 ORDER BY reopened_at DESC LIMIT 1`,
    [fixture.id],
  )).rows[0];
  assert.equal(event.outcome, 'REOPENED');
  assert.equal(event.prior_status, 'COMPLETED');
  assert.equal(event.prior_generation, 0);
  assert.equal(event.next_generation, 1);
  assert.equal(event.reason, 'STATUS_TRANSITION');

  const claimed = await claimNextJob(`phase0-reopen-guard-${Date.now()}`, [ENRICH_TYPE]);
  assert.equal(claimed?.id, fixture.id, 'the highest-priority queued retry must be claimed');
  assert.equal(
    claimed?.reopen_generation,
    1,
    'the claimed job must expose its generation to the worker attempt marker',
  );

  const attempts = (await db.query(
    `SELECT generation,attempt_number,status
       FROM job_attempts WHERE job_id=$1 ORDER BY generation`,
    [fixture.id],
  )).rows;
  assert.equal(attempts.length, 2, 'the pre-reopen attempt must remain in history');
  assert.deepEqual(
    attempts.map(row => ({
      generation: Number(row.generation),
      attemptNumber: Number(row.attempt_number),
      status: row.status,
    })),
    [
      { generation: 0, attemptNumber: 1, status: 'COMPLETED' },
      { generation: 1, attemptNumber: 1, status: 'PROCESSING' },
    ],
  );

  // Simulate a worker deployed before this change: it omits the column.
  await db.query(
    `INSERT INTO job_attempts(job_id,attempt_number,status) VALUES($1,2,'PROCESSING')`,
    [fixture.id],
  );
  const olderWorkerAttempt = (await db.query(
    `SELECT generation FROM job_attempts WHERE job_id=$1 AND attempt_number=2`,
    [fixture.id],
  )).rows[0];
  assert.equal(
    Number(olderWorkerAttempt.generation),
    1,
    'the database must assign the claimed job generation when an older worker omits it',
  );

  // A late marker from an older generation must not attach to the current
  // attempt even when attempt_number matches; it only matches its own row.
  await assert.rejects(
    markCommunityInspectionStarted(fixture.id, 2, 0),
    /Community inspection marker found no open attempt/,
  );
  await markCommunityInspectionStarted(fixture.id, 2, 1);
  const markedAttempt = (await db.query(
    `SELECT logs FROM job_attempts WHERE job_id=$1 AND attempt_number=2`,
    [fixture.id],
  )).rows[0];
  assert.ok(
    Array.isArray(markedAttempt.logs)
      && markedAttempt.logs.includes('communityInspectionStarted'),
    'the matching generation must receive the execution marker',
  );

  await db.query(`UPDATE jobs SET status='COMPLETED',completed_at=now() WHERE id=$1`, [fixture.id]);
});

maybe('the enabled guard blocks the reopen after the per-channel cap', async t => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  const db = await getDb();
  const fixture = await insertTerminalJob(db, RETRY_TYPE);
  t.after(async () => {
    await cleanup(db, fixture);
    await resetGuard(db);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });

  await db.query(
    `UPDATE job_reopen_guard_config
        SET enabled=true,max_reopens_per_30d=2,updated_at=now()
      WHERE singleton`,
  );

  for (let generation = 1; generation <= 2; generation++) {
    const reopened = await reopen(db, fixture);
    assert.equal(reopened.status, 'PENDING');
    assert.equal(reopened.generation, generation);
    await db.query(`UPDATE jobs SET status='COMPLETED',completed_at=now() WHERE id=$1`, [fixture.id]);
  }

  const blocked = await reopen(db, fixture);
  assert.equal(blocked.status, 'COMPLETED', 'the blocked enqueue must return the terminal owner');
  assert.equal(blocked.generation, 2, 'a blocked reopen must not advance the generation');
  const blockedAgain = await reopen(db, fixture);
  assert.equal(blockedAgain.status, 'COMPLETED');

  const row = (await db.query(
    `SELECT status,reopen_generation FROM jobs WHERE id=$1`,
    [fixture.id],
  )).rows[0];
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.reopen_generation, 2);

  const events = (await db.query(
    `SELECT outcome,reason,prior_generation,next_generation
       FROM job_reopen_events WHERE job_id=$1 ORDER BY reopened_at, outcome`,
    [fixture.id],
  )).rows;
  assert.equal(events.filter(event => event.outcome === 'REOPENED').length, 2);
  const blockedEvents = events.filter(event => event.outcome === 'BLOCKED');
  assert.equal(blockedEvents.length, 1, 'the same blocked generation is recorded only once');
  const blockedEvent = blockedEvents[0];
  assert.equal(blockedEvent.reason, 'REOPEN_GENERATION_CAP');
  assert.equal(blockedEvent.prior_generation, 2);
  assert.equal(blockedEvent.next_generation, 3);
});

maybe('the cap is a rolling 30-day window', async t => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  const db = await getDb();
  const fixture = await insertTerminalJob(db, RETRY_TYPE);
  t.after(async () => {
    await cleanup(db, fixture);
    await resetGuard(db);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });

  for (let priorGeneration = 0; priorGeneration < 2; priorGeneration++) {
    await db.query(
      `INSERT INTO job_reopen_events(
         job_id,channel_id,job_type,outcome,prior_status,
         prior_generation,next_generation,reason,reopened_at
       ) VALUES($1,$2,$3,'REOPENED','COMPLETED',$4,$5,'STATUS_TRANSITION',now()-interval '31 days')`,
      [fixture.id, fixture.channelId, RETRY_TYPE, priorGeneration, priorGeneration + 1],
    );
  }
  await db.query(
    `UPDATE job_reopen_guard_config
        SET enabled=true,max_reopens_per_30d=2,updated_at=now()
      WHERE singleton`,
  );

  const reopened = await reopen(db, fixture);
  assert.equal(reopened.status, 'PENDING', 'events outside the window must not count against the cap');
  assert.equal(reopened.generation, 1);
});

maybe('an operator override can reopen a capped job', async t => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  const db = await getDb();
  const fixture = await insertTerminalJob(db, RETRY_TYPE);
  t.after(async () => {
    await cleanup(db, fixture);
    await resetGuard(db);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });

  for (let priorGeneration = 0; priorGeneration < 2; priorGeneration++) {
    await db.query(
      `INSERT INTO job_reopen_events(
         job_id,channel_id,job_type,outcome,prior_status,
         prior_generation,next_generation,reason
       ) VALUES($1,$2,$3,'REOPENED','COMPLETED',$4,$5,'STATUS_TRANSITION')`,
      [fixture.id, fixture.channelId, RETRY_TYPE, priorGeneration, priorGeneration + 1],
    );
  }
  await db.query(
    `UPDATE job_reopen_guard_config
        SET enabled=true,max_reopens_per_30d=2,updated_at=now()
      WHERE singleton`,
  );

  const blocked = await reopen(db, fixture);
  assert.equal(blocked.status, 'COMPLETED');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL acquisition.reopen_guard_override='on'`);
    // Exercise the real reopen path, not a raw status update: enqueueJob must
    // carry the operator override through the trigger.
    const reopened = await enqueueJob(
      RETRY_TYPE,
      { channelId: fixture.channelId },
      {
        idempotencyKey: fixture.key,
        priority: 1_000_000_000,
        maxAttempts: 3,
        clientOverride: client,
      },
    );
    assert.equal(reopened.status, 'PENDING');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const row = (await db.query(
    `SELECT status,reopen_generation FROM jobs WHERE id=$1`,
    [fixture.id],
  )).rows[0];
  assert.equal(row.status, 'PENDING');
  assert.equal(row.reopen_generation, 1);
});

maybe('the disabled guard records reopens but never blocks them', async t => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  const db = await getDb();
  const fixture = await insertTerminalJob(db, RETRY_TYPE);
  t.after(async () => {
    await cleanup(db, fixture);
    await resetGuard(db);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });

  await db.query(
    `UPDATE job_reopen_guard_config
        SET enabled=false,max_reopens_per_30d=1,updated_at=now()
      WHERE singleton`,
  );

  for (let generation = 1; generation <= 3; generation++) {
    const reopened = await reopen(db, fixture);
    assert.equal(reopened.status, 'PENDING');
    assert.equal(reopened.generation, generation);
    await db.query(`UPDATE jobs SET status='COMPLETED',completed_at=now() WHERE id=$1`, [fixture.id]);
  }

  const events = (await db.query(
    `SELECT outcome FROM job_reopen_events WHERE job_id=$1`,
    [fixture.id],
  )).rows;
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.outcome === 'REOPENED'));
});

maybe('non-acquisition job types are recorded but never capped', async t => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  const db = await getDb();
  const fixture = await insertTerminalJob(db, 'TERM_HARVEST');
  t.after(async () => {
    await cleanup(db, fixture);
    await resetGuard(db);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });

  await db.query(
    `UPDATE job_reopen_guard_config
        SET enabled=true,max_reopens_per_30d=1,updated_at=now()
      WHERE singleton`,
  );

  for (let generation = 1; generation <= 2; generation++) {
    const returned = await enqueueJob(
      'TERM_HARVEST',
      { channelId: fixture.channelId },
      { idempotencyKey: fixture.key, priority: 1_000_000_000, maxAttempts: 3, clientOverride: db },
    );
    assert.equal(returned.status, 'PENDING');
    const row = (await db.query(
      `SELECT reopen_generation FROM jobs WHERE id=$1`,
      [fixture.id],
    )).rows[0];
    assert.equal(Number(row.reopen_generation), generation);
    await db.query(`UPDATE jobs SET status='COMPLETED',completed_at=now() WHERE id=$1`, [fixture.id]);
  }

  const events = (await db.query(
    `SELECT outcome FROM job_reopen_events WHERE job_id=$1`,
    [fixture.id],
  )).rows;
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.outcome === 'REOPENED'));
});

maybe('concurrent reopens at the cap boundary cannot both pass', async t => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  const db = await getDb();
  const channelId = `UCphase0concurrent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const first = await insertTerminalJob(db, RETRY_TYPE, 'COMPLETED', channelId);
  const second = await insertTerminalJob(db, RETRY_TYPE, 'COMPLETED', channelId);
  t.after(async () => {
    await cleanup(db, first);
    await cleanup(db, second);
    await resetGuard(db);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });

  await db.query(
    `UPDATE job_reopen_guard_config
        SET enabled=true,max_reopens_per_30d=1,updated_at=now()
      WHERE singleton`,
  );

  const firstClient = await db.connect();
  const secondClient = await db.connect();
  let secondUpdate: any;
  try {
    await firstClient.query('BEGIN');
    await firstClient.query(`UPDATE jobs SET status='PENDING' WHERE id=$1`, [first.id]);

    await secondClient.query('BEGIN');
    secondUpdate = secondClient.query(`UPDATE jobs SET status='PENDING' WHERE id=$1`, [second.id]);
    // Wait until the second transaction is actually queued on the channel
    // advisory lock, then release it. A fixed sleep can miss this on slow CI.
    await waitForWaitingAdvisoryLock(db);
    await firstClient.query('COMMIT');

    const result = await secondUpdate;
    assert.equal(result.rowCount, 0, 'the second transaction must wait and then be capped');
    await secondClient.query('COMMIT');
  } catch (error) {
    await firstClient.query('ROLLBACK').catch(() => undefined);
    await secondClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    firstClient.release();
    secondClient.release();
  }

  const statuses = (await db.query(
    `SELECT id,status FROM jobs WHERE id=ANY($1::uuid[])`,
    [[first.id, second.id]],
  )).rows;
  assert.equal(
    statuses.filter(row => row.status === 'PENDING').length,
    1,
    'exactly one concurrent reopen may consume the last slot',
  );

  const events = (await db.query(
    `SELECT outcome FROM job_reopen_events WHERE job_id=ANY($1::uuid[])`,
    [[first.id, second.id]],
  )).rows;
  assert.equal(events.filter(event => event.outcome === 'REOPENED').length, 1);
  assert.equal(events.filter(event => event.outcome === 'BLOCKED').length, 1);
});
