import { getDb, enqueueJob } from './db';
import { validateChannelCountry } from './countryValidator';
import { resolveScopeEligibility } from './scopeEligibility';

export interface IntakeDeferredSweepResult {
  scanned: number;
  enqueued: number;
  skipped: number;
  locked: number;
}

/**
 * Bounded, deduplicated evidence-acquisition sweep for INTAKE_DEFERRED rows.
 *
 * It enqueues the existing ENRICH_CHANNEL carrier with `intakeRecheck: true`.
 * The worker performs one 2-unit stage-1 evidence fetch and either closes,
 * admits to normal enrichment, or reschedules the deferral. A due row is never
 * re-enqueued while an active recheck/enrichment job exists; the idempotency
 * key is the review version, so a failed retry reopens the same durable job.
 */
export async function sweepIntakeDeferredReviews(options: {
  limit?: number;
  minAgeMinutes?: number;
} = {}): Promise<IntakeDeferredSweepResult> {
  const db = await getDb();
  const limit = Math.min(50, Math.max(1, Math.trunc(options.limit || 10)));
  const minAgeMinutes = Math.max(0, Math.trunc(options.minAgeMinutes ?? 60));
  const due = await db.query(
    `SELECT r.channel_id,r.review_version,r.evidence_snapshot
     FROM intake_deferred_reviews r
     JOIN channels c USING(channel_id)
     WHERE c.scan_status='INTAKE_DEFERRED'
       AND (r.state='PENDING' OR (r.state='DECIDED' AND r.decision='AMBIGUOUS'))
       AND (r.next_recheck_at IS NULL OR r.next_recheck_at <= now())
       AND COALESCE(r.last_checked_at,c.last_checked,c.first_seen) <= now()-($2::text||' minutes')::interval
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.status IN ('PENDING','PROCESSING')
           AND j.type='ENRICH_CHANNEL'
           AND (
             j.payload->>'channelId'=r.channel_id
             OR j.idempotency_key LIKE 'intake-recheck:%'||r.channel_id||':%'
           )
       )
     ORDER BY r.next_recheck_at NULLS FIRST,r.updated_at ASC
     LIMIT $1`,
    [limit, String(minAgeMinutes)],
  );
  let enqueued = 0;
  let skipped = 0;
  let locked = 0;
  for (const row of due.rows) {
    const channelId = String(row.channel_id);
    const client = await db.connect();
    let acquired = false;
    let inTransaction = false;
    try {
      const lock = await client.query(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
        [`intake-recheck:${channelId}`],
      );
      acquired = lock.rows[0]?.locked === true;
      if (!acquired) {
        locked += 1;
        continue;
      }
      await client.query('BEGIN');
      inTransaction = true;
      // Serialize sweeps and human decisions for this channel before taking
      // row locks, so the two paths cannot deadlock on job/review ordering.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`intake-review:${channelId}`]);
      // Re-read under the lock: a human decision may have committed after the
      // due-row snapshot, and the old recheck must not act on a newer review.
      const lockedReview = await client.query(
        `SELECT r.review_version,r.state,r.decision,r.evidence_snapshot,r.next_recheck_at,
                COALESCE(r.last_checked_at,c.last_checked,c.first_seen) AS last_activity,
                c.scan_status
         FROM intake_deferred_reviews r JOIN channels c USING(channel_id)
         WHERE r.channel_id=$1 FOR UPDATE OF r`,
        [channelId],
      );
      const review = lockedReview.rows[0];
      const stateEligible = review
        && (review.state === 'PENDING' || (review.state === 'DECIDED' && review.decision === 'AMBIGUOUS'));
      if (!review || review.scan_status !== 'INTAKE_DEFERRED' || !stateEligible) {
        skipped += 1;
        await client.query('COMMIT');
        inTransaction = false;
        continue;
      }
      const nowMs = Date.now();
      const dueNow = (!review.next_recheck_at || new Date(review.next_recheck_at).getTime() <= nowMs)
        && (!review.last_activity || new Date(review.last_activity).getTime() <= nowMs - minAgeMinutes * 60_000);
      const activeJob = await client.query(
        `SELECT 1 FROM jobs
         WHERE status IN ('PENDING','PROCESSING')
           AND type='ENRICH_CHANNEL'
           AND (payload->>'channelId'=$1 OR idempotency_key LIKE 'intake-recheck:%'||$1||':%')
         LIMIT 1`,
        [channelId],
      );
      if (!dueNow || activeJob.rowCount) {
        skipped += 1;
        await client.query('COMMIT');
        inTransaction = false;
        continue;
      }
      const reviewVersion = Number(review.review_version);
      const evidence = review.evidence_snapshot || {};
      const job = await enqueueJob('ENRICH_CHANNEL', {
        channelId,
        targetCountry: evidence.targetCountry || 'GLOBAL',
        source: evidence.source || 'automated_query',
        candidate: evidence.candidate || { channelId },
        enrichmentStage: 1,
        intakeRecheck: true,
      }, {
        priority: 5,
        maxAttempts: 4,
        idempotencyKey: `intake-recheck:${channelId}:${reviewVersion}`,
        clientOverride: client,
      });
      const runnable = job.status === 'PENDING' || job.status === 'PROCESSING';
      // Runnable work is rechecked after an hour if the worker disappears;
      // a capped/blocked reopen backs off so it cannot monopolize every batch.
      await client.query(
        `UPDATE intake_deferred_reviews
         SET next_recheck_at=now()+($2::text||' minutes')::interval,last_checked_at=now(),updated_at=now()
         WHERE channel_id=$1 AND review_version=$3`,
        [channelId, runnable ? '60' : '360', reviewVersion],
      );
      if (runnable) enqueued += 1;
      else skipped += 1;
      await client.query('COMMIT');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      skipped += 1;
      console.warn(JSON.stringify({
        event: 'intake_deferred_recheck_enqueue_failed',
        channelId,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        timestamp: new Date().toISOString(),
      }));
    } finally {
      if (acquired) {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`intake-recheck:${channelId}`]).catch(() => undefined);
      }
      client.release();
    }
  }
  return { scanned: due.rowCount || 0, enqueued, skipped, locked };
}

export interface LikelyCountryReconciliationResult {
  scanned: number;
  rejected: number;
  retained: number;
  review: number;
  skipped: number;
}

type LikelyCountryRecheckOutcome = 'REJECTED' | 'RETAINED' | 'REVIEW' | 'SKIPPED';

/**
 * Apply one LIKELY-country recheck under row locks. A human review decision can
 * commit while the (slower) country validator runs; re-locking the channel and
 * its review row and verifying the snapshot country/status and review version
 * prevents the sweep from overwriting that correction. Job insertion is
 * re-checked under the same lock.
 */
async function applyLikelyCountryRecheck(args: {
  channelId: string;
  snapshotCountry: string | null;
  snapshotCountryStatus: string | null;
  snapshotReviewVersion: number | null;
  result: Awaited<ReturnType<typeof validateChannelCountry>>;
  detected: string | null;
  now: string;
}): Promise<LikelyCountryRecheckOutcome> {
  const db = await getDb();
  const client = await db.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const locked = args.snapshotReviewVersion == null
      ? await client.query(
        `SELECT NULL::int AS review_version,NULL::text AS state,
                c.country,c.country_status,c.scan_status,c.inspection_trail
         FROM channels c WHERE c.channel_id=$1 FOR UPDATE`,
        [args.channelId],
      )
      : await client.query(
        `SELECT r.review_version,r.state,c.country,c.country_status,c.scan_status,c.inspection_trail
         FROM intake_deferred_reviews r JOIN channels c USING(channel_id)
         WHERE r.channel_id=$1 FOR UPDATE OF r,c`,
        [args.channelId],
      );
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return 'SKIPPED';
    }
    const row = locked.rows[0];
    if (args.snapshotReviewVersion == null) {
      const appeared = await client.query(`SELECT 1 FROM intake_deferred_reviews WHERE channel_id=$1`, [args.channelId]);
      if (appeared.rowCount) {
        await client.query('ROLLBACK');
        inTransaction = false;
        return 'SKIPPED';
      }
    } else if (
      Number(row.review_version) !== args.snapshotReviewVersion
      || !['PENDING', 'DECIDED'].includes(String(row.state))
    ) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return 'SKIPPED';
    }
    if (
      String(row.country || '') !== String(args.snapshotCountry || '')
      || String(row.country_status || '') !== String(args.snapshotCountryStatus || '')
    ) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return 'SKIPPED';
    }
    const active = await client.query(
      `SELECT 1 FROM jobs
       WHERE status IN ('PENDING','PROCESSING')
         AND payload->>'channelId'=$1
         AND type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','CLASSIFY_DISCOVERED_CHANNEL')
       LIMIT 1`,
      [args.channelId],
    );
    if (active.rowCount) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return 'SKIPPED';
    }
    const trail = Array.isArray(row.inspection_trail) ? row.inspection_trail : [];
    const recentRecheck = trail.some((step: any) => step?.title?.startsWith?.('Country Recheck')
      && Date.parse(String(step?.timestamp || '')) > Date.now() - 7 * 86_400_000);
    if (args.result.status === 'REJECTED' && args.detected) {
      const rejection = await client.query(
        `UPDATE channels
         SET country_status='REJECTED',country=$2,confidence_score=$3,
             scan_status=CASE WHEN scan_status='SKIPPED_LOW_AUDIENCE' THEN scan_status ELSE 'COMPLETED' END,
             last_checked=now(),scope_eligibility=$4,
             inspection_trail=$5::jsonb,updated_at=now()
         WHERE channel_id=$1
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.status IN ('PENDING','PROCESSING')
             AND j.payload->>'channelId'=channels.channel_id
             AND j.type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','CLASSIFY_DISCOVERED_CHANNEL')
         )`,
        [
          args.channelId,
          args.detected,
          args.result.score,
          resolveScopeEligibility(args.detected),
          JSON.stringify([...trail, {
            step: 'COUNTRY_VALIDATION',
            title: `Country Recheck (${args.detected})`,
            status: 'REJECTED',
            details: `Likely excluded-country row re-evaluated: ${args.result.decisionLogs}`,
            timestamp: args.now,
          }]),
        ],
      );
      if (!rejection.rowCount) {
        await client.query('ROLLBACK');
        inTransaction = false;
        return 'SKIPPED';
      }
      await client.query(
        `UPDATE intake_deferred_reviews SET state='SUPERSEDED',next_recheck_at=NULL,updated_at=now()
         WHERE channel_id=$1 AND state IN ('PENDING','DECIDED')`,
        [args.channelId],
      );
      await client.query('COMMIT');
      inTransaction = false;
      return 'REJECTED';
    }
    if (args.result.status === 'CONFIRMED' && args.detected && args.result.gateDisposition === 'ALLOW_NORMAL') {
      const retention = await client.query(
        `UPDATE channels SET country=$2,country_status='CONFIRMED',confidence_score=$3,
           scope_eligibility=$4,last_checked=now(),inspection_trail=$5::jsonb,updated_at=now()
         WHERE channel_id=$1
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.status IN ('PENDING','PROCESSING')
             AND j.payload->>'channelId'=channels.channel_id
             AND j.type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','CLASSIFY_DISCOVERED_CHANNEL')
         )`,
        [args.channelId, args.detected, args.result.score, resolveScopeEligibility(args.detected), JSON.stringify(recentRecheck ? trail : [...trail, {
          step: 'COUNTRY_VALIDATION',
          title: `Country Recheck (${args.detected})`,
          status: 'CONFIRMED',
          details: `Likely excluded-country row retained with strong non-excluded evidence: ${args.result.decisionLogs}`,
          timestamp: args.now,
        }])],
      );
      if (!retention.rowCount) {
        await client.query('ROLLBACK');
        inTransaction = false;
        return 'SKIPPED';
      }
      await client.query('COMMIT');
      inTransaction = false;
      return 'RETAINED';
    }
    const reviewWrite = await client.query(
      `UPDATE channels SET last_checked=now(),inspection_trail=$2::jsonb,updated_at=now()
       WHERE channel_id=$1
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.status IN ('PENDING','PROCESSING')
           AND j.payload->>'channelId'=channels.channel_id
           AND j.type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','CLASSIFY_DISCOVERED_CHANNEL')
       )`,
      [args.channelId, JSON.stringify(recentRecheck ? trail : [...trail, {
        step: 'COUNTRY_VALIDATION',
        title: `Country Recheck (${args.detected || args.snapshotCountry})`,
        status: 'PARTIAL',
        details: `Likely excluded-country row left unchanged: evidence is weak, conflicting, or below domicile grade (${args.result.status}/${args.result.gateDisposition || 'NO_GATE'}). ${args.result.decisionLogs}`,
        timestamp: args.now,
      }])],
    );
    if (!reviewWrite.rowCount) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return 'SKIPPED';
    }
    await client.query('COMMIT');
    inTransaction = false;
    return 'REVIEW';
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Safe, bounded re-evaluation of pre-existing LIKELY excluded-country rows.
 * Active enrichment jobs are never touched. Strong domicile evidence rejects;
 * strong non-excluded evidence is retained/updated; genuinely ambiguous or
 * weak evidence is left in place with an audit trail, never blindly rejected.
 */
export async function reconcileLikelyExcludedCountryCandidates(options: {
  limit?: number;
} = {}): Promise<LikelyCountryReconciliationResult> {
  const db = await getDb();
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit || 20)));
  const rows = await db.query(
    `SELECT c.channel_id,c.channel_name,c.country,c.country_status,c.confidence_score,
            c.scan_status,c.last_checked,c.inspection_trail,r.review_version AS review_version
     FROM channels c
     JOIN excluded_countries e ON LOWER(c.country)=LOWER(e.country_name)
     LEFT JOIN intake_deferred_reviews r ON r.channel_id=c.channel_id
     WHERE c.country_status='LIKELY'
       AND c.scan_status IN (
         'PENDING','CLASSIFICATION_PENDING','ENRICHMENT_PENDING','ENRICHING',
         'INTAKE_DEFERRED','COMPLETED','FAILED','FAILED_PERMANENT','SKIPPED_LOW_AUDIENCE'
       )
       AND (c.last_checked IS NULL OR c.last_checked <= now()-interval '24 hours')
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.status IN ('PENDING','PROCESSING')
           AND j.payload->>'channelId'=c.channel_id
           AND j.type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','CLASSIFY_DISCOVERED_CHANNEL')
       )
     ORDER BY c.last_checked NULLS FIRST,c.first_seen ASC
     LIMIT $1`,
    [limit],
  );
  let rejected = 0;
  let retained = 0;
  let review = 0;
  let skipped = 0;
  for (const row of rows.rows) {
    const channelId = String(row.channel_id);
    const latest = await db.query(
      `SELECT payload FROM jobs WHERE type='ENRICH_CHANNEL' AND payload->>'channelId'=$1
       ORDER BY created_at DESC LIMIT 1`,
      [channelId],
    );
    const payload = latest.rows[0]?.payload || {};
    const candidate = payload.candidate || {};
    const targetCountry = String(payload.targetCountry || 'GLOBAL');
    let result;
    try {
      result = await validateChannelCountry({
        channelName: candidate.channelName || row.channel_name,
        description: candidate.description || '',
        videoTitles: candidate.videoTitles || [],
        // Never feed the stored LIKELY country back in as official metadata:
        // that would launder the weak hypothesis into its own proof.
        locationTag: candidate.locationTag || undefined,
        externalLinks: candidate.channelLinks || [],
        metadataStatus: candidate.countryMetadataStatus,
        videoDescriptions: candidate.videoDescriptions || [],
        videoDescriptionsAuthoritative: candidate.videoDescriptionsAuthoritative,
        playlists: candidate.playlists,
      }, targetCountry);
    } catch (error) {
      skipped += 1;
      console.warn(`[LikelyCountryReconciliation] validation failed for ${channelId}:`, error instanceof Error ? error.message : error);
      continue;
    }
    const detected = result.detectedCreatorCountry || row.country || null;
    const outcome = await applyLikelyCountryRecheck({
      channelId,
      snapshotCountry: row.country ? String(row.country) : null,
      snapshotCountryStatus: row.country_status ? String(row.country_status) : null,
      snapshotReviewVersion: row.review_version == null ? null : Number(row.review_version),
      result,
      detected,
      now: new Date().toISOString(),
    });
    if (outcome === 'REJECTED') rejected += 1;
    else if (outcome === 'RETAINED') retained += 1;
    else if (outcome === 'REVIEW') review += 1;
    else skipped += 1;
  }
  return { scanned: rows.rowCount || 0, rejected, retained, review, skipped };
}
