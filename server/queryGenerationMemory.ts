import { createHash } from 'node:crypto';
import { canonicalCountry } from './countryInference';
import { getDb } from './db';
import { semanticQueryKey } from './queryQuality/composition';
import type { QueryGenerationMode, QueryGenerationSource } from './queryGenerationProvenance';

export interface CandidateMemoryInput {
  country: string;
  language: string;
  source: QueryGenerationSource;
  mode: QueryGenerationMode;
  query: string;
  status: 'GENERATED' | 'PROPOSED' | 'ADMITTED' | 'REJECTED' | 'DUPLICATE';
  reasonCodes?: string[];
  batchKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CandidateMemoryRow {
  country: string;
  language: string;
  source: string;
  mode: string;
  normalizedQuery: string;
  semanticKey: string;
  status: string;
  reasonCodes: string[];
  batchKey: string | null;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface GenerationBatchInput {
  batchKey: string;
  country: string;
  language: string;
  source: QueryGenerationSource;
  mode: QueryGenerationMode;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  inputFingerprint: string;
  payload: Record<string, unknown>;
  duplicateRate?: number | null;
  acceptedCount?: number;
  expiresAt: string;
  status?: 'PENDING' | 'COMPLETED' | 'LOW_NOVELTY' | 'FAILED';
}

/** Stable cache identity; the context digest prevents blind regeneration. */
export function queryGenerationBatchKey(input: {
  country: string;
  language: string;
  source: QueryGenerationSource;
  mode: QueryGenerationMode;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  contextDigest: string;
}): string {
  return createHash('sha256').update(JSON.stringify({
    country: input.country.normalize('NFKC').trim().toLocaleLowerCase('en'),
    language: input.language.normalize('NFKC').trim().toLocaleLowerCase('en'),
    source: input.source,
    mode: input.mode,
    provider: input.provider || null,
    model: input.model || null,
    promptVersion: input.promptVersion || null,
    contextDigest: input.contextDigest,
  })).digest('hex');
}

function normalizeMemoryQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
}

function mapMemory(row: any): CandidateMemoryRow {
  return {
    country: String(row.country || ''),
    language: String(row.language || 'und'),
    source: String(row.source || ''),
    mode: String(row.mode || ''),
    normalizedQuery: String(row.normalized_query || ''),
    semanticKey: String(row.semantic_key || ''),
    status: String(row.status || ''),
    reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : [],
    batchKey: row.batch_key ? String(row.batch_key) : null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    firstSeenAt: String(row.first_seen_at || ''),
    lastSeenAt: String(row.last_seen_at || ''),
  };
}

export async function getCandidateMemory(country: string, language: string, limit = 500): Promise<CandidateMemoryRow[]> {
  const db = await getDb();
  const result = await db.query(
    `SELECT * FROM query_candidate_memory
     WHERE LOWER(country)=LOWER($1) AND language=$2
     ORDER BY last_seen_at DESC, id DESC LIMIT $3`,
    [country, language, Math.max(1, Math.min(1000, Math.trunc(limit)))],
  );
  return result.rows.map(mapMemory);
}

const CANDIDATE_STATUS_RANK: Record<CandidateMemoryInput['status'], number> = {
  GENERATED: 0,
  DUPLICATE: 1,
  REJECTED: 2,
  PROPOSED: 3,
  ADMITTED: 4,
};

export async function rememberQueryCandidates(candidates: CandidateMemoryInput[]): Promise<number> {
  const unique = new Map<string, CandidateMemoryInput>();
  for (const candidate of candidates) {
    const normalized = normalizeMemoryQuery(candidate.query);
    if (!normalized) continue;
    const country = canonicalCountry(candidate.country);
    const key = `${country.toLocaleLowerCase('en')}|${candidate.language}|${normalized}`;
    const existing = unique.get(key);
    // Status is monotonic within one write set: an accepted proposal must not
    // be downgraded by a later duplicate decision for the same surface.
    if (!existing || CANDIDATE_STATUS_RANK[candidate.status] >= CANDIDATE_STATUS_RANK[existing.status]) {
      unique.set(key, { ...candidate, country, query: normalized });
    }
  }
  if (!unique.size) return 0;
  const db = await getDb();
  let written = 0;
  for (const candidate of unique.values()) {
    const semanticKey = semanticQueryKey(candidate.query);
    const result = await db.query(
      `INSERT INTO query_candidate_memory(
         country,language,source,mode,normalized_query,semantic_key,status,
         reason_codes,batch_key,metadata,first_seen_at,last_seen_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,now(),now())
       ON CONFLICT(LOWER(country),language,normalized_query) DO UPDATE SET
         status=CASE
           WHEN query_candidate_memory.status='ADMITTED' THEN 'ADMITTED'
           WHEN EXCLUDED.status='ADMITTED' THEN 'ADMITTED'
           WHEN query_candidate_memory.status='PROPOSED' THEN 'PROPOSED'
           WHEN EXCLUDED.status='PROPOSED' THEN 'PROPOSED'
           WHEN query_candidate_memory.status='REJECTED' THEN 'REJECTED'
           WHEN EXCLUDED.status='REJECTED' THEN 'REJECTED'
           WHEN query_candidate_memory.status='DUPLICATE' THEN 'DUPLICATE'
           ELSE EXCLUDED.status
         END,
         reason_codes=CASE
           WHEN EXCLUDED.status='ADMITTED' THEN '[]'::jsonb
           WHEN query_candidate_memory.status='ADMITTED' THEN query_candidate_memory.reason_codes
           WHEN EXCLUDED.status='PROPOSED' THEN '[]'::jsonb
           WHEN query_candidate_memory.status='PROPOSED' AND EXCLUDED.status='REJECTED' THEN query_candidate_memory.reason_codes
           WHEN jsonb_array_length(EXCLUDED.reason_codes)>0 THEN EXCLUDED.reason_codes
           ELSE query_candidate_memory.reason_codes
         END,
         batch_key=COALESCE(EXCLUDED.batch_key,query_candidate_memory.batch_key),
         metadata=query_candidate_memory.metadata || EXCLUDED.metadata,
         last_seen_at=now()
       RETURNING id`,
      [
        candidate.country,
        candidate.language,
        candidate.source,
        candidate.mode,
        candidate.query,
        semanticKey,
        candidate.status,
        JSON.stringify(candidate.reasonCodes || []),
        candidate.batchKey || null,
        JSON.stringify(candidate.metadata || {}),
      ],
    );
    written += result.rowCount || 0;
  }
  return written;
}

export async function getGenerationBatch(batchKey: string): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  const result = await db.query(
    `SELECT payload FROM query_generation_batches
     WHERE batch_key=$1 AND status IN ('COMPLETED','LOW_NOVELTY')
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [batchKey],
  );
  const payload = result.rows[0]?.payload;
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
}

export async function upsertGenerationBatch(input: GenerationBatchInput): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO query_generation_batches(
       batch_key,country,language,source,mode,provider,model,prompt_version,
       input_fingerprint,status,payload,duplicate_rate,accepted_count,generated_at,expires_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,now(),$14)
     ON CONFLICT(batch_key) DO UPDATE SET
       status=EXCLUDED.status,
       payload=EXCLUDED.payload,
       duplicate_rate=EXCLUDED.duplicate_rate,
       accepted_count=EXCLUDED.accepted_count,
       generated_at=now(),
       expires_at=EXCLUDED.expires_at`,
    [
      input.batchKey,
      input.country,
      input.language,
      input.source,
      input.mode,
      input.provider || null,
      input.model || null,
      input.promptVersion || null,
      input.inputFingerprint,
      input.status || 'COMPLETED',
      JSON.stringify(input.payload),
      input.duplicateRate ?? null,
      input.acceptedCount ?? 0,
      input.expiresAt,
    ],
  );
}
