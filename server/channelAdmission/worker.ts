import type { DurableJob } from '../dbCore';
import type { DiscoverySource } from '../../src/types';
import type { DiscoveredChannelRaw } from '../youtube';
import { enqueueAdmissionVerification, findAdmissionCandidate } from './store';
import { verifyAdmissionCandidate } from './index';
import type { AdmissionCandidateInput } from './types';

export const ADMISSION_VERIFICATION_JOB_TYPE = 'VERIFY_CHANNEL_ADMISSION';

export async function processAdmissionVerificationJob(job: DurableJob): Promise<void> {
  const payload = job.payload as Record<string, any>;
  const channelId = String(payload.channelId || '');
  if (!channelId) throw new Error('ADMISSION_JOB_CHANNEL_ID_REQUIRED');
  const row = await findAdmissionCandidate(channelId);
  if (!row) return;
  if (['ADMITTED', 'ADMITTED_AMBIGUOUS', 'REJECTED_UNRELATED', 'REJECTED_COUNTRY', 'EXPIRED_MISSING_EVIDENCE'].includes(row.status)) {
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
  const result = await verifyAdmissionCandidate(input, { row });

  if (result.status === 'WAITING_EVIDENCE') {
    const refreshed = await findAdmissionCandidate(channelId);
    if (refreshed?.next_check_at) {
      await enqueueAdmissionVerification({
        candidate: input,
        runAfter: refreshed.next_check_at,
        attempt: Math.max(2, Number(refreshed.attempts || 0) + 1),
      });
    }
  }
}
