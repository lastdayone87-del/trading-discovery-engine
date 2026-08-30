import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COUNTRY_BOUNDARY_RECOVERY_JOB,
  COUNTRY_BOUNDARY_RECOVERY_VERSION,
  countryBoundaryRecoveryKey,
  hasDiscordInspectionStep,
  isNonExcludedBoundaryCandidate
} from './countryBoundaryRecovery';

const workerSource = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');
const cohortSource = readFileSync(new URL('./countryBoundaryRecovery.ts', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const authSource = readFileSync(new URL('./operatorAuth.ts', import.meta.url), 'utf8');

const candidate = (overrides: Record<string, unknown> = {}) => ({
  country_status: 'REJECTED',
  inspection_trail: [{ step: 'Country Validation', details: 'Target Country Boundary: REJECTED — creator country differs from discovery target.' }],
  trading_status: 'TRADING_CONFIRMED',
  ...overrides
}) as any;

test('dry-run eligibility requires non-excluded pinned-boundary rejection', async () => {
  const { INITIAL_EXCLUDED_COUNTRIES } = await import('../src/data/initial_countries');
  assert.equal(isNonExcludedBoundaryCandidate(candidate({ country_status: 'REJECTED' }), INITIAL_EXCLUDED_COUNTRIES), true);
  assert.equal(isNonExcludedBoundaryCandidate(candidate({ country_status: 'CONFIRMED', inspection_trail: [] }), INITIAL_EXCLUDED_COUNTRIES), false);
});

test('Discord inspection-step detection is independent from current Discord projection', () => {
  assert.equal(hasDiscordInspectionStep(candidate()), false);
  assert.equal(hasDiscordInspectionStep(candidate({ inspection_trail: [{ step: 'Step 4 — Linked Websites', details: 'Inspected successfully.' }] })), true);
});

test('cohort idempotency key is stable and correction-version scoped', () => {
  const key = countryBoundaryRecoveryKey('channel-123');
  assert.equal(key, `country-boundary-reprocess:${COUNTRY_BOUNDARY_RECOVERY_VERSION}:channel-123`);
  assert.match(key, new RegExp(`^country-boundary-reprocess:${COUNTRY_BOUNDARY_RECOVERY_VERSION}:`));
});

test('cohort scheduler is operator-protected, confirmation-gated, and worker uses normal recheck pipeline', () => {
  assert.match(serverSource, /app\.post\('\/api\/reconciliation\/nonexcluded-boundary-cohort'/);
  assert.match(serverSource, /COUNTRY_BOUNDARY_RECOVERY_VERSION/);
  assert.match(authSource, /nonexcluded-boundary-cohort/);
  assert.match(cohortSource, new RegExp(`COUNTRY_BOUNDARY_RECOVERY_JOB = '${COUNTRY_BOUNDARY_RECOVERY_JOB}'`));
  assert.match(workerSource, /reserveOfficialRecheckQuota\('OPERATIONAL_RECHECK', operationId\)/);
  assert.match(workerSource, /claimNextJob\(workerId, COUNTRY_BOUNDARY_RECOVERY_TYPES\)/);
  assert.match(workerSource, /triggerManualRecheck\(channelId, true, true\)/);
  assert.match(workerSource, /completeJob\(job\.id\)/);
  assert.match(workerSource, /failJob\(claimedJobId, error\)/);
});

test('cohort worker keeps quota reservation before claim and bounded backoff on unavailable capacity', () => {
  const reserve = workerSource.indexOf("reserved = await reserveOfficialRecheckQuota('OPERATIONAL_RECHECK', operationId);");
  const claim = workerSource.indexOf('const job = await claimNextJob(workerId, COUNTRY_BOUNDARY_RECOVERY_TYPES);');
  assert.ok(reserve >= 0 && claim > reserve);
  assert.match(workerSource, /nextDelayMs = QUOTA_BACKOFF_MS/);
  assert.match(cohortSource, /maxAttempts: 4/);
  assert.match(cohortSource, /preventReopen: true/);
});

test('TEST C: Reconciliation classification - RECOVERABLE_NON_EXCLUDED', async () => {
  const { classifyReconciliationState } = await import('./countryBoundaryRecovery');
  const { INITIAL_EXCLUDED_COUNTRIES, INITIAL_COUNTRY_VOCABULARIES } = await import('../src/data/initial_countries');
  const excluded = INITIAL_EXCLUDED_COUNTRIES;
  const vocabularies = INITIAL_COUNTRY_VOCABULARIES;

  const excludedSet = new Set(excluded.map(e => e.country_name.toLowerCase()));
  const nonExcludedVocab = vocabularies.find(v => !excludedSet.has(v.country.toLowerCase()) && v.local_market_phrases?.length >= 2);
  assert.ok(nonExcludedVocab, 'A non-excluded country vocabulary with market phrases must exist');

  const nonExcludedCountry = nonExcludedVocab.country;
  const terms = nonExcludedVocab.local_market_phrases.slice(0, 2);

  const channel = candidate({
    country_status: 'REJECTED',
    channel_name: `Trader Channel`,
    inspection_trail: [
      { step: 'COUNTRY_VALIDATION', details: 'Target Country Boundary: REJECTED — creator country differs from discovery target.' },
      { step: 'BIO', details: `Trading analysis and market strategy covering ${terms.join(' and ')}` }
    ]
  });

  const res = classifyReconciliationState(channel, excluded, vocabularies);
  assert.equal(res.state, 'RECOVERABLE_NON_EXCLUDED');
  assert.equal(res.detectedCountry, nonExcludedCountry);
});

test('TEST D: Reconciliation classification - RETAIN_EXCLUDED', async () => {
  const { classifyReconciliationState } = await import('./countryBoundaryRecovery');
  const { INITIAL_EXCLUDED_COUNTRIES, INITIAL_COUNTRY_VOCABULARIES } = await import('../src/data/initial_countries');
  const excluded = INITIAL_EXCLUDED_COUNTRIES;
  const vocabularies = INITIAL_COUNTRY_VOCABULARIES;

  assert.ok(excluded.length > 0, 'Excluded countries policy must be available');
  const excludedName = excluded[0].country_name;

  const excludedVocab = vocabularies.find(v => v.country.toLowerCase() === excludedName.toLowerCase());
  const terms = excludedVocab?.local_market_phrases?.length ? excludedVocab.local_market_phrases.slice(0, 2) : [excludedName, 'market'];

  const channel = candidate({
    country_status: 'REJECTED',
    channel_name: `Trader in ${excludedName}`,
    inspection_trail: [
      { step: 'COUNTRY_VALIDATION', details: 'Target Country Boundary: REJECTED' },
      { step: 'BIO', details: `Trader active in ${excludedName} covering ${terms.join(' and ')}` }
    ]
  });

  const res = classifyReconciliationState(channel, excluded, vocabularies);
  assert.equal(res.state, 'RETAIN_EXCLUDED');
  assert.equal(res.detectedCountry, excludedName);
});

test('TEST E: Reconciliation classification - INSUFFICIENT_EVIDENCE', async () => {
  const { classifyReconciliationState } = await import('./countryBoundaryRecovery');
  const { INITIAL_EXCLUDED_COUNTRIES } = await import('../src/data/initial_countries');
  const excluded = INITIAL_EXCLUDED_COUNTRIES;

  const channel = candidate({
    country_status: 'REJECTED',
    channel_name: 'Generic Channel Name',
    inspection_trail: [
      { step: 'COUNTRY_VALIDATION', details: 'Target Country Boundary: REJECTED' }
    ]
  });

  const res = classifyReconciliationState(channel, excluded);
  assert.equal(res.state, 'INSUFFICIENT_EVIDENCE');
});

test('TEST F: Reconciliation classification - LEGITIMATE_REJECTION', async () => {
  const { classifyReconciliationState } = await import('./countryBoundaryRecovery');
  const { INITIAL_EXCLUDED_COUNTRIES } = await import('../src/data/initial_countries');
  const excluded = INITIAL_EXCLUDED_COUNTRIES;
  const excludedName = excluded[0].country_name;

  const channel = candidate({
    country: excludedName,
    country_status: 'REJECTED',
    channel_name: `Trader ${excludedName}`,
    inspection_trail: [
      { step: 'COUNTRY_VALIDATION', details: `${excludedName} is excluded by policy: Regional Exclusion` }
    ]
  });

  const res = classifyReconciliationState(channel, excluded);
  assert.equal(res.state, 'LEGITIMATE_REJECTION');
});

test('TEST G: Dashboard projection SQL filters out excluded countries and non-rejected status correctly', async () => {
  const { OPERATOR_VISIBLE_CHANNEL_SQL } = await import('./dbCore');
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /country_status <> 'REJECTED'/);
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /NOT EXISTS[\s\S]+FROM excluded_countries/);
});

const postgresUrl = process.env.COUNTRY_BOUNDARY_POSTGRES_URL || process.env.PHASE4_POSTGRES_URL || process.env.DATABASE_URL;

test('TEST H: End-to-End Sighting-Only Cohort Discovery & Recovery Path', {
  skip: postgresUrl ? false : 'COUNTRY_BOUNDARY_POSTGRES_URL or DATABASE_URL environment variable is required to execute PostgreSQL database integration tests'
}, async () => {
  if (postgresUrl) {
    process.env.DATABASE_URL = postgresUrl;
  }
  const { loadCohort, processCountryBoundaryReprocessJob } = await import('./countryBoundaryRecovery');
  const { getDb, getExcludedCountries, getCountryVocabularies, getChannelById } = await import('./db');

  const db = await getDb();
  assert.ok(db, 'Database must be initialized and available for critical sighting-only recovery test');

  const excluded = await getExcludedCountries();
  assert.ok(excluded && excluded.length > 0, 'Database policy must contain at least one excluded country');
  const excludedCountryName = excluded[0].country_name;

  const vocabularies = await getCountryVocabularies();
  assert.ok(vocabularies && vocabularies.length > 0, 'Database policy must contain country vocabularies');
  const excludedSet = new Set(excluded.map(e => e.country_name.toLowerCase()));

  const nonExcludedVocab = vocabularies.find(v => !excludedSet.has(v.country.toLowerCase()) && v.local_market_phrases?.length > 0);
  assert.ok(nonExcludedVocab, 'A valid non-excluded country with vocabularies must exist in current policy');
  const nonExcludedCountryName = nonExcludedVocab.country;

  const testChannelIdNonExcluded = `test-sighting-only-nonexcluded-${Date.now()}`;
  const testChannelIdExcluded = `test-sighting-only-excluded-${Date.now()}`;

  try {
    // A: Insert historical COUNTRY_REJECTED sighting with persisted=false and NO channels row (Non-excluded creator)
    await db.query(
      `INSERT INTO channel_sightings(channel_id, query_id, funnel_outcome, country_outcome, persisted, metadata, observed_at)
       VALUES ($1, 'q-test-1', 'COUNTRY_REJECTED', 'REJECTED', false, jsonb_build_object('channelName', 'Trader Channel', 'country', $2, 'source', 'test'), now())`,
      [testChannelIdNonExcluded, nonExcludedCountryName]
    );

    // Insert historical COUNTRY_REJECTED sighting with persisted=false and NO channels row (Excluded creator)
    await db.query(
      `INSERT INTO channel_sightings(channel_id, query_id, funnel_outcome, country_outcome, persisted, metadata, observed_at)
       VALUES ($1, 'q-test-2', 'COUNTRY_REJECTED', 'REJECTED', false, jsonb_build_object('channelName', 'Trader Channel', 'country', $2, 'source', 'test'), now())`,
      [testChannelIdExcluded, excludedCountryName]
    );

    // Verify initial state: NO channels row exists for either sighting candidate
    const initialChannelNonExcluded = await getChannelById(testChannelIdNonExcluded);
    const initialChannelExcluded = await getChannelById(testChannelIdExcluded);
    assert.equal(initialChannelNonExcluded, null, 'No channels row should exist prior to recovery processing');
    assert.equal(initialChannelExcluded, null, 'No channels row should exist prior to recovery processing');

    // B: Test Cohort Discovery
    const cohort = await loadCohort();

    const candidateNonExcluded = cohort.find((c: any) => c.channel_id === testChannelIdNonExcluded);
    assert.ok(candidateNonExcluded, 'Non-excluded sighting-only candidate must be discovered by loadCohort()');
    assert.equal(candidateNonExcluded.reconciliation.state, 'RECOVERABLE_NON_EXCLUDED');
    assert.equal(candidateNonExcluded.executionEligible, true);

    const candidateExcluded = cohort.find((c: any) => c.channel_id === testChannelIdExcluded);
    assert.ok(candidateExcluded, 'Excluded sighting-only candidate must be discovered by loadCohort()');
    assert.equal(candidateExcluded.reconciliation.state, 'RETAIN_EXCLUDED');
    assert.equal(candidateExcluded.executionEligible, false);

    // C: Test End-to-End Worker Recovery Processing for Recoverable Non-Excluded Sighting Candidate
    const recoveryResult = await processCountryBoundaryReprocessJob({ payload: { channelId: testChannelIdNonExcluded } });
    assert.equal(recoveryResult.recovered, true, 'Recoverable sighting-only candidate must be recovered');
    assert.equal(recoveryResult.reconciliationState, 'RECOVERABLE_NON_EXCLUDED');

    // Verify materialization into channels table
    const materializedChannel = await getChannelById(testChannelIdNonExcluded);
    assert.ok(materializedChannel, 'Recovered sighting-only candidate must be materialized into channels table');
    assert.equal(materializedChannel.country_status, 'CONFIRMED');
    assert.equal(materializedChannel.scan_status, 'PENDING');
    assert.equal(materializedChannel.country, nonExcludedCountryName);

    // Verify historical sighting is preserved (0 deletions)
    const sightingCheck = await db.query('SELECT 1 FROM channel_sightings WHERE channel_id=$1', [testChannelIdNonExcluded]);
    assert.ok(sightingCheck.rowCount > 0, 'Historical channel_sighting must be preserved without deletion');

    // Verify recovery audit event creation & idempotency
    const auditRes = await db.query('SELECT * FROM historical_country_boundary_recovery_events WHERE channel_id=$1', [testChannelIdNonExcluded]);
    assert.equal(auditRes.rowCount, 1, 'Recovery audit event must be created');

    // Run processCountryBoundaryReprocessJob again to verify worker idempotency
    const idempotentResult = await processCountryBoundaryReprocessJob({ payload: { channelId: testChannelIdNonExcluded } });
    assert.equal(idempotentResult.recovered, true, 'Idempotent worker execution must return recovered status');
    const auditRes2 = await db.query('SELECT * FROM historical_country_boundary_recovery_events WHERE channel_id=$1', [testChannelIdNonExcluded]);
    assert.equal(auditRes2.rowCount, 1, 'Recovery audit event must not be duplicated on idempotent re-run');

    // D: Test Worker Execution for Excluded Sighting Candidate
    const excludedRecoveryResult = await processCountryBoundaryReprocessJob({ payload: { channelId: testChannelIdExcluded } });
    assert.equal(excludedRecoveryResult.recovered, false, 'Excluded sighting candidate must NOT be recovered');
    assert.equal(excludedRecoveryResult.reconciliationState, 'RETAIN_EXCLUDED');

    // Verify excluded sighting remains unmaterialized into normal channel enrichment
    const unmaterializedExcluded = await getChannelById(testChannelIdExcluded);
    assert.equal(unmaterializedExcluded, null, 'Excluded sighting candidate must NOT be materialized into channels table');

    // Verify auditable retention event logged for excluded candidate
    const auditExcludedRes = await db.query('SELECT * FROM historical_country_boundary_recovery_events WHERE channel_id=$1', [testChannelIdExcluded]);
    assert.equal(auditExcludedRes.rowCount, 1, 'Auditable retention event must be created for excluded candidate');

  } finally {
    await db.query(`DELETE FROM historical_country_boundary_recovery_events WHERE channel_id IN ($1, $2)`, [testChannelIdNonExcluded, testChannelIdExcluded]);
    await db.query(`DELETE FROM channels WHERE channel_id IN ($1, $2)`, [testChannelIdNonExcluded, testChannelIdExcluded]);
    await db.query(`DELETE FROM channel_sightings WHERE channel_id IN ($1, $2)`, [testChannelIdNonExcluded, testChannelIdExcluded]);
  }
});
