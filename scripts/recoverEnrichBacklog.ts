import { getDb, enqueueJob } from '../server/db';
import {
  buildClassificationJobPayload,
  classificationQueryScopeKey,
  resolveClassificationDecouplingConfig,
  CLASSIFICATION_JOB_TYPE,
} from '../server/classificationDecoupling';
import { candidateFromAdmissionRow } from '../server/channelAdmission';
import type { AdmissionCandidateRow } from '../server/channelAdmission/store';
import type { DiscoveredChannelRaw } from '../server/youtube';
import type { DiscoverySource } from '../src/types';

/**
 * Recover ENRICHING/ENRICHMENT_PENDING channels that have no active job and no
 * next_check. Uses the richest available stored evidence: the semantic
 * admission snapshot first, then the latest ENRICH/CLASSIFY/PROCESS payload,
 * then a minimal channel envelope that lets the pipeline hydrate.
 *
 * Dry-run by default; `--apply` enqueues full-classification jobs. It never
 * approves or rejects a channel.
 */
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = Math.max(1, Math.min(500, Number(limitArg?.split('=')[1] || 25) || 25));

function sourceOf(value: unknown): DiscoverySource {
  return value === 'manual_search' || value === 'recheck' ? value : 'automated_query';
}

const db = await getDb();
const rows = await db.query(
  `select c.channel_id, c.channel_name, c.youtube_url, c.country, c.country_status,
          c.discovery_source, c.subscriber_count, c.scan_status, c.trading_status,
          c.trading_confidence_score,
          cand.id as admission_candidate_id
     from channels c
     left join semantic_admission_candidates cand on cand.channel_id = c.channel_id
    where c.trading_status = 'UNCERTAIN'
      and c.scan_status in ('ENRICHING', 'ENRICHMENT_PENDING')
      and c.next_check is null
      and not exists (
        select 1 from jobs j
         where j.payload->>'channelId' = c.channel_id
           and j.status in ('PENDING', 'PROCESSING')
      )
    order by c.last_checked asc nulls first
    limit $1`,
  [limit],
);

const config = resolveClassificationDecouplingConfig();
let selected = 0;
let enqueued = 0;
for (const row of rows.rows as Array<Record<string, any>>) {
  selected += 1;
  const channelId = String(row.channel_id);
  let candidate: DiscoveredChannelRaw | null = null;
  let targetCountry = String(row.country || 'UNKNOWN');
  let source = sourceOf(row.discovery_source);
  let queryRunId: string | undefined;
  let queryId: number | undefined;
  let discoveryJobId: string | undefined;

  if (row.admission_candidate_id) {
    const admission = await db.query(
      `select cand.* from semantic_admission_candidates cand where cand.channel_id=$1 order by cand.updated_at desc limit 1`,
      [channelId],
    );
    if (admission.rowCount) {
      candidate = candidateFromAdmissionRow(admission.rows[0] as AdmissionCandidateRow);
      candidate.admissionConfirmedTrading = false;
      candidate.admissionDecisionSource = 'SEMANTIC';
      targetCountry = String(admission.rows[0].target_country || targetCountry);
      source = sourceOf(admission.rows[0].source);
      queryRunId = admission.rows[0].query_run_id || undefined;
      queryId = typeof admission.rows[0].query_id === 'number' ? admission.rows[0].query_id : undefined;
      discoveryJobId = admission.rows[0].job_id || undefined;
    }
  }

  if (!candidate) {
    const latest = await db.query(
      `select id, type, payload, payload->>'targetCountry' as target_country, payload->>'source' as source,
              payload->'candidate' as candidate
         from jobs
        where payload->>'channelId'=$1
          and type in ('ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','PROCESS_DISCOVERED_CHANNEL')
        order by created_at desc limit 1`,
      [channelId],
    );
    if (latest.rowCount && latest.rows[0].candidate) {
      candidate = latest.rows[0].candidate as DiscoveredChannelRaw;
      targetCountry = String(latest.rows[0].target_country || targetCountry);
      source = sourceOf(latest.rows[0].source);
      discoveryJobId = String(latest.rows[0].id);
      const payload = latest.rows[0].payload || {};
      queryRunId = typeof payload.queryRunId === 'string' ? payload.queryRunId : undefined;
      queryId = typeof payload.queryId === 'number' ? payload.queryId : undefined;
    }
  }

  if (!candidate) {
    candidate = {
      channelId,
      channelName: String(row.channel_name),
      youtubeUrl: String(row.youtube_url),
      description: '',
      videoTitles: [],
      subscriberCount: row.subscriber_count || undefined,
      locationTag: row.country || undefined,
    };
  }

  // Never let a recovered job reuse the admission shortcut.
  candidate.admissionConfirmedTrading = false;
  if (candidate.admissionDecisionSource === 'SEMANTIC') candidate.admissionConfirmedTrading = false;

  const payload = buildClassificationJobPayload({
    candidate,
    targetCountry,
    source,
    queryRunId,
    queryId,
    queryScopeKey: classificationQueryScopeKey({
      queryRunId,
      queryId,
      query: candidate.channelName,
      country: targetCountry,
    }),
    discoveryJobId: discoveryJobId || `enrich-backlog-recovery:${channelId}`,
    quotaOrigin: 'NORMAL',
    forceExtraction: false,
    forceClassification: true,
  });
  const idempotencyKey = `enrich-backlog-recovery:${channelId}:${discoveryJobId || 'none'}:v1`;
  const summary = {
    channelId,
    channelName: row.channel_name,
    confidence: Number(row.trading_confidence_score || 0),
    scanStatus: row.scan_status,
    evidenceVideos: candidate.videos?.length || 0,
    evidenceTitles: candidate.videoTitles?.length || 0,
    hasBio: Boolean(candidate.description?.trim()),
    targetCountry,
    idempotencyKey,
  };
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, ...summary }));
    continue;
  }
  const job = await enqueueJob(CLASSIFICATION_JOB_TYPE, payload, {
    priority: config.priority,
    maxAttempts: 4,
    idempotencyKey,
    preventCompletedReopen: true,
  });
  enqueued += 1;
  console.log(JSON.stringify({ enqueued: true, jobId: job.id, ...summary }));
}
console.log(JSON.stringify({ apply, selected, enqueued, limit }));
