import { enqueueJob, getAppSetting, getDb } from '../db';
import type {
  AdmissionCandidateInput,
  AdmissionDecision,
  AdmissionEvidence,
  AdmissionMode,
  AdmissionStatus,
  SemanticJudgment,
} from './types';
import { ADMISSION_POLICY_VERSION } from './policy';
import { resolvePreChannelAdmissionQuotaOrigin } from '../quotaOrigin';

type AdmissionQueryable = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export interface AdmissionCandidateRow {
  id: string;
  candidate_key: string;
  channel_id: string;
  channel_name: string;
  youtube_url: string;
  source: string;
  query_id: number | null;
  query_run_id: string | null;
  job_id: string | null;
  page_number: number | null;
  result_rank: number | null;
  target_country: string | null;
  matched_document: Record<string, unknown>;
  raw_observation: Record<string, unknown>;
  declared_language: string | null;
  status: AdmissionStatus;
  decision: AdmissionDecision | null;
  reason_codes: string[];
  evidence_snapshot: AdmissionEvidence | null;
  evidence_hash: string | null;
  semantic_output: SemanticJudgment | null;
  semantic_model: string | null;
  attempts: number;
  next_check_at: string | null;
  expires_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export function admissionCandidateKey(channelId: string): string {
  return `admission:${channelId}:v1`;
}

export function admissionModeFromOverrides(envValue: unknown, settingValue: unknown): AdmissionMode {
  const env = String(envValue || '').trim().toUpperCase();
  // An explicit process override always wins. Unrecognized values fail
  // closed instead of silently inheriting an ACTIVE database setting.
  if (env) return env === 'ACTIVE' || env === 'ON' ? 'ACTIVE' : 'OFF';
  const setting = String(settingValue || '').trim().toUpperCase();
  // Only an explicit enablement activates the gate. A typo or unknown value
  // must not silently divert production discovery.
  return setting === 'ACTIVE' || setting === 'ON' ? 'ACTIVE' : 'OFF';
}

export async function getAdmissionMode(): Promise<AdmissionMode> {
  if (String(process.env.CHANNEL_ADMISSION_MODE || '').trim()) {
    return admissionModeFromOverrides(process.env.CHANNEL_ADMISSION_MODE, null);
  }
  try {
    return admissionModeFromOverrides(null, await getAppSetting('channel_admission_mode', 'OFF'));
  } catch {
    return 'OFF';
  }
}

function mapRow(row: any): AdmissionCandidateRow {
  return {
    ...row,
    reason_codes: Array.isArray(row.reason_codes) ? row.reason_codes : [],
    matched_document: row.matched_document || {},
    raw_observation: row.raw_observation || {},
  } as AdmissionCandidateRow;
}

export async function findAdmissionCandidate(channelId: string): Promise<AdmissionCandidateRow | null> {
  const db = await getDb();
  const result = await db.query(
    `SELECT * FROM semantic_admission_candidates WHERE candidate_key=$1 LIMIT 1`,
    [admissionCandidateKey(channelId)],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function upsertAdmissionCandidate(input: AdmissionCandidateInput): Promise<AdmissionCandidateRow> {
  const db = await getDb();
  const matchedDocument = input.candidate.matchedDocument || {};
  const rawObservation = {
    channelName: input.candidate.channelName,
    youtubeUrl: input.candidate.youtubeUrl,
    locationTag: input.candidate.locationTag || null,
    description: input.candidate.description || '',
    videoTitles: input.candidate.videoTitles || [],
    videoDescriptions: input.candidate.videoDescriptions || [],
    quotaOrigin: resolvePreChannelAdmissionQuotaOrigin(input.candidate.quotaOrigin),
    matchedDocument,
  };
  const result = await db.query(
    `INSERT INTO semantic_admission_candidates(
       candidate_key,channel_id,channel_name,youtube_url,source,query_id,query_run_id,job_id,
       page_number,result_rank,target_country,matched_document,raw_observation,declared_language,status,attempts
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,'PENDING',0)
     ON CONFLICT (candidate_key) DO UPDATE SET
       channel_name=EXCLUDED.channel_name,
       youtube_url=EXCLUDED.youtube_url,
       source=EXCLUDED.source,
       query_id=COALESCE(EXCLUDED.query_id,semantic_admission_candidates.query_id),
       query_run_id=COALESCE(EXCLUDED.query_run_id,semantic_admission_candidates.query_run_id),
       job_id=COALESCE(EXCLUDED.job_id,semantic_admission_candidates.job_id),
       page_number=COALESCE(EXCLUDED.page_number,semantic_admission_candidates.page_number),
       result_rank=COALESCE(EXCLUDED.result_rank,semantic_admission_candidates.result_rank),
       target_country=COALESCE(EXCLUDED.target_country,semantic_admission_candidates.target_country),
       matched_document=EXCLUDED.matched_document,
       raw_observation=CASE
         WHEN semantic_admission_candidates.raw_observation->>'quotaOrigin'='PROBE'
           OR EXCLUDED.raw_observation->>'quotaOrigin'='PROBE'
           THEN jsonb_set(EXCLUDED.raw_observation,'{quotaOrigin}','"PROBE"'::jsonb,true)
         ELSE EXCLUDED.raw_observation
       END,
       declared_language=COALESCE(EXCLUDED.declared_language,semantic_admission_candidates.declared_language),
       status=CASE
         WHEN semantic_admission_candidates.status IN ('REJECTED_UNRELATED','REJECTED_COUNTRY','ADMITTED','ADMITTED_AMBIGUOUS','EXPIRED_MISSING_EVIDENCE','NEEDS_REVIEW')
           THEN semantic_admission_candidates.status
         WHEN semantic_admission_candidates.status IN ('WAITING_EVIDENCE','PROVIDER_DEFERRED')
           AND semantic_admission_candidates.next_check_at IS NOT NULL
           AND semantic_admission_candidates.next_check_at > now()
           THEN semantic_admission_candidates.status
         ELSE 'PENDING'
       END,
       next_check_at=CASE
         WHEN semantic_admission_candidates.status IN ('WAITING_EVIDENCE','PROVIDER_DEFERRED')
           AND semantic_admission_candidates.next_check_at IS NOT NULL
           AND semantic_admission_candidates.next_check_at > now()
           THEN semantic_admission_candidates.next_check_at
         ELSE NULL
       END,
       updated_at=now()
     RETURNING *`,
    [
      admissionCandidateKey(input.candidate.channelId), input.candidate.channelId, input.candidate.channelName,
      input.candidate.youtubeUrl, input.source, input.queryId || null, input.queryRunId || null,
      input.discoveryJobId || null, input.pageNumber || null, input.resultRank || null,
      input.targetCountry, JSON.stringify(matchedDocument), JSON.stringify(rawObservation),
      input.candidate.detectedLanguages?.[0]?.language || null,
    ],
  );
  const mapped = mapRow(result.rows[0]);
  if (input.queryRunId) {
    // A missing sighting makes the page/run outcome counts undercount and can
    // prevent the query guard from stopping a contaminated run. Let the caller
    // retry the candidate instead of silently continuing.
    await db.query(
      `INSERT INTO semantic_admission_sightings(candidate_id,query_run_id,page_number,result_rank,matched_document)
       VALUES($1,$2,$3,$4,$5::jsonb)`,
      [mapped.id, input.queryRunId, input.pageNumber || null, input.resultRank || null, JSON.stringify(matchedDocument)],
    );
  }
  return mapped;
}

export async function hasActiveAdmissionJob(channelId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query(
    `SELECT 1 FROM jobs
      WHERE type='VERIFY_CHANNEL_ADMISSION'
        AND status IN ('PENDING','PROCESSING')
        AND payload->>'channelId'=$1
      LIMIT 1`,
    [channelId],
  );
  return Boolean(result.rowCount);
}

export const ADMISSION_VERIFICATION_PRIORITY = 30;

/** Admission retries inherit the protected priority even when a route-derived
 * priority is lower; higher explicit priorities remain allowed. */
export function admissionVerificationPriority(priority?: number | null): number {
  return Math.max(priority ?? 0, ADMISSION_VERIFICATION_PRIORITY);
}

export async function enqueueAdmissionVerification(input: {
  candidate: AdmissionCandidateInput;
  runAfter?: string;
  attempt?: number;
  priority?: number;
  /** Provider waits and evidence retries use disjoint key namespaces. */
  retryKind?: 'evidence' | 'provider';
  /** Explicit key for operator-initiated requeue work. */
  idempotencyKey?: string;
}): Promise<Awaited<ReturnType<typeof enqueueJob>>> {
  const attempt = Math.max(1, input.attempt || 1);
  const retryKind = input.retryKind === 'provider' ? 'provider-retry' : 'retry';
  const key = attempt === 1
    ? admissionCandidateKey(input.candidate.candidate.channelId)
    : `admission:${input.candidate.candidate.channelId}:${retryKind}:${attempt}`;
  const quotaOrigin = resolvePreChannelAdmissionQuotaOrigin(input.candidate.candidate.quotaOrigin);
  return enqueueJob('VERIFY_CHANNEL_ADMISSION', {
    candidateKey: admissionCandidateKey(input.candidate.candidate.channelId),
    channelId: input.candidate.candidate.channelId,
    candidate: { ...input.candidate.candidate, quotaOrigin },
    quotaOrigin,
    targetCountry: input.candidate.targetCountry,
    source: input.candidate.source,
    query: input.candidate.query,
    queryId: input.candidate.queryId,
    queryRunId: input.candidate.queryRunId,
    discoveryJobId: input.candidate.discoveryJobId,
    pageNumber: input.candidate.pageNumber,
    resultRank: input.candidate.resultRank,
    attempt,
  }, {
    priority: admissionVerificationPriority(input.priority),
    maxAttempts: 3,
    idempotencyKey: input.idempotencyKey || key,
    ...(input.runAfter ? { runAfter: input.runAfter } : {}),
    ...(attempt === 1 ? { preventCompletedReopen: true } : {}),
  });
}

export async function updateAdmissionCandidate(input: {
  id: string;
  status: AdmissionStatus;
  decision?: AdmissionDecision | null;
  reasonCodes?: string[];
  evidence?: AdmissionEvidence;
  evidenceHash?: string;
  judgment?: SemanticJudgment;
  model?: string;
  attempts?: number;
  nextCheckAt?: string | null;
  expiresAt?: string | null;
  /** Optimistic-concurrency guard for provider retries. */
  expectedStatus?: AdmissionStatus;
  expectedAttempts?: number;
  client?: AdmissionQueryable;
}): Promise<AdmissionCandidateRow | null> {
  const db = input.client || await getDb();
  const result = await db.query(
    `UPDATE semantic_admission_candidates SET
       status=$2,
       decision=$3,
       reason_codes=$4::jsonb,
       evidence_snapshot=COALESCE($5::jsonb,evidence_snapshot),
       evidence_hash=COALESCE($6,evidence_hash),
       semantic_output=COALESCE($7::jsonb,semantic_output),
       semantic_model=COALESCE($8,semantic_model),
       attempts=COALESCE($9,attempts),
       next_check_at=$10,
       expires_at=$11,
       decided_at=CASE WHEN $2 IN ('ADMITTED','ADMITTED_AMBIGUOUS','REJECTED_UNRELATED','REJECTED_COUNTRY','EXPIRED_MISSING_EVIDENCE','NEEDS_REVIEW') THEN now() ELSE decided_at END,
       updated_at=now()
     WHERE id=$1
       AND ($12::text IS NULL OR status=$12)
       AND ($13::int IS NULL OR attempts=$13)
     RETURNING *`,
    [
      input.id, input.status, input.decision || null, JSON.stringify(input.reasonCodes || []),
      input.evidence ? JSON.stringify(input.evidence) : null, input.evidenceHash || null,
      input.judgment ? JSON.stringify(input.judgment) : null, input.model || null,
      input.attempts ?? null, input.nextCheckAt ?? null, input.expiresAt ?? null,
      input.expectedStatus ?? null, input.expectedAttempts ?? null,
    ],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function recordAdmissionDecision(input: {
  candidateId: string;
  decisionKey: string;
  channelId: string;
  decision: AdmissionDecision;
  reasonCodes: string[];
  evidenceHash?: string;
  judgment?: SemanticJudgment;
  client?: AdmissionQueryable;
}): Promise<string | null> {
  const db = input.client || await getDb();
  const result = await db.query(
    `INSERT INTO semantic_admission_decisions(candidate_id,decision_key,channel_id,decision,reason_codes,evidence_hash,semantic_output,policy_version)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)
     ON CONFLICT (decision_key) DO UPDATE SET decision=EXCLUDED.decision,reason_codes=EXCLUDED.reason_codes,semantic_output=EXCLUDED.semantic_output
     RETURNING id`,
    [
      input.candidateId, input.decisionKey, input.channelId, input.decision, JSON.stringify(input.reasonCodes || []),
      input.evidenceHash || null, input.judgment ? JSON.stringify(input.judgment) : null,
      ADMISSION_POLICY_VERSION,
    ],
  );
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

/**
 * Persists the ledger decision and the candidate projection atomically. The
 * worker can then recover the whole outcome from an idempotent retry without
 * leaving a terminal candidate that has no decision, or a decision that has
 * no candidate projection.
 */
export async function recordAdmissionOutcome(input: {
  decision: Parameters<typeof recordAdmissionDecision>[0];
  candidate: Parameters<typeof updateAdmissionCandidate>[0];
}): Promise<{ decisionId: string | null; candidate: AdmissionCandidateRow | null }> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const decisionId = await recordAdmissionDecision({ ...input.decision, client });
    const candidate = await updateAdmissionCandidate({ ...input.candidate, client });
    if (!candidate) throw new Error('ADMISSION_CANDIDATE_NOT_FOUND');
    await client.query('COMMIT');
    return { decisionId, candidate };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getAdmissionRunOutcomes(queryRunId: string): Promise<{
  admitted: number;
  ambiguous: number;
  rejected: number;
  held: number;
  deferred: number;
  review: number;
  pending: number;
  total: number;
}> {
  const db = await getDb();
  const result = await db.query(
    `WITH scoped AS (
       SELECT DISTINCT c.id,c.status
         FROM semantic_admission_candidates c
         JOIN semantic_admission_sightings s ON s.candidate_id=c.id
        WHERE s.query_run_id=$1
     )
     SELECT
       COUNT(*) FILTER (WHERE status='ADMITTED')::int admitted,
       COUNT(*) FILTER (WHERE status='ADMITTED_AMBIGUOUS')::int ambiguous,
       COUNT(*) FILTER (WHERE status IN ('REJECTED_UNRELATED','REJECTED_COUNTRY'))::int rejected,
       COUNT(*) FILTER (WHERE status IN ('WAITING_EVIDENCE','EXPIRED_MISSING_EVIDENCE'))::int held,
       COUNT(*) FILTER (WHERE status='PROVIDER_DEFERRED')::int deferred,
       COUNT(*) FILTER (WHERE status='NEEDS_REVIEW')::int review,
       COUNT(*) FILTER (WHERE status IN ('PENDING','VERIFYING'))::int pending,
       COUNT(*) FILTER (WHERE status IN ('ADMITTED','ADMITTED_AMBIGUOUS','REJECTED_UNRELATED','REJECTED_COUNTRY','WAITING_EVIDENCE','EXPIRED_MISSING_EVIDENCE','PROVIDER_DEFERRED','NEEDS_REVIEW'))::int total
     FROM scoped`,
    [queryRunId],
  );
  const row = result.rows[0] || {};
  return {
    admitted: Number(row.admitted || 0),
    ambiguous: Number(row.ambiguous || 0),
    rejected: Number(row.rejected || 0),
    held: Number(row.held || 0),
    deferred: Number(row.deferred || 0),
    review: Number(row.review || 0),
    pending: Number(row.pending || 0),
    total: Number(row.total || 0),
  };
}

export async function getAdmissionPageOutcomes(queryRunId: string, pageNumber: number): Promise<{
  admitted: number;
  ambiguous: number;
  rejected: number;
  held: number;
  deferred: number;
  review: number;
  pending: number;
  total: number;
}> {
  const db = await getDb();
  const result = await db.query(
    `WITH scoped AS (
       SELECT DISTINCT c.id,c.status
         FROM semantic_admission_candidates c
         JOIN semantic_admission_sightings s ON s.candidate_id=c.id
        WHERE s.query_run_id=$1 AND s.page_number=$2
     )
     SELECT
       COUNT(*) FILTER (WHERE status='ADMITTED')::int admitted,
       COUNT(*) FILTER (WHERE status='ADMITTED_AMBIGUOUS')::int ambiguous,
       COUNT(*) FILTER (WHERE status IN ('REJECTED_UNRELATED','REJECTED_COUNTRY'))::int rejected,
       COUNT(*) FILTER (WHERE status IN ('WAITING_EVIDENCE','EXPIRED_MISSING_EVIDENCE'))::int held,
       COUNT(*) FILTER (WHERE status='PROVIDER_DEFERRED')::int deferred,
       COUNT(*) FILTER (WHERE status='NEEDS_REVIEW')::int review,
       COUNT(*) FILTER (WHERE status IN ('PENDING','VERIFYING'))::int pending,
       COUNT(*) FILTER (WHERE status IN ('ADMITTED','ADMITTED_AMBIGUOUS','REJECTED_UNRELATED','REJECTED_COUNTRY','WAITING_EVIDENCE','EXPIRED_MISSING_EVIDENCE','PROVIDER_DEFERRED','NEEDS_REVIEW'))::int total
     FROM scoped`,
    [queryRunId, pageNumber],
  );
  const row = result.rows[0] || {};
  return {
    admitted: Number(row.admitted || 0),
    ambiguous: Number(row.ambiguous || 0),
    rejected: Number(row.rejected || 0),
    held: Number(row.held || 0),
    deferred: Number(row.deferred || 0),
    review: Number(row.review || 0),
    pending: Number(row.pending || 0),
    total: Number(row.total || 0),
  };
}

export async function getAdmissionAmbiguousRate(): Promise<{ admitted: number; ambiguous: number; rate: number }> {
  const db = await getDb();
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE decision='ADMIT')::int admitted,
       COUNT(*) FILTER (WHERE decision='ADMIT_AMBIGUOUS')::int ambiguous
     FROM semantic_admission_decisions
     WHERE created_at >= date_trunc('day', now())
       AND decision IN ('ADMIT','ADMIT_AMBIGUOUS')`,
  );
  const admitted = Number(result.rows[0]?.admitted || 0);
  const ambiguous = Number(result.rows[0]?.ambiguous || 0);
  const total = admitted + ambiguous;
  return { admitted, ambiguous, rate: total ? ambiguous / total : 0 };
}


export async function quarantineQuery(queryId: number, reasonCodes: string[]): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE query_library
        SET collection='REJECTED',
            status='REJECTED',
            generation_metadata=COALESCE(generation_metadata,'{}'::jsonb) || jsonb_build_object('queryHold',$2::jsonb)
      WHERE id=$1`,
    [queryId, JSON.stringify({ reasonCodes, source: 'semantic-admission', at: new Date().toISOString() })],
  );
}
