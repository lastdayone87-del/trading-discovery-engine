import { getDb, enqueueClassificationJobAtomic, getClassificationBackpressureState } from '../server/db';
import {
  buildClassificationJobPayload,
  classificationQueryScopeKey,
  resolveClassificationDecouplingConfig,
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
let limit = Math.max(1, Math.min(500, Number(limitArg?.split('=')[1] || 25) || 25));

function sourceOf(value: unknown): DiscoverySource {
  return value === 'manual_search' || value === 'recheck' ? value : 'automated_query';
}

const config = resolveClassificationDecouplingConfig();
const db = await getDb();
let capacityFull = false;
if (apply) {
  const capacity = await getClassificationBackpressureState('enrich-backlog-recovery');
  const remaining = Math.max(0, capacity.maxPending - capacity.globalPending);
  if (remaining === 0) {
    capacityFull = true;
    console.log(JSON.stringify({
      apply,
      capacityFull: true,
      globalPending: capacity.globalPending,
      maxPending: capacity.maxPending,
      selected: 0,
      enqueued: 0,
    }));
  } else if (remaining < limit) {
    console.log(JSON.stringify({ apply, capacityLimited: true, requested: limit, effectiveLimit: remaining }));
    limit = remaining;
  }
}
const rows = capacityFull ? { rows: [] as Array<Record<string, any>> } : await db.query(
  `select c.channel_id, c.channel_name, c.youtube_url, c.country, c.country_status,
          c.discovery_source, c.subscriber_count, c.scan_status, c.trading_status,
          c.trading_confidence_score,
          (select cand.id
             from semantic_admission_candidates cand
            where cand.channel_id = c.channel_id
            order by cand.updated_at desc
            limit 1) as admission_candidate_id
     from channels c
    where c.trading_status = 'UNCERTAIN'
      and c.scan_status in ('ENRICHING', 'ENRICHMENT_PENDING')
      and c.next_check is null
      and not exists (
        select 1 from jobs j
         where j.payload->>'channelId' = c.channel_id
           and j.status in ('PENDING', 'PROCESSING')
      )
      -- Completed recovery work owns the channel. Failed recovery work is
      -- reopened so a later bounded pass can retry it.
      and not exists (
        select 1 from jobs j
         where left(j.idempotency_key, length('enrich-backlog-recovery:' || c.channel_id || ':')) = 'enrich-backlog-recovery:' || c.channel_id || ':'
           and j.status = 'COMPLETED'
      )
    order by c.last_checked asc nulls first
    limit $1`,
  [limit],
);

let selected = 0;
let enqueued = 0;
for (const row of rows.rows as Array<Record<string, any>>) {
  selected += 1;
  const channelId = String(row.channel_id);
  let candidate: DiscoveredChannelRaw | null = null;
  // channels.country is the detected creator country, not the discovery
  // target. Never substitute it here: without a stored discovery target the
  // safe value is UNKNOWN.
  let targetCountry = 'UNKNOWN';
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
  // Stable per-channel key. Using the newest discovery job id would change the
  // key after every attempt and could enqueue the same channel indefinitely.
  const idempotencyKey = `enrich-backlog-recovery:${channelId}:v1`;
  const summary = {
    channelId,
    channelName: candidate.channelName,
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
  // Re-check before every insert so the batch stops at the configured cap even
  // when normal workers or a concurrent operator run add pending jobs. The cap
  // is the same soft boundary used by search admission; the per-insert check
  // bounds any concurrent overrun to one job per writer.
  const capacity = await getClassificationBackpressureState(payload.queryScopeKey);
  if (capacity.globalPending >= capacity.maxPending || capacity.scopedPending >= capacity.maxPerQuery) {
    console.log(JSON.stringify({ stopped: true, reason: 'CLASSIFICATION_CAPACITY_FULL', globalPending: capacity.globalPending, maxPending: capacity.maxPending, scopedPending: capacity.scopedPending, maxPerQuery: capacity.maxPerQuery, ...summary }));
    break;
  }
  const job = await enqueueClassificationJobAtomic(channelId, payload, {
    priority: config.priority,
    maxAttempts: config.maxAttempts,
    idempotencyKey,
    preventCompletedReopen: true,
  });
  if (!job) {
    console.log(JSON.stringify({ skipped: true, reason: 'ACTIVE_CLASSIFICATION_OWNED', ...summary }));
    continue;
  }
  if (job.status !== 'PENDING' && job.status !== 'PROCESSING') {
    console.log(JSON.stringify({ skipped: true, reason: 'JOB_ALREADY_TERMINAL', jobId: job.id, jobStatus: job.status, ...summary }));
    continue;
  }
  enqueued += 1;
  console.log(JSON.stringify({ enqueued: true, jobId: job.id, ...summary }));
}
console.log(JSON.stringify({ apply, selected, enqueued, limit }));
