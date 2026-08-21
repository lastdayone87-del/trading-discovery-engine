import { getDb, enqueueJob } from './db';
import { normalizeYouTubeLocator } from './braveSearch';
import { resolveYouTubeLocatorAuthoritatively } from './youtube';

export interface PendingStagedCandidate {
  id: string;
  stagingKey: string;
  providerKey: string;
  candidateType: 'CHANNEL_ID' | 'HANDLE' | 'VIDEO_ID' | 'EXTERNAL_EVIDENCE';
  normalizedIdentity: string;
  rawLocator: string;
  country: string;
  discoveryMode: 'DIRECT_YOUTUBE' | 'EXTERNAL_OSINT';
  resolutionStatus: 'PENDING' | 'RESOLVED' | 'FAILED' | 'SKIPPED';
  metadata: Record<string, unknown>;
  resolutionAttempts?: number;
}

export async function getPendingStagedCandidates(limit = 50, clientOverride?: any): Promise<PendingStagedCandidate[]> {
  const db = clientOverride === null ? null : (clientOverride || (process.env.DATABASE_URL ? await getDb() : null));
  if (!db) return [];
  const res = await db.query(
    `SELECT id, staging_key, provider_key, candidate_type, normalized_identity, raw_locator,
            country, discovery_mode, resolution_status, metadata, resolution_attempts
     FROM discovery_candidate_staging
     WHERE resolution_status = 'PENDING'
       AND (next_resolution_at IS NULL OR next_resolution_at <= now())
     ORDER BY discovered_at ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows.map((row: any) => ({
    id: row.id,
    stagingKey: row.staging_key,
    providerKey: row.provider_key,
    candidateType: row.candidate_type,
    normalizedIdentity: row.normalized_identity,
    rawLocator: row.raw_locator,
    country: row.country,
    discoveryMode: row.discovery_mode,
    resolutionStatus: row.resolution_status,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
    resolutionAttempts: Number(row.resolution_attempts || 0)
  }));
}

async function enqueueStagedResolution(candidate: PendingStagedCandidate, clientOverride?: any): Promise<void> {
  const db = clientOverride === null ? null : (clientOverride || (process.env.DATABASE_URL ? await getDb() : null));
  if (!db || typeof db.connect !== 'function') return;
  const attempts = Number(candidate.resolutionAttempts || 0);
  const runAfter = new Date(Date.now() + Math.min(60 * 60_000, Math.max(30_000, 30_000 * 2 ** attempts))).toISOString();
  const job = await enqueueJob('RESOLVE_STAGED_CANDIDATE', {
    stagingId: candidate.id,
    candidateType: candidate.candidateType,
    providerKey: candidate.providerKey
  }, {
    priority: 15,
    maxAttempts: 5,
    runAfter,
    idempotencyKey: `staged-resolution:${candidate.id}`,
    preventReopen: true,
    clientOverride: db
  });
  await db.query(
    `UPDATE discovery_candidate_staging
     SET next_resolution_at=$2, resolution_job_id=$3, updated_at=now()
     WHERE id=$1 AND resolution_status='PENDING'`,
    [candidate.id, runAfter, job.id]
  );
}

/** Collision-safe canonical resolution. Concurrent workers converge to the
 * authoritative YouTube channel row while all observations are re-parented. */
async function setResolvedCanonical(candidate: PendingStagedCandidate, channelId: string, validationStatus: 'UNVALIDATED' | 'VALIDATED' | 'REJECTED', clientOverride?: any): Promise<boolean> {
  const db = clientOverride || await getDb();
  const canonicalKey = `YOUTUBE_CHANNEL:${channelId}`;
  const client = !clientOverride && typeof db.connect === 'function' ? await db.connect() : null;
  const runner = client || db;
  try {
    if (client) await runner.query('BEGIN');
    const current = await runner.query(`SELECT id FROM discovery_candidate_staging WHERE id=$1 FOR UPDATE`, [candidate.id]);
    if (!current.rowCount) { if (client) await runner.query('COMMIT'); return false; }
    const target = await runner.query(`SELECT id FROM discovery_candidate_staging WHERE canonical_candidate_key=$1 FOR UPDATE`, [canonicalKey]);
    const targetId = target.rows[0]?.id;
    if (targetId && String(targetId) !== String(candidate.id)) {
      await runner.query(`UPDATE discovery_candidate_observations SET staging_id=$2,canonical_candidate_key=$3 WHERE staging_id=$1`, [candidate.id, targetId, canonicalKey]);
      await runner.query(`UPDATE discovery_candidate_staging SET resolution_status='RESOLVED',resolved_channel_id=$2,validation_status=$3,updated_at=now() WHERE id=$1`, [targetId, channelId, validationStatus]);
      await runner.query(`DELETE FROM discovery_candidate_staging WHERE id=$1`, [candidate.id]);
    } else {
      await runner.query(`UPDATE discovery_candidate_staging SET canonical_candidate_key=$2,resolution_status='RESOLVED',resolved_channel_id=$3,validation_status=$4,next_resolution_at=NULL,last_resolution_error=NULL,updated_at=now() WHERE id=$1`, [candidate.id, canonicalKey, channelId, validationStatus]);
    }
    if (client) await runner.query('COMMIT');
    return true;
  } catch (error) {
    if (client) await runner.query('ROLLBACK');
    throw error;
  } finally { client?.release(); }
}

export async function updateStagedCandidateResolution(
  stagingId: string,
  input: { resolutionStatus: 'RESOLVED' | 'FAILED' | 'SKIPPED'; resolvedChannelId?: string | null; validationStatus?: 'UNVALIDATED' | 'VALIDATED' | 'REJECTED'; duplicateRejectionReason?: string | null },
  clientOverride?: any
): Promise<boolean> {
  const db = clientOverride === null ? null : (clientOverride || (process.env.DATABASE_URL ? await getDb() : null));
  if (!db) return false;
  if ((!clientOverride || typeof clientOverride.connect === 'function') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stagingId)) return false;
  if (input.resolutionStatus === 'RESOLVED' && input.resolvedChannelId) {
    if (clientOverride && typeof clientOverride.connect !== 'function') {
      const simple = await db.query(`UPDATE discovery_candidate_staging SET resolution_status=$2,resolved_channel_id=$3,validation_status=$4,next_resolution_at=NULL,updated_at=now() WHERE id=$1`, [stagingId, 'RESOLVED', input.resolvedChannelId, input.validationStatus || 'UNVALIDATED']);
      return (simple.rowCount ?? 0) > 0;
    }
    const row = await db.query(`SELECT id,staging_key,provider_key,candidate_type,normalized_identity,raw_locator,country,discovery_mode,resolution_status,metadata FROM discovery_candidate_staging WHERE id=$1`, [stagingId]);
    if (!row.rowCount) return false;
    return setResolvedCanonical({
      id: row.rows[0].id, stagingKey: row.rows[0].staging_key, providerKey: row.rows[0].provider_key,
      candidateType: row.rows[0].candidate_type, normalizedIdentity: row.rows[0].normalized_identity,
      rawLocator: row.rows[0].raw_locator, country: row.rows[0].country,
      discoveryMode: row.rows[0].discovery_mode, resolutionStatus: row.rows[0].resolution_status,
      metadata: row.rows[0].metadata || {}
    }, input.resolvedChannelId, input.validationStatus || 'UNVALIDATED', clientOverride);
  }
  const res = await db.query(
    `UPDATE discovery_candidate_staging SET resolution_status=$2,resolved_channel_id=$3,validation_status=COALESCE($4,validation_status),duplicate_rejection_reason=$5,next_resolution_at=NULL,updated_at=now() WHERE id=$1`,
    [stagingId, input.resolutionStatus, input.resolvedChannelId || null, input.validationStatus || null, input.duplicateRejectionReason || null]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Processes pending candidates. In production, capacity shortages enqueue a
 * durable continuation instead of requiring a caller-supplied resolver. */
export async function processPendingStagedCandidates(
  resolveChannelFn?: (identity: string, type: string) => Promise<string | null>,
  clientOverride?: any
): Promise<{ processed: number; resolved: number; deferred: number; skipped: number }> {
  const pending = await getPendingStagedCandidates(50, clientOverride);
  if (!pending.length) return { processed: 0, resolved: 0, deferred: 0, skipped: 0 };
  let processed = 0, resolved = 0, deferred = 0, skipped = 0;
  const resolver = resolveChannelFn || ((identity: string, type: string) => resolveYouTubeLocatorAuthoritatively(identity, type as 'HANDLE' | 'VIDEO_ID' | 'CHANNEL_ID'));

  for (const cand of pending) {
    if (cand.candidateType === 'CHANNEL_ID') {
      await updateStagedCandidateResolution(cand.id, { resolutionStatus: 'RESOLVED', resolvedChannelId: cand.normalizedIdentity, validationStatus: 'UNVALIDATED' }, clientOverride);
      processed++; resolved++; continue;
    }

    if (cand.candidateType === 'EXTERNAL_EVIDENCE') {
      const snippet = String(cand.metadata.snippet || cand.metadata.title || '');
      const extractedLoc = normalizeYouTubeLocator(snippet);
      if (!extractedLoc || extractedLoc.candidateType === 'EXTERNAL_EVIDENCE') {
        // Snippet omission is not semantic negative evidence. Keep the candidate
        // pending for the governed Phase 11 evidence path and durable retry.
        await enqueueStagedResolution(cand, clientOverride);
        processed++;
        deferred++;
        continue;
      }
      try {
        const channelId = await resolver(extractedLoc.normalizedIdentity, extractedLoc.candidateType);
        if (channelId) { await updateStagedCandidateResolution(cand.id, { resolutionStatus: 'RESOLVED', resolvedChannelId: channelId, validationStatus: 'UNVALIDATED' }, clientOverride); resolved++; }
        else { await enqueueStagedResolution(cand, clientOverride); deferred++; }
        processed++;
      } catch { await enqueueStagedResolution(cand, clientOverride); deferred++; }
      continue;
    }

    try {
      const channelId = await resolver(cand.normalizedIdentity, cand.candidateType);
      if (channelId) { await updateStagedCandidateResolution(cand.id, { resolutionStatus: 'RESOLVED', resolvedChannelId: channelId, validationStatus: 'UNVALIDATED' }, clientOverride); resolved++; }
      else { await updateStagedCandidateResolution(cand.id, { resolutionStatus: 'FAILED', duplicateRejectionReason: 'AUTHORITATIVE_CHANNEL_RESOLUTION_EMPTY' }, clientOverride); }
      processed++;
    } catch (error: any) {
      await enqueueStagedResolution(cand, clientOverride);
      deferred++;
    }
  }
  return { processed, resolved, deferred, skipped };
}
