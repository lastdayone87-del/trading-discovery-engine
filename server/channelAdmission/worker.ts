import type { DurableJob } from '../dbCore';
import { getChannelById } from '../db';
import type { DiscoverySource } from '../../src/types';
import type { DiscoveredChannelRaw } from '../youtube';
import { enqueueAdmissionVerification, findAdmissionCandidate, getAdmissionMode } from './store';
import { resumeAdmittedCandidate, verifyAdmissionCandidate } from './index';
import { isRejectedAdmissionStatus, isWaitingAdmissionStatus } from './types';
import type { AdmissionCandidateInput, AdmissionEvidence } from './types';
import type { AdmissionJudge } from './semanticJudge';

export const ADMISSION_VERIFICATION_JOB_TYPE = 'VERIFY_CHANNEL_ADMISSION';

export interface AdmissionWorkerOverrides {
  /** Deterministic fixture seam for lifecycle tests. */
  evidenceOverride?: AdmissionEvidence;
  judge?: AdmissionJudge;
}

/**
 * Provider deferrals deliberately do not advance the candidate's evidence
 * attempt counter. Their retry key therefore follows the durable job's own
 * attempt number; otherwise every deferral would reuse `retry:2` while that
 * job is still PROCESSING and no successor would be scheduled. Evidence
 * retries still follow the candidate attempt count.
 */
export function nextAdmissionVerificationAttempt(input: {
  status: string;
  jobAttempt?: number;
  candidateAttempts?: number;
}): number {
  if (input.status === 'PROVIDER_DEFERRED') {
    return Math.max(2, Number(input.jobAttempt || 1) + 1);
  }
  return Math.max(2, Number(input.candidateAttempts || 0) + 1);
}

export async function processAdmissionVerificationJob(job: DurableJob, overrides: AdmissionWorkerOverrides = {}): Promise<void> {
  if ((await getAdmissionMode()) === 'OFF') throw new Error('ADMISSION_MODE_OFF');
  const payload = job.payload as Record<string, any>;
  const channelId = String(payload.channelId || '');
  if (!channelId) throw new Error('ADMISSION_JOB_CHANNEL_ID_REQUIRED');
  const row = await findAdmissionCandidate(channelId);
  if (!row) return;
  if (isRejectedAdmissionStatus(row.status)) {
    return;
  }
  const candidate = (payload.candidate || {
    channelId,
    channelName: row.channel_name,
    youtubeUrl: row.youtube_url,
    description: row.raw_observation?.description || '',
    videoTitles: row.raw_observation?.videoTitles || [],
    videoDescriptions: row.raw_observation?.videoDescriptions || [],
    matchedDocument: row.matched_document,
    locationTag: row.raw_observation?.locationTag || undefined,
  }) as DiscoveredChannelRaw;
  const input: AdmissionCandidateInput = {
    candidate,
    targetCountry: String(payload.targetCountry || row.target_country || ''),
    source: String(payload.source || row.source) as DiscoverySource,
    query: payload.query ? String(payload.query) : undefined,
    queryId: payload.queryId ? Number(payload.queryId) : row.query_id || undefined,
    queryRunId: payload.queryRunId ? String(payload.queryRunId) : row.query_run_id || undefined,
    discoveryJobId: payload.discoveryJobId ? String(payload.discoveryJobId) : row.job_id || undefined,
    pageNumber: payload.pageNumber ? Number(payload.pageNumber) : row.page_number || undefined,
    resultRank: payload.resultRank ? Number(payload.resultRank) : row.result_rank || undefined,
  };
  const existingChannel = await getChannelById(channelId);
  if (['ADMITTED', 'ADMITTED_AMBIGUOUS'].includes(row.status)) {
    const resumed = await resumeAdmittedCandidate(input, row);
    if (resumed) return;
  }
  const legacyRevalidation = existingChannel?.scan_status === 'INTAKE_DEFERRED' || existingChannel?.scan_status === 'CLASSIFICATION_PENDING';
  const result = await verifyAdmissionCandidate(input, {
    row,
    existingChannel,
    archiveRejectedExistingChannel: legacyRevalidation,
    evidenceOverride: overrides.evidenceOverride,
    judge: overrides.judge,
  });

  if (isWaitingAdmissionStatus(result.status)) {
    const refreshed = await findAdmissionCandidate(channelId);
    if (refreshed?.next_check_at) {
      await enqueueAdmissionVerification({
        candidate: input,
        runAfter: refreshed.next_check_at,
        attempt: nextAdmissionVerificationAttempt({
          status: result.status,
          jobAttempt: Number(payload.attempt || 1),
          candidateAttempts: Number(refreshed.attempts || 0),
        }),
        priority: result.priority,
      });
    }
  }
}
