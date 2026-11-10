import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getDb } from './dbCore';
import { runRetryBacklogTriageApply } from './retryBacklogTriageApply';

// This suite writes a fixture job/triage row inside a transaction that is
// rolled back. It is opt-in and uses a dedicated scratch database.
const dedicatedDatabaseUrl = process.env.PHASE2_RETRY_TRIAGE_TEST_DATABASE_URL;
if (dedicatedDatabaseUrl) process.env.DATABASE_URL = dedicatedDatabaseUrl;
const enabled = Boolean(dedicatedDatabaseUrl);
const maybe = enabled ? test : test.skip;

maybe('migration 176 and the bounded apply support reversible quarantine', async () => {
  const db = await getDb();
  const client = await db.connect();
  const jobId = randomUUID();
  const now = new Date('2026-11-10T12:00:00.000Z');
  try {
    await client.query('BEGIN');

    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='retry_backlog_triage'`,
    );
    const names = new Set(columns.rows.map(row => String(row.column_name)));
    for (const required of [
      'job_id', 'bucket', 'reason', 'evidence', 'original_priority',
      'original_run_after', 'deferred_until', 'applied_at', 'applied_by',
    ]) {
      assert.ok(names.has(required), `retry_backlog_triage.${required} exists`);
    }

    await client.query(
      `INSERT INTO jobs(id,type,payload,status,priority,max_attempts,run_after,idempotency_key)
       VALUES($1,'RETRY_COMMUNITY_ACQUISITION',$2::jsonb,'PENDING',77,5,'2026-01-01T00:00:00Z',$3)`,
      [
        jobId,
        JSON.stringify({
          channelId: `UCmissing-${jobId}`,
          retryLifecycleVersion: 2,
          retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
          retryObservedAt: '2026-10-01T00:00:00.000Z',
        }),
        `phase2-retry-triage-${jobId}`,
      ],
    );

    const report = await runRetryBacklogTriageApply(client, {
      apply: true,
      actor: 'operator@test',
      jobIds: [jobId],
      buckets: ['QUARANTINE'],
      maxActions: 1,
      now: () => now,
    });
    assert.equal(report.summary.applied, 1);
    assert.equal(report.summary.quarantine, 1);

    const job = await client.query(
      `SELECT status,priority,run_after FROM jobs WHERE id=$1`,
      [jobId],
    );
    assert.equal(job.rows[0].status, 'PENDING');
    assert.equal(Number(job.rows[0].priority), -1000);
    assert.ok(new Date(job.rows[0].run_after).getTime() > now.getTime());

    const triage = await client.query(
      `SELECT bucket,reason,original_priority,original_run_after,deferred_until
         FROM retry_backlog_triage WHERE job_id=$1`,
      [jobId],
    );
    assert.equal(triage.rows[0].bucket, 'QUARANTINE');
    assert.equal(triage.rows[0].reason, 'CHANNEL_MISSING');
    assert.equal(Number(triage.rows[0].original_priority), 77);
    assert.equal(
      new Date(triage.rows[0].original_run_after).toISOString(),
      '2026-01-01T00:00:00.000Z',
    );
    assert.equal(
      new Date(triage.rows[0].deferred_until).toISOString(),
      '2026-12-10T12:00:00.000Z',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
