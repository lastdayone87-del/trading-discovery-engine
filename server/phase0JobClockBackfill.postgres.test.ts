import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillPhase0JobClocks, getDb } from './dbCore';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

maybe('phase 0 clock backfill preserves earliest evidence and historical clocks', async t => {
  const db = await getDb();
  const prefix = `phase0-backfill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const anchor = iso(now - 10 * 60_000);

  const ids: string[] = [];

  t.after(async () => {
    if (!ids.length) return;
    await db.query(`DELETE FROM job_attempts WHERE job_id=ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM jobs WHERE id=ANY($1::uuid[])`, [ids]);
  });

  const insert = async (suffix: string, createdAt: string, payload: unknown): Promise<string> => {
    const res = await db.query(
      `INSERT INTO jobs(
         type,payload,priority,max_attempts,status,created_at,
         first_enqueued_at,last_enqueued_at,first_transient_failure_at,idempotency_key
       ) VALUES(
         $1,$2::jsonb,0,3,'PENDING',$3::timestamptz,
         NULL,NULL,$4::timestamptz,$5
       ) RETURNING id`,
      ['PHASE0_CLOCK_BACKFILL_TEST', JSON.stringify(payload), createdAt, anchor, `${prefix}-${suffix}`],
    );
    const id = res.rows[0].id as string;
    ids.push(id);
    return id;
  };

  const createdEarlier = iso(now - 60 * 60_000);
  const createdLater = iso(now - 4 * 60 * 60_000);
  const createdMissing = iso(now - 2 * 60 * 60_000);
  const createdMalformed = iso(now - 5 * 60 * 60_000);
  const createdAttempt = iso(now - 30 * 60_000);
  const observedEarlier = iso(now - 3 * 60 * 60_000);
  const observedLater = iso(now - 60 * 60_000);
  const observedAttempt = iso(now - 20 * 60_000);
  const firstAttempt = iso(now - 6 * 60 * 60_000);

  const earlierId = await insert('earlier', createdEarlier, { retryObservedAt: observedEarlier });
  const laterId = await insert('later', createdLater, { retryObservedAt: observedLater });
  const missingId = await insert('missing', createdMissing, {});
  const malformedId = await insert('malformed', createdMalformed, { retryObservedAt: 'not-a-date' });
  const attemptId = await insert('attempt', createdAttempt, { retryObservedAt: observedAttempt });

  await db.query(
    `INSERT INTO job_attempts(job_id,attempt_number,started_at,status)
     VALUES($1,1,$2::timestamptz,'FAILED')`,
    [attemptId, firstAttempt],
  );

  const processed = await backfillPhase0JobClocks(db);
  assert.ok(processed >= ids.length, 'the backfill must process every inserted legacy row');

  const rows = (await db.query(
    `SELECT id,created_at,first_enqueued_at,last_enqueued_at,first_transient_failure_at
       FROM jobs WHERE id=ANY($1::uuid[])`,
    [ids],
  )).rows;
  const byId = new Map(rows.map(row => [String(row.id), row]));
  const assertClock = (id: string, expectedFirst: string) => {
    const row = byId.get(id);
    assert.ok(row, `missing backfilled row ${id}`);
    assert.equal(new Date(row.first_enqueued_at).getTime(), new Date(expectedFirst).getTime());
    const created = row.id === earlierId ? createdEarlier
      : row.id === laterId ? createdLater
      : row.id === missingId ? createdMissing
      : row.id === malformedId ? createdMalformed
      : createdAttempt;
    assert.equal(new Date(row.last_enqueued_at).getTime(), new Date(created).getTime());
    assert.equal(new Date(row.created_at).getTime(), new Date(created).getTime());
    assert.equal(new Date(row.first_transient_failure_at).getTime(), new Date(anchor).getTime());
  };

  // An earlier retry observation is accepted as the first queue clock.
  assertClock(earlierId, observedEarlier);
  // A later retry observation is not immutable evidence; created_at wins.
  assertClock(laterId, createdLater);
  // Missing and malformed payloads fall back to created_at without aborting.
  assertClock(missingId, createdMissing);
  assertClock(malformedId, createdMalformed);
  // The first attempt predates both re-aged clocks, so it is the best floor.
  assertClock(attemptId, firstAttempt);

  const replay = await backfillPhase0JobClocks(db);
  assert.ok(Number.isInteger(replay) && replay >= 0);
  const afterReplay = (await db.query(
    `SELECT id,first_enqueued_at,last_enqueued_at FROM jobs WHERE id=ANY($1::uuid[])`,
    [ids],
  )).rows;
  for (const row of afterReplay) {
    const before = byId.get(String(row.id));
    assert.ok(before);
    assert.equal(new Date(row.first_enqueued_at).getTime(), new Date(before.first_enqueued_at).getTime());
    assert.equal(new Date(row.last_enqueued_at).getTime(), new Date(before.last_enqueued_at).getTime());
  }
});
