import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getDb } from './dbCore';
import { runRetryBacklogTriageApply, runRetryBacklogTriageUndo } from './retryBacklogTriageApply';

// This suite writes a fixture job/triage row inside a transaction that is
// rolled back. It is opt-in and uses a dedicated scratch database.
const dedicatedDatabaseUrl = process.env.PHASE2_RETRY_TRIAGE_TEST_DATABASE_URL;
if (dedicatedDatabaseUrl) process.env.DATABASE_URL = dedicatedDatabaseUrl;
const enabled = Boolean(dedicatedDatabaseUrl);
const maybe = enabled ? test : test.skip;

maybe('migration 177 and the bounded apply close an evidenced terminal scope', async () => {
  const db = await getDb();
  const client = await db.connect();
  const jobId = randomUUID();
  const channelId = `UCtriage-terminal-${jobId}`;
  const now = new Date('2026-11-10T12:00:00.000Z');
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO channels(
         channel_id,channel_name,youtube_url,country,country_status,discord_status,
         scan_status,discovery_source,first_seen,trading_status,discord_validation_status,
         scope_eligibility
       ) VALUES($1,$2,$3,'Germany','CONFIRMED','UNCERTAIN','FAILED','automated_query',now(),
                'TRADING_CONFIRMED','RETRY_PENDING','OUT_OF_SCOPE')`,
      [channelId, `Channel ${channelId}`, `https://youtube.test/${channelId}`],
    );
    await client.query(
      `INSERT INTO jobs(id,type,payload,status,priority,max_attempts,run_after,idempotency_key)
       VALUES($1,'RETRY_COMMUNITY_ACQUISITION',$2::jsonb,'PENDING',77,5,'2026-01-01T00:00:00Z',$3)`,
      [
        jobId,
        JSON.stringify({
          channelId,
          retryLifecycleVersion: 2,
          retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
          retryObservedAt: '2026-10-01T00:00:00.000Z',
        }),
        `phase2-retry-terminal-${jobId}`,
      ],
    );

    const report = await runRetryBacklogTriageApply(client, {
      apply: true,
      actor: 'operator@test',
      jobIds: [jobId],
      buckets: ['TERMINAL'],
      maxActions: 1,
      now: () => now,
    });
    assert.equal(report.summary.applied, 1);
    const job = await client.query(
      `SELECT status,closed_reason,closed_by,closed_evidence FROM jobs WHERE id=$1`,
      [jobId],
    );
    assert.equal(job.rows[0].status, 'COMPLETED');
    assert.equal(job.rows[0].closed_reason, 'RETRY_TRIAGE_TERMINAL');
    assert.equal(job.rows[0].closed_by, 'operator@test');
    assert.equal(job.rows[0].closed_evidence.bucket, 'TERMINAL');
    assert.equal(job.rows[0].closed_evidence.reason, 'OUT_OF_SCOPE');
    const triage = await client.query(
      `SELECT bucket,reason FROM retry_backlog_triage WHERE job_id=$1`,
      [jobId],
    );
    assert.equal(triage.rows[0].bucket, 'TERMINAL');
    assert.equal(triage.rows[0].reason, 'OUT_OF_SCOPE');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

maybe('migration 177 and the bounded apply support reversible quarantine', async () => {
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

    const payload = {
      channelId: `UCmissing-${jobId}`,
      retryLifecycleVersion: 2,
      retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
      retryObservedAt: '2026-10-01T00:00:00.000Z',
    };
    await client.query(
      `INSERT INTO jobs(id,type,payload,status,priority,max_attempts,run_after,idempotency_key)
       VALUES($1,'RETRY_COMMUNITY_ACQUISITION',$2::jsonb,'PENDING',77,5,'2026-01-01T00:00:00Z',$3)`,
      [jobId, JSON.stringify(payload), `phase2-retry-triage-${jobId}`],
    );
    await client.query(
      `INSERT INTO job_attempts(job_id,attempt_number,status,finished_at,error)
       VALUES($1,1,'FAILED','2026-10-02T00:00:00Z','historical attempt')`,
      [jobId],
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
      `SELECT status,priority,payload,run_after FROM jobs WHERE id=$1`,
      [jobId],
    );
    assert.equal(job.rows[0].status, 'PENDING');
    assert.equal(Number(job.rows[0].priority), 77);
    assert.deepEqual(job.rows[0].payload, payload);
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
    assert.equal(
      new Date(job.rows[0].run_after).toISOString(),
      new Date(triage.rows[0].deferred_until).toISOString(),
    );

    const attempt = await client.query(
      `SELECT status,finished_at,error FROM job_attempts WHERE job_id=$1`,
      [jobId],
    );
    assert.equal(attempt.rows[0].status, 'FAILED');
    assert.equal(
      new Date(attempt.rows[0].finished_at).toISOString(),
      '2026-10-02T00:00:00.000Z',
    );
    assert.equal(attempt.rows[0].error, 'historical attempt');

    const undo = await runRetryBacklogTriageUndo(client, {
      actor: 'operator@test',
      jobIds: [jobId],
      maxActions: 1,
      now: () => now,
    });
    assert.equal(undo.restored, 1);
    const restored = await client.query(
      `SELECT run_after FROM jobs WHERE id=$1`,
      [jobId],
    );
    assert.equal(
      new Date(restored.rows[0].run_after).toISOString(),
      '2026-01-01T00:00:00.000Z',
    );
    const undone = await client.query(
      `SELECT undone_at,undone_by FROM retry_backlog_triage WHERE job_id=$1`,
      [jobId],
    );
    assert.ok(undone.rows[0].undone_at);
    assert.equal(undone.rows[0].undone_by, 'operator@test');

    await client.query('SAVEPOINT triage_guard');
    await assert.rejects(
      client.query(
        `UPDATE retry_backlog_triage SET reason='TAMPERED' WHERE job_id=$1`,
        [jobId],
      ),
      /RETRY_BACKLOG_TRIAGE_APPEND_ONLY/,
    );
    await client.query('ROLLBACK TO SAVEPOINT triage_guard');
    await assert.rejects(
      client.query(`DELETE FROM retry_backlog_triage WHERE job_id=$1`, [jobId]),
      /RETRY_BACKLOG_TRIAGE_APPEND_ONLY/,
    );
    await client.query('ROLLBACK TO SAVEPOINT triage_guard');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
