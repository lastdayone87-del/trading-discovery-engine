import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  computeAdaptivePilotMetrics,
  recordAdaptivePilotAssignment
} from './adaptiveDiscoveryPilot';
import { ADAPTIVE_PILOT_POLICY_VERSION } from './adaptiveDiscoveryPilotPolicy';
import {
  buildFrontierProposal,
  generateCreatorDerivedProposals,
  persistFrontierProposals
} from './discoveryProposalGenerators';
import { getNeighborhoodCandidates } from './discoveryFrontierAllocator';
import { planCountryNativeProposalQuery } from './queryPlanner';

/**
 * Dedicated-database tests for the adaptive pilot assignment ledger. The CI
 * workflow applies the full migration lineage first; without an explicitly
 * provided scratch database these tests skip rather than touching any shared
 * database.
 */
const dedicatedUrl = process.env.ADAPTIVE_PILOT_TEST_DATABASE_URL;

test('adaptive pilot PostgreSQL tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicatedUrl) {
    console.log('SKIP: set ADAPTIVE_PILOT_TEST_DATABASE_URL to run the adaptive pilot PostgreSQL tests.');
  }
  assert.ok(true);
});

const maybe = dedicatedUrl ? test : test.skip;
const migration156 = readFileSync(
  fileURLToPath(new URL('./db/migrations/156_adaptive_discovery_pilot.sql', import.meta.url)),
  'utf8'
);
const runTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const seed = `pg-${runTag}`;
const windowStart = '2026-10-23T07:00:00.000Z';
const windowEnd = '2026-10-24T07:00:00.000Z';

let pool: Pool | null = null;

async function requirePool(): Promise<Pool> {
  if (!pool) {
    pool = new pg.Pool({ connectionString: dedicatedUrl, max: 5 });
    await pool.query(migration156);
  }
  return pool;
}

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM adaptive_discovery_pilot_assignments WHERE assignment_seed=$1', [seed]).catch(() => undefined);
  await pool.end();
});

maybe('assignments are immutable and idempotent for the same country-day', async () => {
  const db = await requirePool();
  const first = await recordAdaptivePilotAssignment({
    country: 'US',
    quotaDay: '2026-10-23',
    arm: 'TREATMENT',
    treatmentPercent: 50,
    seed,
    windowStart,
    windowEnd
  }, db);
  const replay = await recordAdaptivePilotAssignment({
    country: 'US',
    quotaDay: '2026-10-23',
    arm: 'CONTROL',
    treatmentPercent: 50,
    seed,
    windowStart,
    windowEnd
  }, db);
  assert.equal(first.arm, 'TREATMENT');
  assert.equal(replay.arm, 'TREATMENT', 'a later config change must not flip an existing country-day arm');
  assert.equal(replay.assignmentKey, first.assignmentKey);
  const policyReplay = await recordAdaptivePilotAssignment({
    country: 'US',
    quotaDay: '2026-10-23',
    arm: 'CONTROL',
    treatmentPercent: 50,
    seed,
    windowStart,
    windowEnd,
    policyVersion: 'adaptive-country-pilot-v2'
  }, db);
  assert.equal(policyReplay.arm, 'TREATMENT',
    'a policy release during the day must reuse the recorded arm');
  assert.equal(policyReplay.assignmentKey, first.assignmentKey);
  assert.equal(policyReplay.policyVersion, ADAPTIVE_PILOT_POLICY_VERSION,
    'the ledger keeps the policy that actually randomized the day');
  const count = await db.query(
    'SELECT count(*)::int AS count FROM adaptive_discovery_pilot_assignments WHERE assignment_seed=$1',
    [seed]
  );
  assert.equal(Number(count.rows[0].count), 1, 'one country-day must never have two arms');
});

maybe('a recurring creator concept is persisted and allocatable on the next treatment day', async () => {
  const db = await requirePool();
  const concept = `price action ${runTag}`;
  const dayOneStart = '2026-10-23T07:00:00.000Z';
  const dayOneEnd = '2026-10-24T07:00:00.000Z';
  const dayTwoStart = '2026-10-24T07:00:00.000Z';
  const dayTwoEnd = '2026-10-25T07:00:00.000Z';
  const dayTwoAssignment = await recordAdaptivePilotAssignment({
    country: 'US',
    quotaDay: '2026-10-24',
    arm: 'TREATMENT',
    treatmentPercent: 100,
    seed,
    windowStart: dayTwoStart,
    windowEnd: dayTwoEnd
  }, db);

  const proposal = (quotaDay: string, expiresAt: string, assignmentKey: string) =>
    buildFrontierProposal({
      proposalFamily: 'CREATOR_DERIVED',
      country: 'US',
      concept,
      retrievalLane: 'VIDEO',
      sourceFamily: 'creator_derived',
      sourceProvenance: `creator_metadata:pg-${runTag}:${concept}`,
      expiresAt,
      dedupDiscriminator: assignmentKey,
      supportingEvidence: {
        channelId: `pg-${runTag}`,
        nativeTerm: concept,
        sourceProvenanceFamily: 'CREATOR_DERIVED',
        pilotArm: 'TREATMENT',
        pilotQuotaDay: quotaDay,
        pilotAssignmentKey: assignmentKey,
        pilotPolicyVersion: ADAPTIVE_PILOT_POLICY_VERSION
      },
      noveltyRationale: 'PostgreSQL consecutive-day regression.'
    });

  const dayOne = proposal('2026-10-23', dayOneEnd, `day-one-${runTag}`);
  const dayTwo = proposal('2026-10-24', dayTwoEnd, dayTwoAssignment.assignmentKey);
  assert.notEqual(dayOne.dedupKey, dayTwo.dedupKey);

  try {
    assert.equal(await persistFrontierProposals([dayOne], db), 1);
    assert.equal(await persistFrontierProposals([dayTwo], db), 1);

    const rows = await db.query(
      `SELECT proposal_id::text, dedup_key, supporting_evidence->>'pilotQuotaDay' AS quota_day
       FROM frontier_discovery_proposals WHERE concept=$1`,
      [concept]
    );
    assert.equal(rows.rowCount, 2, 'both country-day proposals must persist');
    const dayOneId = rows.rows.find(row => row.quota_day === '2026-10-23')?.proposal_id;
    const dayTwoId = rows.rows.find(row => row.quota_day === '2026-10-24')?.proposal_id;
    assert.ok(dayOneId && dayTwoId);

    await db.query(
      `INSERT INTO app_settings(setting_key,setting_value)
       VALUES('adaptive_discovery_pilot_enabled','true')
       ON CONFLICT(setting_key) DO UPDATE SET setting_value='true'`
    );
    const candidates = await getNeighborhoodCandidates('US', new Date('2026-10-24T12:00:00.000Z'), db);
    assert.ok(candidates.some(candidate => candidate.proposalId === dayTwoId), 'day-two proposal must be allocatable');
    assert.ok(!candidates.some(candidate => candidate.proposalId === dayOneId), 'expired day-one proposal must not be selected');
  } finally {
    await db.query(`DELETE FROM app_settings WHERE setting_key='adaptive_discovery_pilot_enabled'`).catch(() => undefined);
    await db.query(`DELETE FROM frontier_discovery_proposals WHERE concept=$1`, [concept]).catch(() => undefined);
    await db.query(`DELETE FROM discovery_neighborhoods WHERE neighborhood_key=$1`, [dayTwo.targetNeighborhoodKey]).catch(() => undefined);
  }
});

maybe('creator-derived proposals retain a canonical country that can authorize a treatment query', async () => {
  const db = await requirePool();
  const country = 'Luxembourg';
  const channelId = `creator-country-${runTag}`;
  await db.query(
    `INSERT INTO channels(
       channel_id,channel_name,youtube_url,country,country_status,discord_status,
       scan_status,discovery_source,first_seen,quality_score,trading_status,trading_category
     ) VALUES($1,$2,$3,$4,'CONFIRMED','NOT_FOUND','COMPLETE','YOUTUBE',now(),90,'TRADING_CONFIRMED','Futures')
     ON CONFLICT(channel_id) DO UPDATE SET
       channel_name=EXCLUDED.channel_name,country=EXCLUDED.country,
       quality_score=EXCLUDED.quality_score,trading_status=EXCLUDED.trading_status,
       trading_category=EXCLUDED.trading_category,updated_at=now()`,
    [channelId, 'DAX Mastery', `https://youtube.test/${channelId}`, country]
  );
  try {
    // Mirrors the uppercase identity the assignment ledger stores; the
    // proposal itself must still carry the canonical country identity.
    const proposals = await generateCreatorDerivedProposals('LUXEMBOURG', 5);
    const proposal = proposals.find(item => item.country === country);
    assert.ok(proposal, 'creator-derived proposal must preserve the canonical country name');
    assert.equal(proposal.targetDimensions.country, country,
      'target dimensions must use the same canonical identity as the proposal');
    const nativeTerm = String(proposal.supportingEvidence.nativeTerm || '');
    assert.ok(nativeTerm);
    const planned = planCountryNativeProposalQuery({
      country: proposal.targetDimensions.country,
      nativeTerm,
      targetIntent: proposal.targetDimensions.queryIntent,
      allocationLineage: { proposalId: 'canonical-country-regression' }
    });
    assert.ok(planned,
      'a canonical country must resolve a curated retrieval anchor instead of RETRIEVAL_ANCHOR_UNAVAILABLE');
  } finally {
    await db.query('DELETE FROM channels WHERE channel_id=$1', [channelId]).catch(() => undefined);
  }
});

maybe('default metrics retain an assignment reused across a policy release', async () => {
  const db = await requirePool();
  const quotaDay = '2026-10-22';
  const oldPolicy = 'adaptive-country-pilot-v1';
  await recordAdaptivePilotAssignment({
    country: 'Ireland',
    quotaDay,
    arm: 'CONTROL',
    treatmentPercent: 50,
    seed,
    policyVersion: oldPolicy,
    windowStart: '2026-10-22T07:00:00.000Z',
    windowEnd: '2026-10-23T07:00:00.000Z'
  }, db);
  const allPolicies = await computeAdaptivePilotMetrics({
    windowStart: '2026-10-22T00:00:00.000Z',
    windowEnd: '2026-10-23T00:00:00.000Z',
    client: db
  });
  assert.ok(allPolicies.arms.CONTROL.assignments >= 1,
    'the default report must include an assignment that kept its original policy version');
  const strictCohort = await computeAdaptivePilotMetrics({
    windowStart: '2026-10-22T00:00:00.000Z',
    windowEnd: '2026-10-23T00:00:00.000Z',
    policyVersion: 'adaptive-country-pilot-unreleased',
    client: db
  });
  assert.equal(strictCohort.arms.CONTROL.assignments, 0,
    'an explicit policy-version filter must remain available for strict cohorts');
});

maybe('metrics return zero runs for an assignment without completed observations', async () => {
  const db = await requirePool();
  await recordAdaptivePilotAssignment({
    country: 'CA',
    quotaDay: '2026-10-23',
    arm: 'CONTROL',
    treatmentPercent: 50,
    seed,
    windowStart,
    windowEnd
  }, db);
  const metrics = await computeAdaptivePilotMetrics({
    windowStart: '2026-10-23T00:00:00.000Z',
    windowEnd: '2026-10-24T00:00:00.000Z',
    client: db
  });
  assert.ok(metrics.arms.CONTROL.assignments >= 1);
  assert.ok(metrics.arms.CONTROL.runs >= 0);
  assert.ok(Number.isFinite(metrics.arms.CONTROL.yieldPerRun));
  assert.ok(Number.isFinite(metrics.uplift.treatmentVsControl.newCreatorsPerRun));
});
