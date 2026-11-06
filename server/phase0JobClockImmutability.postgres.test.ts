import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './dbCore';
import { CAPACITY_LEASE_DURATION_MS, capacityLeaseRefreshSetSql } from './acquisitionJobClockPolicy';

const maybe = process.env.DATABASE_URL ? test : test.skip;

function time(value: unknown): number {
  return new Date(String(value)).getTime();
}

maybe('job clocks survive capacity-lease renewal and reject re-aging', async t => {
  const db = await getDb();
  const key = `phase0-clock-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inserted = await db.query(
    `INSERT INTO jobs(
       type,payload,priority,max_attempts,status,created_at,
       first_enqueued_at,last_enqueued_at,first_transient_failure_at,
       capacity_lease_renewals,idempotency_key
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

  const rejected = (sql: string, values: unknown[] = [original.id]) => assert.rejects(
    db.query(sql, values),
    (error: any) => {
      assert.equal(error?.code, 'P0001');
      assert.match(String(error?.message), /JOB_CLOCK_IMMUTABLE/);
      return true;
    }
  );

  await rejected(`UPDATE jobs SET first_enqueued_at=now()-interval '1 hour' WHERE id=$1`);
  await rejected(`UPDATE jobs SET first_enqueued_at=NULL WHERE id=$1`);
  await rejected(`UPDATE jobs SET first_transient_failure_at=now() WHERE id=$1`);
  await rejected(`UPDATE jobs SET capacity_lease_renewals=capacity_lease_renewals+1,created_at=now() WHERE id=$1`);
  await rejected(`UPDATE jobs SET capacity_lease_renewals=capacity_lease_renewals+1,first_transient_failure_at=NULL WHERE id=$1`);

  // A proper lease renewal touches bookkeeping only.
  await db.query(
    `UPDATE jobs SET ${capacityLeaseRefreshSetSql('$2')} WHERE id=$1`,
    [original.id, String(CAPACITY_LEASE_DURATION_MS)]
  );
  const first = (await db.query(
    `SELECT created_at,first_enqueued_at,last_enqueued_at,first_transient_failure_at,
            capacity_lease_started_at,capacity_lease_expires_at,
            capacity_lease_renewed_at,capacity_lease_renewals
       FROM jobs WHERE id=$1`,
    [original.id]
  )).rows[0];

  assert.equal(time(first.created_at), time(original.created_at));
  assert.equal(time(first.first_enqueued_at), time(original.first_enqueued_at));
  assert.equal(time(first.first_transient_failure_at), time(original.first_transient_failure_at));
  assert.ok(first.capacity_lease_started_at);
  assert.ok(time(first.capacity_lease_expires_at) > Date.now());
  assert.equal(first.capacity_lease_renewed_at, null);
  assert.equal(first.capacity_lease_renewals, 0);

  const leaseStartedAt = time(first.capacity_lease_started_at);
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

  assert.equal(time(second.created_at), time(original.created_at));
  assert.equal(time(second.first_enqueued_at), time(original.first_enqueued_at));
  assert.equal(time(second.first_transient_failure_at), time(original.first_transient_failure_at));
  assert.equal(time(second.capacity_lease_started_at), leaseStartedAt);
  assert.ok(second.capacity_lease_renewed_at);
  assert.equal(second.capacity_lease_renewals, 1);

  // Reopening work into a new epoch may advance last_enqueued_at and the
  // lease together, but still cannot re-age the queue or the failure anchor.
  const beforeReopenLease = time(second.capacity_lease_started_at);
  await db.query(
    `UPDATE jobs SET last_enqueued_at=now(),${capacityLeaseRefreshSetSql('$2')} WHERE id=$1`,
    [original.id, String(CAPACITY_LEASE_DURATION_MS)]
  );
  const reopened = (await db.query(
    `SELECT created_at,first_enqueued_at,last_enqueued_at,first_transient_failure_at,
            capacity_lease_started_at,capacity_lease_renewals
       FROM jobs WHERE id=$1`,
    [original.id]
  )).rows[0];
  assert.equal(time(reopened.created_at), time(original.created_at));
  assert.equal(time(reopened.first_enqueued_at), time(original.first_enqueued_at));
  assert.equal(time(reopened.first_transient_failure_at), time(original.first_transient_failure_at));
  assert.equal(time(reopened.capacity_lease_started_at), beforeReopenLease);
  assert.ok(time(reopened.last_enqueued_at) >= Date.now() - 5_000);
  assert.equal(reopened.capacity_lease_renewals, 2);

  // Legacy paths may still reset the queue clock or clear the failure anchor,
  // as long as they do not also touch capacity-lease bookkeeping.
  await db.query(`UPDATE jobs SET created_at=now(),updated_at=now() WHERE id=$1`, [original.id]);
  await db.query(`UPDATE jobs SET first_transient_failure_at=NULL WHERE id=$1`, [original.id]);
  const legacy = (await db.query(
    `SELECT created_at,first_enqueued_at,first_transient_failure_at FROM jobs WHERE id=$1`,
    [original.id]
  )).rows[0];
  assert.equal(time(legacy.first_enqueued_at), time(original.first_enqueued_at));
  assert.ok(time(legacy.created_at) >= Date.now() - 5_000);
  assert.equal(legacy.first_transient_failure_at, null);

  // A cleared anchor may be set once for the new epoch, then it is immovable.
  await db.query(`UPDATE jobs SET first_transient_failure_at=now() WHERE id=$1`, [original.id]);
  await rejected(`UPDATE jobs SET first_transient_failure_at=now()+interval '1 second' WHERE id=$1`);
});

maybe('the bounded backfill may fill a null queue clock exactly once', async t => {
  const db = await getDb();
  const key = `phase0-clock-backfill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inserted = await db.query(
    `INSERT INTO jobs(
       type,payload,priority,max_attempts,status,created_at,
       first_enqueued_at,last_enqueued_at,idempotency_key
     ) VALUES(
       'PHASE0_CLOCK_TEST','{}'::jsonb,0,3,'PENDING',now()-interval '10 hours',
       NULL,NULL,$1
     )
     RETURNING id,created_at`,
    [key]
  );
  const original = inserted.rows[0];
  t.after(async () => {
    await db.query(`DELETE FROM job_attempts WHERE job_id=$1`, [original.id]);
    await db.query(`DELETE FROM jobs WHERE id=$1`, [original.id]);
  });

  await db.query(
    `UPDATE jobs SET first_enqueued_at=now()-interval '10 hours',last_enqueued_at=now()-interval '10 hours' WHERE id=$1`,
    [original.id]
  );
  const filled = (await db.query(
    `SELECT created_at,first_enqueued_at FROM jobs WHERE id=$1`,
    [original.id]
  )).rows[0];
  assert.equal(time(filled.created_at), time(original.created_at));
  assert.equal(time(filled.first_enqueued_at), time(original.created_at));

  await assert.rejects(
    db.query(`UPDATE jobs SET first_enqueued_at=now()-interval '9 hours' WHERE id=$1`, [original.id]),
    (error: any) => {
      assert.equal(error?.code, 'P0001');
      assert.match(String(error?.message), /JOB_CLOCK_IMMUTABLE/);
      return true;
    }
  );
});
