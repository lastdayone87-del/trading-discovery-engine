import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { EvidenceCoverageSnapshot, EvidenceDocumentObservation } from '../evidenceEngine/documentTypes';
import type { EvidenceItem, RawChannelInput } from '../evidenceEngine/types';
import {
  buildOfflineAdmissionV2Report,
  evaluateOfflineAdmissionV2,
  type OfflineAdmissionCoverage,
  type OfflineAdmissionExample,
  type OfflineAdmissionGroundTruth,
  type OfflineAdmissionV2Decision
} from './offlineV2';
import { replayCreatorFocusFromDiagnostic } from './stage0AssertionReplay';

const OPERATOR_VISIBLE_CHANNEL_SQL = `country_status <> 'REJECTED'
  AND scan_status <> 'SKIPPED_EXCLUDED'
  AND trading_status <> 'NON_TRADING'
  AND NOT EXISTS (
    SELECT 1 FROM excluded_countries excluded
    WHERE lower(regexp_replace(trim(excluded.country_name), '\\s+', ' ', 'g')) =
      lower(regexp_replace(trim(channels.country), '\\s+', ' ', 'g'))
  )`;

const json = <T>(value: T | string | null | undefined): T => {
  if (value == null) return value as T;
  return typeof value === 'string' ? JSON.parse(value) as T : value;
};

const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function documentFromRow(row: any): EvidenceDocumentObservation {
  return {
    documentKey: String(row.document_key), canonicalDocumentId: String(row.canonical_document_id),
    subjectEntityId: String(row.subject_entity_id), channelId: String(row.channel_id),
    documentType: row.document_type, provider: String(row.provider),
    providerNativeId: row.provider_native_id || undefined, canonicalLocator: json(row.canonical_locator) || {},
    sourceFamilyId: String(row.source_family_id), sourceEntityId: row.source_entity_id || undefined,
    language: row.language || undefined, script: row.script || undefined, contentType: row.content_type || undefined,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : undefined,
    observedAt: new Date(row.observed_at).toISOString(), normalizedText: String(row.normalized_text || ''),
    textChecksum: String(row.text_checksum), rawPayloadChecksum: String(row.raw_payload_checksum),
    provenance: json(row.provenance) || {}, schemaVersion: String(row.schema_version)
  };
}

function coverageFromRow(row: any): EvidenceCoverageSnapshot {
  return {
    snapshotKey: String(row.coverage_snapshot_key), channelId: String(row.channel_id),
    subjectEntityId: String(row.coverage_subject_entity_id),
    classificationDiagnosticId: row.classification_diagnostic_id ? String(row.classification_diagnostic_id) : undefined,
    requestedSamplingStrategy: json(row.requested_sampling_strategy) || {},
    observedDocumentCounts: json(row.observed_document_counts) || {},
    temporalCoverage: json(row.temporal_coverage) || {}, languageCoverage: json(row.language_coverage) || {},
    independentFamilyCount: Number(row.independent_family_count) || 0,
    providerAvailability: json(row.provider_availability) || [], acquisitionFailures: json(row.acquisition_failures) || [],
    oldestDocumentAt: row.oldest_document_at ? new Date(row.oldest_document_at).toISOString() : undefined,
    latestDocumentAt: row.latest_document_at ? new Date(row.latest_document_at).toISOString() : undefined,
    expectedDocumentCount: Number(row.expected_document_count) || 0,
    observedDocumentCount: Number(row.observed_document_count) || 0,
    completenessDisposition: row.completeness_disposition,
    reasonCodes: json(row.coverage_reason_codes) || [], inputChecksum: String(row.coverage_input_checksum || ''),
    policyVersion: String(row.coverage_policy_version || ''), schemaVersion: String(row.coverage_schema_version || ''),
    observedAt: new Date(row.coverage_observed_at).toISOString()
  };
}

function languageFromCoverage(coverage: EvidenceCoverageSnapshot): string {
  const value = coverage.languageCoverage as any;
  if (typeof value.primary === 'string' && value.primary) return value.primary;
  if (typeof value.language === 'string' && value.language) return value.language;
  if (Array.isArray(value.languages) && value.languages[0]) return String(value.languages[0]);
  return 'UNKNOWN';
}

function replayInputGaps(row: any): string[] {
  const gaps: string[] = [];
  if (!row.classification_diagnostic_id) gaps.push('CLASSIFICATION_DIAGNOSTIC_LINK_MISSING');
  if (!row.coverage_snapshot_id) gaps.push('COVERAGE_SNAPSHOT_LINK_MISSING');
  if (!row.normalized_input) gaps.push('NORMALIZED_INPUT_MISSING');
  if (row.evidence_items == null) gaps.push('EVIDENCE_ITEMS_MISSING');
  if (!row.document_keys || (Array.isArray(row.document_keys) && row.document_keys.length === 0)) gaps.push('DOCUMENT_KEYS_MISSING');
  return gaps;
}

function increment(counts: Record<string, number>, key: string, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

export async function evaluateOperatorVisibleAssertionReplay(): Promise<Record<string, unknown>> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Stage 0 assertion replay.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const result = await db.query(`
      WITH visible AS (
        SELECT channel_id, channel_name, country, discovery_source, trading_status,
               COALESCE(trading_confidence_score,0)::float AS trading_confidence_score,
               COALESCE(trading_category,'General Trading') AS trading_category
          FROM channels WHERE ${OPERATOR_VISIBLE_CHANNEL_SQL}
      ), latest_focus AS (
        SELECT DISTINCT ON (f.channel_id) f.channel_id, f.classification_diagnostic_id,
               f.evidence_coverage_snapshot_id, f.document_keys, f.observed_at
          FROM creator_focus_classification_snapshots f
          JOIN visible v ON v.channel_id=f.channel_id
         ORDER BY f.channel_id, f.observed_at DESC, f.id DESC
      ), latest_review AS (
        SELECT DISTINCT ON (r.channel_id) r.channel_id, r.decision AS review_decision
          FROM channel_review_decisions r JOIN visible v ON v.channel_id=r.channel_id
         WHERE r.decision IN ('APPROVE','REJECT')
         ORDER BY r.channel_id, r.decided_at DESC, r.id DESC
      )
      SELECT v.*, lr.review_decision, lf.classification_diagnostic_id, lf.document_keys,
             d.normalized_input, d.evidence_items, d.created_at AS diagnostic_created_at,
             c.id AS coverage_snapshot_id, c.snapshot_key AS coverage_snapshot_key,
             c.subject_entity_id AS coverage_subject_entity_id, c.requested_sampling_strategy,
             c.observed_document_counts, c.temporal_coverage, c.language_coverage,
             c.independent_family_count, c.provider_availability, c.acquisition_failures,
             c.oldest_document_at, c.latest_document_at, c.expected_document_count,
             c.observed_document_count, c.completeness_disposition,
             c.reason_codes AS coverage_reason_codes, c.input_checksum AS coverage_input_checksum,
             c.policy_version AS coverage_policy_version, c.schema_version AS coverage_schema_version,
             c.observed_at AS coverage_observed_at,
             COALESCE((
               SELECT jsonb_agg(to_jsonb(ed) ORDER BY ed.document_key)
                 FROM evidence_documents ed
                WHERE ed.document_key IN (
                  SELECT jsonb_array_elements_text(COALESCE(lf.document_keys,'[]'::jsonb))
                )
             ), '[]'::jsonb) AS evidence_documents
        FROM visible v
        LEFT JOIN latest_focus lf ON lf.channel_id=v.channel_id
        LEFT JOIN production_classification_diagnostics d ON d.id=lf.classification_diagnostic_id
        LEFT JOIN evidence_coverage_snapshots c ON c.id=lf.evidence_coverage_snapshot_id
        LEFT JOIN latest_review lr ON lr.channel_id=v.channel_id
       ORDER BY v.channel_id`);
    await db.query('ROLLBACK');

    const rows: any[] = [];
    const labeledExamples: OfflineAdmissionExample[] = [];
    const excludedExamples: Array<{exampleKey:string;channelId:string;reasonCode:string}> = [];
    const decisionCounts: Record<OfflineAdmissionV2Decision, number> = { ADMIT_CONFIRMED:0, ADMIT_REVIEW:0, WITHHOLD:0, DEFER_INVESTIGATION:0 };
    const exclusionGapCounts: Record<string, number> = {};
    const projectionTotals: Record<string, number> = {
      evidenceItems: 0, positiveEvidenceItems: 0, negativeEvidenceItems: 0, abstentionEvidenceItems: 0,
      projectableEvidenceItems: 0, droppedNoRawMatches: 0, droppedNoSupportingDocument: 0, assertions: 0
    };
    const projectedTaxonomyTotals: Record<string, number> = {};
    const droppedTaxonomyTotals: Record<string, number> = {};

    for (const row of result.rows) {
      const channelId = String(row.channel_id);
      const exampleKey = `operator-visible-replay:${channelId}`;
      const inputGaps = replayInputGaps(row);
      if (inputGaps.length) {
        inputGaps.forEach(gap => increment(exclusionGapCounts, gap));
        excludedExamples.push({ exampleKey, channelId, reasonCode: 'REPLAY_INPUT_INCOMPLETE' });
        rows.push({ channelId, channelName: row.channel_name, exclusionReason: 'REPLAY_INPUT_INCOMPLETE', replayInputGaps: inputGaps });
        continue;
      }
      const coverage = coverageFromRow(row);
      const documents = (json<any[]>(row.evidence_documents) || []).map(documentFromRow);
      if (!documents.length) {
        increment(exclusionGapCounts, 'REPLAY_DOCUMENTS_MISSING');
        excludedExamples.push({ exampleKey, channelId, reasonCode: 'REPLAY_DOCUMENTS_MISSING' });
        rows.push({ channelId, channelName: row.channel_name, exclusionReason: 'REPLAY_DOCUMENTS_MISSING', replayInputGaps: ['REPLAY_DOCUMENTS_MISSING'] });
        continue;
      }
      const rawInput = json<RawChannelInput>(row.normalized_input);
      const evidenceItems = json<EvidenceItem[]>(row.evidence_items) || [];
      const replay = replayCreatorFocusFromDiagnostic({ channelId, rawInput, evidenceItems, documents, coverage });
      const diagnostics = replay.projectionDiagnostics;
      projectionTotals.evidenceItems += diagnostics.evidenceItemCount;
      projectionTotals.positiveEvidenceItems += diagnostics.positiveEvidenceItemCount;
      projectionTotals.negativeEvidenceItems += diagnostics.negativeEvidenceItemCount;
      projectionTotals.abstentionEvidenceItems += diagnostics.abstentionEvidenceItemCount;
      projectionTotals.projectableEvidenceItems += diagnostics.projectableEvidenceItemCount;
      projectionTotals.droppedNoRawMatches += diagnostics.droppedNoRawMatches;
      projectionTotals.droppedNoSupportingDocument += diagnostics.droppedNoSupportingDocument;
      projectionTotals.assertions += replay.assertionCount;
      Object.entries(diagnostics.projectedSemanticTaxonomyLabels).forEach(([key, value]) => increment(projectedTaxonomyTotals, key, value));
      Object.entries(diagnostics.droppedSemanticTaxonomyLabels).forEach(([key, value]) => increment(droppedTaxonomyTotals, key, value));

      const groundTruth: OfflineAdmissionGroundTruth | null = row.review_decision === 'APPROVE' ? 'TRADING_CONFIRMED'
        : row.review_decision === 'REJECT' ? 'NON_TRADING'
        : row.trading_status === 'TRADING_CONFIRMED' ? 'TRADING_CONFIRMED' : null;
      const offlineCoverage: OfflineAdmissionCoverage = {
        snapshotId: String(row.coverage_snapshot_id), disposition: coverage.completenessDisposition,
        observedDocumentCount: coverage.observedDocumentCount, expectedDocumentCount: coverage.expectedDocumentCount,
        independentFamilyCount: coverage.independentFamilyCount, languageCoverage: coverage.languageCoverage,
        temporalCoverage: coverage.temporalCoverage, providerAvailability: coverage.providerAvailability,
        acquisitionFailures: coverage.acquisitionFailures, reasonCodes: coverage.reasonCodes,
        inputChecksum: coverage.inputChecksum, policyVersion: coverage.policyVersion
      };
      const example: OfflineAdmissionExample = {
        exampleKey, channelId, split:'TEST', groundTruth: groundTruth || 'NON_TRADING', inclusionProbability:1,
        productionStatus:String(row.trading_status), productionScore:Number(row.trading_confidence_score)||0,
        segment:{ country:String(row.country||'UNKNOWN'), language:languageFromCoverage(coverage),
          discovery_source:String(row.discovery_source||'UNKNOWN'), trading_status:String(row.trading_status||'UNKNOWN'),
          trading_category:String(row.trading_category||'General Trading') },
        creatorFocusSnapshotId:`replay:${row.classification_diagnostic_id}`,
        creatorFocusInputChecksum:replay.inputChecksum,
        creatorFocusDistribution:replay.aggregate.distribution,
        creatorFocusProposedStatus:replay.decision.proposedStatus,
        creatorFocusProbability:replay.decision.probability,
        creatorFocusLowerConfidenceBound:replay.decision.lowerConfidenceBound,
        creatorFocusReasonCodes:replay.decision.reasonCodes,
        creatorFocusStageReport:{ stages: replay.decision.stages, historicalReplay:true, persisted:false },
        creatorFocusPolicyVersion:replay.decision.policyVersion, coverage:offlineCoverage
      };
      const admission = evaluateOfflineAdmissionV2(example);
      decisionCounts[admission.decision]++;
      if (groundTruth) labeledExamples.push({ ...example, groundTruth });
      rows.push({
        channelId, channelName:String(row.channel_name||''), country:String(row.country||'UNKNOWN'),
        discoverySource:String(row.discovery_source||'UNKNOWN'), tradingStatus:String(row.trading_status||'UNKNOWN'),
        productionScore:Number(row.trading_confidence_score)||0, tradingCategory:String(row.trading_category||'General Trading'),
        evidenceItemCount:diagnostics.evidenceItemCount, positiveEvidenceItemCount:diagnostics.positiveEvidenceItemCount,
        negativeEvidenceItemCount:diagnostics.negativeEvidenceItemCount, abstentionEvidenceItemCount:diagnostics.abstentionEvidenceItemCount,
        projectableEvidenceItemCount:diagnostics.projectableEvidenceItemCount, droppedNoRawMatches:diagnostics.droppedNoRawMatches,
        droppedNoSupportingDocument:diagnostics.droppedNoSupportingDocument,
        semanticTaxonomyLabels:diagnostics.semanticTaxonomyLabels,
        projectedSemanticTaxonomyLabels:diagnostics.projectedSemanticTaxonomyLabels,
        droppedSemanticTaxonomyLabels:diagnostics.droppedSemanticTaxonomyLabels,
        assertionCount:replay.assertionCount, tradingMass:replay.aggregate.tradingMass,
        alternativeMass:replay.aggregate.alternativeMass, lowerConfidenceBound:replay.aggregate.lowerConfidenceBound,
        creatorFocusProposedStatus:replay.decision.proposedStatus, decision:admission.decision,
        reasonCodes:admission.reasonCodes, futureDashboardVisible:['ADMIT_CONFIRMED','ADMIT_REVIEW'].includes(admission.decision),
        groundTruth, exclusionReason:null
      });
    }

    const labeledReport = labeledExamples.length ? buildOfflineAdmissionV2Report({
      dataset:{ id:'stage0-assertion-replay', key:'operator-visible-assertion-replay', version:1,
        cutoffAt:new Date().toISOString(), checksum:checksum(labeledExamples.map(e=>e.exampleKey).sort()) },
      examples:labeledExamples, excludedExamples
    }) : null;
    const evaluated = rows.filter(row=>!row.exclusionReason).length;
    const operatorVisible = result.rows.length;
    return {
      reportType:'STAGE0_OPERATOR_VISIBLE_ASSERTION_REPLAY', evidenceMode:'ASSERTION_REPLAY', historicalReplay:true,
      persisted:false, readOnly:true, servingAuthority:false, automaticPromotion:false,
      totals:{ operatorVisibleChannels:operatorVisible, evaluated, excluded:operatorVisible-evaluated,
        historicalEvidenceEligibilityRate:operatorVisible ? evaluated/operatorVisible : null, decisionCounts,
        projectedDashboardVisible:decisionCounts.ADMIT_CONFIRMED+decisionCounts.ADMIT_REVIEW,
        exclusionGapCounts, projectionTotals, projectedTaxonomyTotals, droppedTaxonomyTotals },
      labeledMetrics:labeledReport?.metrics || null, hypothesisAssessment:labeledReport?.hypothesisAssessment || null,
      rows,
      inputChecksum:checksum(rows.map(row=>({channelId:row.channelId,assertionCount:row.assertionCount,decision:row.decision,exclusionReason:row.exclusionReason})))
    };
  } catch (error) {
    await db.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
