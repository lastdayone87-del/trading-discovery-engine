import { getDb, getAppSetting } from './db';
import { authorizeCountryNativeAllocationQuery } from './queryIntelligence';
import type { DiscoveryNeighborhoodDimensions } from './discoveryNeighborhood';

export interface GeneratedQueryMaterializationResult {
  enabled: boolean;
  attempted: number;
  materialized: number;
  rejected: number;
  deferred: number;
  queryIds: number[];
}

const parseJson = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Only generated queries explicitly materialized through the normal library
 * path carry this marker. They are scheduled as normal (LEGACY) query runs but
 * retain their target-neighborhood lineage for observation accounting.
 */
export function materializedGeneratedTargetDimensions(
  generationMetadata: Record<string, any> | null | undefined,
): DiscoveryNeighborhoodDimensions | undefined {
  const lineage = generationMetadata?.countryNativeAllocation;
  if (!lineage || typeof lineage !== 'object' || (lineage as any).materialized !== true) return undefined;
  const dimensions = (lineage as any).targetNeighborhoodDimensions;
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) return undefined;
  return dimensions as DiscoveryNeighborhoodDimensions;
}

/**
 * Converts admitted generated COUNTRY_NATIVE proposals into normal
 * EXPERIMENTAL query_library candidates.
 *
 * This is deliberately not a generated-query allocation lane: the resulting
 * rows are ordinary selector candidates and receive no provenance bonus,
 * percentage, or priority. Proposal ADMISSION remains the hard gate; rejected
 * proposals are disabled with their reason rather than blindly admitted.
 */
export async function materializeAdmittedGeneratedQueriesForCountry(
  country: string,
  options: {
    limit?: number;
    db?: any;
    authorize?: typeof authorizeCountryNativeAllocationQuery;
    readSetting?: (key: string, fallback: string) => Promise<string>;
    scopePromotionBasis?: 'PERSISTENT_SCOPE_SELECTION' | 'DIRECT_TARGET';
  } = {},
): Promise<GeneratedQueryMaterializationResult> {
  const readSetting = options.readSetting || getAppSetting;
  const enabled = String(await readSetting('generated_query_materialization_enabled', 'true')) === 'true';
  if (!enabled) return { enabled: false, attempted: 0, materialized: 0, rejected: 0, deferred: 0, queryIds: [] };

  const db = options.db || await getDb();
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
  const rows = await db.query(
    `SELECT proposal_id, proposal_family, country, language, concept,
            target_neighborhood_key, target_dimensions, source_provenance,
            supporting_evidence, confidence
     FROM frontier_discovery_proposals
     WHERE trial_status='PENDING'
       AND LOWER(country)=LOWER($1)
       AND (expires_at IS NULL OR expires_at > now())
       AND proposal_family='COUNTRY_NATIVE'
       AND (source_provenance LIKE 'llm_native_query%'
            OR source_provenance LIKE 'youtube_autocomplete%')
       AND target_neighborhood_key IS NOT NULL
       AND (supporting_evidence->>'materializingAt' IS NULL
            OR (supporting_evidence->>'materializingAt')::timestamptz < now()-interval '15 minutes')
       AND (supporting_evidence->>'materializationDeferredAt' IS NULL
            OR (supporting_evidence->>'materializationDeferredAt')::timestamptz < now()-interval '15 minutes')
     ORDER BY confidence DESC, created_at ASC
     LIMIT $2`,
    [country, limit],
  );

  const authorize = options.authorize || authorizeCountryNativeAllocationQuery;
  const result: GeneratedQueryMaterializationResult = {
    enabled: true, attempted: 0, materialized: 0, rejected: 0, deferred: 0, queryIds: [],
  };

  for (const row of rows.rows as any[]) {
    result.attempted++;
    const dimensions = parseJson(row.target_dimensions) as unknown as DiscoveryNeighborhoodDimensions;
    const evidence = parseJson(row.supporting_evidence);
    const snapshot = {
      proposalFamily: row.proposal_family,
      targetNeighborhoodKey: row.target_neighborhood_key,
      targetDimensions: dimensions,
      supportingEvidence: evidence,
      confidence: Number(row.confidence || 0),
    };
    // Claim before the slow authorization path. Frontier allocation also
    // locks the proposal row and refuses a claimed proposal; this prevents the
    // background materializer from consuming a reservation mid-scheduling.
    const claim = await db.query(
      `UPDATE frontier_discovery_proposals
       SET supporting_evidence = supporting_evidence || jsonb_build_object('materializingAt', now())
       WHERE proposal_id=$1 AND trial_status='PENDING'
         AND (supporting_evidence->>'materializingAt' IS NULL
              OR (supporting_evidence->>'materializingAt')::timestamptz < now()-interval '15 minutes')
       RETURNING proposal_id`,
      [row.proposal_id],
    );
    if (!claim.rowCount) { result.deferred++; continue; }

    let outcome: Awaited<ReturnType<typeof authorize>>;
    try {
      outcome = await authorize({
        country,
        decisionId: `materialized-generated:${row.proposal_id}`,
        proposalId: String(row.proposal_id),
        targetNeighborhoodDimensions: dimensions,
        proposalEvidenceSnapshot: snapshot,
        materialized: true,
        preserveExistingLibraryRow: true,
        scopePromotionBasis: options.scopePromotionBasis,
      } as any);
    } catch (error: any) {
      await db.query(
        `UPDATE frontier_discovery_proposals
         SET supporting_evidence = (supporting_evidence - 'materializingAt')
           || jsonb_build_object('materializationDeferredAt', now())
         WHERE proposal_id=$1 AND trial_status='PENDING'`,
        [row.proposal_id],
      );
      result.deferred++;
      console.warn('[GeneratedSupply] Materialization deferred:', {
        proposalId: row.proposal_id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (outcome.status === 'AUTHORIZED' && outcome.queryRecord) {
      const saved = await db.query(
        `UPDATE frontier_discovery_proposals
         SET trial_status='TRIED',
             supporting_evidence = (supporting_evidence - 'materializingAt')
               || jsonb_build_object('materializedQueryId', $2::int, 'materializedAt', now())
         WHERE proposal_id=$1 AND trial_status='PENDING'`,
        [row.proposal_id, outcome.queryRecord.id],
      );
      if (saved.rowCount) {
        result.materialized++;
        result.queryIds.push(outcome.queryRecord.id);
      } else {
        result.deferred++;
      }
      continue;
    }

    if (outcome.status === 'REJECTED') {
      await db.query(
        `UPDATE frontier_discovery_proposals
         SET trial_status='DISABLED',
             supporting_evidence = (supporting_evidence - 'materializingAt')
               || jsonb_build_object('materializationRejectedCode', $2::text, 'materializationRejectedAt', now())
         WHERE proposal_id=$1 AND trial_status='PENDING'`,
        [row.proposal_id, outcome.code],
      );
      result.rejected++;
    } else {
      await db.query(
        `UPDATE frontier_discovery_proposals
         SET supporting_evidence = (supporting_evidence - 'materializingAt')
           || jsonb_build_object('materializationDeferredAt', now())
         WHERE proposal_id=$1 AND trial_status='PENDING'`,
        [row.proposal_id],
      );
      result.deferred++;
    }
  }
  return result;
}
