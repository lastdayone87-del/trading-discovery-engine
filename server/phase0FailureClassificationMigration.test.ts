import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migrationName = '163_job_attempt_failure_classification.sql';
const migration = readFileSync(`${migrationsDir}${migrationName}`, 'utf8');
const withoutSqlComments = migration
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');
const dbSource = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
const telemetrySource = readFileSync(new URL('./operationsTelemetry.ts', import.meta.url), 'utf8');
const queueSource = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');

test('migration 163 is present and sorts after migration 162', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('162_job_clock_and_capacity_lease.sql'));
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('162_job_clock_and_capacity_lease.sql'));
});

test('migration 163 adds four nullable shadow columns and NOT VALID value checks', () => {
  const statements = withoutSqlComments
    .split(';')
    .map(statement => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  assert.deepEqual(statements, [
    "SET LOCAL lock_timeout = '10s'",
    'ALTER TABLE public.job_attempts ADD COLUMN IF NOT EXISTS failure_class TEXT, '
      + 'ADD COLUMN IF NOT EXISTS failure_reason TEXT, '
      + 'ADD COLUMN IF NOT EXISTS failure_existing_capacity_lease BOOLEAN, '
      + 'ADD COLUMN IF NOT EXISTS failure_work_started_evidence TEXT',
    "ALTER TABLE public.job_attempts ADD CONSTRAINT job_attempts_failure_class_check "
      + "CHECK (failure_class IN ('CAPACITY', 'BROWSER_RUNTIME', 'GENUINE_FAILURE')) NOT VALID",
    'ALTER TABLE public.job_attempts ADD CONSTRAINT job_attempts_failure_work_started_evidence_check '
      + "CHECK (failure_work_started_evidence IN ('UNKNOWN', 'PROVEN_UNSTARTED', 'PROVEN_STARTED')) NOT VALID",
  ]);
  assert.doesNotMatch(withoutSqlComments, /\b(?:DROP|DELETE|TRUNCATE|UPDATE|INSERT)\b/i);
  assert.doesNotMatch(withoutSqlComments, /NOT\s+NULL/i);
  assert.doesNotMatch(withoutSqlComments, /CREATE\s+INDEX/i);
  assert.doesNotMatch(withoutSqlComments, /DO\s+\$\$/);
  assert.doesNotMatch(withoutSqlComments, /first_transient_failure_at\s*=/i);
  assert.doesNotMatch(withoutSqlComments, /created_at\s*=/i);
  // Closed sets are enforced on new writes without scanning history.
  assert.equal(
    (withoutSqlComments.match(/NOT VALID/g) || []).length,
    2,
    'both checks must be NOT VALID so the migration stays metadata-only',
  );
  assert.match(withoutSqlComments, /CHECK \(failure_class IN \('CAPACITY', 'BROWSER_RUNTIME', 'GENUINE_FAILURE'\)\)/);
  assert.match(
    withoutSqlComments,
    /CHECK \(failure_work_started_evidence IN \('UNKNOWN', 'PROVEN_UNSTARTED', 'PROVEN_STARTED'\)\)/,
  );
});

test('the serving failJob persists comparison evidence only inside the flag-on clock path', () => {
  assert.match(
    dbSource,
    /let failureClassification: AcquisitionFailureClassification \| undefined;/,
  );
  assert.match(
    dbSource,
    /failureClassification = classifyAcquisitionFailure\(error, acquisitionEvidenceFromError\(error\)\);/,
  );
  assert.match(
    dbSource,
    /const finalize = failedAttemptFinalizeQuery\(jobId, attemptRowId, persistedMessage, failureClassification\);/,
  );
  assert.match(dbSource, /failure_existing_capacity_lease=\$4/);
  assert.match(dbSource, /failure_work_started_evidence=\$5/);
  assert.match(
    dbSource,
    /classificationPersisted = failureClassification !== undefined && \(finalized\.rowCount \?\? 0\) > 0;/,
  );
  assert.match(dbSource, /bumpJobFailureClassificationFallback\(\);/);
  assert.match(
    dbSource,
    /markJobFailureClassificationCounted\(executionKey\)/,
  );
  assert.match(
    dbSource,
    /const legacyFinalize = failedAttemptFinalizeQuery\(jobId, attemptRowId, persistedMessage\);/,
  );
  // The actual retry decision must remain driven by the legacy predicate.
  assert.match(dbSource, /const capacityLease=clockV2&&isCapacityLeaseFailure\(error\);/);
  assert.match(
    dbSource,
    /const disposition:JobFailureDisposition=capacityLease\?'RETRYING_WITHOUT_ATTEMPT':decision\.disposition;/,
  );
});

test('the community retry worker carries inspection counters into the error failJob sees', () => {
  assert.match(
    queueSource,
    /const inspectionAcquisitionEvidence=inspectionResult&&typeof inspectionResult==='object'\s*\?acquisitionEvidenceFromObservations\(inspectionResult\.inspection\?\.acquisitionOutcomes\)\s*:undefined;/,
  );
  assert.match(queueSource, /new Error\('Retryable community acquisition remains unresolved'\)/);
  assert.equal(
    queueSource.match(/\{acquisitionEvidence:inspectionAcquisitionEvidence\}/g)?.length,
    2,
    'both the capacity deferral and the unresolved retry error carry the counters',
  );
  assert.doesNotMatch(
    queueSource,
    /new Error\('Retryable community acquisition remains unresolved'\),\s*\{[^}]*retryable/,
    'evidence attachment must not change the legacy retry decision',
  );
});

test('classification telemetry is counted only after a durable shadow row exists', () => {
  assert.match(telemetrySource, /jobFailureClassificationsTotal: Record<AcquisitionFailureClass, number>/);
  assert.match(telemetrySource, /jobFailureClassificationFallbacksTotal: number/);
  assert.match(
    telemetrySource,
    /jobFailureClassificationsTotal: \{\s*CAPACITY: 0,\s*BROWSER_RUNTIME: 0,\s*GENUINE_FAILURE: 0,\s*\}/s,
  );
  assert.match(
    telemetrySource,
    /value === 'CAPACITY' \|\| value === 'BROWSER_RUNTIME' \|\| value === 'GENUINE_FAILURE'/,
  );
  assert.match(
    telemetrySource,
    /const countedDispositions = new Map<string, number>\(\);\s*const countedClassifications = new Map<string, number>\(\);/,
    'the two counters must not share one bounded FIFO',
  );
  assert.match(
    telemetrySource,
    /export function markJobFailureClassificationCounted\(executionKey: unknown\): boolean \{\s*return markExecutionCounted\(countedClassifications, String\(executionKey\)\);/,
  );
  assert.match(
    telemetrySource,
    /countedDispositions\.clear\(\);\s*countedClassifications\.clear\(\);/,
    'a test reset must clear both dedupe guards',
  );

  // Prove the serving path counts only after the classified row is durable:
  // the persistence assignment must appear before the counted guard in db.ts.
  const persistedIndex = dbSource.indexOf(
    'classificationPersisted = failureClassification !== undefined && (finalized.rowCount ?? 0) > 0;',
  );
  const countedIndex = dbSource.indexOf(
    'if (classificationPersisted && failureClassification\n    && markJobFailureClassificationCounted(executionKey)) {',
  );
  assert.ok(persistedIndex > -1, 'classification persistence must be captured');
  assert.ok(
    countedIndex > persistedIndex,
    'the classification counter must be gated on the durable row write',
  );
  assert.doesNotMatch(
    dbSource,
    /const countDisposition=[\s\S]{0,200}bumpJobFailureClassification/,
    'a disposition count must not bump the classification counter',
  );
});
