/**
 * Revalidate legacy INTAKE_DEFERRED rows through the semantic admission gate.
 *
 * Default is a read-only dry-run. `--apply` updates the candidate ledger,
 * archives unrelated rows from the normal dashboard, and enqueues normal
 * classification only for admitted creators. It never releases a row directly
 * to enrichment.
 *
 * Usage:
 *   npx tsx scripts/revalidateIntakeDeferredChannels.ts --limit=50
 *   npx tsx scripts/revalidateIntakeDeferredChannels.ts --limit=50 --apply
 */
import { randomUUID } from 'node:crypto';
import { getChannelById, getDb } from '../server/db';
import type { DiscoveredChannelRaw } from '../server/youtube';
import type { ChannelRecord, DiscoverySource } from '../src/types';
import { resumeAdmittedCandidate, verifyAdmissionCandidate } from '../server/channelAdmission';
import { enqueueAdmissionVerification, findAdmissionCandidate, getAdmissionMode, upsertAdmissionCandidate, type AdmissionCandidateRow } from '../server/channelAdmission/store';
import type { AdmissionCandidateInput } from '../server/channelAdmission/types';

interface DeferredRow {
  channel_id: string;
  channel_name: string;
  youtube_url: string;
  country: string | null;
  country_status: string | null;
  scan_status: string;
  trading_status: string | null;
  discovery_source: string | null;
  subscriber_count: string | null;
  channel_thumbnail_url: string | null;
  inspection_trail: unknown;
  enrich_payload: Record<string, any> | null;
}

function argValue(name: string): string | undefined {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

function candidateFromRow(row: DeferredRow): DiscoveredChannelRaw {
  const jobCandidate = row.enrich_payload?.candidate;
  if (jobCandidate && typeof jobCandidate === 'object') {
    return {
      ...jobCandidate,
      channelId: row.channel_id,
      channelName: jobCandidate.channelName || row.channel_name,
      youtubeUrl: jobCandidate.youtubeUrl || row.youtube_url,
    } as DiscoveredChannelRaw;
  }
  return {
    channelId: row.channel_id,
    channelName: row.channel_name,
    youtubeUrl: row.youtube_url,
    description: '',
    videoTitles: [],
    subscriberCount: row.subscriber_count || undefined,
    channelThumbnailUrl: row.channel_thumbnail_url || undefined,
  };
}

function fakeRow(row: DeferredRow): AdmissionCandidateRow {
  return {
    id: `dry-run-${row.channel_id}`,
    candidate_key: `dry-run:${row.channel_id}`,
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    youtube_url: row.youtube_url,
    source: row.discovery_source || 'automated_query',
    query_id: null, query_run_id: null, job_id: null, page_number: null, result_rank: null,
    target_country: row.country, matched_document: {}, raw_observation: {},
    declared_language: null, status: 'PENDING', decision: null, reason_codes: [],
    evidence_snapshot: null, evidence_hash: null, semantic_output: null, semantic_model: null,
    attempts: 0, next_check_at: null, expires_at: null, decided_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const parsedLimit = Number(argValue('limit') || 50);
  const parsedOffset = Number(argValue('offset') || 0);
  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) throw new Error('INVALID_LIMIT');
  if (!Number.isFinite(parsedOffset) || parsedOffset < 0) throw new Error('INVALID_OFFSET');
  const limit = Math.min(500, Math.floor(parsedLimit));
  const offset = Math.floor(parsedOffset);
  // Applied rows leave the INTAKE_DEFERRED set, so offset paging would skip
  // unprocessed rows. Apply batches intentionally start at offset zero.
  if (apply && offset > 0) throw new Error('APPLY_REQUIRES_OFFSET_ZERO');
  const country = argValue('country')?.trim();
  const explicitTarget = argValue('target-country')?.trim();
  const db = await getDb();
  if (apply) {
    if ((await getAdmissionMode()) !== 'ACTIVE') throw new Error('CHANNEL_ADMISSION_OFF');
    const schema = await db.query(`SELECT to_regclass('public.semantic_admission_candidates') AS table_oid`);
    if (!schema.rows[0]?.table_oid) throw new Error('MIGRATION_178_REQUIRED: apply mode needs the semantic admission tables');
  }
  const waitingFilter = apply
    ? `AND NOT EXISTS (
         SELECT 1 FROM semantic_admission_candidates cac
          WHERE cac.channel_id=c.channel_id
            AND cac.status='WAITING_EVIDENCE'
            AND cac.next_check_at IS NOT NULL
            AND cac.next_check_at > now()
       )`
    : '';
  const result = await db.query(
    `SELECT c.channel_id,c.channel_name,c.youtube_url,c.country,c.country_status,c.scan_status,c.trading_status,
            c.discovery_source,c.subscriber_count,c.channel_thumbnail_url,c.inspection_trail,
            j.payload AS enrich_payload
       FROM channels c
       LEFT JOIN LATERAL (
         SELECT payload FROM jobs WHERE type='ENRICH_CHANNEL' AND payload->>'channelId'=c.channel_id
         ORDER BY created_at DESC LIMIT 1
       ) j ON true
      WHERE c.scan_status='INTAKE_DEFERRED'
        AND ($2::text IS NULL OR LOWER(c.country)=LOWER($2))
        ${waitingFilter}
      ORDER BY c.first_seen, c.channel_id
      LIMIT $1 OFFSET $3`,
    [limit, country || null, offset],
  );
  const rows = result.rows as DeferredRow[];
  const counts = { admitted: 0, ambiguous: 0, rejected: 0, held: 0, expired: 0, country: 0, failed: 0 };
  for (const row of rows) {
    const candidate = candidateFromRow(row);
    const targetCountry = String(explicitTarget || row.enrich_payload?.targetCountry || '');
    const source = String(row.discovery_source || 'automated_query') as DiscoverySource;
    const input: AdmissionCandidateInput = { candidate, targetCountry, source };
    try {
      let candidateRow: AdmissionCandidateRow;
      if (apply) {
        candidateRow = await upsertAdmissionCandidate(input);
      } else {
        candidateRow = fakeRow(row);
      }
      const existingChannel = apply ? await getChannelById(row.channel_id) : (row as unknown as ChannelRecord);
      const outcome = await verifyAdmissionCandidate(input, {
        row: candidateRow,
        existingChannel,
        dryRun: !apply,
        archiveRejectedExistingChannel: apply,
      });
      if (apply && outcome.status === 'WAITING_EVIDENCE') {
        const refreshed = await findAdmissionCandidate(row.channel_id);
        if (refreshed?.next_check_at) {
          await enqueueAdmissionVerification({
            candidate: input,
            runAfter: refreshed.next_check_at,
            attempt: Math.max(2, Number(refreshed.attempts || 0) + 1),
          });
        }
      }
      if (outcome.decision === 'ADMIT') counts.admitted += 1;
      else if (outcome.decision === 'ADMIT_AMBIGUOUS') counts.ambiguous += 1;
      else if (outcome.decision === 'REJECT_UNRELATED') counts.rejected += 1;
      else if (outcome.decision === 'REJECT_COUNTRY') counts.country += 1;
      else if (outcome.status === 'EXPIRED_MISSING_EVIDENCE') counts.expired += 1;
      else counts.held += 1;
      console.log(JSON.stringify({
        event: 'intake_deferred_revalidation',
        apply,
        channelId: row.channel_id,
        channelName: row.channel_name,
        decision: outcome.decision,
        status: outcome.status,
        reasonCodes: outcome.reasonCodes,
        evidenceCoverage: outcome.evidence.evidenceCoverage,
        counts,
        timestamp: new Date().toISOString(),
      }));
    } catch (error) {
      counts.failed += 1;
      if (apply) {
        const refreshed = await findAdmissionCandidate(row.channel_id).catch(() => null);
        if (refreshed) {
          if (['ADMITTED', 'ADMITTED_AMBIGUOUS'].includes(refreshed.status)) {
            await resumeAdmittedCandidate(input, refreshed).catch(retryError => {
              console.error(JSON.stringify({ event: 'intake_deferred_classification_retry_failed', channelId: row.channel_id, error: retryError instanceof Error ? retryError.message : String(retryError) }));
            });
          } else {
            await enqueueAdmissionVerification({
              candidate: input,
              attempt: Math.max(2, Number(refreshed.attempts || 0) + 1),
            }).catch(retryError => {
              console.error(JSON.stringify({ event: 'intake_deferred_verification_retry_failed', channelId: row.channel_id, error: retryError instanceof Error ? retryError.message : String(retryError) }));
            });
          }
        }
      }
      console.error(JSON.stringify({
        event: 'intake_deferred_revalidation_failed',
        apply,
        channelId: row.channel_id,
        channelName: row.channel_name,
        error: error instanceof Error ? error.message : String(error),
        counts,
        timestamp: new Date().toISOString(),
      }));
    }
  }
  console.log(JSON.stringify({
    event: 'intake_deferred_revalidation_summary',
    apply,
    limit,
    offset,
    country: country || null,
    targetCountry: explicitTarget || null,
    selected: rows.length,
    counts,
  }));
  if (counts.failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error('Intake deferred revalidation failed:', error);
  process.exit(1);
});
