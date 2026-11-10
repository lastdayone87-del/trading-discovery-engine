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
      const evidence = row.evidence_snapshot || {};
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
        idempotencyKey: `intake-recheck:${channelId}:${row.review_version}`,
        clientOverride: client,
      });
      if (job.status === 'PENDING' || job.status === 'PROCESSING') {
        enqueued += 1;
        await client.query(
          `UPDATE intake_deferred_reviews
           SET next_recheck_at=now()+interval '1 hour',last_checked_at=now(),
               recheck_attempts=recheck_attempts+1,updated_at=now()
           WHERE channel_id=$1`,
          [channelId],
        );
      } else {
        skipped += 1;
      }
    } catch (error) {
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
            c.scan_status,c.last_checked,c.inspection_trail
     FROM channels c
     JOIN excluded_countries e ON LOWER(c.country)=LOWER(e.country_name)
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
    const now = new Date().toISOString();
    const trail = Array.isArray(row.inspection_trail) ? row.inspection_trail : [];
    const recentRecheck = trail.some((step: any) => step?.title?.startsWith?.('Country Recheck')
      && Date.parse(String(step?.timestamp || '')) > Date.now() - 7 * 86_400_000);
    if (result.status === 'REJECTED' && detected) {
      const rejection = await db.query(
        `UPDATE channels
         SET country_status='REJECTED',country=$2,confidence_score=$3,scan_status='COMPLETED',
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
          channelId,
          detected,
          result.score,
          resolveScopeEligibility(detected),
          JSON.stringify([...trail, {
            step: 'COUNTRY_VALIDATION',
            title: `Country Recheck (${detected})`,
            status: 'REJECTED',
            details: `Likely excluded-country row re-evaluated: ${result.decisionLogs}`,
            timestamp: now,
          }]),
        ],
      );
      if (!rejection.rowCount) {
        skipped += 1;
        continue;
      }
      await db.query(
        `UPDATE intake_deferred_reviews SET state='SUPERSEDED',next_recheck_at=NULL,updated_at=now()
         WHERE channel_id=$1 AND state IN ('PENDING','DECIDED')`,
        [channelId],
      );
      rejected += 1;
      continue;
    }
    if (result.status === 'CONFIRMED' && detected && result.gateDisposition === 'ALLOW_NORMAL') {
      const retention = await db.query(
        `UPDATE channels SET country=$2,country_status='CONFIRMED',confidence_score=$3,
           scope_eligibility=$4,last_checked=now(),inspection_trail=$5::jsonb,updated_at=now()
         WHERE channel_id=$1
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.status IN ('PENDING','PROCESSING')
           AND j.payload->>'channelId'=channels.channel_id
           AND j.type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','CLASSIFY_DISCOVERED_CHANNEL')
       )`,
        [channelId, detected, result.score, resolveScopeEligibility(detected), JSON.stringify(recentRecheck ? trail : [...trail, {
          step: 'COUNTRY_VALIDATION',
          title: `Country Recheck (${detected})`,
          status: 'CONFIRMED',
          details: `Likely excluded-country row retained with strong non-excluded evidence: ${result.decisionLogs}`,
          timestamp: now,
        }])],
      );
      if (!retention.rowCount) {
        skipped += 1;
        continue;
      }
      retained += 1;
      continue;
    }
    review += 1;
    await db.query(
      `UPDATE channels SET last_checked=now(),inspection_trail=$2::jsonb,updated_at=now()
       WHERE channel_id=$1`,
      [channelId, JSON.stringify(recentRecheck ? trail : [...trail, {
        step: 'COUNTRY_VALIDATION',
        title: `Country Recheck (${detected || row.country})`,
        status: 'PARTIAL',
        details: `Likely excluded-country row left unchanged: evidence is weak, conflicting, or below domicile grade (${result.status}/${result.gateDisposition || 'NO_GATE'}). ${result.decisionLogs}`,
        timestamp: now,
      }])],
    );
  }
  return { scanned: rows.rowCount || 0, rejected, retained, review, skipped };
}
