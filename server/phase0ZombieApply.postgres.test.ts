import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './dbCore';
import { runPhase0ZombieApply } from './phase0ZombieApply';

// The suite inserts jobs/channels/attempt/ledger fixtures, so it is opt-in and
// only runs against the dedicated scratch database configured by the workflow.
const dedicatedDatabaseUrl = process.env.PHASE0_ZOMBIE_TEST_DATABASE_URL;
if (dedicatedDatabaseUrl) process.env.DATABASE_URL = dedicatedDatabaseUrl;
const enabled = Boolean(dedicatedDatabaseUrl);
const maybe = enabled ? test : test.skip;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

maybe('the bounded apply closes only evidence-backed zombies and records immutable evidence', async () => {
  const db = await getDb();
  const client = await db.connect();
  const suffix = uniqueSuffix();
  const channel = (name: string) => `UCapply-${name}-${suffix}`;

  async function insertChannel(name: string, discordStatus: string, validation: string): Promise<string> {
    const channelId = channel(name);
    await client.query(
      `INSERT INTO channels(
         channel_id,channel_name,youtube_url,country,country_status,discord_status,
         scan_status,discovery_source,first_seen,trading_status,discord_validation_status
       ) VALUES($1,$2,$3,'Germany','CONFIRMED',$4,'ENRICHING','automated_query',now(),
                'UNCERTAIN',$5)`,
      [
        channelId,
        `Channel ${channelId}`,
        `https://youtube.test/${channelId}`,
        discordStatus,
        validation,
      ],
    );
    return channelId;
  }

  async function insertJob(channelId: string, status: string): Promise<string> {
    const result = await client.query(
      `INSERT INTO jobs(
         type,payload,status,priority,max_attempts,run_after,idempotency_key,first_enqueued_at
       ) VALUES(
         'RETRY_COMMUNITY_ACQUISITION',$1::jsonb,$2,1000000000,5,
         now()-interval '1 minute',$3,now()-interval '2 hours'
       ) RETURNING id`,
      [
        JSON.stringify({
          channelId,
          retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
          retryLifecycleVersion: 2,
          retryObservedAt: '2026-10-02T00:00:00.000Z',
          reconciliationStatus: 'NONE',
        }),
        status,
        `zombie-apply-${channelId}`,
      ],
    );
    return String(result.rows[0].id);
  }

  async function insertAttempt(jobId: string): Promise<void> {
    await client.query(
      `INSERT INTO job_attempts(job_id,attempt_number,status)
       VALUES($1,1,'PROCESSING')`,
      [jobId],
    );
  }

  async function insertObservation(channelId: string, key: string): Promise<void> {
    await client.query(
      `INSERT INTO external_acquisition_observations(
         observation_key,channel_id,requested_url,outcome,retryable,failure_class,
         detail,provenance,policy_version,observed_at
       ) VALUES($1,$2,'https://fixture.example/community','ACQUISITION_FAILED',true,
                'TIMEOUT','zombie apply fixture',
                '{"provider":"external-link","surface":"CREATOR_WEBSITES","required":true}'::jsonb,
                'phase0-zombie-apply-test-v1','2026-10-03T00:00:00.000Z')`,
      [key, channelId],
    );
  }

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

    const closeTerminal = await insertJob(
      await insertChannel('close-terminal', 'FOUND', 'SUCCEEDED'),
      'PENDING',
    );
    await insertAttempt(closeTerminal);

    const closeFound = await insertJob(
      await insertChannel('close-found', 'FOUND', 'NOT_STARTED'),
      'PENDING',
    );

    const skipOpen = await insertJob(
      await insertChannel('skip-open', 'UNCERTAIN', 'RETRY_PENDING'),
      'PENDING',
    );

    const processing = await insertJob(
      await insertChannel('processing', 'FOUND', 'COMPLETED'),
      'PROCESSING',
    );
    await insertAttempt(processing);

    const skipFreshChannel = await insertChannel('skip-fresh', 'FOUND', 'COMPLETED');
    await insertObservation(skipFreshChannel, `zombie-apply-fresh-${suffix}`);
    const skipFreshJob = await insertJob(skipFreshChannel, 'PENDING');

    const jobIds = [closeTerminal, closeFound, skipOpen, processing, skipFreshJob];
    const report = await runPhase0ZombieApply(client, {
      apply: true,
      actor: 'phase0-zombie-apply-test',
      maxScan: 10,
      maxClosures: 10,
      jobIds,
    });

    assert.equal(report.dryRun, false);
    assert.equal(report.restricted, true);
    assert.equal(report.scan.locked, 4, 'PROCESSING is never a candidate');
    assert.equal(report.summary.examined, 4);
    assert.equal(report.summary.proposedClosures, 2);
    assert.equal(report.summary.appliedClosures, 2);
    assert.equal(report.summary.skipped, 2);
    assert.deepEqual(
      report.closures.map(closure => closure.jobId).sort(),
      [closeTerminal, closeFound].sort(),
    );
    assert.ok(report.closures.every(closure => closure.applied));
    assert.ok(report.closures.every(closure => closure.actor === 'phase0-zombie-apply-test'));
    assert.ok(report.closures.every(closure => typeof closure.evidence.closedAt === 'string'));
    assert.ok(report.warnings.includes('phase0_ledger_empty_channel_evidence_only'));
    assert.equal(report.warnings.some(warning => warning.startsWith('closure_update_skipped')), false);

    const closed = await client.query(
      `SELECT id,status,completed_at,closed_reason,closed_evidence,closed_by,closed_at
         FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[closeTerminal, closeFound]],
    );
    assert.equal(closed.rows.length, 2);
    for (const row of closed.rows) {
      assert.equal(row.status, 'COMPLETED');
      assert.ok(row.completed_at);
      assert.equal(row.closed_reason, 'CHANNEL_TERMINAL');
      assert.equal(row.closed_by, 'phase0-zombie-apply-test');
      assert.ok(row.closed_at);
      assert.equal(row.completed_at.getTime(), row.closed_at.getTime());
      assert.equal(
        new Date(row.closed_evidence.closedAt).getTime(),
        row.closed_at.getTime(),
      );
      assert.equal(row.closed_evidence.classifier, 'phase0-zombie-retry-closure');
      assert.equal(row.closed_evidence.reason, 'CHANNEL_TERMINAL');
      assert.equal(row.closed_evidence.criterion, 'channel_terminal');
      assert.equal(row.closed_evidence.classifierVersion, 'phase0-zombie-apply-v1');
      assert.equal(row.closed_evidence.job.id, row.id);
      assert.equal(row.closed_evidence.job.statusAtClosure, 'PENDING');
      assert.equal(row.closed_evidence.job.retryObservedAt, '2026-10-02T00:00:00.000Z');
      assert.equal(row.closed_evidence.newerRetryOwningObservations, 0);
      assert.ok(Array.isArray(row.closed_evidence.supportingEvidence));
      assert.ok(row.closed_evidence.supportingEvidence.includes('criterion=channel_terminal'));
    }

    const unfinished = await client.query(
      `SELECT job_id,status,finished_at FROM job_attempts
        WHERE job_id = ANY($1::uuid[]) ORDER BY job_id`,
      [[closeTerminal, processing]],
    );
    const attemptByJob = new Map(unfinished.rows.map(row => [String(row.job_id), row]));
    assert.equal(attemptByJob.get(closeTerminal)?.status, 'COMPLETED');
    assert.ok(attemptByJob.get(closeTerminal)?.finished_at);
    assert.equal(attemptByJob.get(processing)?.status, 'PROCESSING');
    assert.equal(attemptByJob.get(processing)?.finished_at, null);

    const untouched = await client.query(
      `SELECT id,status,closed_at FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[skipOpen, processing, skipFreshJob]],
    );
    assert.equal(untouched.rows.length, 3);
    assert.ok(untouched.rows.every(row => row.status === 'PENDING' || row.status === 'PROCESSING'));
    assert.ok(untouched.rows.every(row => row.closed_at === null));

    // A second bounded run over the same ids cannot re-close the same epochs.
    const second = await runPhase0ZombieApply(client, {
      apply: true,
      actor: 'phase0-zombie-apply-test',
      maxScan: 10,
      maxClosures: 10,
      jobIds,
    });
    assert.equal(second.summary.proposedClosures, 0);
    assert.equal(second.summary.appliedClosures, 0);
    assert.equal(second.scan.locked, 2, 'only the two legitimate skips remain scannable');

    // Closure evidence is append-only.
    await client.query('SAVEPOINT closure_guard');
    await assert.rejects(
      client.query(`UPDATE jobs SET closed_reason='OTHER' WHERE id=$1`, [closeTerminal]),
      /JOB_CLOSURE_IMMUTABLE/,
    );
    await client.query('ROLLBACK TO SAVEPOINT closure_guard');

    // A partial closure write is rejected by the completeness check.
    await client.query('SAVEPOINT completeness_guard');
    await assert.rejects(
      client.query(`UPDATE jobs SET closed_reason='PARTIAL' WHERE id=$1`, [skipOpen]),
      /jobs_closure_evidence_complete_check/,
    );
    await client.query('ROLLBACK TO SAVEPOINT completeness_guard');

    // A complete closure shape still has to use a classifier reason.
    await client.query('SAVEPOINT reason_guard');
    await assert.rejects(
      client.query(
        `UPDATE jobs
            SET closed_reason='OTHER',
                closed_evidence='{}'::jsonb,
                closed_by='phase0-zombie-apply-test',
                closed_at=now()
          WHERE id=$1`,
        [skipOpen],
      ),
      /jobs_closure_reason_allowed_check/,
    );
    await client.query('ROLLBACK TO SAVEPOINT reason_guard');

    // A closed job cannot be deleted, so its evidence cannot disappear.
    await client.query('SAVEPOINT delete_guard');
    await assert.rejects(
      client.query('DELETE FROM jobs WHERE id=$1', [closeTerminal]),
      /JOB_CLOSURE_IMMUTABLE: closure evidence cannot be deleted/,
    );
    await client.query('ROLLBACK TO SAVEPOINT delete_guard');
  } finally {
    // Everything in this suite is transactional; rolling back removes the
    // fixtures without deleting append-only historical observations.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
