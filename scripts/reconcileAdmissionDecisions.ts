/**
 * Bounded admission/backlog reconciliation.
 *
 * Re-runs the unified pre-catalog admission decision against the preserved
 * evidence snapshot for legacy ambiguous/review rows. Dry-run by default;
 * `--apply` performs at most `--limit` decisions and never bulk-approves.
 *
 * Legacy `ADMITTED_AMBIGUOUS`/`NEEDS_REVIEW` candidates remain readable, but
 * this script is the explicit path that moves them to a terminal state. With
 * `--include-confirmed` it also audits legacy confirmed admissions such as the
 * old broad MARKET_INSTITUTION rows.
 */
import { getChannelById, getDb } from '../server/db';
import { candidateFromAdmissionRow, verifyAdmissionCandidate } from '../server/channelAdmission';
import { findAdmissionCandidate, type AdmissionCandidateRow } from '../server/channelAdmission/store';
import type { AdmissionCandidateInput, AdmissionEvidence } from '../server/channelAdmission/types';
import type { DiscoverySource } from '../src/types';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeConfirmed = args.includes('--include-confirmed');
const channelArg = args.find(arg => arg.startsWith('--channel='))?.split('=').slice(1).join('=');
const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = Math.max(1, Math.min(200, Number(limitArg?.split('=')[1] || 25) || 25));

function sourceOf(value: unknown): DiscoverySource {
  return value === 'manual_search' || value === 'recheck' ? value : 'automated_query';
}

const db = await getDb();
const statuses = includeConfirmed
  ? ['ADMITTED', 'ADMITTED_AMBIGUOUS', 'WAITING_EVIDENCE', 'PROVIDER_DEFERRED', 'NEEDS_REVIEW']
  : ['ADMITTED_AMBIGUOUS', 'WAITING_EVIDENCE', 'PROVIDER_DEFERRED', 'NEEDS_REVIEW'];
const selected = await db.query(
  `SELECT cand.*
     FROM semantic_admission_candidates cand
     JOIN channels c ON c.channel_id = cand.channel_id
    WHERE cand.status = ANY($1::text[])
      AND ($2::text IS NULL OR cand.channel_id = $2)
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
         WHERE j.status IN ('PENDING','PROCESSING')
           AND j.type IN ('VERIFY_CHANNEL_ADMISSION','ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL')
           AND j.payload->>'channelId' = cand.channel_id
      )
    ORDER BY cand.first_seen ASC
    LIMIT $3`,
  [statuses, channelArg || null, limit],
);

const results: Array<Record<string, unknown>> = [];
for (const raw of selected.rows as Array<Record<string, any>>) {
  const row = await findAdmissionCandidate(String(raw.channel_id));
  if (!row) continue;
  const evidence = (row.evidence_snapshot || null) as AdmissionEvidence | null;
  if (!evidence) {
    results.push({ channelId: row.channel_id, skipped: 'NO_EVIDENCE_SNAPSHOT' });
    continue;
  }
  const candidate = candidateFromAdmissionRow(row);
  const input: AdmissionCandidateInput = {
    candidate,
    targetCountry: row.target_country || '',
    source: sourceOf(row.source),
    queryId: row.query_id || undefined,
    queryRunId: row.query_run_id || undefined,
    discoveryJobId: row.job_id || undefined,
    pageNumber: row.page_number || undefined,
    resultRank: row.result_rank || undefined,
  };
  const existingChannel = await getChannelById(row.channel_id);
  try {
    const result = await verifyAdmissionCandidate(input, {
      row,
      existingChannel,
      evidenceOverride: evidence,
      dryRun: !apply,
      archiveRejectedExistingChannel: true,
    });
    results.push({
      channelId: row.channel_id,
      priorStatus: row.status,
      decision: result.decision,
      status: result.status,
      reasonCodes: result.reasonCodes,
      applied: apply,
    });
  } catch (error) {
    results.push({
      channelId: row.channel_id,
      priorStatus: row.status,
      error: error instanceof Error ? error.message : String(error),
      applied: false,
    });
  }
}

console.log(JSON.stringify({
  event: 'admission_backlog_reconciliation',
  apply,
  includeConfirmed,
  limit,
  selected: selected.rowCount,
  applied: results.filter(result => result.applied === true).length,
  results,
  timestamp: new Date().toISOString(),
}, null, 2));

export type { AdmissionCandidateRow };
