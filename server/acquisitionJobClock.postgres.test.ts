import test from 'node:test';
import assert from 'node:assert/strict';
import { claimNextJob, enqueueJob, getDb } from './dbCore';
import {
  ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV,
  CAPACITY_LEASE_DURATION_MS,
  capacityLeaseRefreshSetSql,
} from './acquisitionJobClockPolicy';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

maybe('capacity lease refresh preserves queue age and the genuine failure anchor', async t => {
  const db = await getDb();
  const key = `phase0-clock-lease-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inserted = await db.query(
    `INSERT INTO jobs(
       type,payload,priority,max_attempts,status,created_at,first_enqueued_at,
       last_enqueued_at,first_transient_failure_at,capacity_lease_renewals,idempotency_key
     ) VALUES(
       'PHASE0_CLOCK_TEST','{}'::jsonb,0,3,'PENDING',
       now()-interval '10 hours',now()-interval '10 hours',now()-interval '10 hours',
       now()-interval '9 hours',0,$1
     )
     RETURNING id,created_at,first_enqueued_at,first_transient_failure_at`,
    [key]
  );
  const original = inserted.rows[0];
  t.after(async () => {
    await db.query(`DELETE FROM job_attempts WHERE job_id=$1`, [original.id]);
    await db.query(`DELETE FROM jobs WHERE id=$1`, [original.id]);
  });

  await db.query(
    `UPDATE jobs SET ${capacityLeaseRefreshSetSql('$2')} WHERE id=$1`,
    [original.id, String(CAPACITY_LEASE_DURATION_MS)]
  );
  const first = (await db.query(
    `SELECT created_at,first_enqueued_at,first_transient_failure_at,
            capacity_lease_started_at,capacity_lease_expires_at,
            capacity_lease_renewed_at,capacity_lease_renewals
       FROM jobs WHERE id=$1`,
    [original.id]
  )).rows[0];

  assert.equal(new Date(first.created_at).getTime(), new Date(original.created_at).getTime());
  assert.equal(new Date(first.first_enqueued_at).getTime(), new Date(original.first_enqueued_at).getTime());
  assert.equal(new Date(first.first_transient_failure_at).getTime(), new Date(original.first_transient_failure_at).getTime());
  assert.ok(first.capacity_lease_started_at);
  assert.ok(new Date(first.capacity_lease_expires_at).getTime() > Date.now());
  assert.equal(first.capacity_lease_renewed_at, null);
  assert.equal(first.capacity_lease_renewals, 0);

  const startedAt = new Date(first.capacity_lease_started_at).getTime();
  await new Promise(resolve => setTimeout(resolve, 20));
  await db.query(
    `UPDATE jobs SET ${capacityLeaseRefreshSetSql('$2')} WHERE id=$1`,
    [original.id, String(CAPACITY_LEASE_DURATION_MS)]
  );
  const second = (await db.query(
    `SELECT created_at,first_enqueued_at,first_transient_failure_at,
            capacity_lease_started_at,capacity_lease_renewed_at,capacity_lease_renewals
       FROM jobs WHERE id=$1`,
    [original.id]
  )).rows[0];

  assert.equal(new Date(second.created_at).getTime(), new Date(original.created_at).getTime());
  assert.equal(new Date(second.first_enqueued_at).getTime(), new Date(original.first_enqueued_at).getTime());
  assert.equal(new Date(second.first_transient_failure_at).getTime(), new Date(original.first_transient_failure_at).getTime());
  assert.equal(new Date(second.capacity_lease_started_at).getTime(), startedAt);
  assert.ok(second.capacity_lease_renewed_at);
  assert.equal(second.capacity_lease_renewals, 1);
});

maybe('enqueueJob reopen records a new generation without rewriting the first enqueue or failure clocks', async t => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  const key = `phase0-clock-reopen-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const db = await getDb();
  t.after(async () => {
    await db.query(`DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE idempotency_key=$1)`, [key]);
    await db.query(`DELETE FROM jobs WHERE idempotency_key=$1`, [key]);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });
  try {
    const inserted = await db.query(
      `INSERT INTO jobs(
         type,payload,priority,max_attempts,status,attempts,created_at,
         first_enqueued_at,last_enqueued_at,first_transient_failure_at,
         reopen_generation,idempotency_key,run_after
       ) VALUES(
         'PHASE0_CLOCK_TEST','{}'::jsonb,0,3,'COMPLETED',3,
         now()-interval '10 hours',now()-interval '20 hours',now()-interval '10 hours',
         now()-interval '9 hours',2,$1,now()
       )
       RETURNING id,created_at,first_enqueued_at,first_transient_failure_at`,
      [key]
    );
    const original = inserted.rows[0];

    await enqueueJob('PHASE0_CLOCK_TEST', { reopened: true }, { idempotencyKey: key, maxAttempts: 3 });
    const after = (await db.query(
      `SELECT status,created_at,first_enqueued_at,last_enqueued_at,
              first_transient_failure_at,reopen_generation,last_reopened_at
         FROM jobs WHERE id=$1`,
      [original.id]
    )).rows[0];

    assert.equal(after.status, 'PENDING');
    assert.equal(new Date(after.created_at).getTime(), new Date(original.created_at).getTime());
    assert.equal(new Date(after.first_enqueued_at).getTime(), new Date(original.first_enqueued_at).getTime());
    assert.equal(new Date(after.first_transient_failure_at).getTime(), new Date(original.first_transient_failure_at).getTime());
    assert.equal(after.reopen_generation, 3);
    assert.ok(after.last_reopened_at);
    assert.ok(new Date(after.last_enqueued_at).getTime() >= Date.now() - 5_000);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

maybe('claimNextJob uses first_enqueued_at for FIFO when the clock flag is on', async t => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  const db = await getDb();
  const type = `PHASE0_CLOCK_CLAIM_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  t.after(async () => {
    await db.query(`DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE type=$1)`, [type]);
    await db.query(`DELETE FROM jobs WHERE type=$1`, [type]);
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  });
  try {
    const early = await db.query(
      `INSERT INTO jobs(
         type,payload,priority,max_attempts,status,created_at,first_enqueued_at,
         last_enqueued_at,idempotency_key,run_after
       ) VALUES(
         $1,'{}'::jsonb,0,3,'PENDING',now()-interval '1 hour',
         now()-interval '3 hours',now()-interval '3 hours',$2,now()-interval '1 minute'
       ) RETURNING id`,
      [type, `${type}-early`]
    );
    await db.query(
      `INSERT INTO jobs(
         type,payload,priority,max_attempts,status,created_at,first_enqueued_at,
         last_enqueued_at,idempotency_key,run_after
       ) VALUES(
         $1,'{}'::jsonb,0,3,'PENDING',now()-interval '3 hours',
         now()-interval '1 hour',now()-interval '1 hour',$2,now()-interval '1 minute'
       )`,
      [type, `${type}-late`]
    );

    const claimed = await claimNextJob('phase0-clock-test-worker', [type]);
    assert.equal(claimed?.id, early.rows[0].id, 'the older first_enqueued_at must win even though its created_at is newer');
    await db.query(`UPDATE jobs SET status='COMPLETED' WHERE id=$1`, [early.rows[0].id]);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});
