import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import {
  buildRetrievalConfiguration,
  createRetrievalConfigKey,
  CURRENT_RETRIEVAL_POLICY_VERSION
} from './retrievalConfiguration';
import {
  evaluateRetrievalPolicyEligibility,
  deterministicExplorationValue,
  selectLearnedRetrievalConfiguration,
  reserveRetrievalCanaryTreatment,
  reserveIncrementalTreatmentPageQuota,
  enqueueChildAndCommitPageReservation,
  releaseIncrementalTreatmentPageReservation
} from './retrievalPolicyCanary';
import {
  evaluatePreferredRetrievalConfig,
  evaluateShadowRetrievalRecommendation
} from './retrievalPolicyShadow';
import { evaluateContinuation } from './continuationPolicy';
import { enqueueJob } from './db';

/** Helper that constructs a database runner using sql.js to execute actual PostgreSQL SQL queries. */
async function createDatabaseRunner() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  // Create real schema tables
  db.run(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      type TEXT NOT NULL,
      payload TEXT,
      priority INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      run_after TEXT,
      idempotency_key TEXT UNIQUE,
      catalog_version_id TEXT,
      catalog_policy_version TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_by TEXT,
      locked_at TEXT,
      last_error TEXT,
      completed_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE retrieval_configurations (
      config_key TEXT PRIMARY KEY,
      search_ordering TEXT NOT NULL,
      retrieval_lane TEXT NOT NULL,
      requested_page_depth INTEGER NOT NULL,
      continuation_mode TEXT NOT NULL,
      freshness_mode TEXT NOT NULL,
      maintenance_mode TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE retrieval_canary_reservations (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      reservation_id TEXT UNIQUE NOT NULL,
      opportunity_key TEXT NOT NULL,
      neighborhood_key TEXT,
      query_run_id TEXT,
      reservation_status TEXT NOT NULL DEFAULT 'RESERVED',
      quota_reserved INTEGER NOT NULL DEFAULT 100,
      quota_consumed INTEGER NOT NULL DEFAULT 0,
      quota_day TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      retrieval_config_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE retrieval_canary_page_reservations (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      page_reservation_id TEXT UNIQUE NOT NULL,
      query_run_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      reservation_status TEXT NOT NULL DEFAULT 'RESERVED',
      quota_reserved INTEGER NOT NULL DEFAULT 100,
      quota_consumed INTEGER NOT NULL DEFAULT 0,
      quota_day TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const client = {
    query: async (sql: string, params: any[] = []) => {
      let processedSql = sql;

      // Stub pg_advisory_xact_lock
      if (processedSql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }

      // Replace PostgreSQL NOW() / date functions for sql.js compatibility
      processedSql = processedSql.replace(/now\(\)/gi, `datetime('now')`);

      // Execute statement
      try {
        const stmt = db.prepare(processedSql);
        if (params && params.length) {
          stmt.bind(params);
        }

        const rows: any[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        stmt.free();

        const changes = db.getRowsModified();
        return { rows, rowCount: rows.length || changes };
      } catch (err) {
        try {
          db.run(processedSql, params);
          const changes = db.getRowsModified();
          return { rows: [], rowCount: changes };
        } catch (runErr) {
          throw err;
        }
      }
    }
  };

  return { db, client };
}

test('deterministic retrieval-configuration identity and hashing', () => {
  const config1 = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });
  const config2 = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });
  const config3 = buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });

  assert.equal(config1.configKey, config2.configKey);
  assert.notEqual(config1.configKey, config3.configKey);
  assert.equal(config1.policyVersion, CURRENT_RETRIEVAL_POLICY_VERSION);
});

test('shadow recommendation explicitly distinguishes control, executed, and recommended configs', async () => {
  const control = buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: 'VIDEO', requestedPageDepth: 1 });
  const executed = buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: 'VIDEO', requestedPageDepth: 2 });

  const shadow = await evaluateShadowRetrievalRecommendation({
    opportunityKey: 'opp_shadow_test_1',
    neighborhoodKey: 'neigh_shadow_test_1',
    controlConfig: control,
    executedConfig: executed
  });

  assert.equal(shadow.opportunityKey, 'opp_shadow_test_1');
  assert.equal(shadow.controlConfigKey, control.configKey);
  assert.equal(shadow.executedConfigKey, executed.configKey);
  assert.equal(typeof shadow.differsFromControl, 'boolean');
  assert.equal(typeof shadow.differsFromExecuted, 'boolean');
});

test('HARMFUL and SATURATED neighborhoods remain ineligible for Phase 9 deep retrieval', () => {
  const harmful = evaluateRetrievalPolicyEligibility({ neighborhoodKey: 'n1', frontierState: 'HARMFUL' });
  assert.equal(harmful.eligible, false);
  assert.equal(harmful.maxPageDepthCeiling, 1);
  assert.deepEqual(harmful.allowedOrderings, ['RELEVANCE']);

  const saturated = evaluateRetrievalPolicyEligibility({ neighborhoodKey: 'n2', frontierState: 'SATURATED', isSaturating: true });
  assert.equal(saturated.eligible, false);
  assert.equal(saturated.maxPageDepthCeiling, 1);
});

test('evaluateContinuation remains authoritative stopping boundary for deeper pagination', () => {
  // Page 1 productive
  const p1 = evaluateContinuation({
    pageNumber: 1, maxPages: 3, hasNextPage: true,
    distinctCreators: 10, cumulativeDistinctCreators: 10,
    newCreators: 8, confirmedCreators: 5, qualityConfirmedCreators: 3,
    countryPrecision: 0.9, communityDiversity: 0.4, duplicateRatio: 0.1,
    consecutiveLowYieldPages: 0, maxConsecutiveLowYieldPages: 2
  });
  assert.equal(p1.shouldContinue, true);

  // Page 2 duplicate-heavy & zero value (second consecutive low yield page)
  const p2 = evaluateContinuation({
    pageNumber: 2, maxPages: 3, hasNextPage: true,
    distinctCreators: 10, cumulativeDistinctCreators: 20,
    newCreators: 0, confirmedCreators: 0, qualityConfirmedCreators: 0,
    countryPrecision: 0.4, communityDiversity: 0, duplicateRatio: 0.9,
    consecutiveLowYieldPages: 1, maxConsecutiveLowYieldPages: 2
  });
  assert.equal(p2.shouldContinue, false);
  assert.ok(p2.reasonCodes.includes('ZERO_CONFIRMED_VALUE') || p2.reasonCodes.includes('DUPLICATE_HEAVY'));
});

test('database-backed: preventReopen=true preserves PENDING, PROCESSING, COMPLETED, and FAILED states during Phase 9 reconciliation', async () => {
  const { db, client } = await createDatabaseRunner();
  const idempotencyKey = 'search-run:run_db_test_1:page:2';

  // 1. Initial enqueue in PENDING state
  const job1 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_db_test_1', pageNumber: 2 }, {
    priority: 20,
    maxAttempts: 3,
    idempotencyKey,
    clientOverride: client,
    preventReopen: true
  });

  assert.ok(job1.id);
  assert.equal(job1.status, 'PENDING');

  // Reconcile PENDING child job
  const recon1 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_db_test_1', pageNumber: 2 }, {
    priority: 20,
    maxAttempts: 3,
    idempotencyKey,
    clientOverride: client,
    preventReopen: true
  });
  assert.equal(recon1.id, job1.id);
  assert.equal(recon1.status, 'PENDING');

  // 2. Move child job to PROCESSING with worker lock
  db.run(`UPDATE jobs SET status='PROCESSING', locked_by='worker_1', locked_at='2026-08-12 12:00:00', attempts=1 WHERE id=?`, [job1.id]);

  // Reconcile PROCESSING child job
  const recon2 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_db_test_1', pageNumber: 2 }, {
    priority: 20,
    maxAttempts: 3,
    idempotencyKey,
    clientOverride: client,
    preventReopen: true
  });
  assert.equal(recon2.id, job1.id);
  assert.equal(recon2.status, 'PROCESSING');
  assert.equal(recon2.locked_by, 'worker_1');
  assert.equal(recon2.attempts, 1);

  // 3. Move child job to COMPLETED
  db.run(`UPDATE jobs SET status='COMPLETED', completed_at='2026-08-12 12:05:00', locked_by=NULL WHERE id=?`, [job1.id]);

  // Reconcile COMPLETED child job
  const recon3 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_db_test_1', pageNumber: 2 }, {
    priority: 20,
    maxAttempts: 3,
    idempotencyKey,
    clientOverride: client,
    preventReopen: true
  });
  assert.equal(recon3.id, job1.id);
  assert.equal(recon3.status, 'COMPLETED');

  // 4. Move child job to FAILED
  db.run(`UPDATE jobs SET status='FAILED', last_error='provider timeout' WHERE id=?`, [job1.id]);

  // Reconcile FAILED child job
  const recon4 = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_db_test_1', pageNumber: 2 }, {
    priority: 20,
    maxAttempts: 3,
    idempotencyKey,
    clientOverride: client,
    preventReopen: true
  });
  assert.equal(recon4.id, job1.id);
  assert.equal(recon4.status, 'FAILED');
  assert.equal(recon4.last_error, 'provider timeout');

  // 5. Verify ordinary callers without preventReopen still reopen COMPLETED/FAILED jobs
  const reopenCall = await enqueueJob('SEARCH_YOUTUBE', { queryRunId: 'run_db_test_1', pageNumber: 2 }, {
    priority: 20,
    maxAttempts: 3,
    idempotencyKey,
    clientOverride: client,
    preventReopen: false
  });
  assert.equal(reopenCall.id, job1.id);
  assert.equal(reopenCall.status, 'PENDING');
  assert.equal(reopenCall.attempts, 0);
  assert.equal((reopenCall as any).completed_at ?? null, null);
});

test('database-backed: atomic continuation enqueueChildAndCommitPageReservation produces exactly one committed reservation and child lineage', async () => {
  const { db, client } = await createDatabaseRunner();

  // Create parent reservation
  db.run(`INSERT INTO retrieval_canary_reservations(id, reservation_id, opportunity_key, query_run_id, reservation_status, quota_reserved, quota_consumed, quota_day, policy_version) VALUES('res1', 'retrieval-res:opp1:v1', 'opp1', 'run_parent_1', 'COMMITTED', 100, 0, '2026-08-12', 'v1')`);

  // Create page 2 reservation in RESERVED state
  const pageResId = 'inc-page-res:run_parent_1:2:v1';
  db.run(`INSERT INTO retrieval_canary_page_reservations(id, page_reservation_id, query_run_id, page_number, reservation_status, quota_reserved, quota_consumed, quota_day, policy_version) VALUES('pres1', ?, 'run_parent_1', 2, 'RESERVED', 100, 0, '2026-08-12', 'v1')`, [pageResId]);

  // First atomic child enqueue + page reservation commit
  const childJob1 = await enqueueChildAndCommitPageReservation({
    pageReservationId: pageResId,
    queryRunId: 'run_parent_1',
    jobType: 'SEARCH_YOUTUBE',
    jobPayload: { queryRunId: 'run_parent_1', pageNumber: 2 },
    idempotencyKey: 'search-run:run_parent_1:page:2',
    clientOverride: client
  });

  assert.ok(childJob1.id);
  assert.equal(childJob1.status, 'PENDING');

  // Verify page reservation transitioned to COMMITTED
  const pageRows1 = db.exec(`SELECT * FROM retrieval_canary_page_reservations WHERE page_reservation_id='${pageResId}'`);
  assert.equal(pageRows1[0].values[0][4], 'COMMITTED');

  // Reconcile / parent retry: second atomic call with same idempotency key
  const childJob2 = await enqueueChildAndCommitPageReservation({
    pageReservationId: pageResId,
    queryRunId: 'run_parent_1',
    jobType: 'SEARCH_YOUTUBE',
    jobPayload: { queryRunId: 'run_parent_1', pageNumber: 2 },
    idempotencyKey: 'search-run:run_parent_1:page:2',
    clientOverride: client
  });

  // Verify same child job ID returned, exactly 1 job exists, and 1 page reservation exists
  assert.equal(childJob2.id, childJob1.id);
  const totalJobs = db.exec(`SELECT COUNT(*) FROM jobs WHERE idempotency_key='search-run:run_parent_1:page:2'`);
  assert.equal(totalJobs[0].values[0][0], 1);

  const totalPageReservations = db.exec(`SELECT COUNT(*) FROM retrieval_canary_page_reservations WHERE page_reservation_id='${pageResId}'`);
  assert.equal(totalPageReservations[0].values[0][0], 1);
});
