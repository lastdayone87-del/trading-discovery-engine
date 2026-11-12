/**
 * Destructive end-to-end admission lifecycle test for a disposable/staging
 * PostgreSQL database only.
 *
 * Required:
 *   ADMISSION_STAGING_DATABASE_URL=postgresql://...
 *   --confirm-staging
 *
 * The script refuses to run without both. It writes only to the database in
 * that URL; it never reads production settings or applies production changes.
 */
import assert from 'node:assert/strict';
import { getDb, getChannelById, insertChannelIfAbsent } from '../server/db';
import {
  enqueueAdmissionVerification,
  findAdmissionCandidate,
  getAdmissionMode,
  hasActiveAdmissionJob,
  upsertAdmissionCandidate,
} from '../server/channelAdmission/store';
import {
  resolveAdmissionReview,
  resumeAdmittedCandidate,
  verifyAdmissionCandidate,
} from '../server/channelAdmission';
import { nextAdmissionVerificationAttempt } from '../server/channelAdmission/worker';
import type { AdmissionCandidateInput, AdmissionEvidence, SemanticJudgment } from '../server/channelAdmission/types';
import type { ChannelRecord } from '../src/types';

const PREFIX = 'UCSTG_';

function fixtureEvidence(input: {
  channelId: string;
  channelName: string;
  description: string;
  videos: Array<{ title: string; description?: string }>;
}): AdmissionEvidence {
  return {
    channelId: input.channelId,
    channelName: input.channelName,
    youtubeUrl: `https://youtube.com/channel/${input.channelId}`,
    description: input.description,
    links: [],
    country: 'SE',
    declaredLanguage: 'en',
    videos: input.videos.map((video, index) => ({
      videoId: `v${index}`,
      title: video.title,
      description: video.description || '',
      publishedAt: '2026-11-01T00:00:00.000Z',
    })),
    source: 'automated_query',
    targetCountry: 'Sweden',
    evidenceCoverage: 'COMPLETE',
    fetchedAt: new Date().toISOString(),
  };
}

const tradingEvidence = fixtureEvidence({
  channelId: `${PREFIX}DET_ADMIT`,
  channelName: 'Nifty Hindi Trader',
  description: 'Nifty और Bank Nifty पर रोज़ाना ट्रेडिंग विश्लेषण, चार्ट सेटअप और रिस्क मैनेजमेंट.',
  videos: [
    { title: 'Nifty 50 आज का विश्लेषण', description: 'Technical analysis और price action.' },
    { title: 'Bank Nifty ट्रेड सेटअप', description: 'Market structure और risk management.' },
    { title: 'Weekly market outlook', description: 'Support and resistance levels.' },
  ],
});

const cookingEvidence = fixtureEvidence({
  channelId: `${PREFIX}DET_REJECT`,
  channelName: 'Kikifoodies',
  description: 'Cooking made SIMPLE',
  videos: [
    { title: 'The best Sliced Bread Recipe', description: 'Ingredients and baking instructions.' },
    { title: 'Mexican Red Rice Recipe', description: 'A rice recipe.' },
    { title: 'Easy Chicken StirFry', description: 'A cooking recipe.' },
    { title: 'How to Make Puff Puff', description: 'A pastry recipe.' },
  ],
});

const reviewEvidence = fixtureEvidence({
  channelId: `${PREFIX}REVIEW`,
  channelName: 'Sparse Review Candidate',
  description: 'Short bio',
  videos: [{ title: 'One video' }],
});

const unknownJudgment: SemanticJudgment = {
  mainSubject: 'UNKNOWN',
  tradingFocus: 40,
  unrelatedDomains: [],
  incidentalTradingMentions: [],
  citations: [],
  explanation: 'Staging fixture: genuinely ambiguous.',
  model: 'staging-fixture',
  provider: 'gemini_semantic',
};

const unknownJudge = {
  async judge(): Promise<SemanticJudgment> {
    return { ...unknownJudgment };
  },
};

const providerFailureJudge = {
  async judge(): Promise<SemanticJudgment> {
    throw Object.assign(new Error('429 rate limit exceeded'), { status: 429, retryable: true });
  },
};

function candidateInput(evidence: AdmissionEvidence): AdmissionCandidateInput {
  return {
    candidate: {
      channelId: evidence.channelId,
      channelName: evidence.channelName,
      youtubeUrl: evidence.youtubeUrl,
      description: evidence.description,
      videoTitles: evidence.videos.map(video => video.title),
      videoDescriptions: evidence.videos.map(video => video.description),
    },
    targetCountry: 'Sweden',
    source: 'automated_query',
  };
}

async function cleanup(db: any): Promise<void> {
  const ids = `${PREFIX}%`;
  await db.query(`DELETE FROM semantic_admission_sightings WHERE candidate_id IN (SELECT id FROM semantic_admission_candidates WHERE channel_id LIKE $1)`, [ids]);
  await db.query(`DELETE FROM semantic_admission_decisions WHERE channel_id LIKE $1`, [ids]);
  await db.query(`DELETE FROM semantic_admission_candidates WHERE channel_id LIKE $1`, [ids]);
  await db.query(`DELETE FROM jobs WHERE payload->>'channelId' LIKE $1`, [ids]);
  await db.query(`DELETE FROM channel_reviews WHERE channel_id LIKE $1`, [ids]);
  await db.query(`DELETE FROM channels WHERE channel_id LIKE $1`, [ids]);
}

async function insertDeferredChannel(channelId: string): Promise<void> {
  const now = new Date().toISOString();
  const channel: ChannelRecord = {
    channel_id: channelId,
    channel_name: 'Deferred Review Channel',
    youtube_url: `https://youtube.com/channel/${channelId}`,
    country: 'SE',
    country_status: 'UNCERTAIN',
    confidence_score: 0,
    discord_status: 'UNCERTAIN',
    discord_invite: null,
    scan_status: 'INTAKE_DEFERRED',
    scan_attempts: 0,
    discovery_source: 'automated_query',
    first_seen: now,
    last_checked: now,
    trading_status: 'UNCERTAIN',
    trading_confidence_score: 0,
    trading_category: 'General Trading',
  };
  await insertChannelIfAbsent(channel);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm-staging')) {
    throw new Error('REFUSING_TO_RUN: pass --confirm-staging');
  }
  const stagingUrl = String(process.env.ADMISSION_STAGING_DATABASE_URL || '').trim();
  if (!stagingUrl) throw new Error('ADMISSION_STAGING_DATABASE_URL_REQUIRED');
  if (/prod/i.test(stagingUrl)) throw new Error('REFUSING_PRODUCTION_LIKE_URL');
  process.env.DATABASE_URL = stagingUrl;

  const db = await getDb();
  const checks: Array<{ name: string; ok: boolean; details?: unknown }> = [];
  const check = async (name: string, work: () => Promise<unknown>) => {
    try {
      const details = await work();
      checks.push({ name, ok: true, details });
      console.log(JSON.stringify({ event: 'staging_check', name, ok: true, details }));
    } catch (error) {
      checks.push({ name, ok: false, details: error instanceof Error ? error.message : String(error) });
      console.log(JSON.stringify({ event: 'staging_check', name, ok: false, error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  };

  await cleanup(db);
  await db.query(`INSERT INTO app_settings(setting_key,setting_value) VALUES('channel_admission_mode','ACTIVE') ON CONFLICT (setting_key) DO UPDATE SET setting_value='ACTIVE'`);
  assert.equal(await getAdmissionMode(), 'ACTIVE');
  checks.push({ name: 'admission mode ACTIVE in staging', ok: true });

  const schema = await db.query(`SELECT to_regclass('public.semantic_admission_candidates') AS candidates, to_regclass('public.semantic_admission_decisions') AS decisions`);
  assert.ok(schema.rows[0]?.candidates && schema.rows[0]?.decisions, 'migration 178 tables missing');
  checks.push({ name: 'migration 178 tables present', ok: true });

  await check('deterministic ADMIT persists ledger, candidate, channel and classification once', async () => {
    const input = candidateInput(tradingEvidence);
    const row = await upsertAdmissionCandidate(input);
    const result = await verifyAdmissionCandidate(input, { row, evidenceOverride: tradingEvidence });
    assert.equal(result.status, 'ADMITTED');
    assert.equal(result.decisionSource, 'DETERMINISTIC');
    const candidate = await findAdmissionCandidate(tradingEvidence.channelId);
    assert.equal(candidate?.status, 'ADMITTED');
    const ledger = await db.query(`SELECT decision,evidence_hash,semantic_output FROM semantic_admission_decisions WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 1`, [tradingEvidence.channelId]);
    assert.equal(ledger.rows[0]?.decision, 'ADMIT');
    assert.ok(ledger.rows[0]?.evidence_hash);
    const channel = await getChannelById(tradingEvidence.channelId);
    assert.equal(channel?.admission_status, 'ADMITTED');
    assert.ok(channel?.admission_decision_id);
    const jobs = await db.query(`SELECT id,status,idempotency_key FROM jobs WHERE payload->>'channelId'=$1 AND type='CLASSIFY_DISCOVERED_CHANNEL'`, [tradingEvidence.channelId]);
    assert.equal(jobs.rowCount, 1);
    await resumeAdmittedCandidate(input, candidate!);
    await resumeAdmittedCandidate(input, candidate!);
    const jobsAgain = await db.query(`SELECT id FROM jobs WHERE payload->>'channelId'=$1 AND type='CLASSIFY_DISCOVERED_CHANNEL'`, [tradingEvidence.channelId]);
    assert.equal(jobsAgain.rowCount, 1);
    return { candidateStatus: candidate?.status, channelAdmissionStatus: channel?.admission_status, classificationJobs: jobsAgain.rowCount };
  });

  await check('deterministic REJECT is terminal, cited and never creates a channel or classification job', async () => {
    const input = candidateInput(cookingEvidence);
    const row = await upsertAdmissionCandidate(input);
    const result = await verifyAdmissionCandidate(input, { row, evidenceOverride: cookingEvidence });
    assert.equal(result.status, 'REJECTED_UNRELATED');
    assert.equal(result.decisionSource, 'DETERMINISTIC');
    assert.ok((result.judgment?.citations || []).length >= 2);
    const candidate = await findAdmissionCandidate(cookingEvidence.channelId);
    assert.equal(candidate?.status, 'REJECTED_UNRELATED');
    const ledger = await db.query(`SELECT decision FROM semantic_admission_decisions WHERE channel_id=$1 LIMIT 1`, [cookingEvidence.channelId]);
    assert.equal(ledger.rows[0]?.decision, 'REJECT_UNRELATED');
    const channel = await getChannelById(cookingEvidence.channelId);
    assert.equal(channel, null);
    const jobs = await db.query(`SELECT id FROM jobs WHERE payload->>'channelId'=$1`, [cookingEvidence.channelId]);
    assert.equal(jobs.rowCount, 0);
    return { citations: result.judgment?.citations.length || 0, channel: null };
  });

  await check('semantic ambiguity persists terminal NEEDS_REVIEW without channel or enrichment', async () => {
    const input = candidateInput(reviewEvidence);
    const row = await upsertAdmissionCandidate(input);
    const result = await verifyAdmissionCandidate(input, { row, evidenceOverride: reviewEvidence, judge: unknownJudge });
    assert.equal(result.status, 'NEEDS_REVIEW');
    const candidate = await findAdmissionCandidate(reviewEvidence.channelId);
    assert.equal(candidate?.status, 'NEEDS_REVIEW');
    const ledger = await db.query(`SELECT decision FROM semantic_admission_decisions WHERE channel_id=$1 LIMIT 1`, [reviewEvidence.channelId]);
    assert.equal(ledger.rows[0]?.decision, 'NEEDS_REVIEW');
    assert.equal(await getChannelById(reviewEvidence.channelId), null);
    const jobs = await db.query(`SELECT id FROM jobs WHERE payload->>'channelId'=$1`, [reviewEvidence.channelId]);
    assert.equal(jobs.rowCount, 0);
    return { candidateStatus: candidate?.status, jobs: 0 };
  });

  await check('human review ADMIT creates a channel and one durable classification', async () => {
    const resolved = await resolveAdmissionReview({
      channelId: reviewEvidence.channelId,
      action: 'ADMIT',
      reviewer: 'staging-e2e',
      reason: 'fixture confirms trading evidence',
    });
    assert.equal(resolved.status, 'ADMITTED');
    const candidate = await findAdmissionCandidate(reviewEvidence.channelId);
    assert.equal(candidate?.status, 'ADMITTED');
    const channel = await getChannelById(reviewEvidence.channelId);
    assert.equal(channel?.admission_status, 'ADMITTED');
    const jobs = await db.query(`SELECT id FROM jobs WHERE payload->>'channelId'=$1 AND type='CLASSIFY_DISCOVERED_CHANNEL'`, [reviewEvidence.channelId]);
    assert.equal(jobs.rowCount, 1);
    const ledger = await db.query(`SELECT decision FROM semantic_admission_decisions WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 1`, [reviewEvidence.channelId]);
    assert.equal(ledger.rows[0]?.decision, 'ADMIT');
    return { status: resolved.status, classificationJobs: jobs.rowCount };
  });

  await check('human review REJECT projects an existing deferred channel', async () => {
    const evidence = fixtureEvidence({
      channelId: `${PREFIX}REVIEW_REJECT`,
      channelName: 'Human Reject Candidate',
      description: 'Short bio',
      videos: [{ title: 'One video' }],
    });
    const input = candidateInput(evidence);
    await insertDeferredChannel(evidence.channelId);
    const row = await upsertAdmissionCandidate(input);
    const result = await verifyAdmissionCandidate(input, { row, evidenceOverride: evidence, judge: unknownJudge });
    assert.equal(result.status, 'NEEDS_REVIEW');
    const resolved = await resolveAdmissionReview({
      channelId: evidence.channelId,
      action: 'REJECT',
      reviewer: 'staging-e2e',
      reason: 'fixture is not a trading creator',
    });
    assert.equal(resolved.status, 'REJECTED_UNRELATED');
    const channel = await getChannelById(evidence.channelId);
    assert.equal(channel?.scan_status, 'SKIPPED_NON_TRADING');
    assert.equal(channel?.trading_status, 'NON_TRADING');
    return { status: resolved.status, channelScanStatus: channel?.scan_status };
  });

  await check('human review REQUEUE creates exactly one fresh PENDING admission job', async () => {
    const evidence = fixtureEvidence({
      channelId: `${PREFIX}REQUEUE`,
      channelName: 'Requeue Candidate',
      description: 'Short bio',
      videos: [{ title: 'One video' }],
    });
    const input = candidateInput(evidence);
    const row = await upsertAdmissionCandidate(input);
    const result = await verifyAdmissionCandidate(input, { row, evidenceOverride: evidence, judge: unknownJudge });
    assert.equal(result.status, 'NEEDS_REVIEW');
    const resolved = await resolveAdmissionReview({
      channelId: evidence.channelId,
      action: 'REQUEUE',
      reviewer: 'staging-e2e',
      reason: 'retry with fresh evidence',
    });
    assert.equal(resolved.status, 'PENDING');
    const jobs = await db.query(`SELECT status,idempotency_key FROM jobs WHERE payload->>'channelId'=$1 AND type='VERIFY_CHANNEL_ADMISSION'`, [evidence.channelId]);
    assert.equal(jobs.rowCount, 1);
    assert.equal(jobs.rows[0].status, 'PENDING');
    assert.match(jobs.rows[0].idempotency_key, /:review:/);
    assert.equal(await hasActiveAdmissionJob(evidence.channelId), true);
    return { jobs: jobs.rowCount, key: jobs.rows[0].idempotency_key };
  });

  await check('provider failure retains attempts/expiry and schedules retry:2 then retry:3', async () => {
    const evidence = fixtureEvidence({
      channelId: `${PREFIX}DEFERRED`,
      channelName: 'Provider Deferred Candidate',
      description: 'Short bio',
      videos: [{ title: 'One video' }],
    });
    const input = candidateInput(evidence);
    const row = await upsertAdmissionCandidate(input);
    const result = await verifyAdmissionCandidate(input, { row, evidenceOverride: evidence, judge: providerFailureJudge });
    assert.equal(result.status, 'PROVIDER_DEFERRED');
    const candidate = await findAdmissionCandidate(evidence.channelId);
    assert.equal(candidate?.status, 'PROVIDER_DEFERRED');
    assert.equal(Number(candidate?.attempts), 0);
    assert.equal(candidate?.expires_at, null);
    assert.ok(candidate?.next_check_at);
    const ledger = await db.query(`SELECT id FROM semantic_admission_decisions WHERE channel_id=$1`, [evidence.channelId]);
    assert.equal(ledger.rowCount, 0);
    const attempt2 = nextAdmissionVerificationAttempt({ status: 'PROVIDER_DEFERRED', jobAttempt: 1, candidateAttempts: 0 });
    await enqueueAdmissionVerification({ candidate: input, attempt: attempt2, runAfter: candidate!.next_check_at! });
    const attempt3 = nextAdmissionVerificationAttempt({ status: 'PROVIDER_DEFERRED', jobAttempt: 2, candidateAttempts: 0 });
    await enqueueAdmissionVerification({ candidate: input, attempt: attempt3, runAfter: candidate!.next_check_at! });
    const keys = await db.query(`SELECT idempotency_key,status FROM jobs WHERE payload->>'channelId'=$1 AND type='VERIFY_CHANNEL_ADMISSION' ORDER BY idempotency_key`, [evidence.channelId]);
    assert.equal(keys.rowCount, 2);
    assert.ok(keys.rows.some((job: any) => job.idempotency_key.endsWith(':retry:2')));
    assert.ok(keys.rows.some((job: any) => job.idempotency_key.endsWith(':retry:3')));
    return { attempts: candidate?.attempts, expiresAt: candidate?.expires_at, retryKeys: keys.rows.map((job: any) => job.idempotency_key) };
  });

  await check('duplicate admission enqueue is idempotent and active-job detection works', async () => {
    const evidence = fixtureEvidence({
      channelId: `${PREFIX}DEDUPE`,
      channelName: 'Dedupe Candidate',
      description: 'Short bio',
      videos: [{ title: 'One video' }],
    });
    const input = candidateInput(evidence);
    const first = await upsertAdmissionCandidate(input);
    const second = await upsertAdmissionCandidate(input);
    assert.equal(first.id, second.id);
    await enqueueAdmissionVerification({ candidate: input });
    await enqueueAdmissionVerification({ candidate: input });
    const jobs = await db.query(`SELECT id FROM jobs WHERE payload->>'channelId'=$1 AND type='VERIFY_CHANNEL_ADMISSION'`, [evidence.channelId]);
    assert.equal(jobs.rowCount, 1);
    assert.equal(await hasActiveAdmissionJob(evidence.channelId), true);
    return { candidateRows: 1, admissionJobs: jobs.rowCount };
  });

  const failed = checks.filter(item => !item.ok);
  console.log(JSON.stringify({
    event: 'staging_e2e_complete',
    checks: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    results: checks,
    timestamp: new Date().toISOString(),
  }));
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error('Staging admission E2E failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
