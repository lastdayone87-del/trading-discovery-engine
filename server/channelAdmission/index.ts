import { randomUUID } from 'node:crypto';
import type { ChannelRecord, DiscoverySource } from '../../src/types';
import { getDb, getChannelById, hasActiveClassificationJob, insertChannelIfAbsent, upsertChannel, upsertChannelWithResult } from '../db';
import { CLASSIFICATION_JOB_TYPE, buildClassificationJobPayload, classificationQueryScopeKey } from '../classificationDecoupling';
import { enqueueClassificationJobAtomic } from '../dbCore';
import { validateChannelCountry } from '../countryValidator';
import { assertCountryAllowed } from '../countryExclusion';
import { fetchAdmissionEvidence, isProviderEvidenceFailure } from './evidence';
import { ADMISSION_POLICY_VERSION, DEFAULT_AMBIGUOUS_RATE_CAP, decideAdmission } from './policy';
import { admissionEvidenceChecksum, isSemanticDecisionFailure, needsSecondJudge, ProviderAdmissionJudge, type AdmissionJudge } from './semanticJudge';
import { evaluateDeterministicAdmission } from './deterministic';
import { admissionSemanticRouteAvailable } from './routeHealth';
import {
  enqueueAdmissionVerification,
  findAdmissionCandidate,
  getAdmissionAmbiguousRate,
  getAdmissionMode,
  recordAdmissionOutcome,
  updateAdmissionCandidate,
  type AdmissionCandidateRow,
} from './store';
import type {
  AdmissionCandidateInput,
  AdmissionDecision,
  AdmissionEvidence,
  AdmissionPolicyResult,
  AdmissionVerificationResult,
  SemanticJudgment,
} from './types';
import { providerDeferredCandidateFields } from './types';
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
    quotaOrigin: input.candidate.quotaOrigin === 'PROBE' ? 'PROBE' : 'NORMAL',
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

export function candidateFromAdmissionRow(row: AdmissionCandidateRow): DiscoveredChannelRaw {
  return {
    channelId: row.channel_id,
    channelName: row.channel_name,
    youtubeUrl: row.youtube_url,
    description: String(row.raw_observation?.description || ''),
    videoTitles: Array.isArray(row.raw_observation?.videoTitles) ? row.raw_observation.videoTitles : [],
    videoDescriptions: Array.isArray(row.raw_observation?.videoDescriptions) ? row.raw_observation.videoDescriptions : [],
    matchedDocument: row.matched_document as unknown as DiscoveredChannelRaw['matchedDocument'],
    locationTag: typeof row.raw_observation?.locationTag === 'string' ? row.raw_observation.locationTag : undefined,
    quotaOrigin: row.raw_observation?.quotaOrigin === 'PROBE' ? 'PROBE' : undefined,
  };
}

export type AdmissionReviewAction = 'ADMIT' | 'REJECT' | 'REQUEUE';

export function parseAdmissionReviewAction(flags: {
  admit?: boolean;
  reject?: boolean;
  requeue?: boolean;
}): AdmissionReviewAction | null {
  const actions: AdmissionReviewAction[] = [];
  if (flags.admit) actions.push('ADMIT');
  if (flags.reject) actions.push('REJECT');
  if (flags.requeue) actions.push('REQUEUE');
  if (actions.length > 1) throw new Error('REVIEW_ACTION_CONFLICT');
  return actions[0] || null;
}

/**
 * Operator resolution for a retained NEEDS_REVIEW candidate. Review never
 * silently admits or rejects: the operator must choose ADMIT, REJECT or
 * REQUEUE, and the choice is recorded with the reviewer and reason.
 */
export async function resolveAdmissionReview(input: {
  channelId: string;
  action: 'ADMIT' | 'REJECT' | 'REQUEUE';
  reviewer: string;
  reason: string;
}): Promise<{ status: 'ADMITTED' | 'REJECTED_UNRELATED' | 'PENDING' }> {
  if (!input.channelId.trim()) throw new Error('REVIEW_CHANNEL_ID_REQUIRED');
  if (!input.reviewer.trim()) throw new Error('REVIEW_REVIEWER_REQUIRED');
  if (!input.reason.trim()) throw new Error('REVIEW_REASON_REQUIRED');
  const row = await findAdmissionCandidate(input.channelId);
  if (!row) throw new Error('REVIEW_CANDIDATE_MISSING');
  if (row.status !== 'NEEDS_REVIEW') throw new Error(`REVIEW_CANDIDATE_NOT_PENDING:${row.status}`);
  const candidate = candidateFromAdmissionRow(row);
  const targetCountry = row.target_country || '';
  const source = String(row.source) as DiscoverySource;
  const reasonCodes = [`HUMAN_REVIEW_${input.action}`, `REVIEWER_${input.reviewer}`, input.reason];

  if (input.action === 'REQUEUE') {
    const updated = await updateAdmissionCandidate({
      id: row.id,
      status: 'PENDING',
      decision: null,
      reasonCodes: [...reasonCodes, 'REVIEW_REQUEUE_RESETS_ATTEMPTS'],
      // A person is explicitly restarting the evidence lifecycle. Reset the
      // attempt counter so an exhausted review candidate is not immediately
      // exhausted again on its first retry.
      attempts: 0,
      nextCheckAt: null,
      expiresAt: null,
      expectedStatus: row.status,
      expectedAttempts: row.attempts,
    });
    if (!updated) throw new Error('ADMISSION_CANDIDATE_STALE');
    const queued = await enqueueAdmissionVerification({
      candidate: {
        candidate,
        targetCountry,
        source,
        queryRunId: row.query_run_id || undefined,
        queryId: row.query_id || undefined,
        discoveryJobId: row.job_id || undefined,
        pageNumber: row.page_number || undefined,
        resultRank: row.result_rank || undefined,
      },
      idempotencyKey: `admission:${row.channel_id}:review:${Date.now()}`,
    });
    if (!queued || queued.reopen_blocked || (queued.status !== 'PENDING' && queued.status !== 'PROCESSING')) {
      throw new Error('REVIEW_REQUEUE_NOT_QUEUED');
    }
    return { status: 'PENDING' };
  }

  const evidence = (row.evidence_snapshot || null) as AdmissionEvidence | null;
  if (!evidence) throw new Error('REVIEW_EVIDENCE_MISSING');
  const decision = input.action === 'ADMIT' ? 'ADMIT' as const : 'REJECT_UNRELATED' as const;
  const status = input.action === 'ADMIT' ? 'ADMITTED' as const : 'REJECTED_UNRELATED' as const;
  if (input.action === 'REJECT') {
    // Project the rejection first. If this fails, the candidate remains open
    // and the operator can retry instead of losing the channel side effect.
    const existing = await getChannelById(row.channel_id);
    if (existing) {
      existing.trading_status = 'NON_TRADING';
      existing.trading_category = 'Unrelated';
      existing.scan_status = 'SKIPPED_NON_TRADING';
      existing.discord_status = 'UNCERTAIN';
      existing.discord_invite = null;
      existing.last_checked = new Date().toISOString();
      await upsertChannel(existing, { allowDiscordClear: true });
    }
  }
  const recorded = await recordAdmissionOutcome({
    decision: {
      candidateId: row.id,
      decisionKey: `${row.id}:${decision}:HUMAN:${Date.now()}`,
      channelId: row.channel_id,
      decision,
      reasonCodes,
      evidenceHash: row.evidence_hash || undefined,
    },
    candidate: {
      id: row.id,
      status,
      decision,
      reasonCodes,
      evidence,
      evidenceHash: row.evidence_hash || undefined,
      attempts: Number(row.attempts || 0),
      nextCheckAt: null,
      expiresAt: null,
      expectedStatus: row.status,
      expectedAttempts: row.attempts,
    },
  });
  if (input.action === 'REJECT') return { status };

  const now = new Date().toISOString();
  const decisionId = recorded.decisionId || randomUUID();
  try {
    const existing = await getChannelById(row.channel_id);
    if (!existing) {
      candidate.admissionNewlyCreated = true;
      await insertChannelIfAbsent(admittedChannel({
        evidence,
        decisionId,
        status: 'ADMITTED',
        source,
        now,
      }));
      await markChannelAdmitted({ channelId: row.channel_id, decisionId, status: 'ADMITTED' });
    } else {
      existing.admitted_at = existing.admitted_at || now;
      existing.admission_status = 'ADMITTED';
      existing.admission_decision_id = decisionId;
      if (existing.scan_status === 'INTAKE_DEFERRED' || existing.scan_status === 'CLASSIFICATION_PENDING') {
        existing.scan_status = 'CLASSIFICATION_PENDING';
        existing.trading_status = 'UNCERTAIN';
      }
      await upsertChannel(existing, { preserveDiscordOnUpdate: true });
      await markChannelAdmitted({ channelId: row.channel_id, decisionId, status: 'ADMITTED' });
    }
    candidate.admissionDecisionId = decisionId;
    candidate.admissionStatus = 'ADMITTED';
    candidate.admissionDecisionSource = 'HUMAN';
    candidate.admissionConfirmedTrading = true;
    candidate.admissionTradingConfidence = 100;
    candidate.admissionCitations = Array.isArray(row.semantic_output?.citations) ? row.semantic_output.citations : [];
    candidate.admissionEvidenceHash = row.evidence_hash || undefined;
    candidate.admissionCategory = 'General Trading';
    const queued = await enqueueClassificationAfterAdmission({
      candidate,
      targetCountry,
      source,
      queryRunId: row.query_run_id || undefined,
      queryId: row.query_id || undefined,
      discoveryJobId: row.job_id || undefined,
      pageNumber: row.page_number || undefined,
      admissionDecisionId: decisionId,
    });
    if (!queued) throw new Error('ADMISSION_CLASSIFICATION_ENQUEUE_FAILED');
    return { status };
  } catch (error) {
    // The ledger decision is already durable. Reopen the candidate rather than
    // leaving a human admission whose channel/classification side effect never
    // completed; the operator can safely retry.
    await updateAdmissionCandidate({
      id: row.id,
      status: 'NEEDS_REVIEW',
      decision: 'NEEDS_REVIEW',
      reasonCodes: [...reasonCodes, 'HUMAN_ADMIT_SIDE_EFFECT_FAILED', error instanceof Error ? error.message : String(error)],
      attempts: Number(row.attempts || 0),
      nextCheckAt: null,
      expiresAt: null,
      expectedStatus: 'ADMITTED',
      expectedAttempts: row.attempts,
    }).catch(() => undefined);
    throw error;
  }
}

export async function resumeAdmittedCandidate(input: AdmissionCandidateInput, row: AdmissionCandidateRow): Promise<boolean> {
  await assertCountryAllowed(input.targetCountry, `admission_resume:${input.candidate.channelId}`);
  const db = await getDb();
  const decision = await db.query(
    `SELECT id,decision,semantic_output,evidence_hash FROM semantic_admission_decisions WHERE candidate_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [row.id],
  ).catch(() => null);
  let channel = await getChannelById(row.channel_id);
  const decisionId = channel?.admission_decision_id || decision?.rows[0]?.id || null;
  if (!decisionId) return false;
  const admissionStatus = row.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED';
  if (!channel) {
    // The ledger decision committed but the channel write did not. Rebuild
    // the admitted projection from the durable decision instead of running a
    // fresh verification that could contradict the terminal admission.
    const evidence = (row.evidence_snapshot || null) as AdmissionEvidence | null;
    if (!evidence) return false;
    const now = new Date().toISOString();
    await insertChannelIfAbsent(admittedChannel({
      evidence,
      decisionId,
      status: admissionStatus,
      source: String(row.source) as DiscoverySource,
      now,
    }));
    await markChannelAdmitted({ channelId: row.channel_id, decisionId, status: admissionStatus });
    channel = await getChannelById(row.channel_id);
    if (!channel) return false;
  } else {
    // Repair the channel projection from the durable decision before resuming.
    // A crash between the ledger commit and the channel write can otherwise leave
    // a legacy row INTAKE_DEFERRED with no admission provenance while its
    // classification job is already durable.
    await db.query(
      `UPDATE channels
          SET admitted_at=COALESCE(admitted_at,now()),
              admission_status=$2,
              admission_decision_id=$3,
              scan_status=CASE WHEN scan_status IN ('INTAKE_DEFERRED','CLASSIFICATION_PENDING')
                               THEN 'CLASSIFICATION_PENDING' ELSE scan_status END,
              updated_at=now()
        WHERE channel_id=$1`,
      [row.channel_id, admissionStatus, decisionId],
    );
    channel.admission_status = admissionStatus;
    channel.admission_decision_id = decisionId;
    if (channel.scan_status === 'INTAKE_DEFERRED' || channel.scan_status === 'CLASSIFICATION_PENDING') {
      channel.scan_status = 'CLASSIFICATION_PENDING';
    }
  }
  // The decision ledger is authoritative. A stale candidate projection must
  // not change the confidence or citations used by resumed classification.
  const semanticOutput = (decision?.rows[0]?.semantic_output || row.semantic_output) as Record<string, any> | null;
  input.candidate.admissionDecisionId = decisionId;
  input.candidate.admissionStatus = admissionStatus;
  input.candidate.admissionDecisionSource = semanticOutput?.model === 'deterministic-first-v1'
    ? 'DETERMINISTIC'
    : semanticOutput?.provider ? 'SEMANTIC' : 'HUMAN';
  input.candidate.admissionConfirmedTrading = admissionStatus === 'ADMITTED';
  const savedConfidence = semanticOutput?.tradingFocus;
  input.candidate.admissionTradingConfidence = savedConfidence === undefined || savedConfidence === null
    ? (admissionStatus === 'ADMITTED' ? 90 : 0)
    : Number(savedConfidence);
  input.candidate.admissionCitations = Array.isArray(semanticOutput?.citations) ? semanticOutput.citations : [];
  input.candidate.admissionModel = semanticOutput?.model || undefined;
  input.candidate.admissionProvider = ['gemini_semantic', 'groq_semantic', 'gemini_free_semantic'].includes(String(semanticOutput?.provider || ''))
    ? semanticOutput.provider
    : undefined;
  input.candidate.admissionEvidenceHash = decision?.rows[0]?.evidence_hash || row.evidence_hash || undefined;
  input.candidate.admissionCategory = 'General Trading';
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
  /** Test/cohort seam: evaluate this evidence instead of refetching it. */
  evidenceOverride?: AdmissionEvidence;
}

export async function verifyAdmissionCandidate(
  input: AdmissionCandidateInput,
  options: VerifyAdmissionOptions = {},
): Promise<AdmissionVerificationResult> {
  const row = options.row || await findAdmissionCandidate(input.candidate.channelId);
  if (!row) throw new Error('ADMISSION_CANDIDATE_MISSING');
  if (options.evidenceOverride && options.evidenceOverride.channelId !== input.candidate.channelId) {
    throw new Error('ADMISSION_EVIDENCE_CHANNEL_MISMATCH');
  }
  await assertCountryAllowed(input.targetCountry, `admission_worker:${input.candidate.channelId}`);
  const evidence = options.evidenceOverride ?? await fetchAdmissionEvidence({
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
        // Apply the legacy channel side effect first. If it fails, the
        // candidate stays retryable instead of becoming a terminal rejection
        // that the worker will refuse to resume.
        const existing = options.existingChannel === undefined ? await getChannelById(evidence.channelId) : options.existingChannel;
        if (existing) {
          existing.country = country.detectedCreatorCountry || existing.country;
          existing.country_status = 'REJECTED';
          existing.scan_status = 'SKIPPED_EXCLUDED';
          existing.trading_status = existing.trading_status || 'UNCERTAIN';
          existing.last_checked = new Date().toISOString();
          await upsertChannel(existing, { allowDiscordClear: true });
        }
        await recordAdmissionOutcome({
          decision: {
            candidateId: row.id,
            decisionKey: `${row.id}:REJECT_COUNTRY:${hash}`,
            channelId: evidence.channelId,
            decision: 'REJECT_COUNTRY',
            reasonCodes,
            evidenceHash: hash,
          },
          candidate: {
            id: row.id,
            status: 'REJECTED_COUNTRY',
            decision: 'REJECT_COUNTRY',
            reasonCodes,
            evidence,
            evidenceHash: hash,
            attempts: Number(row.attempts || 0) + 1,
            expectedStatus: row.status,
            expectedAttempts: row.attempts,
          },
        });
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
    const providerFailure = isProviderEvidenceFailure(evidence.failureReason);
    if (providerFailure) {
      // Quota, rate-limit and transient provider failures are infrastructure
      // waits. Keep the candidate, its evidence and its attempt count exactly
      // as they are; retry later without expiry.
      const reasonCodes = ['PROVIDER_RETRY_WITHOUT_ATTEMPT', 'EVIDENCE_PROVIDER_DEFERRED', evidence.failureReason || 'EVIDENCE_PROVIDER_FAILURE'];
      if (!options.dryRun) {
        const updated = await updateAdmissionCandidate({
          id: row.id,
          ...providerDeferredCandidateFields(row.attempts),
          decision: null,
          reasonCodes,
          evidence,
          evidenceHash: hash,
          nextCheckAt: new Date(Date.now() + retryDelayMs(1)).toISOString(),
          expectedStatus: row.status,
          expectedAttempts: row.attempts,
        });
        if (!updated) throw new Error('ADMISSION_CANDIDATE_STALE');
      }
      return {
        channelId: evidence.channelId,
        channelName: evidence.channelName,
        decision: 'PROVIDER_DEFERRED',
        status: 'PROVIDER_DEFERRED',
        reasonCodes,
        evidence,
        decisionSource: 'SEMANTIC',
        priority: 20,
      };
    }
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
        expectedStatus: row.status,
        expectedAttempts: row.attempts,
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

  let decisionSource: 'DETERMINISTIC' | 'SEMANTIC' = 'SEMANTIC';
  let deterministicRoute: string | null = null;
  let judgment: SemanticJudgment | undefined;
  let secondJudgment: SemanticJudgment | undefined;
  let policy: AdmissionPolicyResult | undefined;

  // Deterministic-first stage. It needs no AI and is deliberately allowed to
  // decide only the clear cases; anything close is passed to the existing
  // Gemini/Groq judge below. A local prefilter failure must fall back to AI,
  // never block admission.
  const deterministic = await evaluateDeterministicAdmission(evidence).catch(error => {
    console.warn(`[ChannelAdmission] deterministic stage failed for ${evidence.channelId}:`, error instanceof Error ? error.message : error);
    return {
      outcome: 'AMBIGUOUS' as const,
      route: null,
      confidence: 0,
      reasonCodes: ['DETERMINISTIC_STAGE_FAILED'],
      citations: [],
      priority: 20,
    };
  });
  deterministicRoute = deterministic.route;
  if (deterministic.outcome !== 'AMBIGUOUS' && deterministic.judgment) {
    decisionSource = 'DETERMINISTIC';
    judgment = deterministic.judgment;
    if (deterministic.outcome === 'PASS') {
      policy = {
        decision: 'ADMIT',
        status: 'ADMITTED',
        reasonCodes: deterministic.reasonCodes,
        rejected: false,
        admitted: true,
        hold: false,
        ambiguous: false,
        review: false,
        citationsValid: deterministic.citations.length > 0,
        independentUnrelatedCitations: 0,
        independentTradingCitations: deterministic.citations.length,
        effectiveRole: 'PRIMARY',
      };
    } else {
      policy = {
        decision: 'REJECT_UNRELATED',
        status: 'REJECTED_UNRELATED',
        reasonCodes: deterministic.reasonCodes,
        rejected: true,
        admitted: false,
        hold: false,
        ambiguous: false,
        review: false,
        citationsValid: true,
        independentUnrelatedCitations: deterministic.citations.length,
        independentTradingCitations: 0,
        effectiveRole: 'PRIMARY',
      };
    }
  }

  if (!policy) {
    // Deterministic admission already completed above. Only the semantic
    // fallback needs a healthy provider route; preflight it before reserving
    // model budget so an all-cooling/unconfigured pool defers without a
    // wasted reservation.
    if (!options.judge && !(await admissionSemanticRouteAvailable())) {
      const reasonCodes = ['PROVIDER_RETRY_WITHOUT_ATTEMPT', 'SEMANTIC_ROUTES_COOLING'];
      if (!options.dryRun) {
        const updated = await updateAdmissionCandidate({
          id: row.id,
          ...providerDeferredCandidateFields(row.attempts),
          decision: null,
          reasonCodes,
          evidence,
          evidenceHash: hash,
          nextCheckAt: new Date(Date.now() + retryDelayMs(1)).toISOString(),
          expectedStatus: row.status,
          expectedAttempts: row.attempts,
        });
        if (!updated) throw new Error('ADMISSION_CANDIDATE_STALE');
      }
      return {
        channelId: evidence.channelId,
        channelName: evidence.channelName,
        decision: 'PROVIDER_DEFERRED',
        status: 'PROVIDER_DEFERRED',
        reasonCodes,
        evidence,
        deterministicRoute,
        decisionSource: 'SEMANTIC',
        priority: deterministic.priority,
      };
    }
    const judge = options.judge || new ProviderAdmissionJudge({
      jobId: input.discoveryJobId,
      runId: input.queryRunId,
      readOnly: options.dryRun === true,
    });
    try {
      judgment = await judge.judge(evidence, 'PRIMARY');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isSemanticDecisionFailure(error)) {
        // Both providers returned a response that cannot become a decisive
        // judgment. That is an AI-decision failure, so it may consume bounded
        // evidence attempts and end in retained human review rather than an
        // endless provider deferral.
        const attempts = Number(row.attempts || 0) + 1;
        const exhausted = attempts >= 3;
        const status = exhausted ? 'NEEDS_REVIEW' as const : 'WAITING_EVIDENCE' as const;
        const reasonCodes = [exhausted ? 'SEMANTIC_UNRESOLVED_NEEDS_REVIEW' : 'SEMANTIC_INVALID_OUTPUT_RETRY', reason];
        if (!options.dryRun) {
          if (exhausted) {
            await recordAdmissionOutcome({
              decision: {
                candidateId: row.id,
                decisionKey: `${row.id}:NEEDS_REVIEW:${hash}`,
                channelId: evidence.channelId,
                decision: 'NEEDS_REVIEW',
                reasonCodes,
                evidenceHash: hash,
              },
              candidate: {
                id: row.id,
                status: 'NEEDS_REVIEW',
                decision: 'NEEDS_REVIEW',
                reasonCodes,
                evidence,
                evidenceHash: hash,
                attempts,
                nextCheckAt: null,
                expiresAt: null,
                expectedStatus: row.status,
                expectedAttempts: row.attempts,
              },
            });
          } else {
            const updated = await updateAdmissionCandidate({
              id: row.id,
              status,
              decision: null,
              reasonCodes,
              evidence,
              evidenceHash: hash,
              attempts,
              nextCheckAt: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
              expiresAt: null,
              expectedStatus: row.status,
              expectedAttempts: row.attempts,
            });
            if (!updated) throw new Error('ADMISSION_CANDIDATE_STALE');
          }
        }
        return {
          channelId: evidence.channelId,
          channelName: evidence.channelName,
          decision: exhausted ? 'NEEDS_REVIEW' : 'HOLD_MISSING_EVIDENCE',
          status,
          reasonCodes,
          evidence,
          judgment: undefined,
          decisionSource: 'SEMANTIC',
          deterministicRoute,
          priority: deterministic.priority,
        };
      }
      // Provider, budget and transport failures are infrastructure waits. They
      // must never consume evidence attempts or expire a valid creator.
      const attempts = Number(row.attempts || 0);
      const reasonCodes = ['PROVIDER_RETRY_WITHOUT_ATTEMPT', 'SEMANTIC_UNAVAILABLE_RETRY', reason];
      if (!options.dryRun) {
        const updated = await updateAdmissionCandidate({
          id: row.id,
          ...providerDeferredCandidateFields(attempts),
          decision: null,
          reasonCodes,
          evidence,
          evidenceHash: hash,
          nextCheckAt: new Date(Date.now() + retryDelayMs(1)).toISOString(),
          expectedStatus: row.status,
          expectedAttempts: row.attempts,
        });
        if (!updated) throw new Error('ADMISSION_CANDIDATE_STALE');
      }
      return {
        channelId: evidence.channelId,
        channelName: evidence.channelName,
        decision: 'PROVIDER_DEFERRED',
        status: 'PROVIDER_DEFERRED',
        reasonCodes,
        evidence,
        deterministicRoute,
        decisionSource: 'SEMANTIC',
        priority: deterministic.priority,
      };
    }

    if (needsSecondJudge(judgment, evidence)) {
      try {
        secondJudgment = await judge.judge(evidence, 'SECOND');
      } catch (error) {
        // The primary judgment still stands; ambiguity policy will preserve
        // the candidate for human review rather than rejecting it.
        console.warn(`[ChannelAdmission] second judge unavailable for ${evidence.channelId}:`, error instanceof Error ? error.message : error);
      }
    }
    policy = decideAdmission({ evidence, judgment, secondJudgment });
  }

  const effectiveJudgment = policy.effectiveRole === 'SECOND' && secondJudgment ? secondJudgment : judgment;
  if (!effectiveJudgment) throw new Error('ADMISSION_JUDGMENT_MISSING');
  let recordedDecisionId: string | null = null;
  if (policy.ambiguous) {
    const health = await getAdmissionAmbiguousRate().catch(() => null);
    const cap = Math.max(0, Math.min(1, Number(process.env.ADMISSION_AMBIGUOUS_RATE_CAP || DEFAULT_AMBIGUOUS_RATE_CAP)));
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
  // Legacy rejection projection must complete before the terminal decision is
  // committed. Otherwise a failed upsert leaves a rejected candidate whose
  // existing channel can never be resumed by the worker.
  if (policy.rejected && options.archiveRejectedExistingChannel && !options.dryRun) {
    const existing = options.existingChannel === undefined ? await getChannelById(evidence.channelId) : options.existingChannel;
    if (existing) {
      existing.trading_status = 'NON_TRADING';
      existing.trading_confidence_score = Math.max(0, Math.min(100, Number(effectiveJudgment.tradingFocus) || 0));
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

  if (!options.dryRun) {
    const recorded = await recordAdmissionOutcome({
      decision: {
        candidateId: row.id,
        decisionKey: `${row.id}:${policy.decision}:${hash}`,
        channelId: evidence.channelId,
        decision: policy.decision,
        reasonCodes: policy.reasonCodes,
        evidenceHash: hash,
        judgment: effectiveJudgment,
      },
      candidate: {
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
        expiresAt: policy.hold ? (row.expires_at || new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()) : null,
        expectedStatus: row.status,
        expectedAttempts: row.attempts,
      },
    });
    recordedDecisionId = recorded.decisionId;
  }

  if (policy.review) {
    // Human review is a deliberate terminal admission outcome, not an
    // enrichment or provider retry. The candidate and its evidence stay
    // available for an operator without entering the served corpus.
    return {
      channelId: evidence.channelId,
      channelName: evidence.channelName,
      decision: 'NEEDS_REVIEW',
      status: 'NEEDS_REVIEW',
      reasonCodes: policy.reasonCodes,
      evidence,
      judgment: effectiveJudgment,
      decisionSource,
      deterministicRoute,
    };
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
        const expectedScanStatus = existing.scan_status;
        const expectedTradingStatus = existing.trading_status;
        existing.admitted_at = existing.admitted_at || now;
        existing.admission_status = policy.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED';
        existing.admission_decision_id = decisionId;
        if (existing.scan_status === 'INTAKE_DEFERRED' || existing.scan_status === 'CLASSIFICATION_PENDING') {
          existing.scan_status = 'CLASSIFICATION_PENDING';
          existing.trading_status = 'UNCERTAIN';
        }
        const applied = await upsertChannelWithResult(existing, {
          preserveDiscordOnUpdate: true,
          requireStatusSnapshot: {
            scan_status: expectedScanStatus,
            trading_status: expectedTradingStatus,
          },
        });
        if (!applied) {
          // A classification completed between our read and this write. Keep
          // its result; markChannelAdmitted below applies only safe admission
          // provenance.
          console.warn(JSON.stringify({
            event: 'admission_channel_snapshot_stale',
            channelId: evidence.channelId,
            timestamp: new Date().toISOString(),
          }));
        }
        await markChannelAdmitted({
          channelId: evidence.channelId,
          decisionId,
          status: policy.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED',
        });
      }
      input.candidate.admissionDecisionId = decisionId;
      input.candidate.admissionStatus = policy.status === 'ADMITTED_AMBIGUOUS' ? 'ADMITTED_AMBIGUOUS' : 'ADMITTED';
      input.candidate.admissionDecisionSource = decisionSource;
      input.candidate.admissionCitations = effectiveJudgment.citations;
      input.candidate.admissionModel = effectiveJudgment.model;
      input.candidate.admissionProvider = effectiveJudgment.provider;
      input.candidate.admissionConfirmedTrading = policy.status === 'ADMITTED';
      input.candidate.admissionTradingConfidence = effectiveJudgment.tradingFocus;
      input.candidate.admissionEvidenceHash = hash;
      input.candidate.admissionCategory = effectiveJudgment.mainSubject === 'TRADING' ? 'General Trading' : 'General Trading';
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
    judgment: effectiveJudgment,
    secondJudgment,
    decisionSource,
    deterministicRoute,
    priority: deterministic.priority,
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
