import { createHash } from 'node:crypto';
import pg from 'pg';
import { getAppSetting, getDb } from './db';
import { evaluationChecksum } from './decisionEvaluation';
import {
  CREATOR_FOCUS_CLASSIFIER_VERSION,
  CREATOR_FOCUS_POLICY_VERSION
} from './evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from './evidenceEngine/coverage';
import { EVIDENCE_DUAL_WRITE_VERSION } from './evidenceEngine/dualWrite';
import { PHASE_B_SHADOW_POLICY_VERSION } from './phaseBShadow';

export const PHASE_B_COLLECTION_EPOCH_VERSION = 'phase-b-collection-epoch-v1';
export const PHASE_B_DEFAULT_MINIMUM_BUNDLE_AVAILABILITY_BPS = 9000;

export interface PhaseBCollectionEpochGateSnapshot {
  validationStatus?: string;
  validationRunId?: string;
  assertionsEnabled: boolean;
  assertionActivationHasPassingValidation: boolean;
  documentsEnabled: boolean;
  samplingEnabled: boolean;
  creatorFocusMode: string;
  creatorFocusCanaryBasisPoints: number;
  gapSpecificMode: string;
  advisoryMode: string;
  protectedAuditPolicyApproved: boolean;
  samplingSaltFingerprint: string;
  invalidCreatorFocusEffectiveStatusCount: number;
}

export interface PhaseBCollectionEpochCheck {
  code: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

export interface PhaseBCollectionEpochGateReport {
  version: string;
  ready: boolean;
  servingAuthority: false;
  automaticPromotion: false;
  checks: PhaseBCollectionEpochCheck[];
  checksum: string;
}

export interface PhaseBBundleAvailabilityMetrics {
  diagnostics: number;
  withCoverage: number;
  withCreatorFocus: number;
  withCoverageFocusLineage: number;
  completeBundles: number;
  availabilityBasisPoints: number;
}

export interface PhaseBBundleAvailabilityReport {
  version: string;
  windowStart: string;
  cutoffAt: string;
  ready: boolean;
  servingAuthority: false;
  minimumAvailabilityBasisPoints: number;
  metrics: PhaseBBundleAvailabilityMetrics;
  reasonCodes: string[];
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  );

const checksum = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const normalized = (value: string | undefined): string => String(value || '').trim().toUpperCase();

export function fingerprintSamplingSalt(salt: string | undefined): string {
  const value = String(salt || '');
  if (!value.trim()) return '';
  return createHash('sha256').update(`phase-b-sampling-salt:${value}`).digest('hex');
}

export function evaluatePhaseBCollectionEpochGate(snapshot: PhaseBCollectionEpochGateSnapshot): PhaseBCollectionEpochGateReport {
  const checks: PhaseBCollectionEpochCheck[] = [];
  const check = (code: string, passes: boolean, detail: string) =>
    checks.push({ code, status: passes ? 'PASS' : 'FAIL', detail });

  check('PASSING_DOCUMENT_VALIDATION', snapshot.validationStatus === 'PASS' && !!snapshot.validationRunId, 'A PASS document-projection validation run is required.');
  check('DOCUMENTS_ENABLED', snapshot.documentsEnabled, 'Evidence document dual-write must be enabled.');
  check('SAMPLING_ENABLED', snapshot.samplingEnabled, 'Evaluation sampling must be enabled.');
  check('ASSERTIONS_ENABLED', snapshot.assertionsEnabled, 'Assertion dual-write must be enabled before the collection epoch.');
  check('ASSERTION_ACTIVATION_GOVERNED', snapshot.assertionActivationHasPassingValidation, 'Assertion activation must be linked to a PASS validation run.');
  check('CREATOR_FOCUS_SHADOW_ONLY', normalized(snapshot.creatorFocusMode) === 'SHADOW', 'Creator Focus must be SHADOW for the collection epoch.');
  check('CREATOR_FOCUS_CANARY_DISABLED', snapshot.creatorFocusCanaryBasisPoints === 0, 'Creator Focus canary allocation must remain zero.');
  check('INVESTIGATION_AUTHORITY_DISABLED', normalized(snapshot.gapSpecificMode) === 'OFF', 'Gap-specific investigation scheduling must remain OFF.');
  check('ADVISORY_AUTHORITY_DISABLED', normalized(snapshot.advisoryMode) === 'OFF', 'Creator Focus serving advisory must remain OFF.');
  check('PROTECTED_AUDIT_POLICY', snapshot.protectedAuditPolicyApproved, 'The protected-audit sampling policy must be approved.');
  check('SAMPLING_SALT_PINNED', !!snapshot.samplingSaltFingerprint, 'A non-empty sampling salt fingerprint is required for the epoch pin.');
  check('EFFECTIVE_STATUS_NON_AUTHORITATIVE', snapshot.invalidCreatorFocusEffectiveStatusCount === 0, 'Every Creator Focus snapshot must retain effective_status UNCERTAIN.');

  const unsigned = {
    version: PHASE_B_COLLECTION_EPOCH_VERSION,
    ready: checks.every(item => item.status === 'PASS'),
    servingAuthority: false as const,
    automaticPromotion: false as const,
    checks
  };
  return { ...unsigned, checksum: checksum(unsigned) };
}

export function buildPhaseBBundleAvailabilityReport(input: {
  windowStart: string;
  cutoffAt: string;
  metrics: Omit<PhaseBBundleAvailabilityMetrics, 'availabilityBasisPoints'>;
  minimumAvailabilityBasisPoints?: number;
}): PhaseBBundleAvailabilityReport {
  const minimum = input.minimumAvailabilityBasisPoints ?? PHASE_B_DEFAULT_MINIMUM_BUNDLE_AVAILABILITY_BPS;
  const availabilityBasisPoints = input.metrics.diagnostics
    ? Math.floor((input.metrics.completeBundles * 10000) / input.metrics.diagnostics)
    : 0;
  const metrics: PhaseBBundleAvailabilityMetrics = { ...input.metrics, availabilityBasisPoints };
  const reasonCodes: string[] = [];
  if (!metrics.diagnostics) reasonCodes.push('INSUFFICIENT_DIAGNOSTICS');
  if (metrics.availabilityBasisPoints < minimum) reasonCodes.push('BUNDLE_AVAILABILITY_BELOW_FLOOR');
  if (metrics.withCoverage < metrics.diagnostics) reasonCodes.push('COVERAGE_SNAPSHOT_GAPS');
  if (metrics.withCreatorFocus < metrics.diagnostics) reasonCodes.push('CREATOR_FOCUS_SNAPSHOT_GAPS');
  if (metrics.withCoverageFocusLineage < metrics.diagnostics) reasonCodes.push('COVERAGE_FOCUS_LINEAGE_GAPS');
  return {
    version: PHASE_B_COLLECTION_EPOCH_VERSION,
    windowStart: input.windowStart,
    cutoffAt: input.cutoffAt,
    ready: reasonCodes.length === 0,
    servingAuthority: false,
    minimumAvailabilityBasisPoints: minimum,
    metrics,
    reasonCodes
  };
}

export function collectionEpochKey(input: {
  validationRunId: string;
  startedAt: string;
  samplingPolicyKey: string;
  samplingPolicyVersion: number;
  samplingSaltFingerprint: string;
  coveragePolicyVersion: string;
  creatorFocusPolicyVersion: string;
  classifierVersion: string;
}): string {
  return `phase-b:epoch:${checksum({ version: PHASE_B_COLLECTION_EPOCH_VERSION, ...input })}`;
}

export async function declarePhaseBCollectionEpoch(input: {
  validationRunId: string;
  actor: string;
  reason: string;
  startedAt?: string;
  minimumBundleAvailabilityBps?: number;
}): Promise<{
  epochKey: string;
  startedAt: string;
  servingAuthority: false;
  automaticPromotion: false;
  pinned: Record<string, string | number | boolean>;
}> {
  if (!input.actor.trim() || !input.reason.trim()) throw new Error('ACTOR_AND_REASON_REQUIRED');
  if (!input.validationRunId.trim()) throw new Error('VALIDATION_RUN_ID_REQUIRED');
  const startedAt = input.startedAt || new Date().toISOString();
  if (!Number.isFinite(new Date(startedAt).getTime())) throw new Error('INVALID_EPOCH_START');

  const saltFingerprint = fingerprintSamplingSalt(process.env.DECISION_EVALUATION_SAMPLING_SALT);
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const validation = await client.query(
      `SELECT id, status FROM evidence_projection_validation_runs WHERE id=$1 FOR SHARE`,
      [input.validationRunId]
    );
    const settings = await client.query(
      `SELECT setting_key, setting_value FROM app_settings
        WHERE setting_key = ANY($1::text[])`,
      [[
        'evidence_assertion_dual_write_enabled',
        'evidence_document_dual_write_enabled',
        'decision_evaluation_sampling_enabled',
        'creator_focus_classifier_mode',
        'creator_focus_classifier_canary_basis_points',
        'gap_specific_scheduler_mode',
        'release5_creator_focus_advisory_mode'
      ]]
    );
    const settingMap = Object.fromEntries(settings.rows.map(row => [String(row.setting_key), String(row.setting_value)]));
    const assertionActivation = await client.query(
      `SELECT 1
         FROM phase_b_shadow_control_events e
         JOIN evidence_projection_validation_runs v ON v.id = e.validation_run_id
        WHERE e.control = 'EVIDENCE_ASSERTIONS'
          AND e.resulting_value = 'true'
          AND v.status = 'PASS'
        LIMIT 1`
    );
    const protectedAudit = await client.query(
      `SELECT 1 FROM evaluation_sampling_policies
        WHERE policy_key='protected-audit' AND version=1 AND status='APPROVED' LIMIT 1`
    );
    const invalidFocus = await client.query(
      `SELECT count(*)::int AS count FROM creator_focus_classification_snapshots WHERE effective_status <> 'UNCERTAIN'`
    );
    const existing = await client.query(`SELECT epoch_key FROM phase_b_collection_epochs ORDER BY started_at DESC, created_at DESC LIMIT 1`);

    const gate = evaluatePhaseBCollectionEpochGate({
      validationStatus: validation.rows[0]?.status,
      validationRunId: validation.rows[0]?.id ? String(validation.rows[0].id) : undefined,
      assertionsEnabled: settingMap.evidence_assertion_dual_write_enabled === 'true',
      assertionActivationHasPassingValidation: !!assertionActivation.rowCount,
      documentsEnabled: settingMap.evidence_document_dual_write_enabled === 'true',
      samplingEnabled: settingMap.decision_evaluation_sampling_enabled === 'true',
      creatorFocusMode: settingMap.creator_focus_classifier_mode || 'OFF',
      creatorFocusCanaryBasisPoints: Number(settingMap.creator_focus_classifier_canary_basis_points || 0),
      gapSpecificMode: settingMap.gap_specific_scheduler_mode || 'OFF',
      advisoryMode: settingMap.release5_creator_focus_advisory_mode || 'OFF',
      protectedAuditPolicyApproved: !!protectedAudit.rowCount,
      samplingSaltFingerprint: saltFingerprint,
      invalidCreatorFocusEffectiveStatusCount: Number(invalidFocus.rows[0]?.count || 0)
    });
    if (!gate.ready) {
      throw new Error(`COLLECTION_EPOCH_GATE_FAILED:${gate.checks.filter(c => c.status === 'FAIL').map(c => c.code).join(',')}`);
    }

    const pinned = {
      samplingPolicyKey: 'protected-audit',
      samplingPolicyVersion: 1,
      samplingSaltFingerprint: saltFingerprint,
      coveragePolicyVersion: EVIDENCE_COVERAGE_POLICY_VERSION,
      creatorFocusPolicyVersion: CREATOR_FOCUS_POLICY_VERSION,
      classifierVersion: CREATOR_FOCUS_CLASSIFIER_VERSION,
      shadowPolicyVersion: PHASE_B_SHADOW_POLICY_VERSION,
      dualWriteVersion: EVIDENCE_DUAL_WRITE_VERSION
    };
    const epochKey = collectionEpochKey({
      validationRunId: input.validationRunId,
      startedAt,
      samplingPolicyKey: pinned.samplingPolicyKey,
      samplingPolicyVersion: pinned.samplingPolicyVersion,
      samplingSaltFingerprint: pinned.samplingSaltFingerprint,
      coveragePolicyVersion: pinned.coveragePolicyVersion,
      creatorFocusPolicyVersion: pinned.creatorFocusPolicyVersion,
      classifierVersion: pinned.classifierVersion
    });
    const definition = {
      version: PHASE_B_COLLECTION_EPOCH_VERSION,
      gateChecksum: gate.checksum,
      pinned,
      servingAuthority: false,
      automaticPromotion: false
    };
    if (existing.rows[0]?.epoch_key && String(existing.rows[0].epoch_key) !== epochKey) {
      throw new Error(`COLLECTION_EPOCH_ALREADY_DECLARED:${existing.rows[0].epoch_key}`);
    }
    if (existing.rows[0]?.epoch_key && String(existing.rows[0].epoch_key) === epochKey) {
      await client.query('COMMIT');
      return {
        epochKey,
        startedAt,
        servingAuthority: false,
        automaticPromotion: false,
        pinned
      };
    }
    await client.query(
      `INSERT INTO phase_b_collection_epochs(
         epoch_key, validation_run_id, started_at, sampling_policy_key, sampling_policy_version,
         sampling_salt_fingerprint, coverage_policy_version, creator_focus_policy_version, classifier_version,
         shadow_policy_version, dual_write_version, assertion_dual_write_enabled, creator_focus_mode,
         serving_authority, automatic_promotion, minimum_bundle_availability_bps, declared_by, reason, definition
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,'SHADOW',false,false,$12,$13,$14,$15)
       ON CONFLICT (epoch_key) DO NOTHING`,
      [
        epochKey,
        input.validationRunId,
        startedAt,
        pinned.samplingPolicyKey,
        pinned.samplingPolicyVersion,
        pinned.samplingSaltFingerprint,
        pinned.coveragePolicyVersion,
        pinned.creatorFocusPolicyVersion,
        pinned.classifierVersion,
        pinned.shadowPolicyVersion,
        pinned.dualWriteVersion,
        input.minimumBundleAvailabilityBps ?? PHASE_B_DEFAULT_MINIMUM_BUNDLE_AVAILABILITY_BPS,
        input.actor,
        input.reason,
        JSON.stringify(definition)
      ]
    );
    const eventKey = evaluationChecksum({
      control: 'COLLECTION_EPOCH',
      epochKey,
      validationRunId: input.validationRunId,
      policy: PHASE_B_SHADOW_POLICY_VERSION
    });
    await client.query(
      `INSERT INTO phase_b_shadow_control_events(event_key, control, prior_value, resulting_value, reason, changed_by, policy_version, validation_run_id)
       VALUES ($1,'COLLECTION_EPOCH','UNDECLARED',$2,$3,$4,$5,$6)
       ON CONFLICT (event_key) DO NOTHING`,
      [eventKey, epochKey, input.reason, input.actor, PHASE_B_SHADOW_POLICY_VERSION, input.validationRunId]
    );
    await client.query('COMMIT');
    return {
      epochKey,
      startedAt,
      servingAuthority: false,
      automaticPromotion: false,
      pinned
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function inspectPhaseBBundleAvailability(input: {
  windowStart: string;
  cutoffAt: string;
  minimumAvailabilityBasisPoints?: number;
}): Promise<PhaseBBundleAvailabilityReport> {
  const start = new Date(input.windowStart);
  const cutoff = new Date(input.cutoffAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(cutoff.getTime()) || start >= cutoff) {
    throw new Error('INVALID_BUNDLE_AVAILABILITY_WINDOW');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Phase B bundle availability inspection.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const result = await db.query(
      `WITH diagnostics AS (
         SELECT id FROM production_classification_diagnostics WHERE created_at >= $1 AND created_at < $2
       )
       SELECT count(*)::int diagnostics,
              count(*) FILTER (WHERE c.id IS NOT NULL)::int with_coverage,
              count(*) FILTER (WHERE f.id IS NOT NULL)::int with_creator_focus,
              count(*) FILTER (WHERE f.evidence_coverage_snapshot_id IS NOT NULL)::int with_coverage_focus_lineage,
              count(*) FILTER (
                WHERE c.id IS NOT NULL
                  AND f.id IS NOT NULL
                  AND f.evidence_coverage_snapshot_id IS NOT NULL
                  AND f.effective_status = 'UNCERTAIN'
              )::int complete_bundles
         FROM diagnostics d
         LEFT JOIN evidence_coverage_snapshots c ON c.classification_diagnostic_id = d.id
         LEFT JOIN creator_focus_classification_snapshots f ON f.classification_diagnostic_id = d.id`,
      [input.windowStart, input.cutoffAt]
    );
    const row = result.rows[0] || {};
    const report = buildPhaseBBundleAvailabilityReport({
      windowStart: input.windowStart,
      cutoffAt: input.cutoffAt,
      minimumAvailabilityBasisPoints: input.minimumAvailabilityBasisPoints,
      metrics: {
        diagnostics: Number(row.diagnostics || 0),
        withCoverage: Number(row.with_coverage || 0),
        withCreatorFocus: Number(row.with_creator_focus || 0),
        withCoverageFocusLineage: Number(row.with_coverage_focus_lineage || 0),
        completeBundles: Number(row.complete_bundles || 0)
      }
    });
    await db.query('ROLLBACK');
    return report;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

export async function inspectActivePhaseBCollectionEpoch(): Promise<{
  declared: boolean;
  servingAuthority: false;
  automaticPromotion: false;
  epoch?: Record<string, unknown>;
}> {
  const db = await getDb();
  const result = await db.query(
    `SELECT epoch_key, validation_run_id, started_at, sampling_policy_key, sampling_policy_version,
            sampling_salt_fingerprint, coverage_policy_version, creator_focus_policy_version,
            classifier_version, shadow_policy_version, dual_write_version, assertion_dual_write_enabled,
            creator_focus_mode, serving_authority, automatic_promotion, minimum_bundle_availability_bps,
            declared_by, reason, definition, created_at
       FROM phase_b_collection_epochs
      ORDER BY started_at DESC, created_at DESC
      LIMIT 1`
  );
  if (!result.rowCount) {
    return { declared: false, servingAuthority: false, automaticPromotion: false };
  }
  const row = result.rows[0];
  return {
    declared: true,
    servingAuthority: false,
    automaticPromotion: false,
    epoch: {
      epochKey: row.epoch_key,
      validationRunId: row.validation_run_id,
      startedAt: row.started_at,
      samplingPolicyKey: row.sampling_policy_key,
      samplingPolicyVersion: row.sampling_policy_version,
      samplingSaltFingerprint: row.sampling_salt_fingerprint,
      coveragePolicyVersion: row.coverage_policy_version,
      creatorFocusPolicyVersion: row.creator_focus_policy_version,
      classifierVersion: row.classifier_version,
      shadowPolicyVersion: row.shadow_policy_version,
      dualWriteVersion: row.dual_write_version,
      assertionDualWriteEnabled: row.assertion_dual_write_enabled,
      creatorFocusMode: row.creator_focus_mode,
      minimumBundleAvailabilityBps: row.minimum_bundle_availability_bps,
      declaredBy: row.declared_by,
      reason: row.reason,
      definition: row.definition,
      createdAt: row.created_at
    }
  };
}
