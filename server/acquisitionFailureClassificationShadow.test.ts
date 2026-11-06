import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { failedAttemptFinalizeQuery, failJob } from './db';
import { ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV } from './acquisitionJobClockPolicy';
import { operationsTelemetrySnapshot, resetOperationsTelemetry } from './operationsTelemetry';

interface QueryRecord {
  sql: string;
  values?: unknown[];
}

function makeDb(
  row: Record<string, unknown> = {
    attempts: 1,
    max_attempts: 5,
    first_transient_failure_at: null,
  },
  options: { attemptRowId?: string | null; finalizeRowCount?: number } = {},
) {
  const queries: QueryRecord[] = [];
  const attemptRowId = options.attemptRowId === undefined ? randomUUID() : options.attemptRowId;
  return {
    queries,
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT attempts,max_attempts,first_transient_failure_at FROM jobs')) {
        return { rowCount: 1, rows: [row] };
      }
      if (sql.startsWith('SELECT id FROM job_attempts')) {
        return attemptRowId
          ? { rowCount: 1, rows: [{ id: attemptRowId }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.startsWith('UPDATE job_attempts')) {
        return { rowCount: options.finalizeRowCount ?? 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

function finalizeQuery(queries: QueryRecord[]) {
  return queries.find(query => query.sql.startsWith('UPDATE job_attempts SET status='));
}

test('flag on persists the shadow classification and both comparison fields', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  try {
    const db = makeDb();
    const error = Object.assign(new Error('not found'), { status: 404 });
    await failJob('job-genuine', error, { db, now: Date.UTC(2026, 10, 6, 12) });

    const finalize = finalizeQuery(db.queries);
    assert.ok(finalize, 'failJob must finalize the attempt row');
    assert.match(finalize!.sql, /failure_class=\$2/);
    assert.match(finalize!.sql, /failure_reason=\$3/);
    assert.match(finalize!.sql, /failure_existing_capacity_lease=\$4/);
    assert.match(finalize!.sql, /failure_work_started_evidence=\$5/);
    assert.deepEqual(finalize!.values!.slice(1, 5), [
      'GENUINE_FAILURE',
      'TERMINAL_OR_UNCLASSIFIED',
      false,
      'UNKNOWN',
    ]);
    assert.equal(operationsTelemetrySnapshot().jobFailureClassificationsTotal.GENUINE_FAILURE, 1);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('flag on records capacity and browser-runtime classifications separately', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  try {
    const capacityDb = makeDb();
    await failJob(
      'job-capacity',
      Object.assign(new Error('Community acquisition deferred: RENDERED_FALLBACK_SATURATED'), {
        code: 'BROWSER_RUNTIME_UNAVAILABLE',
        retryable: true,
      }),
      { db: capacityDb, now: Date.UTC(2026, 10, 6, 12) },
    );
    assert.deepEqual(finalizeQuery(capacityDb.queries)!.values!.slice(1, 5), [
      'CAPACITY',
      'BROWSER_GATE_SATURATION',
      true,
      'UNKNOWN',
    ]);

    const browserDb = makeDb();
    await failJob(
      'job-browser',
      Object.assign(new Error('browser launch failed'), {
        code: 'BROWSER_LAUNCH_FAILED',
        retryable: true,
      }),
      { db: browserDb, now: Date.UTC(2026, 10, 6, 12) },
    );
    assert.deepEqual(finalizeQuery(browserDb.queries)!.values!.slice(1, 5), [
      'BROWSER_RUNTIME',
      'BROWSER_RUNTIME',
      true,
      'UNKNOWN',
    ]);

    const counts = operationsTelemetrySnapshot().jobFailureClassificationsTotal;
    assert.equal(counts.CAPACITY, 1);
    assert.equal(counts.BROWSER_RUNTIME, 1);
    assert.equal(counts.GENUINE_FAILURE, 0);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('a browser failure after real work persists as a genuine failure with evidence', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  try {
    const db = makeDb();
    const error = Object.assign(new Error('browser process exited after navigation'), {
      code: 'BROWSER_LAUNCH_FAILED',
      retryable: true,
      acquisitionEvidence: {
        pagesInspected: 2,
        requestsStarted: 4,
        redirectsFollowed: 1,
      },
    });
    await failJob('job-browser-after-work', error, { db, now: Date.UTC(2026, 10, 6, 12) });

    assert.deepEqual(finalizeQuery(db.queries)!.values!.slice(1, 5), [
      'GENUINE_FAILURE',
      'BROWSER_RUNTIME_WORK_STARTED',
      true,
      'PROVEN_STARTED',
    ]);
    assert.equal(operationsTelemetrySnapshot().jobFailureClassificationsTotal.GENUINE_FAILURE, 1);
    assert.equal(operationsTelemetrySnapshot().jobFailureClassificationsTotal.BROWSER_RUNTIME, 0);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('flag off keeps the legacy finalize statement and does not count a classification', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'false';
  resetOperationsTelemetry();
  try {
    const db = makeDb();
    await failJob('job-legacy', new Error('not found'), { db, now: Date.UTC(2026, 10, 6, 12) });

    const finalize = finalizeQuery(db.queries);
    assert.ok(finalize);
    assert.doesNotMatch(finalize!.sql, /failure_class|failure_reason/);
    assert.deepEqual(operationsTelemetrySnapshot().jobFailureClassificationsTotal, {
      CAPACITY: 0,
      BROWSER_RUNTIME: 0,
      GENUINE_FAILURE: 0,
    });
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('a repeated failJob for the same captured attempt row counts the classification once', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  try {
    const db = makeDb();
    const now = Date.UTC(2026, 10, 6, 12);
    const error = Object.assign(new Error('not found'), { status: 404 });
    await failJob('job-repeat', error, { db, now });
    await failJob('job-repeat', error, { db, now });
    assert.equal(operationsTelemetrySnapshot().jobFailureClassificationsTotal.GENUINE_FAILURE, 1);
    assert.equal(operationsTelemetrySnapshot().jobFailureDispositionsTotal.RETRYING, 1);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('a repeated failJob without an attempt row still counts once by job and attempt', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  try {
    const db = makeDb(undefined, { attemptRowId: null });
    const now = Date.UTC(2026, 10, 6, 12);
    const error = Object.assign(new Error('not found'), { status: 404 });
    await failJob('job-repeat-fallback', error, { db, now });
    await failJob('job-repeat-fallback', error, { db, now });
    assert.equal(operationsTelemetrySnapshot().jobFailureClassificationsTotal.GENUINE_FAILURE, 1);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('a finalize that affects no row does not count a classification', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  try {
    const db = makeDb(undefined, { finalizeRowCount: 0 });
    await failJob('job-no-row', new Error('not found'), { db, now: Date.UTC(2026, 10, 6, 12) });
    assert.deepEqual(operationsTelemetrySnapshot().jobFailureClassificationsTotal, {
      CAPACITY: 0,
      BROWSER_RUNTIME: 0,
      GENUINE_FAILURE: 0,
    });
    assert.equal(operationsTelemetrySnapshot().jobFailureDispositionsTotal.RETRYING, 1);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('a missing shadow column warns, counts a fallback, and uses the legacy finalize statement', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  const queries: QueryRecord[] = [];
  const db = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT attempts,max_attempts,first_transient_failure_at FROM jobs')) {
        return { rowCount: 1, rows: [{ attempts: 1, max_attempts: 5, first_transient_failure_at: null }] };
      }
      if (sql.startsWith('SELECT id FROM job_attempts')) {
        return { rowCount: 1, rows: [{ id: 'attempt-row-A' }] };
      }
      if (sql.startsWith('UPDATE job_attempts') && sql.includes('failure_class')) {
        throw new Error('column "failure_class" does not exist');
      }
      return { rowCount: 1, rows: [] };
    },
  };
  try {
    const disposition = await failJob('job-missing-column', new Error('not found'), {
      db,
      now: Date.UTC(2026, 10, 6, 12),
    });
    assert.equal(disposition, 'RETRYING');
    const attemptUpdates = queries.filter(query => query.sql.startsWith('UPDATE job_attempts'));
    assert.equal(attemptUpdates.length, 2, 'the classification write is attempted, then the legacy write');
    assert.match(attemptUpdates[0].sql, /failure_class/);
    assert.doesNotMatch(attemptUpdates[1].sql, /failure_class/);
    assert.equal(operationsTelemetrySnapshot().jobFailureClassificationFallbacksTotal, 1);
    assert.deepEqual(operationsTelemetrySnapshot().jobFailureClassificationsTotal, {
      CAPACITY: 0,
      BROWSER_RUNTIME: 0,
      GENUINE_FAILURE: 0,
    });
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /Shadow classification write failed/);
  } finally {
    console.warn = originalWarn;
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('finalize query with a classification targets the captured attempt row', () => {
  const query = failedAttemptFinalizeQuery('job-1', 'attempt-row-A', 'boom', {
    failureClass: 'BROWSER_RUNTIME',
    reason: 'BROWSER_RUNTIME',
    existingCapacityLease: true,
    workStartedEvidence: 'PROVEN_STARTED',
  });
  assert.match(
    query.text,
    /failure_class=\$2,failure_reason=\$3,failure_existing_capacity_lease=\$4,failure_work_started_evidence=\$5 WHERE id=\$6 AND finished_at IS NULL/,
  );
  assert.deepEqual(query.values, [
    'boom',
    'BROWSER_RUNTIME',
    'BROWSER_RUNTIME',
    true,
    'PROVEN_STARTED',
    'attempt-row-A',
  ]);
});

test('finalize query without a captured row uses the job-scoped filter', () => {
  const query = failedAttemptFinalizeQuery('job-1', null, 'boom', {
    failureClass: 'CAPACITY',
    reason: 'COMMUNITY_CAPACITY_DEFERRAL',
    existingCapacityLease: true,
    workStartedEvidence: 'PROVEN_UNSTARTED',
  });
  assert.match(
    query.text,
    /failure_class=\$2,failure_reason=\$3,failure_existing_capacity_lease=\$4,failure_work_started_evidence=\$5 WHERE job_id=\$6 AND finished_at IS NULL/,
  );
  assert.deepEqual(query.values, [
    'boom',
    'CAPACITY',
    'COMMUNITY_CAPACITY_DEFERRAL',
    true,
    'PROVEN_UNSTARTED',
    'job-1',
  ]);
});

test('finalize query without a classification remains byte-for-byte legacy', () => {
  const query = failedAttemptFinalizeQuery('job-1', 'attempt-row-A', 'boom');
  assert.equal(
    query.text,
    `UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$1 WHERE id=$2 AND finished_at IS NULL`,
  );
  assert.deepEqual(query.values, ['boom', 'attempt-row-A']);
});
