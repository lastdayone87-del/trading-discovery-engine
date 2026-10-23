/**
 * Resolves quota provenance for pipeline calls and durable queue jobs.
 *
 * Database reads are deliberately separated from the pure ALS fence so the
 * hot official dispatcher never needs a database query. The pipeline and queue
 * worker establish the context once, before any provider work.
 */

import { getDb } from './dbCore';
import {
  currentOfficialYouTubeQuotaOrigin,
  mergeQuotaOrigins,
  type ResolvedQuotaOrigin,
} from './officialYouTubeQuotaFence';
import type { QuotaOrigin } from '../src/types';

export interface QuotaOriginDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

const NORMAL_ONLY_JOB_TYPES = new Set([
  'SEARCH_YOUTUBE',
  'MANUAL_SEARCH_PAGE',
  'TERM_HARVEST',
  'SCORE_CANDIDATES',
  'AI_ADJUDICATE_CANDIDATE',
  'PROPOSE_CONCEPT_RESOLUTION',
  'OFFLINE_CANDIDATE_EVALUATION',
  'PERSISTENT_RESEARCH_EXTERNAL_PROVIDER',
  'RESOLVE_STAGED_CANDIDATE',
  'COUNTRY_BOUNDARY_REPROCESS',
]);

function normalizeQuotaOrigin(value: unknown): QuotaOrigin | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return value === 'PROBE' || value === 'NORMAL' ? value : undefined;
}

function hasInvalidOriginHint(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' &&
    value !== 'PROBE' && value !== 'NORMAL';
}

function rowOrigin(value: unknown): QuotaOrigin | 'UNKNOWN' {
  if (value === 'PROBE') return 'PROBE';
  if (value === 'NORMAL') return 'NORMAL';
  // Missing/malformed persisted provenance fails closed.
  return 'UNKNOWN';
}

/**
 * Reads the persisted marker. Returns null only when the channel row does not
 * exist. Database failures throw and callers map them to UNKNOWN.
 */
export async function getChannelQuotaOrigin(
  channelId: string,
  client?: QuotaOriginDb,
): Promise<QuotaOrigin | 'UNKNOWN' | null> {
  if (!channelId) return null;
  const db = client ?? (await getDb());
  const result = await db.query(
    `SELECT quota_origin FROM channels WHERE channel_id=$1`,
    [channelId],
  );
  if (!result.rows?.length) return null;
  return rowOrigin(result.rows[0]?.quota_origin);
}

/**
 * Resolves origin for a direct ingestion call. Existing rows are authoritative;
 * new rows may be NORMAL unless a caller explicitly marks them PROBE.
 */
export async function resolvePipelineQuotaOrigin(
  candidate: { channelId?: string | null; quotaOrigin?: QuotaOrigin | null },
  options?: { quotaOrigin?: QuotaOrigin | null },
  client?: QuotaOriginDb,
): Promise<ResolvedQuotaOrigin> {
  // The ambient context is authoritative too: a nested pipeline call must
  // never downgrade an enclosing PROBE queue/probe run to NORMAL just because
  // the caller omitted an explicit hint.
  const hinted = mergeQuotaOrigins(
    candidate.quotaOrigin,
    options?.quotaOrigin,
    currentOfficialYouTubeQuotaOrigin(),
  );
  if (hinted === 'PROBE') return 'PROBE';
  if (hinted === 'UNKNOWN') return 'UNKNOWN';

  let stored: QuotaOrigin | 'UNKNOWN' | null;
  try {
    stored = await getChannelQuotaOrigin(String(candidate.channelId || ''), client);
  } catch {
    return 'UNKNOWN';
  }

  if (stored === null) return hinted ?? 'NORMAL';
  return mergeQuotaOrigins(hinted, stored) ?? 'UNKNOWN';
}

function collectChannelIds(payload: any): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) values.add(value.trim());
  };
  const addArray = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') add((item as any).channelId);
    }
  };

  add(payload.channelId);
  add(payload.sourceChannelId);
  add(payload.seedChannelId);
  add(payload.targetChannelId);
  add(payload.candidate?.channelId);
  addArray(payload.channelIds);
  addArray(payload.seedChannelIds);
  addArray(payload.seeds);
  addArray(payload.candidates);
  return [...values];
}

/**
 * Resolves the origin for a claimed job from the persisted payload and the
 * authoritative channel rows. Channel-keyed jobs with a missing row or a failed
 * DB read return UNKNOWN and are failed closed by the queue dispatcher.
 */
export async function resolveJobQuotaOrigin(
  job: { type: string; payload?: any },
  client?: QuotaOriginDb,
): Promise<ResolvedQuotaOrigin> {
  const payload = job.payload || {};
  const hinted = normalizeQuotaOrigin(payload.quotaOrigin);
  if (hasInvalidOriginHint(payload.quotaOrigin)) return 'UNKNOWN';
  if (hinted === 'PROBE') return 'PROBE';

  const channelIds = collectChannelIds(payload);
  if (channelIds.length === 0) {
    if (NORMAL_ONLY_JOB_TYPES.has(job.type)) return hinted ?? 'NORMAL';
    return 'UNKNOWN';
  }

  let result: { rows: any[] };
  try {
    const db = client ?? (await getDb());
    result = await db.query(
      `SELECT channel_id, quota_origin FROM channels WHERE channel_id = ANY($1::text[])`,
      [channelIds],
    ) as { rows: any[] };
  } catch {
    return 'UNKNOWN';
  }

  const byId = new Map<string, string>();
  for (const row of result.rows || []) {
    if (typeof row?.channel_id === 'string') byId.set(row.channel_id, String(row.quota_origin));
  }

  let resolved: ResolvedQuotaOrigin = hinted ?? 'NORMAL';
  for (const channelId of channelIds) {
    if (!byId.has(channelId)) return 'UNKNOWN';
    const origin = rowOrigin(byId.get(channelId));
    if (origin === 'UNKNOWN') return 'UNKNOWN';
    resolved = mergeQuotaOrigins(resolved, origin) ?? 'NORMAL';
    if (resolved === 'PROBE') return 'PROBE';
  }
  return resolved;
}

export function isNormalOnlyJobType(type: string): boolean {
  return NORMAL_ONLY_JOB_TYPES.has(type);
}
