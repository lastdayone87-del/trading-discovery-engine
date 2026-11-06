import test from 'node:test';
import assert from 'node:assert/strict';
import { failJob } from './db';
import {
  ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV,
  CAPACITY_LEASE_DURATION_MS,
} from './acquisitionJobClockPolicy';

interface QueryRecord {
  sql: string;
  values?: unknown[];
}

function makeDb(row: Record<string, unknown>) {
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

function capacityError(now: number) {
  return Object.assign(new Error('Community acquisition deferred: browser gate saturated'), {
    code: 'BROWSER_RUNTIME_UNAVAILABLE',
    retryable: true,
    retryAt: now + 60_000,
  });
}

test('flag off keeps the legacy capacity failure-budget path', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'false';
  try {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const db = makeDb({ attempts: 2, max_attempts: 5, first_transient_failure_at: null });
    const disposition = await failJob('job-legacy-capacity', capacityError(now), { db, now });

    assert.equal(disposition, 'RETRYING_WITHOUT_ATTEMPT');
    const transition = db.queries.find(query => query.sql.startsWith('UPDATE jobs SET status='));
    assert.ok(transition, 'failJob must transition the job row');
    assert.match(transition!.sql, /first_transient_failure_at=COALESCE/);
    assert.doesNotMatch(transition!.sql, /capacity_lease_/);
    assert.doesNotMatch(transition!.sql, /created_at/);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('flag on renews a capacity lease without touching queue age or an old genuine anchor', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const anchor = new Date(now - 7 * 60 * 60_000).toISOString();
    const db = makeDb({ attempts: 2, max_attempts: 5, first_transient_failure_at: anchor });
    const error = capacityError(now);
    const disposition = await failJob('job-capacity', error, { db, now });

    // The genuine anchor is older than the six-hour ceiling. A capacity wait
    // still must not terminalize: it never ran acquisition work.
    assert.equal(disposition, 'RETRYING_WITHOUT_ATTEMPT');
    const transition = db.queries.find(query => query.sql.startsWith('UPDATE jobs SET status='));
    assert.ok(transition, 'failJob must transition the job row');
    assert.match(transition!.sql, /capacity_lease_started_at=COALESCE/);
    assert.match(transition!.sql, /capacity_lease_expires_at=/);
    assert.match(transition!.sql, /capacity_lease_renewed_at=/);
    assert.match(transition!.sql, /capacity_lease_renewals=/);
    assert.doesNotMatch(transition!.sql, /first_transient_failure_at/);
    assert.doesNotMatch(transition!.sql, /created_at/);
    assert.doesNotMatch(transition!.sql, /run_after=now\(\)/);
    assert.equal(transition!.values?.[2], new Date(now + 60_000).toISOString());
    assert.equal(transition!.values?.[3], String(CAPACITY_LEASE_DURATION_MS));
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('flag on preserves the genuine first-failure anchor for transient failures', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const anchor = new Date(now - 60 * 60_000).toISOString();
    const db = makeDb({ attempts: 2, max_attempts: 5, first_transient_failure_at: anchor });
    const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const disposition = await failJob('job-transient', error, { db, now });

    assert.equal(disposition, 'RETRYING_WITHOUT_ATTEMPT');
    const transition = db.queries.find(query => query.sql.startsWith('UPDATE jobs SET status='));
    assert.ok(transition, 'failJob must transition the job row');
    assert.match(transition!.sql, /first_transient_failure_at=COALESCE/);
    assert.doesNotMatch(transition!.sql, /capacity_lease_/);
    assert.equal(transition!.values?.[3], anchor);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('flag on still terminalizes a genuine retryable failure after six hours', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const anchor = new Date(now - 7 * 60 * 60_000).toISOString();
    const db = makeDb({ attempts: 2, max_attempts: 5, first_transient_failure_at: anchor });
    const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const disposition = await failJob('job-transient-terminal', error, { db, now });

    assert.equal(disposition, 'FAILED');
    const transition = db.queries.find(query => query.sql.startsWith('UPDATE jobs SET status='));
    assert.ok(transition, 'failJob must transition the job row');
    assert.match(transition!.sql, /CASE WHEN \$3::boolean THEN COALESCE\(first_transient_failure_at,\$4::timestamptz\)/);
    assert.doesNotMatch(transition!.sql, /capacity_lease_/);
    assert.equal(transition!.values?.[2], true);
    assert.equal(transition!.values?.[3], anchor);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('flag on bounds a rendered capacity retry hint before persisting run_after', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const db = makeDb({ attempts: 1, max_attempts: 5, first_transient_failure_at: null });
    const error = Object.assign(new Error('rendered capacity saturated'), {
      code: 'RENDERED_FALLBACK_SATURATED',
      retryable: true,
      retryAt: now + 48 * 60 * 60_000,
    });
    const disposition = await failJob('job-rendered-hint', error, { db, now });

    assert.equal(disposition, 'RETRYING_WITHOUT_ATTEMPT');
    const transition = db.queries.find(query => query.sql.startsWith('UPDATE jobs SET status='));
    assert.ok(transition, 'failJob must transition the job row');
    assert.equal(transition!.values?.[2], new Date(now + 15 * 60_000).toISOString());
    assert.match(transition!.sql, /capacity_lease_expires_at=/);
    assert.doesNotMatch(transition!.sql, /first_transient_failure_at/);
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('flag on honors a quota reset hint but never beyond twenty-four hours', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const nearReset = Object.assign(new Error('ENRICHMENT YouTube quota allocation is exhausted'), {
      code: 'QUOTA_ALLOCATION_EXHAUSTED',
      retryAt: now + 20 * 60 * 60_000,
    });
    const acceptedDb = makeDb({ attempts: 1, max_attempts: 5, first_transient_failure_at: null });
    assert.equal(
      await failJob('job-quota-near-reset', nearReset, { db: acceptedDb, now }),
      'RETRYING_WITHOUT_ATTEMPT'
    );
    const accepted = acceptedDb.queries.find(query => query.sql.startsWith('UPDATE jobs SET status='));
    assert.ok(accepted);
    assert.equal(accepted!.values?.[2], new Date(now + 20 * 60 * 60_000).toISOString());
    assert.match(accepted!.sql, /capacity_lease_expires_at=/);
    assert.doesNotMatch(accepted!.sql, /first_transient_failure_at/);

    const farReset = Object.assign(new Error('ENRICHMENT YouTube quota allocation is exhausted'), {
      code: 'QUOTA_ALLOCATION_EXHAUSTED',
      retryAt: now + 30 * 60 * 60_000,
    });
    const cappedDb = makeDb({ attempts: 1, max_attempts: 5, first_transient_failure_at: null });
    assert.equal(
      await failJob('job-quota-far-reset', farReset, { db: cappedDb, now }),
      'RETRYING_WITHOUT_ATTEMPT'
    );
    const capped = cappedDb.queries.find(query => query.sql.startsWith('UPDATE jobs SET status='));
    assert.ok(capped);
    assert.equal(capped!.values?.[2], new Date(now + 24 * 60 * 60_000).toISOString());
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});

test('flag on does not let an expired provider hint retry a capacity wait immediately', async () => {
  process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] = 'true';
  try {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const db = makeDb({ attempts: 1, max_attempts: 5, first_transient_failure_at: null });
    const error = Object.assign(new Error('Community acquisition deferred: browser gate saturated'), {
      code: 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
      retryable: true,
      retryAt: now - 60_000,
    });
    const disposition = await failJob('job-expired-hint', error, { db, now });

    assert.equal(disposition, 'RETRYING_WITHOUT_ATTEMPT');
    const transition = db.queries.find(query => query.sql.startsWith('UPDATE jobs SET status='));
    assert.ok(transition, 'failJob must transition the job row');
    assert.equal(transition!.values?.[2], new Date(now + 30_000).toISOString());
  } finally {
    delete process.env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV];
  }
});
