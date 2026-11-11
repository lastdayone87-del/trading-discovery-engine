import { randomUUID } from 'node:crypto';
import type { ChannelRecord, DiscoverySource } from '../../src/types';
import { getDb, getChannelById, hasActiveClassificationJob, insertChannelIfAbsent, upsertChannel } from '../db';
import { CLASSIFICATION_JOB_TYPE, buildClassificationJobPayload, classificationQueryScopeKey } from '../classificationDecoupling';
import { enqueueClassificationJobAtomic } from '../dbCore';
import { validateChannelCountry } from '../countryValidator';
import { assertCountryAllowed } from '../countryExclusion';
import { fetchAdmissionEvidence } from './evidence';
import { ADMISSION_POLICY_VERSION, decideAdmission } from './policy';
import { admissionEvidenceChecksum, needsSecondJudge, ProviderAdmissionJudge, type AdmissionJudge } from './semanticJudge';
import {
  findAdmissionCandidate,
  getAdmissionAmbiguousRate,
  getAdmissionMode,
  recordAdmissionDecision,
  updateAdmissionCandidate,
  type AdmissionCandidateRow,
} from './store';
import type {
  AdmissionCandidateInput,
  AdmissionDecision,
  AdmissionEvidence,
  AdmissionVerificationResult,
  SemanticJudgment,
} from './types';
import type { DiscoveredChannelRaw } from '../youtube';

function evidenceHash(evidence: AdmissionEvidence): string {
  return admissionEvidenceChecksum(evidence);
}

function retryDelayMs(attempt: number): number {
  if (attempt <= 1) return 60 * 60 * 1000;
  if (attempt === 2) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function admittedChannel(input: {
  evidence: AdmissionEvidence;
  decisionId: string;
  status: 'ADMITTED' | 'ADMITTED_AMBIGUOUS';
  source: DiscoverySource;
  now: string;
}): ChannelRecord {
  const candidate = input.evidence;
  return {
    channel_id: candidate.channelId,
    channel_name: candidate.channelName,
    youtube_url: candidate.youtubeUrl,
    country: 'UNKNOWN',
    country_status: 'UNCERTAIN',
    confidence_score: 0,
    discord_status: 'UNCERTAIN',
    discord_invite: null,
    scan_status: 'CLASSIFICATION_PENDING',
    scan_attempts: 0,
    discovery_source: input.source,
    first_seen: input.now,
    last_checked: input.now,
    inspection_trail: [{
      step: 'BIO',
      title: 'Semantic admission',
      status: 'FOUND',
      details: `Admitted by ${ADMISSION_POLICY_VERSION} (${input.status}); downstream classification owns trading status.`,
      timestamp: input.now,
    }],
    subscriber_count: candidate.subscriberCount,
    channel_thumbnail_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(candidate.channelName)}&background=0f172a&color=38bdf8&bold=true`,
    trading_status: 'UNCERTAIN',
    trading_confidence_score: 0,
    trading_category: 'General Trading',
  };
}

async function markChannelAdmitted(input: {
  channelId: string;
  decisionId: string;
  status: 'ADMITTED' | 'ADMITTED_AMBIGUOUS';
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE channels SET admitted_at=COALESCE(admitted_at,now()), admission_status=$2, admission_decision_id=$3, updated_at=now() WHERE channel_id=$1`,
    [input.channelId, input.status, input.decisionId],
  );
}

async function enqueueClassificationAfterAdmission(input: {
  candidate: DiscoveredChannelRaw;
  targetCountry: string;
  source: DiscoverySource;
  query?: string;
  queryId?: number;
  queryRunId?: string;
  discoveryJobId?: string;
  pageNumber?: number;
  admissionDecisionId?: string;
}): Promise<boolean> {
  const payload = buildClassificationJobPayload({
    candidate: input.candidate,
    targetCountry: input.targetCountry,
    source: input.source,
    queryRunId: input.queryRunId,
    queryId: input.queryId,
    queryScopeKey: classificationQueryScopeKey({
      queryRunId: input.queryRunId,
      queryId: input.queryId,
      query: input.query || input.candidate.channelName,
      country: input.targetCountry,
    }),
    discoveryJobId: input.discoveryJobId || `admission:${input.candidate.channelId}`,
    quotaOrigin: 'NORMAL',
    forceExtraction: false,
  });
  const job = await enqueueClassificationJobAtomic(input.candidate.channelId, payload, {
    priority: 20,
    maxAttempts: 4,
    idempotencyKey: `admission-classify:${input.candidate.channelId}:${input.admissionDecisionId || 'v1'}`,
    preventCompletedReopen: true,
  });
  if (job == null) return await hasActiveClassificationJob(input.candidate.channelId);
  // A completed job already owns this decision; a blocked reopen is still a
  // completed classification attempt and must not put the worker in a retry loop.
  return job.status === 'PENDING' || job.status === 'PROCESSING' || job.status === 'COMPLETED';
}

export async function resumeAdmittedCandidate(input: AdmissionCandidateInput, row: AdmissionCandidateRow): Promise<boolean> {
  const channel = await getChannelById(row.channel_id);
  if (!channel) return false;
  const queued = await enqueueClassificationAfterAdmission({
    candidate: input.candidate,
    targetCountry: input.targetCountry,
    source: input.source,
    query: input.query,
    queryId: input.queryId,
    queryRunId: input.queryRunId,
    discoveryJobId: input.discoveryJobId,
    pageNumber: input.pageNumber,
    admissionDecisionId: channel.admission_decision_id || undefined,
  });
  if (!queued) throw new Error('ADMISSION_CLASSIFICATION_ENQUEUE_FAILED');
  return true;
}

export interface VerifyAdmissionOptions {
  judge?: AdmissionJudge;
  row?: AdmissionCandidateRow;
  existingChannel?: ChannelRecord | null;
  dryRun?: boolean;
  /** Legacy revalidation only: retire an existing unrelated row from the dashboard. */
  archiveRejectedExistingChannel?: boolean;
}

export async function verifyAdmissionCandidate(
  input: AdmissionCandidateInput,
  options: VerifyAdmissionOptions = {},
): Promise<AdmissionVerificationResult> {
  const row = options.row || await findAdmissionCandidate(input.candidate.channelId);
  if (!row) throw new Error('ADMISSION_CANDIDATE_MISSING');
  await assertCountryAllowed(input.targetCountry, `admission_worker:${input.candidate.channelId}`);
  const evidence = await fetchAdmissionEvidence({
    candidate: input.candidate,
    targetCountry: input.targetCountry,
    source: input.source,
    query: input.query,
    queryId: input.queryId,
    queryRunId: input.queryRunId,
    pageNumber: input.pageNumber,
    resultRank: input.resultRank,
  });
  const hash = evidenceHash(evidence);

  if (evidence.evidenceCoverage === 'COMPLETE') {
    const country = await validateChannelCountry({
      channelName: evidence.channelName,
      description: evidence.description,
      videoTitles: evidence.videos.map(video => video.title),
      videoDescriptions: evidence.videos.map(video => video.description),
      locationTag: evidence.country,
      externalLinks: evidence.links,
    }, input.targetCountry);
    if (country.status === 'REJECTED') {
      const reasonCodes = ['COUNTRY_POLICY_REJECTED', country.rejectionReason || 'COUNTRY_REJECTED'];
      if (!options.dryRun) {
        await recordAdmissionDecision({
          candidateId: row.id,
          decisionKey: `${row.id}:REJECT_COUNTRY:${hash}`,
          channelId: evidence.channelId,
          decision: 'REJECT_COUNTRY',
          reasonCodes,
          evidenceHash: hash,
        });
        await updateAdmissionCandidate({
          id: row.id,
          status: 'REJECTED_COUNTRY',
          decision: 'REJECT_COUNTRY',
          reasonCodes,
          evidence,
          evidenceHash: hash,
          attempts: Number(row.attempts || 0) + 1,
        });
        const existing = options.existingChannel === undefined ? await getChannelById(evidence.channelId) : options.existingChannel;
        if (existing) {
          existing.country = country.detectedCreatorCountry || existing.country;
          existing.country_status = 'REJECTED';
          existing.scan_status = 'SKIPPED_EXCLUDED';
          existing.trading_status = existing.trading_status || 'UNCERTAIN';
          existing.last_checked = new Date().toISOString();
          await upsertChannel(existing, { allowDiscordClear: true });
        }
      }
      return {
        channelId: evidence.channelId,
        channelName: evidence.channelName,
        decision: 'REJECT_COUNTRY',
        status: 'REJECTED_COUNTRY',
        reasonCodes,
        evidence,
      };
    }
  }

  if (evidence.evidenceCoverage !== 'COMPLETE') {
    const attempts = Number(row.attempts || 0) + 1;
    const expired = attempts >= 3 || (row.expires_at ? Date.parse(row.expires_at) <= Date.now() : false);
    const status = expired ? 'EXPIRED_MISSING_EVIDENCE' : 'WAITING_EVIDENCE';
    const reasonCodes = [expired ? 'MISSING_EVIDENCE_EXPIRED' : 'MISSING_EVIDENCE_RETRY', evidence.failureReason || 'EVIDENCE_INCOMPLETE'];
    if (!options.dryRun) {
      await updateAdmissionCandidate({
        id: row.id,
        status,
        decision: expired ? 'HOLD_MISSING_EVIDENCE' : null,
        reasonCodes,
        evidence,
        evidenceHash: hash,
        attempts,
        nextCheckAt: expired ? null : new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
        expiresAt: row.expires_at || new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      });
    }
    return {
      channelId: evidence.channelId,
      channelName: evidence.channelName,
      decision: 'HOLD_MISSING_EVIDENCE',
      status,
      reasonCodes,
      evidence,
    };
  }

  const judge = options.judge || new ProviderAdmissionJudge({
    jobId: input.discoveryJobId,
    runId: input.queryRunId,
    readOnly: options.dryRun === true,
  });
  let judgment: SemanticJudgment;
  try {
    judgment = await judge.judge(evidence, 'PRIMARY');
  } catch (error) {
    const attempts = Number(row.attempts || 0) + 1;
    const expired = attempts >= 3;
    const reasonCodes = [expired ? 'SEMANTIC_UNAVAILABLE_EXPIRED' : 'SEMANTIC_UNAVAILABLE_RETRY', error instanceof Error ? error.message : String(error)];
    if (!options.dryRun) {
      await updateAdmissionCandidate({
        id: row.id,
        status: expired ? 'EXPIRED_MISSING_EVIDENCE' : 'WAITING_EVIDENCE',
        decision: expired ? 'HOLD_MISSING_EVIDENCE' : null,
        reasonCodes,
        evidence,
        evidenceHash: hash,
        attempts,
        nextCheckAt: expired ? null : new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
        expiresAt: row.expires_at || new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      });
    }
    return {
      channelId: evidence.channelId,
      channelName: evidence.channelName,
      decision: 'HOLD_MISSING_EVIDENCE',
      status: expired ? 'EXPIRED_MISSING_EVIDENCE' : 'WAITING_EVIDENCE',
      reasonCodes,
      evidence,
    };
  }

  let secondJudgment: SemanticJudgment | undefined;
  if (needsSecondJudge(judgment, evidence)) {
    try {
      secondJudgment = await judge.judge(evidence, 'SECOND');
    } catch (error) {
      // The primary judgment still stands; ambiguity policy will admit rather
      // than reject when citations are not decisive.
      console.warn(`[ChannelAdmission] second judge unavailable for ${evidence.channelId}:`, error instanceof Error ? error.message : error);
    }
  }

  const policy = decideAdmission({ evidence, judgment, secondJudgment });
  const effectiveJudgment = policy.effectiveRole === 'SECOND' && secondJudgment ? secondJudgment : judgment;
  let recordedDecisionId: string | null = null;
  if (policy.ambiguous) {
    const health = await getAdmissionAmbiguousRate().catch(() => null);
    const cap = Math.max(0, Math.min(1, Number(process.env.ADMISSION_AMBIGUOUS_RATE_CAP || 0.35)));
    if (health && health.rate > cap) {
      console.warn(JSON.stringify({
        event: 'admission_ambiguous_rate_above_cap',
        channelId: evidence.channelId,
        rate: health.rate,
        cap,
        admitted: health.admitted,
        ambiguous: health.ambiguous,
        timestamp: new Date().toISOString(),
      }));
    }
  }
  if (!options.dryRun) {
    recordedDecisionId = await recordAdmissionDecision({
      candidateId: row.id,
      decisionKey: `${row.id}:${policy.decision}:${hash}`,
      channelId: evidence.channelId,
      decision: policy.decision,
      reasonCodes: policy.reasonCodes,
      evidenceHash: hash,
      judgment: effectiveJudgment,
    });
    await updateAdmissionCandidate({
      id: row.id,
      status: policy.status,
      decision: policy.decision,
      reasonCodes: policy.reasonCodes,
      evidence,
      evidenceHash: hash,
      judgment: effectiveJudgment,
      model: effectiveJudgment.model,
      attempts: Number(row.attempts || 0) + 1,
      nextCheckAt: policy.hold ? new Date(Date.now() + retryDelayMs(1)).toISOString() : null,
      expiresAt: row.expires_at || (policy.hold ? new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString() : null),
    });
  }

  if (policy.rejected && options.archiveRejectedExistingChannel && !options.dryRun) {
    const existing = options.existingChannel === undefined ? await getChannelById(evidence.channelId) : options.existingChannel;
    if (existing) {
      existing.trading_status = 'NON_TRADING';
      existing.trading_confidence_score = Math.max(0, Math.min(100, Number(judgment.tradingFocus) || 0));
      existing.trading_category = 'Unrelated';
      existing.scan_status = 'SKIPPED_NON_TRADING';
      existing.discord_status = 'UNCERTAIN';
      existing.discord_invite = null;
      existing.last_checked = new Date().toISOString();
      existing.inspection_trail = [...(existing.inspection_trail || []), {
        step: 'BIO',
        title: 'Semantic admission rejected as unrelated',
        status: 'REJECTED',
        details: `Admission ${ADMISSION_POLICY_VERSION}: ${policy.reasonCodes.join(', ')}. Evidence hash ${hash}.`,
        timestamp: existing.last_checked,
      }];
      await upsertChannel(existing, { allowDiscordClear: true });
    }
  }

  if (policy.admitted) {
    if (!options.dryRun) {
      const now = new Date().toISOString();
      const existing = options.existingChannel === undefined ? await getChannelById(evidence.channelId) : options.existingChannel;
      const decisionId = recordedDecisionId || randomUUID();
      if (!existing) {
        input.candidate.admissionNewlyCreated = true;
        await insertChannelIfAbsent(admittedChannel({
          evidence,
          decisionId,
          status: policy.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED',
          source: input.source,
          now,
        }));
        await markChannelAdmitted({
          channelId: evidence.channelId,
          decisionId,
          status: policy.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED',
        });
      } else {
        existing.admitted_at = existing.admitted_at || now;
        existing.admission_status = policy.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED';
        existing.admission_decision_id = decisionId;
        if (existing.scan_status === 'INTAKE_DEFERRED' || existing.scan_status === 'CLASSIFICATION_PENDING') {
          existing.scan_status = 'CLASSIFICATION_PENDING';
          existing.trading_status = 'UNCERTAIN';
        }
        await upsertChannel(existing, { preserveDiscordOnUpdate: true });
        await markChannelAdmitted({
          channelId: evidence.channelId,
          decisionId,
          status: policy.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED',
        });
      }
      input.candidate.admissionDecisionId = decisionId;
      input.candidate.admissionStatus = policy.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED';
      input.candidate.admissionConfirmedTrading = policy.status === 'ADMITTED';
      input.candidate.admissionTradingConfidence = effectiveJudgment.tradingFocus;
      input.candidate.admissionCategory = judgment.mainSubject === 'TRADING' ? 'General Trading' : 'General Trading';
      const queued = await enqueueClassificationAfterAdmission({
        candidate: input.candidate,
        targetCountry: input.targetCountry,
        source: input.source,
        query: input.query,
        queryId: input.queryId,
        queryRunId: input.queryRunId,
        discoveryJobId: input.discoveryJobId,
        pageNumber: input.pageNumber,
        admissionDecisionId: decisionId,
      });
      if (!queued) throw new Error('ADMISSION_CLASSIFICATION_ENQUEUE_FAILED');
    }
  }

  return {
    channelId: evidence.channelId,
    channelName: evidence.channelName,
    decision: policy.decision,
    status: policy.status,
    reasonCodes: policy.reasonCodes,
    evidence,
    judgment,
    secondJudgment,
  };
}

export {
  ADMISSION_POLICY_VERSION,
  decideAdmission,
  getAdmissionMode,
  findAdmissionCandidate,
  fetchAdmissionEvidence,
};
export type { AdmissionCandidateInput, AdmissionVerificationResult };
