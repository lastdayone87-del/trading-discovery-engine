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
  country: 'Germany',
  country_status: 'REJECTED',
  inspection_trail: [{ step: 'Country Validation (Germany)', details: 'Target Country Boundary: REJECTED — creator country differs from pinned discovery country Netherlands.' }],
  trading_status: 'TRADING_CONFIRMED',
  ...overrides
}) as any;

test('dry-run eligibility requires non-excluded pinned-boundary rejection', () => {
  assert.equal(isNonExcludedBoundaryCandidate(candidate({ country_status: 'REJECTED' }), [{ country_name: 'Vietnam' }]), true);
  assert.equal(isNonExcludedBoundaryCandidate(candidate({ country_status: 'CONFIRMED', inspection_trail: [] }), [{ country_name: 'Vietnam' }]), false);
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
  const channel = candidate({
    country: 'Germany',
    country_status: 'REJECTED',
    channel_name: 'Börsenblick Deutschland',
    inspection_trail: [
      { step: 'COUNTRY_VALIDATION', details: 'Target Country Boundary: REJECTED — creator country differs from pinned discovery country Canada.' },
      { step: 'BIO', details: 'Börsenanalyse und Handelsstrategie in Deutschland' }
    ]
  });

  const res = classifyReconciliationState(channel, [{ country_name: 'India' }]);
  assert.equal(res.state, 'RECOVERABLE_NON_EXCLUDED');
  assert.equal(res.detectedCountry, 'Germany');
});

test('TEST D: Reconciliation classification - RETAIN_EXCLUDED', async () => {
  const { classifyReconciliationState } = await import('./countryBoundaryRecovery');
  const channel = candidate({
    country: 'India',
    country_status: 'REJECTED',
    channel_name: 'Nifty Trader Mumbai',
    inspection_trail: [
      { step: 'COUNTRY_VALIDATION', details: 'Target Country Boundary: REJECTED' },
      { step: 'BIO', details: 'Indian trader in Mumbai covering Nifty 50 and Zerodha' }
    ]
  });

  const res = classifyReconciliationState(channel, [{ country_name: 'India' }]);
  assert.equal(res.state, 'RETAIN_EXCLUDED');
  assert.equal(res.detectedCountry, 'India');
});

test('TEST E: Reconciliation classification - INSUFFICIENT_EVIDENCE', async () => {
  const { classifyReconciliationState } = await import('./countryBoundaryRecovery');
  const channel = candidate({
    country: 'Germany',
    country_status: 'REJECTED',
    channel_name: 'Generic Channel Name',
    inspection_trail: [
      { step: 'COUNTRY_VALIDATION', details: 'Target Country Boundary: REJECTED' }
    ]
  });

  const res = classifyReconciliationState(channel, [{ country_name: 'India' }]);
  assert.equal(res.state, 'INSUFFICIENT_EVIDENCE');
});

test('TEST F: Reconciliation classification - LEGITIMATE_REJECTION', async () => {
  const { classifyReconciliationState } = await import('./countryBoundaryRecovery');
  const channel = candidate({
    country: 'India',
    country_status: 'REJECTED',
    channel_name: 'Nifty Scalper',
    inspection_trail: [
      { step: 'COUNTRY_VALIDATION', details: 'India is excluded by policy: South Asian Exclusion' }
    ]
  });

  const res = classifyReconciliationState(channel, [{ country_name: 'India' }]);
  assert.equal(res.state, 'LEGITIMATE_REJECTION');
});

test('TEST G: Dashboard projection SQL filters out excluded countries and non-rejected status correctly', async () => {
  const { OPERATOR_VISIBLE_CHANNEL_SQL } = await import('./dbCore');
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /country_status <> 'REJECTED'/);
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /NOT EXISTS[\s\S]+FROM excluded_countries/);
});

test('TEST H: loadCohort discovers unpersisted historical channel_sightings without channels row', async () => {
  const { loadCohort } = await import('./countryBoundaryRecovery');
  const { getDb } = await import('./db');

  let db: any;
  try {
    db = await getDb();
  } catch {
    // Skip DB-dependent test if database unavailable
    return;
  }

  const testChannelIdNonExcluded = `test-sighting-only-ca-${Date.now()}`;
  const testChannelIdExcluded = `test-sighting-only-in-${Date.now()}`;

  try {
    // Insert sighting-only row for non-excluded country (Canada)
    await db.query(
      `INSERT INTO channel_sightings(channel_id, query_id, funnel_outcome, country_outcome, metadata, observed_at)
       VALUES ($1, 'q-test-1', 'COUNTRY_REJECTED', 'REJECTED', jsonb_build_object('channelName', 'Börsenblick Canada', 'country', 'Canada', 'source', 'test'), now())`,
      [testChannelIdNonExcluded]
    );

    // Insert sighting-only row for excluded country (India)
    await db.query(
      `INSERT INTO channel_sightings(channel_id, query_id, funnel_outcome, country_outcome, metadata, observed_at)
       VALUES ($1, 'q-test-2', 'COUNTRY_REJECTED', 'REJECTED', jsonb_build_object('channelName', 'Nifty Trader Mumbai', 'country', 'India', 'source', 'test'), now())`,
      [testChannelIdExcluded]
    );

    // Ensure India is in excluded_countries for test
    await db.query(`INSERT INTO excluded_countries(country_name, reason) VALUES ('India', 'South Asian Exclusion') ON CONFLICT DO NOTHING`);

    // Dynamically access loadCohort
    const cohort = await (loadCohort as any)();

    const candidateNonExcluded = cohort.find((c: any) => c.channel_id === testChannelIdNonExcluded);
    assert.ok(candidateNonExcluded, 'Non-excluded sighting-only candidate should be discovered by loadCohort');
    assert.equal(candidateNonExcluded.reconciliation.state, 'RECOVERABLE_NON_EXCLUDED');
    assert.equal(candidateNonExcluded.executionEligible, true);

    const candidateExcluded = cohort.find((c: any) => c.channel_id === testChannelIdExcluded);
    assert.ok(candidateExcluded, 'Excluded sighting-only candidate should be discovered by loadCohort');
    assert.equal(candidateExcluded.reconciliation.state, 'RETAIN_EXCLUDED');
    assert.equal(candidateExcluded.executionEligible, false);
  } finally {
    await db.query(`DELETE FROM channel_sightings WHERE channel_id IN ($1, $2)`, [testChannelIdNonExcluded, testChannelIdExcluded]);
  }
});
