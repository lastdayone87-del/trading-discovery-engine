import { createHash } from 'node:crypto';
import pg from 'pg';
import { CREATOR_FOCUS_POLICY_VERSION } from './evidenceEngine/classifierV4';

export const PHASE_B_HISTORY_READINESS_VERSION = 'phase-b-history-readiness-v1';
export const PHASE_B_REQUIRED_MIGRATIONS = [36, 37, 55, 56, 57, 63] as const;
export const PHASE_B_REQUIRED_TABLES = [
  'production_classification_diagnostics',
  'evaluation_sampling_policies',
  'evaluation_cohort_assignments',
  'evaluation_ground_truth_labels',
  'decision_evaluation_datasets',
  'decision_evaluation_examples',
  'evidence_documents',
  'classification_evidence_assertions',
  'evidence_coverage_snapshots',
  'creator_focus_policy_versions',
  'creator_focus_classification_snapshots',
  'creator_type_adjudications',
  'evidence_projection_observations',
  'evidence_projection_validation_runs',
  'phase_b_shadow_control_events'
] as const;

export const PHASE_B_REQUIRED_IMMUTABLE_TABLES = [
  'production_classification_diagnostics',
  'evaluation_sampling_policies',
  'evaluation_cohort_assignments',
  'evaluation_ground_truth_labels',
  'decision_evaluation_datasets',
  'decision_evaluation_examples',
  'evidence_documents',
  'classification_evidence_assertions',
  'evidence_coverage_snapshots',
  'creator_focus_policy_versions',
  'creator_focus_classification_snapshots',
  'creator_type_adjudications',
  'evidence_projection_observations',
  'evidence_projection_validation_runs',
  'phase_b_shadow_control_events'
] as const;

export const PHASE_B_REQUIRED_SETTINGS = [
  'decision_evaluation_sampling_enabled',
  'evidence_document_dual_write_enabled',
  'evidence_assertion_dual_write_enabled',
  'creator_focus_classifier_mode',
  'creator_focus_classifier_canary_basis_points',
  'gap_specific_scheduler_mode',
  'release5_creator_focus_advisory_mode'
] as const;

export interface PhaseBHistoryReadinessSnapshot {
  transactionReadOnly: boolean;
  migrations: number[];
  tables: string[];
  immutableTables: string[];
  settings: Record<string, string>;
  protectedAuditPolicyApproved: boolean;
  creatorFocusPolicyPresent: boolean;
  invalidCreatorFocusEffectiveStatusCount: number;
  assertionActivationHasPassingValidation: boolean;
}

export interface PhaseBHistoryReadinessCheck {
  code: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

export interface PhaseBHistoryReadinessReport {
  version: string;
  ready: boolean;
  authorityPreserved: true;
  servingAuthority: false;
  automaticPromotion: false;
  checks: PhaseBHistoryReadinessCheck[];
  checksum: string;
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item
);

const checksum = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const normalized = (value: string | undefined): string => String(value || '').trim().toUpperCase();
const booleanSetting = (value: string | undefined): boolean => ['TRUE', 'FALSE'].includes(normalized(value));

export function evaluatePhaseBHistoryReadiness(snapshot: PhaseBHistoryReadinessSnapshot): PhaseBHistoryReadinessReport {
  const checks: PhaseBHistoryReadinessCheck[] = [];
  const check = (code: string, passes: boolean, detail: string) => checks.push({ code, status: passes ? 'PASS' : 'FAIL', detail });
  const migrationSet = new Set(snapshot.migrations);
  const tableSet = new Set(snapshot.tables);
  const immutableSet = new Set(snapshot.immutableTables);
  const missingMigrations = PHASE_B_REQUIRED_MIGRATIONS.filter(version => !migrationSet.has(version));
  const missingTables = PHASE_B_REQUIRED_TABLES.filter(table => !tableSet.has(table));
  const mutableTables = PHASE_B_REQUIRED_IMMUTABLE_TABLES.filter(table => !immutableSet.has(table));
  const missingSettings = PHASE_B_REQUIRED_SETTINGS.filter(key => !(key in snapshot.settings));

  check('READ_ONLY_INSPECTION', snapshot.transactionReadOnly, 'Readiness inspection must execute in a read-only transaction.');
  check('REQUIRED_MIGRATIONS', !missingMigrations.length, missingMigrations.length ? `Missing migrations: ${missingMigrations.join(', ')}` : 'All required migrations are recorded.');
  check('REQUIRED_TABLES', !missingTables.length, missingTables.length ? `Missing tables: ${missingTables.join(', ')}` : 'All required Phase B tables exist.');
  check('IMMUTABLE_HISTORY', !mutableTables.length, mutableTables.length ? `Tables missing immutable UPDATE/DELETE triggers: ${mutableTables.join(', ')}` : 'All Phase B history tables reject UPDATE and DELETE.');
  check('REQUIRED_CONTROLS', !missingSettings.length, missingSettings.length ? `Missing controls: ${missingSettings.join(', ')}` : 'All Phase B controls are present.');
  check('SAMPLING_CONTROL_VALUE', booleanSetting(snapshot.settings.decision_evaluation_sampling_enabled), 'Evaluation sampling is independently boolean-controlled.');
  check('DOCUMENT_CONTROL_VALUE', booleanSetting(snapshot.settings.evidence_document_dual_write_enabled), 'Evidence document dual-write is independently boolean-controlled.');
  check('ASSERTION_CONTROL_VALUE', booleanSetting(snapshot.settings.evidence_assertion_dual_write_enabled), 'Evidence assertion dual-write is independently boolean-controlled.');
  check('CREATOR_FOCUS_SHADOW_ONLY', ['OFF', 'SHADOW'].includes(normalized(snapshot.settings.creator_focus_classifier_mode)), 'Creator Focus collection may only be OFF or SHADOW.');
  check('CREATOR_FOCUS_CANARY_DISABLED', Number(snapshot.settings.creator_focus_classifier_canary_basis_points) === 0, 'Creator Focus canary allocation must remain zero.');
  check('INVESTIGATION_AUTHORITY_DISABLED', normalized(snapshot.settings.gap_specific_scheduler_mode) === 'OFF', 'Gap-specific investigation scheduling must remain OFF.');
  check('ADVISORY_AUTHORITY_DISABLED', normalized(snapshot.settings.release5_creator_focus_advisory_mode) === 'OFF', 'Creator Focus serving advisory must remain OFF.');
  check('PROTECTED_AUDIT_POLICY', snapshot.protectedAuditPolicyApproved, 'The propensity-bearing protected-audit sampling policy must be approved.');
  check('CREATOR_FOCUS_POLICY', snapshot.creatorFocusPolicyPresent, `Creator Focus policy ${CREATOR_FOCUS_POLICY_VERSION} must be present.`);
  check('EFFECTIVE_STATUS_NON_AUTHORITATIVE', snapshot.invalidCreatorFocusEffectiveStatusCount === 0, 'Every Creator Focus snapshot must retain effective_status UNCERTAIN.');
  const assertionsEnabled = normalized(snapshot.settings.evidence_assertion_dual_write_enabled) === 'TRUE';
  check('ASSERTION_ACTIVATION_GOVERNED', !assertionsEnabled || snapshot.assertionActivationHasPassingValidation, 'Enabled assertions require an immutable activation event linked to a PASS validation run.');

  const unsigned = {
    version: PHASE_B_HISTORY_READINESS_VERSION,
    ready: checks.every(item => item.status === 'PASS'),
    authorityPreserved: true as const,
    servingAuthority: false as const,
    automaticPromotion: false as const,
    checks
  };
  return { ...unsigned, checksum: checksum(unsigned) };
}

export async function inspectPhaseBHistoryReadiness(): Promise<PhaseBHistoryReadinessReport> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Phase B history readiness inspection.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const readOnly = await db.query("SELECT current_setting('transaction_read_only') value");
    const migrations = await db.query('SELECT version FROM schema_migrations WHERE version=ANY($1::int[]) ORDER BY version', [[...PHASE_B_REQUIRED_MIGRATIONS]]);
    const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name`, [[...PHASE_B_REQUIRED_TABLES]]);
    const existingTables = new Set(tables.rows.map(row => String(row.table_name)));
    const settings = await db.query('SELECT setting_key,setting_value FROM app_settings WHERE setting_key=ANY($1::text[]) ORDER BY setting_key', [[...PHASE_B_REQUIRED_SETTINGS]]);
    const immutable = await db.query(`SELECT DISTINCT c.relname table_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname=ANY($1::text[]) AND (t.tgtype & 2)=2 AND (t.tgtype & 8)=8 AND (t.tgtype & 16)=16 ORDER BY c.relname`, [[...PHASE_B_REQUIRED_IMMUTABLE_TABLES]]);

    let protectedAuditPolicyApproved = false;
    let creatorFocusPolicyPresent = false;
    let invalidCreatorFocusEffectiveStatusCount = 0;
    let assertionActivationHasPassingValidation = false;
    if (existingTables.has('evaluation_sampling_policies')) {
      protectedAuditPolicyApproved = !!(await db.query(`SELECT 1 FROM evaluation_sampling_policies WHERE policy_key='protected-audit' AND version=1 AND status='APPROVED' LIMIT 1`)).rowCount;
    }
    if (existingTables.has('creator_focus_policy_versions')) {
      creatorFocusPolicyPresent = !!(await db.query('SELECT 1 FROM creator_focus_policy_versions WHERE definition_checksum=$1 LIMIT 1', [CREATOR_FOCUS_POLICY_VERSION])).rowCount;
    }
    if (existingTables.has('creator_focus_classification_snapshots')) {
      invalidCreatorFocusEffectiveStatusCount = Number((await db.query(`SELECT count(*)::int count FROM creator_focus_classification_snapshots WHERE effective_status<>'UNCERTAIN'`)).rows[0]?.count || 0);
    }
    if (existingTables.has('phase_b_shadow_control_events') && existingTables.has('evidence_projection_validation_runs')) {
      assertionActivationHasPassingValidation = !!(await db.query(`SELECT 1 FROM phase_b_shadow_control_events e JOIN evidence_projection_validation_runs v ON v.id=e.validation_run_id WHERE e.control='EVIDENCE_ASSERTIONS' AND e.resulting_value='true' AND v.status='PASS' LIMIT 1`)).rowCount;
    }

    const report = evaluatePhaseBHistoryReadiness({
      transactionReadOnly: readOnly.rows[0]?.value === 'on',
      migrations: migrations.rows.map(row => Number(row.version)),
      tables: [...existingTables],
      immutableTables: immutable.rows.map(row => String(row.table_name)),
      settings: Object.fromEntries(settings.rows.map(row => [String(row.setting_key), String(row.setting_value)])),
      protectedAuditPolicyApproved,
      creatorFocusPolicyPresent,
      invalidCreatorFocusEffectiveStatusCount,
      assertionActivationHasPassingValidation
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
