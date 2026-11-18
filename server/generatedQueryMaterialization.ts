import { randomUUID } from 'node:crypto';
import { getDb, getAppSetting } from './db';
import { authorizeCountryNativeAllocationQuery } from './queryIntelligence';
import type { DiscoveryNeighborhoodDimensions } from './discoveryNeighborhood';
import { assessGeneratedSurface, loadGeneratedSurfaceHistory, surfaceDeferralEligibleSql } from './generatedQuerySurface';

export interface GeneratedQueryMaterializationResult {
  enabled: boolean;
  attempted: number;
  materialized: number;
  rejected: number;
  deferred: number;
  queryIds: number[];
}

async function isStillInPersistentSelection(
  country: string,
  readSetting: (key: string, fallback: string) => Promise<string>,
): Promise<boolean> {
  const scope = String(await readSetting('query_intelligence_discovery_scope', 'GLOBAL')).toUpperCase();
  // A persistent promotion is valid only while the live mode still selects
  // countries. GLOBAL or malformed scope means the old promotion is stale.
  if (scope !== 'SELECTED_COUNTRIES') return false;
  const raw = await readSetting('query_intelligence_selected_countries', '[]');
  try {
    const selected = JSON.parse(raw);
    if (!Array.isArray(selected) || selected.some(value => typeof value !== 'string')) return false;
    const target = country.normalize('NFKC').trim().toLocaleLowerCase('en');
    return selected.some(value => typeof value === 'string'
      && value.normalize('NFKC').trim().toLocaleLowerCase('en') === target);
  } catch {
    return false;
  }
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
       AND ${surfaceDeferralEligibleSql('supporting_evidence')}
     ORDER BY confidence DESC, created_at ASC
     LIMIT $2`,
    [country, limit],
  );

  const authorize = options.authorize || authorizeCountryNativeAllocationQuery;
  // Actual-history surface gate: near-duplicates of already-executed surfaces
  // that yielded no new creators or no results are deferred before they enter
  // the normal library. The gate is applied per country and per batch.
  const surfaceHistory = rows.rows.length ? await loadGeneratedSurfaceHistory(country, db) : [];
  const batchSurfaces: string[] = [];
  const deferSurface = async (proposalId: string, reason: string): Promise<void> => {
    await db.query(
      `UPDATE frontier_discovery_proposals
       SET supporting_evidence = supporting_evidence || jsonb_build_object(
         'surfaceDeferredAt', now(),
         'surfaceDeferredReason', $2::text
       )
       WHERE proposal_id=$1 AND trial_status='PENDING'`,
      [proposalId, reason],
    ).catch(error => {
      console.warn('[GeneratedSupply] Surface deferral write failed:', {
        proposalId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const result: GeneratedQueryMaterializationResult = {
    enabled: true, attempted: 0, materialized: 0, rejected: 0, deferred: 0, queryIds: [],
  };

  for (const row of rows.rows as any[]) {
    result.attempted++;
    // A detached materialization may outlive a scope change. Re-check the live
    // persistent selection before creating a promoted dormant-country row.
    if (options.scopePromotionBasis === 'PERSISTENT_SCOPE_SELECTION'
      && !await isStillInPersistentSelection(country, readSetting)) {
      result.deferred++;
      continue;
    }
    const dimensions = parseJson(row.target_dimensions) as unknown as DiscoveryNeighborhoodDimensions;
    const evidence = parseJson(row.supporting_evidence);
    const proposalSurface = String(evidence.nativeTerm || row.concept || '').trim();
    const surfaceGate = assessGeneratedSurface(proposalSurface, surfaceHistory, batchSurfaces);
    if (surfaceGate.allowed === false) {
      await deferSurface(row.proposal_id, surfaceGate.reason);
      result.deferred++;
      continue;
    }
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
    const claimToken = randomUUID();
    const claim = await db.query(
      `UPDATE frontier_discovery_proposals
       SET supporting_evidence = supporting_evidence || jsonb_build_object(
         'materializingAt', now(),
         'materializingClaim', $2::text
       )
       WHERE proposal_id=$1 AND trial_status='PENDING'
         AND (expires_at IS NULL OR expires_at > now())
         AND (supporting_evidence->>'materializingAt' IS NULL
              OR (supporting_evidence->>'materializingAt')::timestamptz < now()-interval '15 minutes')
         AND (supporting_evidence->>'materializationDeferredAt' IS NULL
              OR (supporting_evidence->>'materializationDeferredAt')::timestamptz < now()-interval '15 minutes')
         AND ${surfaceDeferralEligibleSql('supporting_evidence')}
         AND NOT EXISTS (
           SELECT 1 FROM frontier_allocation_decisions d
           WHERE d.proposal_id=$1
             AND d.decision_status IN ('RESERVED','COMMITTED')
         )
       RETURNING proposal_id`,
      [row.proposal_id, claimToken],
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
         SET supporting_evidence = (supporting_evidence - 'materializingAt' - 'materializingClaim')
           || jsonb_build_object('materializationDeferredAt', now())
         WHERE proposal_id=$1 AND trial_status='PENDING'
           AND supporting_evidence->>'materializingClaim'=$2`,
        [row.proposal_id, claimToken],
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
             supporting_evidence = (supporting_evidence - 'materializingAt' - 'materializingClaim')
               || jsonb_build_object('materializedQueryId', $3::int, 'materializedAt', now())
         WHERE proposal_id=$1 AND trial_status='PENDING'
           AND supporting_evidence->>'materializingClaim'=$2`,
        [row.proposal_id, claimToken, outcome.queryRecord.id],
      );
      if (saved.rowCount) {
        result.materialized++;
        batchSurfaces.push(proposalSurface);
        result.queryIds.push(outcome.queryRecord.id);
      } else {
        result.deferred++;
      }
      continue;
    }

    if (outcome.status === 'REJECTED' && outcome.code !== 'SCOPE_PROMOTION_STALE') {
      await db.query(
        `UPDATE frontier_discovery_proposals
         SET trial_status='DISABLED',
             supporting_evidence = (supporting_evidence - 'materializingAt' - 'materializingClaim')
               || jsonb_build_object('materializationRejectedCode', $3::text, 'materializationRejectedAt', now())
         WHERE proposal_id=$1 AND trial_status='PENDING'
           AND supporting_evidence->>'materializingClaim'=$2`,
        [row.proposal_id, claimToken, outcome.code],
      );
      result.rejected++;
    } else {
      await db.query(
        `UPDATE frontier_discovery_proposals
         SET supporting_evidence = (supporting_evidence - 'materializingAt' - 'materializingClaim')
           || jsonb_build_object('materializationDeferredAt', now())
         WHERE proposal_id=$1 AND trial_status='PENDING'
           AND supporting_evidence->>'materializingClaim'=$2`,
        [row.proposal_id, claimToken],
      );
      result.deferred++;
    }
  }
  return result;
}
