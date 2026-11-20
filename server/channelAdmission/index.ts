import { randomUUID } from 'node:crypto';
import type { ChannelRecord, DiscoverySource } from '../../src/types';
import { enqueueJob, getDb, getChannelById, hasActiveClassificationJob, insertChannelIfAbsent, upsertChannel, upsertChannelWithResult } from '../db';
import { CLASSIFICATION_JOB_TYPE, buildClassificationJobPayload, classificationQueryScopeKey, enrichmentJobIdempotencyKey, resolveClassificationDecouplingConfig } from '../classificationDecoupling';
import { enqueueClassificationJobAtomic } from '../dbCore';
import { validateChannelCountry } from '../countryValidator';
import { assertCountryAllowed } from '../countryExclusion';
import { fetchAdmissionEvidence, isProviderEvidenceFailure } from './evidence';
import { ADMISSION_POLICY_VERSION, DEFAULT_AMBIGUOUS_RATE_CAP, decideAdmission } from './policy';
import { admissionEvidenceChecksum, type AdmissionJudge } from './semanticJudge';
import { evaluateDeterministicAdmission } from './deterministic';
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
    priority: resolveClassificationDecouplingConfig().priority,
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
  const snapshot = row.evidence_snapshot;
  const raw = row.raw_observation || {};
  const hasSnapshot = snapshot != null;
  const snapshotVideos = Array.isArray(snapshot?.videos) ? snapshot.videos : [];
  const videos = snapshotVideos
    .filter(video => video && typeof video.title === 'string')
    .map(video => ({
      id: video.videoId,
      title: video.title,
      description: video.description || '',
      published_at: video.publishedAt,
    }));
  const snapshotLinks = Array.isArray(snapshot?.links) ? snapshot.links.filter(link => typeof link === 'string' && link.trim()) : [];
  const rawLinks = Array.isArray(raw.channelLinks) ? raw.channelLinks.filter((link): link is string => typeof link === 'string' && Boolean(link.trim())) : [];
  const links = hasSnapshot ? snapshotLinks : rawLinks;
  const rawTitles = Array.isArray(raw.videoTitles) ? raw.videoTitles : [];
  const rawDescriptions = Array.isArray(raw.videoDescriptions) ? raw.videoDescriptions : [];
  const snapshotDescription = typeof snapshot?.description === 'string' ? snapshot.description.trim() : '';
  const snapshotName = typeof snapshot?.channelName === 'string' ? snapshot.channelName.trim() : '';
  const snapshotUrl = typeof snapshot?.youtubeUrl === 'string' ? snapshot.youtubeUrl.trim() : '';
  return {
    channelId: row.channel_id,
    channelName: snapshotName || row.channel_name,
    youtubeUrl: snapshotUrl || row.youtube_url,
    // The admission evidence snapshot contains the full creator-owned sample
    // (bio, recent videos and descriptions) that the admission model saw. When
    // a snapshot exists, never fall back to raw_observation: those fields are
    // the sparse search match, not creator evidence the judge evaluated.
    description: hasSnapshot ? snapshotDescription : String(raw.description ?? ''),
    videos: videos.length ? videos : undefined,
    videoTitles: hasSnapshot ? videos.map(video => video.title) : rawTitles,
    videoDescriptions: hasSnapshot ? videos.map(video => video.description) : rawDescriptions,
    // Only snapshot video descriptions may vote. A bio-only COMPLETE snapshot
    // has no authoritative video sample, so the flag must stay false.
    videoDescriptionsAuthoritative: hasSnapshot && videos.length > 0 && snapshot?.evidenceCoverage === 'COMPLETE',
    channelLinks: links.length ? links : undefined,
    externalLinkDetails: links.length ? links.map(url => ({ url })) : undefined,
    subscriberCount: snapshot?.subscriberCount ?? (typeof raw.subscriberCount === 'string' ? raw.subscriberCount : undefined),
    matchedDocument: (snapshot?.matchedDocument || row.matched_document) as unknown as DiscoveredChannelRaw['matchedDocument'],
    relationshipProvenance: (snapshot?.relationshipProvenance || raw.relationshipProvenance) as DiscoveredChannelRaw['relationshipProvenance'],
    locationTag: snapshot?.country || (typeof raw.locationTag === 'string' ? raw.locationTag : undefined),
    quotaOrigin: raw.quotaOrigin === 'PROBE' ? 'PROBE' : undefined,
  };
}

/**
 * Explicit review decisions carry a HUMAN key. Everything else is machine
 * provenance: deterministic-first rows are deterministic, and missing or
 * legacy semantic provenance stays semantic. Never infer HUMAN from absent
 * fields; that would reopen the confirmation shortcut.
 */
export function resumeAdmissionDecisionSource(input: {
  decisionKey?: string | null;
  semanticOutput?: Record<string, any> | null;
}): 'HUMAN' | 'DETERMINISTIC' | 'SEMANTIC' {
  if (String(input.decisionKey || '').includes(':HUMAN:')) return 'HUMAN';
  if (String(input.decisionKey || '').includes(':DETERMINISTIC_AMBIGUOUS:')) return 'DETERMINISTIC';
  if (input.semanticOutput?.model === 'deterministic-first-v1') return 'DETERMINISTIC';
  return 'SEMANTIC';
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
 * Build the classification candidate from the full admission evidence
 * snapshot while preserving the discovery envelope. The discovery candidate is
 * often only a search-match payload; the snapshot is the creator-owned
 * bio/video sample the admission model actually evaluated. Keep the base row
 * so accounting flags (notably admissionNewlyCreated), thumbnail, activity,
 * query and nomination provenance survive the rebuild. Only creator-evidence
 * fields are replaced by the snapshot.
 */
export function classificationCandidateForAdmission(
  base: DiscoveredChannelRaw,
  row: AdmissionCandidateRow,
): DiscoveredChannelRaw {
  const evidence = candidateFromAdmissionRow(row);
  return {
    ...base,
    channelName: evidence.channelName,
    youtubeUrl: evidence.youtubeUrl,
    description: evidence.description,
    videos: evidence.videos,
    videoTitles: evidence.videoTitles,
    videoDescriptions: evidence.videoDescriptions,
    videoDescriptionsAuthoritative: evidence.videoDescriptionsAuthoritative,
    channelLinks: evidence.channelLinks,
    externalLinkDetails: evidence.externalLinkDetails,
    subscriberCount: evidence.subscriberCount ?? base.subscriberCount,
    matchedDocument: evidence.matchedDocument ?? base.matchedDocument,
    relationshipProvenance: evidence.relationshipProvenance ?? base.relationshipProvenance,
    locationTag: evidence.locationTag ?? base.locationTag,
    // The caller writes admission provenance immediately before building this
    // candidate; keep it explicit so a future field addition cannot silently
    // reintroduce the semantic shortcut.
    admissionDecisionId: base.admissionDecisionId,
    admissionStatus: base.admissionStatus,
    admissionDecisionSource: base.admissionDecisionSource,
    admissionConfirmedTrading: base.admissionConfirmedTrading,
    admissionTradingConfidence: base.admissionTradingConfidence,
    admissionCitations: base.admissionCitations,
    admissionModel: base.admissionModel,
    admissionProvider: base.admissionProvider,
    admissionEvidenceHash: base.admissionEvidenceHash,
    admissionCategory: base.admissionCategory,
    admissionNewlyCreated: base.admissionNewlyCreated,
  };
}

/**
 * Deterministic admission abstained: acquire creator-owned evidence before the
 * single full AI judge. The stage-1 enrichment payload deliberately carries no
 * semantic-admission judgment or confirmation marker.
 */
async function enqueueEnrichmentAfterAmbiguousAdmission(input: {
  candidate: DiscoveredChannelRaw;
  row: AdmissionCandidateRow;
  evidence: AdmissionEvidence;
  decisionId: string;
  targetCountry: string;
  source: DiscoverySource;
  query?: string;
  queryId?: number;
  queryRunId?: string;
  discoveryJobId?: string;
}): Promise<boolean> {
  const candidate = classificationCandidateForAdmission(input.candidate, {
    ...input.row,
    evidence_snapshot: input.evidence,
  });
  candidate.admissionDecisionId = input.decisionId;
  candidate.admissionStatus = 'ADMITTED_AMBIGUOUS';
  candidate.admissionDecisionSource = 'DETERMINISTIC';
  candidate.admissionConfirmedTrading = false;
  candidate.admissionTradingConfidence = 0;
  const payload = {
    channelId: candidate.channelId,
    targetCountry: input.targetCountry,
    source: input.source,
    query: input.query,
    queryId: input.queryId,
    queryRunId: input.queryRunId,
    discoveryJobId: input.discoveryJobId,
    candidate,
    enrichmentStage: 1,
    quotaOrigin: candidate.quotaOrigin === 'PROBE' ? 'PROBE' : 'NORMAL',
  };
  const db = await getDb();
  const activeStageOne = await db.query(
    `SELECT 1 FROM jobs
      WHERE type='ENRICH_CHANNEL' AND status IN ('PENDING','PROCESSING')
        AND payload->>'channelId'=$1 AND COALESCE(payload->>'enrichmentStage','')='1'
      LIMIT 1`,
    [candidate.channelId],
  );
  if (activeStageOne.rowCount) return true;
  const key = enrichmentJobIdempotencyKey(candidate.channelId, 1);
  const job = await enqueueJob('ENRICH_CHANNEL', payload, {
    priority: 10,
    maxAttempts: 4,
    idempotencyKey: key,
    preventCompletedReopen: true,
  });
  if (job.status === 'COMPLETED') {
    // Stage-1 enrichment already finished before the admission side effect
    // committed. Move directly to the one full classifier on the current
    // admission snapshot. The completed job's stored payload is the input to
    // that earlier pass, not the evidence this admission decision evaluated.
    const enrichedCandidate = candidate;
    return enqueueClassificationAfterAdmission({
      candidate: {
        ...enrichedCandidate,
        admissionDecisionId: candidate.admissionDecisionId,
        admissionStatus: candidate.admissionStatus,
        admissionDecisionSource: candidate.admissionDecisionSource,
        admissionConfirmedTrading: candidate.admissionConfirmedTrading,
        admissionTradingConfidence: candidate.admissionTradingConfidence,
        admissionCitations: candidate.admissionCitations,
        admissionModel: candidate.admissionModel,
        admissionProvider: candidate.admissionProvider,
        admissionEvidenceHash: candidate.admissionEvidenceHash,
        admissionCategory: candidate.admissionCategory,
        admissionNewlyCreated: candidate.admissionNewlyCreated,
      },
      targetCountry: input.targetCountry,
      source: input.source,
      query: input.query,
      queryId: input.queryId,
      queryRunId: input.queryRunId,
      discoveryJobId: input.discoveryJobId,
      admissionDecisionId: input.decisionId,
    });
  }
  return job.status === 'PENDING' || job.status === 'PROCESSING';
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
    `SELECT id,decision,decision_key,semantic_output,evidence_hash FROM semantic_admission_decisions WHERE candidate_id=$1 ORDER BY created_at DESC LIMIT 1`,
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
  // Only the review path's explicit HUMAN decision key may claim human
  // provenance. Legacy semantic judgments may have lost both provider and
  // model; defaulting them to HUMAN would let them take the shortcut. Default
  // to SEMANTIC so the full classifier owns the decision.
  const decisionSource = resumeAdmissionDecisionSource({
    decisionKey: decision?.rows[0]?.decision_key,
    semanticOutput,
  });
  input.candidate.admissionDecisionId = decisionId;
  input.candidate.admissionStatus = admissionStatus;
  input.candidate.admissionDecisionSource = decisionSource;
  input.candidate.admissionConfirmedTrading = admissionStatus === 'ADMITTED';
  const savedConfidence = semanticOutput?.tradingFocus;
  input.candidate.admissionTradingConfidence = savedConfidence === undefined || savedConfidence === null
    ? (admissionStatus === 'ADMITTED' && decisionSource !== 'SEMANTIC' ? (decisionSource === 'HUMAN' ? 100 : 90) : 0)
    : Number(savedConfidence);
  input.candidate.admissionCitations = Array.isArray(semanticOutput?.citations) ? semanticOutput.citations : [];
  input.candidate.admissionModel = semanticOutput?.model || undefined;
  input.candidate.admissionProvider = ['gemini_semantic', 'groq_semantic', 'gemini_free_semantic'].includes(String(semanticOutput?.provider || ''))
    ? semanticOutput.provider
    : undefined;
  input.candidate.admissionEvidenceHash = decision?.rows[0]?.evidence_hash || row.evidence_hash || undefined;
  input.candidate.admissionCategory = 'General Trading';
  if (admissionStatus === 'ADMITTED_AMBIGUOUS' && decisionSource === 'DETERMINISTIC') {
    const evidence = (row.evidence_snapshot || null) as AdmissionEvidence | null;
    if (!evidence) return false;
    const queued = await enqueueEnrichmentAfterAmbiguousAdmission({
      candidate: input.candidate,
      row,
      evidence,
      decisionId,
      targetCountry: input.targetCountry,
      source: input.source,
      query: input.query,
      queryId: input.queryId,
      queryRunId: input.queryRunId,
      discoveryJobId: input.discoveryJobId,
    });
    if (!queued) throw new Error('ADMISSION_ENRICHMENT_ENQUEUE_FAILED');
    return true;
  }
  const queued = await enqueueClassificationAfterAdmission({
    candidate: classificationCandidateForAdmission(input.candidate, row),
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
    // Deterministic admission abstained. Do not call a second (semantic)
    // admission judge and do not enqueue a classification pass that would run
    // AI on the same pre-enrichment evidence. Acquire creator-owned evidence
    // first; the one full classifier judge runs after enrichment.
    const reasonCodes = ['DETERMINISTIC_ADMISSION_ABSTAINED', ...deterministic.reasonCodes];
    let recordedDecisionId: string | null = null;
    let decisionId: string = randomUUID();
    if (!options.dryRun) {
      const recorded = await recordAdmissionOutcome({
        decision: {
          candidateId: row.id,
          decisionKey: `${row.id}:DETERMINISTIC_AMBIGUOUS:${hash}`,
          channelId: evidence.channelId,
          decision: 'ADMIT_AMBIGUOUS',
          reasonCodes,
          evidenceHash: hash,
        },
        candidate: {
          id: row.id,
          status: 'ADMITTED_AMBIGUOUS',
          decision: 'ADMIT_AMBIGUOUS',
          reasonCodes,
          evidence,
          evidenceHash: hash,
          attempts: Number(row.attempts || 0) + 1,
          nextCheckAt: null,
          expiresAt: null,
          expectedStatus: row.status,
          expectedAttempts: row.attempts,
        },
      });
      recordedDecisionId = recorded.decisionId;
      if (recordedDecisionId) decisionId = recordedDecisionId;
      const now = new Date().toISOString();
      const existing = options.existingChannel === undefined ? await getChannelById(evidence.channelId) : options.existingChannel;
      let preserveExistingDecision = Boolean(existing && (
        existing.trading_status === 'TRADING_CONFIRMED'
        || existing.trading_status === 'NON_TRADING'
        || existing.trading_status === 'HUMAN_REJECTED'
        || existing.scan_status === 'COMPLETED'
        || existing.scan_status === 'SKIPPED_NON_TRADING'
      ));
      if (!existing) {
        input.candidate.admissionNewlyCreated = true;
        const channel = admittedChannel({
          evidence,
          decisionId,
          status: 'ADMITTED_AMBIGUOUS',
          source: input.source,
          now,
        });
        channel.scan_status = 'ENRICHMENT_PENDING';
        channel.inspection_trail = [{
          step: 'BIO',
          title: 'Deterministic admission abstained',
          status: 'FOUND',
          details: `${reasonCodes.join(', ')}; evidence acquisition precedes the full classifier.`,
          timestamp: now,
        }];
        await insertChannelIfAbsent(channel);
      } else if (!preserveExistingDecision) {
        const expectedSnapshot = { scan_status: existing.scan_status, trading_status: existing.trading_status };
        existing.admission_status = 'ADMITTED_AMBIGUOUS';
        existing.admission_decision_id = decisionId;
        existing.scan_status = 'ENRICHMENT_PENDING';
        existing.trading_status = 'UNCERTAIN';
        existing.trading_confidence_score = 0;
        existing.last_checked = now;
        existing.inspection_trail = [...(existing.inspection_trail || []), {
          step: 'BIO',
          title: 'Deterministic admission abstained',
          status: 'FOUND',
          details: `${reasonCodes.join(', ')}; evidence acquisition precedes the full classifier.`,
          timestamp: now,
        }];
        const applied = await upsertChannelWithResult(existing, {
          preserveDiscordOnUpdate: true,
          requireStatusSnapshot: expectedSnapshot,
        });
        if (!applied) {
          // Another worker changed the channel between our read and write.
          // Preserve only a terminal decision; a nonterminal transition still
          // needs the enrichment handoff, otherwise the candidate is stranded.
          const refreshed = await getChannelById(evidence.channelId);
          preserveExistingDecision = Boolean(refreshed && (
            refreshed.trading_status === 'TRADING_CONFIRMED'
            || refreshed.trading_status === 'NON_TRADING'
            || refreshed.trading_status === 'HUMAN_REJECTED'
            || refreshed.scan_status === 'COMPLETED'
            || refreshed.scan_status === 'SKIPPED_NON_TRADING'
          ));
        }
      }
      if (!preserveExistingDecision) {
        await markChannelAdmitted({ channelId: evidence.channelId, decisionId, status: 'ADMITTED_AMBIGUOUS' });
      }
      if (preserveExistingDecision) {
        return {
          channelId: evidence.channelId,
          channelName: evidence.channelName,
          decision: 'ADMIT_AMBIGUOUS',
          status: 'ADMITTED_AMBIGUOUS',
          reasonCodes: [...reasonCodes, 'EXISTING_TERMINAL_DECISION_PRESERVED'],
          evidence,
          deterministicRoute,
          decisionSource: 'DETERMINISTIC',
          priority: deterministic.priority,
        };
      }
      const queued = await enqueueEnrichmentAfterAmbiguousAdmission({
        candidate: input.candidate,
        row,
        evidence,
        decisionId,
        targetCountry: input.targetCountry,
        source: input.source,
        query: input.query,
        queryId: input.queryId,
        queryRunId: input.queryRunId,
        discoveryJobId: input.discoveryJobId || undefined,
      });
      if (!queued) throw new Error('ADMISSION_ENRICHMENT_ENQUEUE_FAILED');
    }
    return {
      channelId: evidence.channelId,
      channelName: evidence.channelName,
      decision: 'ADMIT_AMBIGUOUS',
      status: 'ADMITTED_AMBIGUOUS',
      reasonCodes,
      evidence,
      deterministicRoute,
      decisionSource: 'DETERMINISTIC',
      priority: deterministic.priority,
    };
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
        // Use the evidence that was just evaluated, not the pre-verification
        // row. On a first attempt the stored snapshot may still be null; the
        // classifier must receive the same bio/video sample as the judge.
        candidate: classificationCandidateForAdmission(input.candidate, { ...row, evidence_snapshot: evidence }),
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
