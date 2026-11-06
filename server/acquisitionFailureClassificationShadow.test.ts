import assert from 'node:assert/strict';
import test from 'node:test';
import { failedAttemptFinalizeQuery, failJob } from './db';
import { ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV } from './acquisitionJobClockPolicy';
import { operationsTelemetrySnapshot, resetOperationsTelemetry } from './operationsTelemetry';

interface QueryRecord {
  sql: string;
  values?: unknown[];
}

function makeDb(row: Record<string, unknown> = {
  attempts: 1,
  max_attempts: 5,
  first_transient_failure_at: null,
}) {
  const queries: QueryRecord[] = [];
  return {
    queries,
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT attempts,max_attempts,first_transient_failure_at FROM jobs')) {
        return { rowCount: 1, rows: [row] };
      }
      if (sql.startsWith('SELECT id FROM job_attempts')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

function finalizeQuery(queries: QueryRecord[]) {
  return queries.find(query => query.sql.startsWith('UPDATE job_attempts SET status='));
}

test('flag on persists the shadow classification with the attempt', async () => {
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
    assert.deepEqual(finalize!.values.slice(1, 3), ['GENUINE_FAILURE', 'TERMINAL_OR_UNCLASSIFIED']);
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
    assert.deepEqual(finalizeQuery(capacityDb.queries)!.values.slice(1, 3), [
      'CAPACITY',
      'BROWSER_GATE_SATURATION',
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
    assert.deepEqual(finalizeQuery(browserDb.queries)!.values.slice(1, 3), [
      'BROWSER_RUNTIME',
      'BROWSER_RUNTIME',
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

test('a repeated failJob for the same execution counts the classification once', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  try {
    const db = makeDb();
    const now = Date.UTC(2026, 10, 6, 12);
    const error = Object.assign(new Error('not found'), { status: 404 });
    await failJob('job-repeat', error, { db, now });
    await failJob('job-repeat', error, { db, now });
    assert.equal(operationsTelemetrySnapshot().jobFailureClassificationsTotal.GENUINE_FAILURE, 1);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('a missing shadow column falls back to the legacy finalize statement', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  resetOperationsTelemetry();
  const queries: QueryRecord[] = [];
  const db = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT attempts,max_attempts,first_transient_failure_at FROM jobs')) {
        return { rowCount: 1, rows: [{ attempts: 1, max_attempts: 5, first_transient_failure_at: null }] };
      }
      if (sql.startsWith('SELECT id FROM job_attempts')) {
        return { rowCount: 0, rows: [] };
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
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
    resetOperationsTelemetry();
  }
});

test('finalize query with a classification targets the captured attempt row', () => {
  const query = failedAttemptFinalizeQuery('job-1', 'attempt-row-A', 'boom', {
    failureClass: 'BROWSER_RUNTIME',
    reason: 'BROWSER_RUNTIME',
  });
  assert.match(query.text, /failure_class=\$2,failure_reason=\$3 WHERE id=\$4 AND finished_at IS NULL/);
  assert.deepEqual(query.values, ['boom', 'BROWSER_RUNTIME', 'BROWSER_RUNTIME', 'attempt-row-A']);
});

test('finalize query without a captured row uses the job-scoped filter', () => {
  const query = failedAttemptFinalizeQuery('job-1', null, 'boom', {
    failureClass: 'CAPACITY',
    reason: 'COMMUNITY_CAPACITY_DEFERRAL',
  });
  assert.match(query.text, /failure_class=\$2,failure_reason=\$3 WHERE job_id=\$4 AND finished_at IS NULL/);
  assert.deepEqual(query.values, ['boom', 'CAPACITY', 'COMMUNITY_CAPACITY_DEFERRAL', 'job-1']);
});

test('finalize query without a classification remains byte-for-byte legacy', () => {
  const query = failedAttemptFinalizeQuery('job-1', 'attempt-row-A', 'boom');
  assert.equal(
    query.text,
    `UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$1 WHERE id=$2 AND finished_at IS NULL`,
  );
  assert.deepEqual(query.values, ['boom', 'attempt-row-A']);
});
