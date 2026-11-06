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

test('migration 163 is present and sorts after migration 162', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('162_job_clock_and_capacity_lease.sql'));
  assert.ok(files.includes(migrationName));
  assert.ok(files.indexOf(migrationName) > files.indexOf('162_job_clock_and_capacity_lease.sql'));
});

test('migration 163 adds only nullable shadow classification columns', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS failure_class TEXT/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS failure_reason TEXT/);
  assert.doesNotMatch(withoutSqlComments, /NOT\s+NULL/i);
  assert.doesNotMatch(withoutSqlComments, /\b(?:DROP|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(withoutSqlComments, /\bUPDATE\b/i);
  assert.doesNotMatch(withoutSqlComments, /CREATE\s+INDEX/i);
  assert.doesNotMatch(withoutSqlComments, /first_transient_failure_at\s*=/i);
  assert.doesNotMatch(withoutSqlComments, /created_at\s*=/i);
});

test('migration 163 performs metadata-only DDL under a lock timeout', () => {
  assert.match(migration, /SET LOCAL lock_timeout = '10s'/);
  assert.doesNotMatch(withoutSqlComments, /DO\s+\$\$/);
  assert.doesNotMatch(withoutSqlComments, /UPDATE\s+public\.job_attempts/i);
});

test('the serving failJob persists classification only inside the flag-on clock path', () => {
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
    /if \(failureClassification\) bumpJobFailureClassification\(failureClassification\.failureClass\);/,
  );
  assert.match(
    dbSource,
    /const finalize = failedAttemptFinalizeQuery\(jobId, attemptRowId, persistedMessage, failureClassification\);/,
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

test('classification telemetry is counted once with the disposition and never normalizes to a new bucket', () => {
  assert.match(telemetrySource, /jobFailureClassificationsTotal: Record<AcquisitionFailureClass, number>/);
  assert.match(telemetrySource, /jobFailureClassificationsTotal: \{\s*CAPACITY: 0,\s*BROWSER_RUNTIME: 0,\s*GENUINE_FAILURE: 0,\s*\}/s);
  assert.match(
    telemetrySource,
    /value === 'CAPACITY' \|\| value === 'BROWSER_RUNTIME' \|\| value === 'GENUINE_FAILURE'/,
  );
});
