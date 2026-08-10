import {
  evaluateSealedDatasetOfflineV2
} from './candidateAdmission/offlineV2Store';
import type { OfflineAdmissionV2Report } from './candidateAdmission/offlineV2';
import {
  CREATOR_FOCUS_CLASSIFIER_VERSION,
  CREATOR_FOCUS_POLICY_VERSION
} from './evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from './evidenceEngine/coverage';
import pg from 'pg';

export const PHASE_B_ADMISSION_V2_POC_VERSION = 'phase-b-admission-v2-poc-v1';

export interface PhaseBAdmissionV2PocVerificationSnapshot {
  datasetFound: boolean;
  datasetChecksumPresent: boolean;
  datasetKeyPresent: boolean;
  totalExamples: number;
  testExamples: number;
  calibrationExamples: number;
  testMissingCreatorFocus: number;
  testMissingCoverage: number;
  testMissingCoverageFocusLineage: number;
  testVersionMismatchedSnapshots: number;
  offlineReportGenerated: boolean;
  offlineServingAuthorityFalse: boolean;
  offlineAutomaticPromotionFalse: boolean;
  offlineGeneratedFromImmutableHistory: boolean;
  offlineInputChecksumPresent: boolean;
  offlineOutputChecksumPresent: boolean;
  offlineEvaluatedExamples: number;
  deterministicReplay: boolean;
  outputChecksumsMatch: boolean;
}

export interface PhaseBAdmissionV2PocCheck {
  code: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

export interface PhaseBAdmissionV2PocVerificationReport {
  version: string;
  ready: boolean;
  servingAuthority: false;
  automaticPromotion: false;
  checks: PhaseBAdmissionV2PocCheck[];
  reasonCodes: string[];
  metrics: PhaseBAdmissionV2PocVerificationSnapshot;
}

export interface PhaseBAdmissionV2PocResult {
  version: string;
  ready: boolean;
  servingAuthority: false;
  automaticPromotion: false;
  verification: PhaseBAdmissionV2PocVerificationReport;
  offlineReport: OfflineAdmissionV2Report;
  replay: {
    deterministic: boolean;
    firstOutputChecksum: string;
    secondOutputChecksum: string;
  };
  dataset: OfflineAdmissionV2Report['dataset'];
}

export function evaluatePhaseBAdmissionV2PocVerification(
  snapshot: PhaseBAdmissionV2PocVerificationSnapshot
): PhaseBAdmissionV2PocVerificationReport {
  const checks: PhaseBAdmissionV2PocCheck[] = [];
  const check = (code: string, passes: boolean, detail: string) =>
    checks.push({ code, status: passes ? 'PASS' : 'FAIL', detail });

  check('DATASET_FOUND', snapshot.datasetFound, 'Sealed evaluation dataset must exist.');
  check('DATASET_CHECKSUM', snapshot.datasetChecksumPresent, 'Dataset checksum must be present for membership integrity.');
  check('DATASET_KEY', snapshot.datasetKeyPresent, 'Dataset key must be present.');
  check('MEMBERSHIP_NONEMPTY', snapshot.totalExamples > 0, 'Sealed dataset must contain evaluation examples.');
  check('TEST_SPLIT_PRESENT', snapshot.testExamples > 0, 'Sealed dataset must contain a TEST split.');
  check('CALIBRATION_SPLIT_PRESENT', snapshot.calibrationExamples > 0, 'Sealed dataset should contain a CALIBRATION split for offline methodology.');
  check(
    'CREATOR_FOCUS_SNAPSHOTS_COMPLETE',
    snapshot.testMissingCreatorFocus === 0,
    snapshot.testMissingCreatorFocus
      ? `${snapshot.testMissingCreatorFocus} TEST examples missing Creator Focus snapshots.`
      : 'Every TEST example has a Creator Focus snapshot at exact policy/classifier versions.'
  );
  check(
    'COVERAGE_SNAPSHOTS_COMPLETE',
    snapshot.testMissingCoverage === 0,
    snapshot.testMissingCoverage
      ? `${snapshot.testMissingCoverage} TEST examples missing coverage snapshots.`
      : 'Every TEST example has an evidence coverage snapshot.'
  );
  check(
    'COVERAGE_FOCUS_LINEAGE_COMPLETE',
    snapshot.testMissingCoverageFocusLineage === 0,
    'Creator Focus snapshots on TEST examples must retain coverage lineage.'
  );
  check(
    'EXACT_VERSION_SNAPSHOTS',
    snapshot.testVersionMismatchedSnapshots === 0,
    'Creator Focus and coverage snapshots must match pinned classifier/policy/coverage versions.'
  );
  check('OFFLINE_REPORT_GENERATED', snapshot.offlineReportGenerated, 'Offline Admission V2 report must be generated from the sealed dataset.');
  check('OFFLINE_NON_AUTHORITATIVE', snapshot.offlineServingAuthorityFalse && snapshot.offlineAutomaticPromotionFalse, 'Offline report must declare zero serving and promotion authority.');
  check('OFFLINE_IMMUTABLE_HISTORY', snapshot.offlineGeneratedFromImmutableHistory, 'Offline report must be generated from immutable history only.');
  check('OFFLINE_INPUT_CHECKSUM', snapshot.offlineInputChecksumPresent, 'Offline report input checksum must be present for deterministic replay.');
  check('OFFLINE_OUTPUT_CHECKSUM', snapshot.offlineOutputChecksumPresent, 'Offline report output checksum must be present for deterministic replay.');
  check('OFFLINE_EVALUATED_EXAMPLES', snapshot.offlineEvaluatedExamples > 0, 'Offline evaluation must score at least one TEST example.');
  check('DETERMINISTIC_REPLAY', snapshot.deterministicReplay && snapshot.outputChecksumsMatch, 'Two offline evaluations of the same sealed dataset must yield identical output checksums.');

  const reasonCodes = checks.filter(item => item.status === 'FAIL').map(item => item.code);
  return {
    version: PHASE_B_ADMISSION_V2_POC_VERSION,
    ready: reasonCodes.length === 0,
    servingAuthority: false,
    automaticPromotion: false,
    checks,
    reasonCodes,
    metrics: snapshot
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function inspectSealedDatasetMembership(datasetId: string): Promise<{
  datasetFound: boolean;
  datasetChecksumPresent: boolean;
  datasetKeyPresent: boolean;
  totalExamples: number;
  testExamples: number;
  calibrationExamples: number;
  testMissingCreatorFocus: number;
  testMissingCoverage: number;
  testMissingCoverageFocusLineage: number;
  testVersionMismatchedSnapshots: number;
  dataset?: { id: string; key: string; version: number; cutoffAt: string; checksum: string };
}> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Phase B Admission V2 PoC verification.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const datasetResult = await db.query(
      `SELECT id, dataset_key, version, cutoff_at, checksum
         FROM decision_evaluation_datasets
        WHERE id = $1`,
      [datasetId]
    );
    if (!datasetResult.rowCount) {
      await db.query('ROLLBACK');
      return {
        datasetFound: false,
        datasetChecksumPresent: false,
        datasetKeyPresent: false,
        totalExamples: 0,
        testExamples: 0,
        calibrationExamples: 0,
        testMissingCreatorFocus: 0,
        testMissingCoverage: 0,
        testMissingCoverageFocusLineage: 0,
        testVersionMismatchedSnapshots: 0
      };
    }
    const datasetRow = datasetResult.rows[0];
    const membership = await db.query(
      `SELECT
         count(*)::int AS total_examples,
         count(*) FILTER (WHERE split = 'TEST')::int AS test_examples,
         count(*) FILTER (WHERE split = 'CALIBRATION')::int AS calibration_examples
       FROM decision_evaluation_examples
       WHERE dataset_id = $1`,
      [datasetId]
    );
    const lineage = await db.query(
      `SELECT
         count(*) FILTER (WHERE focus.id IS NULL)::int AS missing_focus,
         count(*) FILTER (WHERE coverage.id IS NULL)::int AS missing_coverage,
         count(*) FILTER (
           WHERE focus.id IS NOT NULL
             AND (focus.evidence_coverage_snapshot_id IS NULL)
         )::int AS missing_lineage,
         count(*) FILTER (
           WHERE focus.id IS NOT NULL
             AND (
               focus.classifier_version <> $3
               OR focus.policy_version <> $4
               OR coverage.policy_version IS DISTINCT FROM $5
             )
         )::int AS version_mismatched
       FROM decision_evaluation_examples e
       LEFT JOIN LATERAL (
         SELECT f.id, f.classifier_version, f.policy_version, f.evidence_coverage_snapshot_id
           FROM creator_focus_classification_snapshots f
          WHERE f.classification_diagnostic_id = e.decision_diagnostic_id
            AND f.observed_at <= $2
            AND f.classifier_version = $3
            AND f.policy_version = $4
          ORDER BY f.observed_at DESC, f.id DESC
          LIMIT 1
       ) focus ON true
       LEFT JOIN LATERAL (
         SELECT c.id, c.policy_version
           FROM evidence_coverage_snapshots c
          WHERE c.classification_diagnostic_id = e.decision_diagnostic_id
            AND c.observed_at <= $2
            AND c.policy_version = $5
          ORDER BY c.observed_at DESC, c.id DESC
          LIMIT 1
       ) coverage ON true
       WHERE e.dataset_id = $1 AND e.split = 'TEST'`,
      [
        datasetId,
        datasetRow.cutoff_at,
        CREATOR_FOCUS_CLASSIFIER_VERSION,
        CREATOR_FOCUS_POLICY_VERSION,
        EVIDENCE_COVERAGE_POLICY_VERSION
      ]
    );
    await db.query('ROLLBACK');
    const m = membership.rows[0] || {};
    const l = lineage.rows[0] || {};
    return {
      datasetFound: true,
      datasetChecksumPresent: !!datasetRow.checksum,
      datasetKeyPresent: !!datasetRow.dataset_key,
      totalExamples: Number(m.total_examples || 0),
      testExamples: Number(m.test_examples || 0),
      calibrationExamples: Number(m.calibration_examples || 0),
      testMissingCreatorFocus: Number(l.missing_focus || 0),
      testMissingCoverage: Number(l.missing_coverage || 0),
      testMissingCoverageFocusLineage: Number(l.missing_lineage || 0),
      testVersionMismatchedSnapshots: Number(l.version_mismatched || 0),
      dataset: {
        id: String(datasetRow.id),
        key: String(datasetRow.dataset_key),
        version: Number(datasetRow.version),
        cutoffAt: new Date(datasetRow.cutoff_at).toISOString(),
        checksum: String(datasetRow.checksum)
      }
    };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

/**
 * End-to-end Phase B PoC: verify sealed dataset integrity, run the existing
 * offline Admission V2 evaluator twice for deterministic replay, and emit a
 * non-authoritative verification report. Does not invent a parallel evaluator.
 */
export async function runPhaseBAdmissionV2Poc(datasetId: string): Promise<PhaseBAdmissionV2PocResult> {
  if (!UUID_RE.test(datasetId)) throw new Error('A sealed evaluation dataset UUID is required.');

  const membership = await inspectSealedDatasetMembership(datasetId);
  const first = await evaluateSealedDatasetOfflineV2(datasetId);
  const second = await evaluateSealedDatasetOfflineV2(datasetId);
  const deterministic = first.outputChecksum === second.outputChecksum && first.inputChecksum === second.inputChecksum;

  const snapshot: PhaseBAdmissionV2PocVerificationSnapshot = {
    datasetFound: membership.datasetFound,
    datasetChecksumPresent: membership.datasetChecksumPresent,
    datasetKeyPresent: membership.datasetKeyPresent,
    totalExamples: membership.totalExamples,
    testExamples: membership.testExamples,
    calibrationExamples: membership.calibrationExamples,
    testMissingCreatorFocus: membership.testMissingCreatorFocus,
    testMissingCoverage: membership.testMissingCoverage,
    testMissingCoverageFocusLineage: membership.testMissingCoverageFocusLineage,
    testVersionMismatchedSnapshots: membership.testVersionMismatchedSnapshots,
    offlineReportGenerated: !!first,
    offlineServingAuthorityFalse: first.servingAuthority === false,
    offlineAutomaticPromotionFalse: first.automaticPromotion === false,
    offlineGeneratedFromImmutableHistory: first.generatedFromImmutableHistory === true,
    offlineInputChecksumPresent: !!first.inputChecksum,
    offlineOutputChecksumPresent: !!first.outputChecksum,
    offlineEvaluatedExamples: first.evaluatedExamples,
    deterministicReplay: deterministic,
    outputChecksumsMatch: first.outputChecksum === second.outputChecksum
  };

  const verification = evaluatePhaseBAdmissionV2PocVerification(snapshot);
  return {
    version: PHASE_B_ADMISSION_V2_POC_VERSION,
    ready: verification.ready,
    servingAuthority: false,
    automaticPromotion: false,
    verification,
    offlineReport: first,
    replay: {
      deterministic,
      firstOutputChecksum: first.outputChecksum,
      secondOutputChecksum: second.outputChecksum
    },
    dataset: first.dataset
  };
}
