import { getDb, enqueueJob } from '../server/db';
import {
  buildClassificationJobPayload,
  classificationQueryScopeKey,
  resolveClassificationDecouplingConfig,
  CLASSIFICATION_JOB_TYPE,
} from '../server/classificationDecoupling';
import { candidateFromAdmissionRow } from '../server/channelAdmission';
import type { AdmissionCandidateRow } from '../server/channelAdmission/store';
import type { DiscoverySource } from '../src/types';

/**
 * Reclassify semantic-admitted channels through the full classifier using the
 * original admission evidence snapshot. This is deliberately a dry-run by
 * default; `--apply` enqueues one CLASSIFY_DISCOVERED_CHANNEL job per channel.
 *
 * It does not approve, reject or relabel anything. The full classifier owns the
 * outcome. Active jobs are skipped; the idempotency key prevents duplicates.
 */
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = Math.max(1, Math.min(500, Number(limitArg?.split('=')[1] || 25) || 25));
const includeConfirmed = args.includes('--include-confirmed');

function sourceOf(value: unknown): DiscoverySource {
  return value === 'manual_search' || value === 'recheck' ? value : 'automated_query';
}

const db = await getDb();
const rows = await db.query(
  `select cand.*,
          c.channel_id as channel_id,
          c.trading_status,
          c.scan_status,
          c.trading_confidence_score,
          c.admission_decision_id,
          s.decision,
          s.semantic_output,
          s.reason_codes as admission_reason_codes
     from channels c
     join semantic_admission_decisions s on s.id = c.admission_decision_id
     join semantic_admission_candidates cand on cand.id = s.candidate_id
    where s.decision in ('ADMIT', 'ADMIT_AMBIGUOUS')
      and (c.admission_status = 'ADMITTED' or c.admission_status = 'ADMITTED_AMBIGUOUS')
      -- Semantic admission only. Deterministic and human admissions are
      -- legitimate first-class decisions and keep their fast path.
      and coalesce(s.semantic_output->>'model', '') <> 'deterministic-first-v1'
      and coalesce(s.decision_key, '') not like '%:HUMAN:%'
      and ($2::boolean or c.trading_status in ('NEEDS_REVIEW', 'UNCERTAIN'))
      and not exists (
        select 1 from jobs j
         where j.payload->>'channelId' = c.channel_id
           and j.status in ('PENDING', 'PROCESSING')
      )
      -- A completed reprocessing job owns this decision; only failed work is
      -- retried. This keeps repeated bounded batches moving forward.
      and not exists (
        select 1 from jobs j
         where j.idempotency_key = 'semantic-admission-reprocess:' || c.channel_id || ':' || c.admission_decision_id || ':v1'
           and j.status = 'COMPLETED'
      )
    order by c.updated_at desc
    limit $1`,
  [limit, includeConfirmed],
);

const config = resolveClassificationDecouplingConfig();
let selected = 0;
let enqueued = 0;
for (const row of rows.rows as Array<Record<string, any>>) {
  selected += 1;
  const admissionRow = row as unknown as AdmissionCandidateRow;
  const candidate = candidateFromAdmissionRow(admissionRow);
  // Semantic admission is a router. Clear the shortcut marker so the full
  // classifier receives the original evidence and applies all safeguards.
  candidate.admissionConfirmedTrading = false;
  candidate.admissionDecisionSource = 'SEMANTIC';
  const semantic = row.semantic_output && typeof row.semantic_output === 'object' ? row.semantic_output : {};
  candidate.admissionTradingConfidence = Number(
    semantic.tradingFocus ?? semantic.raw?.trading_focus ?? 0,
  );
  const targetCountry = String(row.target_country || row.evidence_snapshot?.targetCountry || 'UNKNOWN');
  const source = sourceOf(row.source);
  const query = String(row.raw_observation?.query || row.channel_name || '');
  const payload = buildClassificationJobPayload({
    candidate,
    targetCountry,
    source,
    queryRunId: row.query_run_id || undefined,
    queryId: typeof row.query_id === 'number' ? row.query_id : undefined,
    queryScopeKey: classificationQueryScopeKey({
      queryRunId: row.query_run_id || undefined,
      queryId: typeof row.query_id === 'number' ? row.query_id : undefined,
      query,
      country: targetCountry,
    }),
    discoveryJobId: row.job_id || `semantic-admission-reprocess:${row.channel_id}`,
    quotaOrigin: 'NORMAL',
    forceExtraction: false,
    forceClassification: true,
  });
  const idempotencyKey = `semantic-admission-reprocess:${row.channel_id}:${row.admission_decision_id}:v1`;
  const summary = {
    channelId: row.channel_id,
    channelName: row.channel_name,
    status: row.trading_status,
    confidence: Number(row.trading_confidence_score || 0),
    admissionDecision: row.decision,
    admissionFocus: candidate.admissionTradingConfidence,
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
  if (job.status !== 'PENDING' && job.status !== 'PROCESSING') {
    console.log(JSON.stringify({ skipped: true, reason: 'JOB_ALREADY_TERMINAL', jobId: job.id, jobStatus: job.status, ...summary }));
    continue;
  }
  enqueued += 1;
  console.log(JSON.stringify({ enqueued: true, jobId: job.id, ...summary }));
}
console.log(JSON.stringify({ apply, selected, enqueued, limit }));
