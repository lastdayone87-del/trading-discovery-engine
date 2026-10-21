import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, recoverStaleChannelLocks } from './db';
import { decideReview } from './reviewStore';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;
const PREFIX = 'stale-lock-';

type ChannelOverrides = {
  scanStatus?: string;
  tradingStatus?: string;
  updatedAt?: string;
};

/**
 * These tests exercise the real recovery SQL and the migration 153 trigger on
 * PostgreSQL. The unit suite next door only checks source text and pure
 * helpers; it cannot prove the query or trigger behavior at the boundary.
 */
maybe('runtime sweep recovers only abandoned locks without a live processing job', async t => {
  const db = await getDb();
  const suffix = `${Date.now()}_${process.pid}`;
  const id = (name: string) => `${PREFIX}${name}-${suffix}`;
  const ids = {
    old: id('old'),
    fresh: id('fresh'),
    live: id('live'),
    review: id('review'),
    enrich: id('enrich'),
  };
  const insertedJobs: string[] = [];
  const cleanup = async () => {
    if (insertedJobs.length) await db.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [insertedJobs]).catch(() => undefined);
    // channel_reviews holds an ON DELETE RESTRICT FK to channels; the eligibility
    // decision row itself is immutable by design, so only the repairable projection
    // and the review row are cleaned up.
    await db.query(`DELETE FROM channel_reviews WHERE channel_id = ANY($1::text[])`, [Object.values(ids)]).catch(() => undefined);
    await db.query(`DELETE FROM review_eligibility_projection WHERE channel_id = ANY($1::text[])`, [Object.values(ids)]).catch(() => undefined);
    await db.query(`DELETE FROM channels WHERE channel_id = ANY($1::text[])`, [Object.values(ids)]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  const insertChannel = async (channelId: string, overrides: ChannelOverrides = {}) => {
    await db.query(
      `INSERT INTO channels(
        channel_id,channel_name,youtube_url,country,country_status,discord_status,discord_invite,
        scan_status,discovery_source,first_seen,trading_status,subscriber_count,
        discord_validation_status,discord_liveness_status,discord_discovery_status,updated_at
      ) VALUES($1,$2,$3,'Germany','CONFIRMED','NOT_FOUND',NULL,$4,'automated_query',now(),$5,'1000','COMPLETED','NOT_CHECKED','NOT_DISCOVERED',COALESCE($6::timestamptz, now()))`,
      [
        channelId,
        `stale lock ${channelId}`,
        `https://youtube.test/${channelId}`,
        overrides.scanStatus || 'LOCKED',
        overrides.tradingStatus || 'TRADING_CONFIRMED',
        overrides.updatedAt || null,
      ],
    );
  };
  const insertJob = async (type: string, status: string, channelId?: string) => {
    const res = await db.query(
      `INSERT INTO jobs(type,status,payload,max_attempts) VALUES($1,$2,$3::jsonb,3) RETURNING id`,
      [type, status, JSON.stringify(channelId ? { channelId } : {})],
    );
    const jobId = String(res.rows[0].id);
    insertedJobs.push(jobId);
    return jobId;
  };
  const statusOf = async (channelId: string) => {
    const res = await db.query(`SELECT scan_status FROM channels WHERE channel_id=$1`, [channelId]);
    return res.rows[0]?.scan_status as string | undefined;
  };
  /**
   * Migration 094's channels_authoritative_needs_review trigger rewrites any
   * NEEDS_REVIEW write without an authoritative serving decision back to
   * UNCERTAIN/ENRICHMENT_PENDING. Reproduce the real lineage first (serving
   * decision -> ELIGIBLE projection -> PENDING review), then flip the channel,
   * so the sweep sees a genuine LOCKED-but-NEEDS_REVIEW row to preserve.
   */
  const seedAuthoritativeReview = async (channelId: string, updatedAt: string) => {
    const decision = await db.query(
      `INSERT INTO review_eligibility_decisions(
        decision_key,channel_id,status,reason_codes,input_snapshot,input_checksum,
        policy_version,mode,assignment_basis_points,randomization_value,assigned,serving_authority
      ) VALUES($1,$2,'ELIGIBLE','[]'::jsonb,'{}'::jsonb,'stale-lock-fixture','review-eligibility-v2-serving-1','CANARY',0,0,true,true)
      RETURNING id`,
      [`${PREFIX}decision-${channelId}`, channelId],
    );
    const decisionId = String(decision.rows[0].id);
    await db.query(
      `INSERT INTO review_eligibility_projection(
        channel_id,status,version,decision_id,reason_codes,evidence_checksum,policy_version,decided_at
      ) VALUES($1,'ELIGIBLE',1,$2,'[]'::jsonb,'stale-lock-fixture','review-eligibility-v2-serving-1',now())`,
      [channelId, decisionId],
    );
    await db.query(
      `INSERT INTO channel_reviews(channel_id,state,evidence_snapshot,pending_since)
       VALUES($1,'PENDING',$2::jsonb,now())`,
      [channelId, JSON.stringify({ source: 'review-eligibility-v2-serving', eligibilityDecisionId: decisionId })],
    );
    await db.query(`UPDATE channels SET trading_status='NEEDS_REVIEW',updated_at=$2::timestamptz WHERE channel_id=$1`, [channelId, updatedAt]);
  };

  await insertChannel(ids.old, { updatedAt: new Date(Date.now() - 61 * 60_000).toISOString() });
  await insertChannel(ids.fresh);
  await insertChannel(ids.live, { updatedAt: new Date(Date.now() - 61 * 60_000).toISOString() });
  const reviewUpdatedAt = new Date(Date.now() - 61 * 60_000).toISOString();
  await insertChannel(ids.review, { updatedAt: reviewUpdatedAt, tradingStatus: 'UNCERTAIN' });
  await seedAuthoritativeReview(ids.review, reviewUpdatedAt);
  await insertChannel(ids.enrich, { updatedAt: new Date(Date.now() - 61 * 60_000).toISOString(), tradingStatus: 'UNCERTAIN' });
  await insertJob('ENRICH_CHANNEL', 'PROCESSING', ids.live);
  await insertJob('ENRICH_CHANNEL', 'PENDING', ids.enrich);

  await recoverStaleChannelLocks(60, 50);

  assert.equal(await statusOf(ids.old), 'PENDING', 'an abandoned lock is recovered to PENDING');
  assert.equal(await statusOf(ids.fresh), 'LOCKED', 'a fresh lock is untouched');
  assert.equal(await statusOf(ids.live), 'LOCKED', 'a live PROCESSING job protects its channel');
  assert.equal(await statusOf(ids.review), 'NEEDS_REVIEW', 'explicit review state is preserved');
  assert.equal(await statusOf(ids.enrich), 'ENRICHMENT_PENDING', 'a pending enrichment retry is preserved');
});

maybe('runtime sweep caps each batch and continues the backlog on the next call', async t => {
  const db = await getDb();
  const suffix = `${Date.now()}_${process.pid}_batch`;
  const ids = [`${PREFIX}a-${suffix}`, `${PREFIX}b-${suffix}`, `${PREFIX}c-${suffix}`];
  const cleanup = async () => {
    await db.query(`DELETE FROM channels WHERE channel_id = ANY($1::text[])`, [ids]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  for (const channelId of ids) {
    await db.query(
      `INSERT INTO channels(
        channel_id,channel_name,youtube_url,country,country_status,discord_status,discord_invite,
        scan_status,discovery_source,first_seen,trading_status,subscriber_count,
        discord_validation_status,discord_liveness_status,discord_discovery_status,updated_at
      ) VALUES($1,$2,$3,'Germany','CONFIRMED','NOT_FOUND',NULL,'LOCKED','automated_query',now(),'TRADING_CONFIRMED','1000','COMPLETED','NOT_CHECKED','NOT_DISCOVERED','2000-01-01T00:00:00Z')`,
      [channelId, `stale lock batch ${channelId}`, `https://youtube.test/${channelId}`],
    );
  }
  const lockedCount = async () => {
    const res = await db.query(
      `SELECT count(*)::int AS count FROM channels WHERE channel_id = ANY($1::text[]) AND scan_status='LOCKED'`,
      [ids],
    );
    return Number(res.rows[0]?.count ?? 0);
  };

  const first = await recoverStaleChannelLocks(60, 2);
  assert.ok(first <= 2, `one sweep recovers at most the batch size (got ${first})`);
  assert.equal(await lockedCount(), 1, 'exactly one channel waits for the next sweep');

  await recoverStaleChannelLocks(60, 2);
  assert.equal(await lockedCount(), 0, 'the next sweep continues where the previous one stopped');
});

maybe('terminal job release is age-bounded and keeps fresh locks for the failure handler', async t => {
  const db = await getDb();
  const suffix = `${Date.now()}_${process.pid}_terminal`;
  const id = (name: string) => `${PREFIX}${name}-${suffix}`;
  const ids = {
    freshFailed: id('fresh-failed'),
    oldFailed: id('old-failed'),
    freshPending: id('fresh-pending'),
    unrelated: id('unrelated'),
    liveOther: id('live-other'),
  };
  const insertedJobs: string[] = [];
  const cleanup = async () => {
    if (insertedJobs.length) await db.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [insertedJobs]).catch(() => undefined);
    await db.query(`DELETE FROM channels WHERE channel_id = ANY($1::text[])`, [Object.values(ids)]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  const insertChannel = async (channelId: string, updatedAt: string | null) => {
    await db.query(
      `INSERT INTO channels(
        channel_id,channel_name,youtube_url,country,country_status,discord_status,discord_invite,
        scan_status,discovery_source,first_seen,trading_status,subscriber_count,
        discord_validation_status,discord_liveness_status,discord_discovery_status,updated_at
      ) VALUES($1,$2,$3,'Germany','CONFIRMED','NOT_FOUND',NULL,'LOCKED','automated_query',now(),'TRADING_CONFIRMED','1000','COMPLETED','NOT_CHECKED','NOT_DISCOVERED',COALESCE($4::timestamptz, now()))`,
      [channelId, `stale lock terminal ${channelId}`, `https://youtube.test/${channelId}`, updatedAt],
    );
  };
  const insertProcessingJob = async (channelId?: string) => {
    const res = await db.query(
      `INSERT INTO jobs(type,status,payload,max_attempts) VALUES('POST_APPROVAL_ENRICH','PROCESSING',$1::jsonb,3) RETURNING id`,
      [JSON.stringify(channelId ? { channelId } : {})],
    );
    const jobId = String(res.rows[0].id);
    insertedJobs.push(jobId);
    return jobId;
  };
  const statusOf = async (channelId: string) => {
    const res = await db.query(`SELECT scan_status FROM channels WHERE channel_id=$1`, [channelId]);
    return res.rows[0]?.scan_status as string | undefined;
  };
  const old = new Date(Date.now() - 61 * 60_000).toISOString();

  const freshFailedJob = await insertProcessingJob(ids.freshFailed);
  await insertChannel(ids.freshFailed, null);
  await db.query(`UPDATE jobs SET status='FAILED' WHERE id=$1`, [freshFailedJob]);
  assert.equal(
    await statusOf(ids.freshFailed),
    'LOCKED',
    'a fresh lock survives a terminal release so resolveTerminalEnrichmentFailure can project FAILED',
  );

  const oldFailedJob = await insertProcessingJob(ids.oldFailed);
  await insertChannel(ids.oldFailed, old);
  await db.query(`UPDATE jobs SET status='FAILED' WHERE id=$1`, [oldFailedJob]);
  assert.equal(await statusOf(ids.oldFailed), 'PENDING', 'an abandoned lock is released by a terminal job');

  const freshPendingJob = await insertProcessingJob(ids.freshPending);
  await insertChannel(ids.freshPending, null);
  await db.query(`UPDATE jobs SET status='PENDING' WHERE id=$1`, [freshPendingJob]);
  assert.equal(await statusOf(ids.freshPending), 'PENDING', 'the retry branch keeps migration 090 semantics without an age bound');

  const unrelatedJob = await insertProcessingJob();
  await insertChannel(ids.unrelated, null);
  await db.query(`UPDATE jobs SET status='FAILED' WHERE id=$1`, [unrelatedJob]);
  assert.equal(await statusOf(ids.unrelated), 'LOCKED', 'a terminal job without a channelId cannot release a lock');

  const firstLiveJob = await insertProcessingJob(ids.liveOther);
  const secondLiveJob = await insertProcessingJob(ids.liveOther);
  await insertChannel(ids.liveOther, old);
  await db.query(`UPDATE jobs SET status='FAILED' WHERE id=$1`, [firstLiveJob]);
  assert.equal(await statusOf(ids.liveOther), 'LOCKED', 'another live PROCESSING job still protects the lock');
  await db.query(`UPDATE jobs SET status='COMPLETED' WHERE id=$1`, [secondLiveJob]);
  assert.equal(await statusOf(ids.liveOther), 'PENDING', 'the last terminal release clears the abandoned lock');
});

maybe('concurrent terminal releases serialize and clear an abandoned lock', async t => {
  const db = await getDb();
  const suffix = `${Date.now()}_${process.pid}_concurrent`;
  const channelId = `${PREFIX}concurrent-${suffix}`;
  const insertedJobs: string[] = [];
  const cleanup = async () => {
    if (insertedJobs.length) await db.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [insertedJobs]).catch(() => undefined);
    await db.query(`DELETE FROM channels WHERE channel_id=$1`, [channelId]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  await db.query(
    `INSERT INTO channels(
      channel_id,channel_name,youtube_url,country,country_status,discord_status,discord_invite,
      scan_status,discovery_source,first_seen,trading_status,subscriber_count,
      discord_validation_status,discord_liveness_status,discord_discovery_status,updated_at
    ) VALUES($1,$2,$3,'Germany','CONFIRMED','NOT_FOUND',NULL,'LOCKED','automated_query',now(),'TRADING_CONFIRMED','1000','COMPLETED','NOT_CHECKED','NOT_DISCOVERED',$4)`,
    [channelId, `stale lock concurrent ${channelId}`, `https://youtube.test/${channelId}`, new Date(Date.now() - 61 * 60_000).toISOString()],
  );
  for (let index = 0; index < 2; index += 1) {
    const res = await db.query(
      `INSERT INTO jobs(type,status,payload,max_attempts) VALUES('ENRICH_CHANNEL','PROCESSING',$1::jsonb,3) RETURNING id`,
      [JSON.stringify({ channelId })],
    );
    insertedJobs.push(String(res.rows[0].id));
  }

  const clientOne = await db.connect();
  const clientTwo = await db.connect();
  try {
    await clientOne.query('BEGIN');
    await clientTwo.query('BEGIN');
    await clientOne.query(`UPDATE jobs SET status='COMPLETED' WHERE id=$1`, [insertedJobs[0]]);
    const secondRelease = clientTwo.query(`UPDATE jobs SET status='COMPLETED' WHERE id=$1`, [insertedJobs[1]]);
    await clientOne.query('COMMIT');
    await secondRelease;
    await clientTwo.query('COMMIT');
  } catch (error) {
    await clientOne.query('ROLLBACK').catch(() => undefined);
    await clientTwo.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    clientOne.release();
    clientTwo.release();
  }

  const res = await db.query(`SELECT scan_status FROM channels WHERE channel_id=$1`, [channelId]);
  assert.equal(
    res.rows[0]?.scan_status,
    'PENDING',
    'after both terminal releases commit, the abandoned lock is clear without waiting for the sweep',
  );
});

maybe('review rejection takes the job lock before the channel lock', async t => {
  const db = await getDb();
  const suffix = `${Date.now()}_${process.pid}_review-overlap`;
  const channelId = `${PREFIX}review-overlap-${suffix}`;
  const jobIds: string[] = [];
  const cleanup = async () => {
    if (jobIds.length) await db.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [jobIds]).catch(() => undefined);
    await db.query(`DELETE FROM channel_review_decisions WHERE channel_id=$1`, [channelId]).catch(() => undefined);
    await db.query(`DELETE FROM channel_reviews WHERE channel_id=$1`, [channelId]).catch(() => undefined);
    await db.query(`DELETE FROM channels WHERE channel_id=$1`, [channelId]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  await db.query(
    `INSERT INTO channels(
      channel_id,channel_name,youtube_url,country,country_status,discord_status,discord_invite,
      scan_status,discovery_source,first_seen,trading_status,subscriber_count,
      discord_validation_status,discord_liveness_status,discord_discovery_status
    ) VALUES($1,$2,$3,'Germany','CONFIRMED','NOT_FOUND',NULL,'LOCKED','automated_query',now(),'TRADING_CONFIRMED','1000','COMPLETED','NOT_CHECKED','NOT_DISCOVERED')`,
    [channelId, `review overlap ${channelId}`, `https://youtube.test/${channelId}`],
  );
  await db.query(
    `INSERT INTO channel_reviews(channel_id,state,evidence_snapshot,pending_since)
     VALUES($1,'PENDING',$2::jsonb,now())`,
    [channelId, JSON.stringify({ source: 'review-overlap-regression' })],
  );
  const job = await db.query(
    `INSERT INTO jobs(type,status,payload,max_attempts)
     VALUES('ENRICH_CHANNEL','PROCESSING',$1::jsonb,3) RETURNING id`,
    [JSON.stringify({ channelId })],
  );
  const jobId = String(job.rows[0].id);
  jobIds.push(jobId);

  const worker = await db.connect();
  try {
    await worker.query('BEGIN');
    // Hold the job row without changing status, so the migration 153 trigger
    // does not fire yet. The review rejection must wait here before it is
    // allowed to lock the channel.
    await worker.query(`UPDATE jobs SET locked_at=now() WHERE id=$1`, [jobId]);

    const reviewPromise = decideReview({
      channelId,
      action: 'REJECT',
      expectedVersion: 1,
      reviewer: 'review-overlap-test',
      reviewReasonCode: 'NOT_TRADING_CREATOR',
      reviewReasonVersion: 'human-review-reasons-v1',
      idempotencyKey: `review-overlap-${suffix}`,
    });

    let waitingOnJob = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await db.query(
        `SELECT count(*)::int AS count
         FROM pg_stat_activity
         WHERE datname=current_database()
           AND state='active'
           AND wait_event_type='Lock'
           AND query ILIKE '%jobs%'`,
      );
      if (Number(waiting.rows[0]?.count || 0) > 0) {
        waitingOnJob = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(waitingOnJob, true, 'review rejection should wait on the worker job lock');

    // If the review took the channel first (the old order), this NOWAIT probe
    // fails. With jobs-first ordering the channel is not locked while the
    // review waits for the worker, so there is no cycle for the worker's
    // terminal trigger to close.
    const probe = await db.connect();
    try {
      await probe.query('BEGIN');
      await probe.query(`SELECT 1 FROM channels WHERE channel_id=$1 FOR UPDATE NOWAIT`, [channelId]);
      await probe.query('ROLLBACK');
    } catch (error) {
      await probe.query('ROLLBACK').catch(() => undefined);
      throw new Error(`review rejection acquired the channel before the job lock: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      probe.release();
    }

    await worker.query('COMMIT');
    const result = await reviewPromise;
    assert.equal(result.review.state, 'REJECTED');
    assert.equal(result.channel.tradingStatus, 'HUMAN_REJECTED');
    const persistedJob = await db.query(`SELECT status FROM jobs WHERE id=$1`, [jobId]);
    assert.equal(persistedJob.rows[0]?.status, 'FAILED');
  } catch (error) {
    await worker.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    worker.release();
  }
});
