import { getDb } from './db';

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
}

/**
 * Fetches pending staged candidates that require YouTube enrichment/resolution.
 */
export async function getPendingStagedCandidates(
  limit = 50,
  clientOverride?: any
): Promise<PendingStagedCandidate[]> {
  const db = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!db) return [];

  const res = await db.query(
    `SELECT id, staging_key, provider_key, candidate_type, normalized_identity, raw_locator,
            country, discovery_mode, resolution_status, metadata
     FROM discovery_candidate_staging
     WHERE resolution_status = 'PENDING'
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
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
  }));
}

/**
 * Updates candidate staging resolution status post YouTube resolution/enrichment attempt.
 */
export async function updateStagedCandidateResolution(
  stagingId: string,
  input: {
    resolutionStatus: 'RESOLVED' | 'FAILED' | 'SKIPPED';
    resolvedChannelId?: string | null;
    validationStatus?: 'UNVALIDATED' | 'VALIDATED' | 'REJECTED';
    duplicateRejectionReason?: string | null;
  },
  clientOverride?: any
): Promise<boolean> {
  const db = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!db) return false;

  const res = await db.query(
    `UPDATE discovery_candidate_staging
     SET resolution_status = $2,
         resolved_channel_id = $3,
         validation_status = COALESCE($4, validation_status),
         duplicate_rejection_reason = $5,
         updated_at = now()
     WHERE id = $1`,
    [
      stagingId,
      input.resolutionStatus,
      input.resolvedChannelId || null,
      input.validationStatus || null,
      input.duplicateRejectionReason || null
    ]
  );

  return (res.rowCount ?? 0) > 0;
}

/**
 * Processes pending staged candidates by resolving handles, videos, or channel IDs via YouTube API,
 * or leaving them safely staged as PENDING when YouTube capacity is unavailable.
 */
export async function processPendingStagedCandidates(
  resolveChannelFn?: (identity: string, type: string) => Promise<string | null>,
  clientOverride?: any
): Promise<{ processed: number; resolved: number; deferred: number }> {
  const pending = await getPendingStagedCandidates(50, clientOverride);
  if (pending.length === 0) {
    return { processed: 0, resolved: 0, deferred: 0 };
  }

  let processed = 0;
  let resolved = 0;
  let deferred = 0;

  for (const cand of pending) {
    if (cand.candidateType === 'CHANNEL_ID') {
      await updateStagedCandidateResolution(cand.id, {
        resolutionStatus: 'RESOLVED',
        resolvedChannelId: cand.normalizedIdentity,
        validationStatus: 'VALIDATED'
      }, clientOverride);
      processed++;
      resolved++;
      continue;
    }

    if (resolveChannelFn) {
      try {
        const channelId = await resolveChannelFn(cand.normalizedIdentity, cand.candidateType);
        if (channelId) {
          await updateStagedCandidateResolution(cand.id, {
            resolutionStatus: 'RESOLVED',
            resolvedChannelId: channelId,
            validationStatus: 'VALIDATED'
          }, clientOverride);
          resolved++;
        } else {
          await updateStagedCandidateResolution(cand.id, {
            resolutionStatus: 'FAILED',
            duplicateRejectionReason: 'CHANNEL_RESOLUTION_FAILED'
          }, clientOverride);
        }
        processed++;
      } catch (err) {
        // Leave candidate as PENDING (deferred) when resolution fails or capacity unavailable
        deferred++;
      }
    } else {
      // Without explicit resolver, defer candidates safely in PENDING state
      deferred++;
    }
  }

  return { processed, resolved, deferred };
}
