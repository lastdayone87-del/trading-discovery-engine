import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { REVIEW_ELIGIBILITY_POLICY_VERSION } from './policy';
import { materializeEligibleReviewInTransaction } from '../release5/reviewMaterializer';
import { recordDashboardCorpusShadow } from '../dashboardCorpus/store';

export const CLASSIFICATION_EXHAUSTION_POLICY_VERSION = 'classification-exhaustion-review-v1';
export const CLASSIFICATION_EXHAUSTION_REASON_FAMILY = 'EVIDENCE_EXHAUSTED';

export interface ExhaustedReviewInput {
  channelId: string;
  classificationDiagnosticId?: string | null;
  reasonCode: string;
  reasonCodes?: string[];
  evidenceSummary?: Record<string, unknown>;
  decidedAt?: string | Date;
}

export interface ExhaustedReviewResult {
  materialized: boolean;
  reason: string;
  eligibilityDecisionId: string;
  reviewVersion?: number;
}

/**
 * Materializes a human-review row for machine-exhausted uncertainty.
 *
 * This is deliberately not a terminal classification path. It never writes
 * TRADING_CONFIRMED or NON_TRADING, and it does not alter the evidence policy
 * thresholds. It only makes the exhausted case reviewable by an operator.
 *
 * The existing review trigger requires an ELIGIBLE serving decision, so this
 * path writes an explicit EVIDENCE_EXHAUSTED eligibility decision and then
 * reuses the established review materializer. Normal human-ambiguity
 * eligibility continues to come from evaluateReviewEligibilityV2 unchanged.
 */
export async function materializeExhaustedReview(input: ExhaustedReviewInput): Promise<ExhaustedReviewResult> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Normal eligibility writes lock the projection first, then the channel.
    // Use the same order and a channel advisory lock to avoid deadlocks with
    // concurrent evaluation/materialization transactions.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`review-eligibility:${input.channelId}`]);
    const priorProjection = await client.query(
      `SELECT version,decision_id,evidence_checksum,decided_at FROM review_eligibility_projection WHERE channel_id=$1 FOR UPDATE`,
      [input.channelId],
    );
    const channelResult = await client.query(
      `SELECT channel_id,trading_status,scan_status,country_status FROM channels WHERE channel_id=$1 FOR UPDATE`,
      [input.channelId],
    );
    if (!channelResult.rowCount) throw new Error('CHANNEL_NOT_FOUND');
    const channel = channelResult.rows[0];
    if (['TRADING_CONFIRMED', 'NON_TRADING', 'HUMAN_REJECTED'].includes(String(channel.trading_status))) {
      await client.query('COMMIT');
      return { materialized: false, reason: 'TERMINAL_DECISION_PRESERVED', eligibilityDecisionId: '' };
    }
    if (String(channel.country_status) === 'REJECTED') {
      await client.query('COMMIT');
      return { materialized: false, reason: 'COUNTRY_POLICY_TERMINAL', eligibilityDecisionId: '' };
    }

    const reasonCodes = [CLASSIFICATION_EXHAUSTION_REASON_FAMILY, input.reasonCode, ...(input.reasonCodes || [])]
      .filter((value, index, all) => value && all.indexOf(value) === index);
    const inputSnapshot = {
      source: 'classification-exhaustion',
      reasonFamily: CLASSIFICATION_EXHAUSTION_REASON_FAMILY,
      reasonCode: input.reasonCode,
      reasonCodes,
      classificationDiagnosticId: input.classificationDiagnosticId || null,
      evidenceSummary: input.evidenceSummary || {},
      evidenceRequirementsUnchanged: true,
      policyVersion: CLASSIFICATION_EXHAUSTION_POLICY_VERSION,
    };
    const checksum = createHash('sha256').update(JSON.stringify(inputSnapshot)).digest('hex');
    // New evidence creates a new review decision instead of silently reusing
    // an older exhaustion snapshot.
    const decisionKey = `classification-exhaustion:${input.channelId}:${input.reasonCode}:${input.classificationDiagnosticId || 'none'}:${checksum}`;
    const decidedAt = input.decidedAt ? new Date(input.decidedAt).toISOString() : new Date().toISOString();

    let decisionId: string;
    const existingDecision = await client.query(
      `SELECT id FROM review_eligibility_decisions WHERE decision_key=$1`,
      [decisionKey],
    );
    if (existingDecision.rowCount) {
      decisionId = String(existingDecision.rows[0].id);
    } else {
      const inserted = await client.query(
        `INSERT INTO review_eligibility_decisions(
           decision_key,channel_id,classification_diagnostic_id,investigation_id,creator_focus_snapshot_id,
           status,reason_codes,input_snapshot,input_checksum,policy_version,mode,assignment_basis_points,
           randomization_value,assigned,serving_authority,decided_at
         ) VALUES($1,$2,$3,NULL,NULL,'ELIGIBLE',$4,$5,$6,$7,'SHADOW',0,0,true,true,$8)
         RETURNING id`,
        [
          decisionKey, input.channelId, input.classificationDiagnosticId || null,
          JSON.stringify(reasonCodes), JSON.stringify(inputSnapshot), checksum,
          REVIEW_ELIGIBILITY_POLICY_VERSION, decidedAt,
        ],
      );
      decisionId = String(inserted.rows[0].id);
    }

    const decision = await client.query(
      `SELECT id,status,serving_authority,policy_version,input_snapshot,reason_codes FROM review_eligibility_decisions WHERE id=$1`,
      [decisionId],
    );
    if (!decision.rowCount || decision.rows[0].status !== 'ELIGIBLE' || decision.rows[0].serving_authority !== true) {
      throw new Error('EXHAUSTED_REVIEW_DECISION_NOT_SERVING');
    }
    const projectionCurrent = priorProjection.rows[0]?.decision_id === decisionId;
    if (!projectionCurrent) {
      const version = Number(priorProjection.rows[0]?.version || 0) + 1;
      await client.query(
        `INSERT INTO review_eligibility_events(event_key,channel_id,decision_id,expected_projection_version,payload,policy_version)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          createHash('sha256').update(`classification-exhaustion-event:${decisionKey}:${version}`).digest('hex'),
          input.channelId, decisionId, Number(priorProjection.rows[0]?.version || 0),
          JSON.stringify({ status: 'ELIGIBLE', reasonCodes, reasonFamily: CLASSIFICATION_EXHAUSTION_REASON_FAMILY, evidenceChecksum: checksum }),
          REVIEW_ELIGIBILITY_POLICY_VERSION,
        ],
      );
      await client.query(
        `INSERT INTO review_eligibility_projection(
           channel_id,status,version,decision_id,reason_codes,evidence_checksum,policy_version,decided_at
         ) VALUES($1,'ELIGIBLE',$2,$3,$4,$5,$6,$7)
         ON CONFLICT(channel_id) DO UPDATE SET
           status='ELIGIBLE',version=excluded.version,decision_id=excluded.decision_id,
           reason_codes=excluded.reason_codes,evidence_checksum=excluded.evidence_checksum,
           policy_version=excluded.policy_version,decided_at=excluded.decided_at,updated_at=now()`,
        [
          input.channelId, version, decisionId, JSON.stringify(reasonCodes), checksum,
          REVIEW_ELIGIBILITY_POLICY_VERSION, decidedAt,
        ],
      );
    }

    const materialized = await materializeEligibleReviewInTransaction(client, {
      channelId: input.channelId,
      eligibilityDecisionId: decisionId,
    });
    await client.query('COMMIT');
    if (materialized.materialized || materialized.reason === 'CURRENT_PENDING_REVIEW_PRESERVED') {
      await recordDashboardCorpusShadow({ channelId: input.channelId, admissionState: 'ADMITTED_REVIEW' })
        .catch(error => console.warn(`[ClassificationResolution] Dashboard corpus observation failed for ${input.channelId}:`, error instanceof Error ? error.message : error));
    }
    return {
      materialized: materialized.materialized === true,
      reason: materialized.reason,
      eligibilityDecisionId: decisionId,
      reviewVersion: materialized.reviewVersion,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
