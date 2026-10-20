/**
 * Evidence-first discovery Phase 1 — idempotent staging writer.
 *
 * Persists PROBE_ELIGIBLE evidence candidates into the existing
 * discovery_candidate_staging / discovery_candidate_observations tables,
 * following the Brave shadow path conventions (braveSearch.ts
 * stageDiscoveredCandidates): staging_key = canonical_candidate_key,
 * ON CONFLICT (staging_key) DO UPDATE ... RETURNING (xmax=0), and
 * observation rows keyed by an independently recomputable observation_key
 * with ON CONFLICT DO NOTHING.
 *
 * Row semantics are deliberately distinct from the Brave lane:
 * - provider_key 'evidence_extraction', retrieval_surface 'INGESTION_METADATA',
 *   discovery_mode 'EVIDENCE_EXTRACTION', candidate_type 'SEARCH_TERM';
 * - resolution_status 'EVIDENCE_ONLY' (never the Brave lane's pending
 *   channel-resolution state): these rows are inert evidence records. The
 *   Brave backlog counter and the RESOLVE_STAGED_CANDIDATE claim path select
 *   only that lane's pending value, so extraction writes can never enter —
 *   or block — the channel-resolution queue.
 *
 * Rollback: the flag OFF stops all writes; rows may remain (inert) or be
 * removed by provider_key.
 */

import { createHash } from 'node:crypto';
import {
  EVIDENCE_CANDIDATE_TYPE,
  EVIDENCE_EXTRACTION_DISCOVERY_MODE,
  EVIDENCE_EXTRACTION_PROVIDER_CAPABILITY,
  EVIDENCE_EXTRACTION_PROVIDER_KEY,
  EVIDENCE_EXTRACTION_RETRIEVAL_SURFACE,
  EVIDENCE_EXTRACTION_VERSION,
  type EvidenceCandidate,
  type EvidenceProvenance,
} from './evidenceExtraction';

export const EVIDENCE_RESOLUTION_STATUS = 'EVIDENCE_ONLY';

export interface EvidenceStagingQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface EvidenceStagingConnection extends EvidenceStagingQueryable {
  release?: () => void;
}

export interface EvidenceStagingClient extends EvidenceStagingQueryable {
  connect?: () => Promise<EvidenceStagingConnection>;
  /** Present on pg.Pool; distinguishes a pool from an already-connected client. */
  totalCount?: number;
}

export interface EvidenceStagingContext {
  channelId: string;
  /** Canonicalized country identity (creator evidence when known, else retrieval country). */
  country: string;
  language?: string | null;
}

export interface EvidenceStagingResult {
  stagedCount: number;
  duplicateCount: number;
  observationCount: number;
}

export function evidenceObservationKey(
  canonicalCandidateKey: string,
  channelId: string,
  provenance: EvidenceProvenance
): string {
  return createHash('sha256')
    .update(
      [
        canonicalCandidateKey,
        EVIDENCE_EXTRACTION_PROVIDER_KEY,
        EVIDENCE_EXTRACTION_RETRIEVAL_SURFACE,
        channelId,
        provenance.sourceType,
        provenance.sourceId,
        provenance.sourceHash,
        provenance.sourceIndex,
        provenance.extractionMethod,
        provenance.textSpan ? `${provenance.textSpan.start}-${provenance.textSpan.end}` : 'null',
      ].join('|')
    )
    .digest('hex');
}

/**
 * Idempotent staging insert for one candidate. Returns whether the staging row
 * was newly inserted (xmax=0) and how many observation rows were newly written.
 */
async function stageOne(
  db: EvidenceStagingQueryable,
  candidate: EvidenceCandidate,
  context: EvidenceStagingContext
): Promise<{ inserted: boolean; observationCount: number }> {
  const stagingKey = candidate.canonicalCandidateKey;
  const primary = candidate.provenance[0];
  const provenanceJson = {
    provider: EVIDENCE_EXTRACTION_PROVIDER_KEY,
    extractorVersion: EVIDENCE_EXTRACTION_VERSION,
    signalKind: candidate.signalKind,
    canonicalIdentity: candidate.canonicalIdentity,
    primarySource: primary
      ? {
          sourceType: primary.sourceType,
          sourceId: primary.sourceId,
          sourceIndex: primary.sourceIndex,
          textSpan: primary.textSpan,
          extractionMethod: primary.extractionMethod,
          sourceHash: primary.sourceHash,
        }
      : null,
  };
  const metadataJson = {
    frequency: candidate.frequency,
    extractorVersion: EVIDENCE_EXTRACTION_VERSION,
    provenanceCount: candidate.provenance.length,
  };

  const res = await db.query(
    `INSERT INTO discovery_candidate_staging(
       staging_key, canonical_candidate_key, provider_key, retrieval_surface, provider_capability, candidate_type,
       normalized_identity, raw_locator, query_run_id, opportunity_key, country, language,
       neighborhood_key, discovery_mode, provenance, resolution_status, validation_status, metadata
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (staging_key) DO UPDATE SET
       updated_at=now(),
       provenance=excluded.provenance,
       metadata=excluded.metadata,
       country=excluded.country,
       language=excluded.language
     RETURNING id, (xmax=0) AS inserted`,
    [
      stagingKey,
      stagingKey,
      EVIDENCE_EXTRACTION_PROVIDER_KEY,
      EVIDENCE_EXTRACTION_RETRIEVAL_SURFACE,
      EVIDENCE_EXTRACTION_PROVIDER_CAPABILITY,
      EVIDENCE_CANDIDATE_TYPE,
      candidate.normalizedTerm,
      candidate.rawTerm,
      null,
      null,
      context.country,
      context.language || null,
      null,
      EVIDENCE_EXTRACTION_DISCOVERY_MODE,
      JSON.stringify(provenanceJson),
      EVIDENCE_RESOLUTION_STATUS,
      'UNVALIDATED',
      JSON.stringify(metadataJson),
    ]
  );
  const stagingId = res.rows?.[0]?.id;
  if (!stagingId) throw new Error('EVIDENCE_STAGING_ID_MISSING');
  const inserted = res.rows[0]?.inserted === true || res.rows[0]?.inserted === 'true';

  let observationCount = 0;
  for (const provenance of candidate.provenance) {
    const observationKey = evidenceObservationKey(candidate.canonicalCandidateKey, context.channelId, provenance);
    const observation = await db.query(
      `INSERT INTO discovery_candidate_observations(
         observation_key, staging_id, canonical_candidate_key, provider_key, retrieval_surface,
         provider_capability, candidate_type, normalized_identity, raw_locator, query_run_id,
         opportunity_key, country, language, neighborhood_key, discovery_mode, provenance, metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT(observation_key) DO NOTHING
       RETURNING observation_key`,
      [
        observationKey,
        stagingId,
        candidate.canonicalCandidateKey,
        EVIDENCE_EXTRACTION_PROVIDER_KEY,
        EVIDENCE_EXTRACTION_RETRIEVAL_SURFACE,
        EVIDENCE_EXTRACTION_PROVIDER_CAPABILITY,
        EVIDENCE_CANDIDATE_TYPE,
        candidate.normalizedTerm,
        candidate.rawTerm,
        null,
        null,
        context.country,
        context.language || null,
        null,
        EVIDENCE_EXTRACTION_DISCOVERY_MODE,
        JSON.stringify({
          provider: EVIDENCE_EXTRACTION_PROVIDER_KEY,
          channelId: context.channelId,
          extractorVersion: EVIDENCE_EXTRACTION_VERSION,
          ...provenance,
        }),
        JSON.stringify({ frequency: candidate.frequency, extractorVersion: EVIDENCE_EXTRACTION_VERSION }),
      ]
    );
    if (observation.rows?.[0]?.observation_key !== undefined) {
      observationCount += 1;
    }
  }
  return { inserted, observationCount };
}

async function withStagingTransaction<T>(
  client: EvidenceStagingClient,
  fn: (db: EvidenceStagingQueryable) => Promise<T>
): Promise<T> {
  if (typeof client.connect !== 'function' || typeof client.totalCount !== 'number') {
    // Test/in-memory clients (and already-connected clients) execute directly.
    return fn(client);
  }
  const connection = await client.connect();
  try {
    await connection.query('BEGIN');
    const result = await fn(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release?.();
  }
}

/**
 * Stage PROBE_ELIGIBLE candidates. Idempotent: re-running with identical input
 * increments duplicateCount without duplicating rows or observations.
 * `client` is injected by the pipeline runner; without one this is a no-op so
 * direct callers can never open an implicit pool/write. A batch is staged in a
 * single transaction when the client exposes a pool, so a failure mid-batch
 * cannot leave staging rows without their observations.
 */
export async function stageEvidenceCandidates(
  candidates: EvidenceCandidate[],
  context: EvidenceStagingContext,
  client?: EvidenceStagingClient
): Promise<EvidenceStagingResult> {
  if (candidates.length === 0) return { stagedCount: 0, duplicateCount: 0, observationCount: 0 };
  if (!client) return { stagedCount: 0, duplicateCount: 0, observationCount: 0 };
  if (!context.country || !context.country.trim()) throw new Error('EVIDENCE_STAGING_COUNTRY_REQUIRED');

  return withStagingTransaction(client, async db => {
    let stagedCount = 0;
    let duplicateCount = 0;
    let observationCount = 0;
    for (const candidate of candidates) {
      const result = await stageOne(db, candidate, context);
      if (result.inserted) stagedCount += 1;
      else duplicateCount += 1;
      observationCount += result.observationCount;
    }
    return { stagedCount, duplicateCount, observationCount };
  });
}
