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
  OfficialYouTubeQuotaFenceError,
  type ResolvedQuotaOrigin,
} from './officialYouTubeQuotaFence';
import type { QuotaOrigin } from '../src/types';

export interface QuotaOriginDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

/**
 * A provenance read could not complete. This is infrastructure, not a
 * provenance verdict: the job may retry without spending official quota.
 */
export class QuotaOriginUnavailableError extends Error {
  readonly code = 'QUOTA_ORIGIN_UNAVAILABLE';
  readonly retryable = true;

  constructor(message: string, readonly details: { cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'QuotaOriginUnavailableError';
  }
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
  // Operator/canary jobs whose payloads are not channel-keyed (a playlist ID
  // or a relationship seed cohort). They have their own adapter quota controls
  // and are not probe-origin. A probe-origin variant must carry an explicit
  // quotaOrigin:'PROBE' hint, which is honored before this allowlist.
  'INSPECT_PLAYLIST',
  'RELATIONSHIP_CANARY_EXPANSION',
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
 * exist. Database failures throw QuotaOriginUnavailableError from the
 * pipeline resolver; a malformed persisted value is a real UNKNOWN verdict.
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
  } catch (error) {
    // A provenance read failure is infrastructure, not a provenance verdict.
    // Returning UNKNOWN here would become a terminal quota-fence failure and
    // permanently drop retryable work.
    throw new QuotaOriginUnavailableError(
      `Unable to read persisted quota provenance for channel ${candidate.channelId || 'unknown'}.`,
      { cause: error },
    );
  }

  if (stored === null) return hinted ?? 'NORMAL';
  return mergeQuotaOrigins(hinted, stored) ?? 'UNKNOWN';
}

/**
 * Pre-channel admission verification has no channels row, so the normal
 * channel-row lookup cannot establish provenance. Its only valid origins are
 * NORMAL and PROBE: an explicit PROBE hint or an enclosing PROBE run stays
 * sticky, and missing provenance falls back to NORMAL. An explicit NORMAL hint
 * cannot downgrade an enclosing PROBE run. The discovery dispatcher has
 * already blocked an UNKNOWN-origin parent before this point.
 */
export function resolvePreChannelAdmissionQuotaOrigin(
  explicit: QuotaOrigin | null | undefined,
  ambient: ResolvedQuotaOrigin = currentOfficialYouTubeQuotaOrigin(),
): QuotaOrigin {
  if (explicit && explicit !== 'PROBE' && explicit !== 'NORMAL') {
    throw new OfficialYouTubeQuotaFenceError('UNKNOWN', 'admission-verification');
  }
  if (explicit === 'PROBE' || ambient === 'PROBE') return 'PROBE';
  if (ambient === 'UNKNOWN') {
    throw new OfficialYouTubeQuotaFenceError('UNKNOWN', 'admission-verification');
  }
  return 'NORMAL';
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
 * Resolves the origin for a claimed job from the persisted payload, the
 * admission candidate (for pre-channel verification), and the authoritative
 * channel rows. Channel-keyed jobs with a missing or malformed row return
 * UNKNOWN and are failed closed by the queue dispatcher, except
 * INSPECT_FEATURED_CHANNELS, VERIFY_CHANNEL_ADMISSION and
 * PROCESS_DISCOVERED_CHANNEL, whose sources may legitimately exist before a
 * channels row. A database read failure throws
 * QuotaOriginUnavailableError so the dispatcher's normal retry lifecycle
 * applies instead of a terminal provenance failure.
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
  let candidateOrigin: QuotaOrigin | undefined;
  let candidateInvalid = false;
  try {
    const db = client ?? (await getDb());
    result = await db.query(
      `SELECT channel_id, quota_origin FROM channels WHERE channel_id = ANY($1::text[])`,
      [channelIds],
    ) as { rows: any[] };
    if (job.type === 'VERIFY_CHANNEL_ADMISSION') {
      const candidates = await db.query(
        `SELECT raw_observation->>'quotaOrigin' AS quota_origin
           FROM semantic_admission_candidates
          WHERE channel_id = ANY($1::text[])`,
        [channelIds],
      ) as { rows: any[] };
      for (const row of candidates.rows || []) {
        const value = row?.quota_origin;
        if (value === undefined || value === null || value === '') continue;
        if (value !== 'PROBE' && value !== 'NORMAL') candidateInvalid = true;
        else if (value === 'PROBE') candidateOrigin = 'PROBE';
        else if (candidateOrigin !== 'PROBE') candidateOrigin = 'NORMAL';
      }
    }
  } catch (error) {
    throw new QuotaOriginUnavailableError(
      `Unable to read durable quota provenance for job type ${job.type}.`,
      { cause: error },
    );
  }
  if (candidateInvalid) return 'UNKNOWN';
  if (candidateOrigin === 'PROBE') return 'PROBE';

  const byId = new Map<string, string>();
  for (const row of result.rows || []) {
    if (typeof row?.channel_id === 'string') byId.set(row.channel_id, String(row.quota_origin));
  }

  // A featured-canary source can exist only in creator_outcome_records /
  // entity_bindings, and a pre-channel admission candidate has no channels row
  // yet. Both may lack a row; their explicit PROBE hint is honored above, and
  // an existing PROBE row stays sticky. Other channel-keyed jobs still fail
  // closed when the row is missing.
  const missingRowIsNormal = job.type === 'INSPECT_FEATURED_CHANNELS'
    || job.type === 'VERIFY_CHANNEL_ADMISSION'
    || job.type === 'PROCESS_DISCOVERED_CHANNEL';
  let resolved: ResolvedQuotaOrigin = mergeQuotaOrigins(hinted ?? 'NORMAL', candidateOrigin) ?? 'NORMAL';
  if (resolved === 'PROBE') return 'PROBE';
  for (const channelId of channelIds) {
    if (!byId.has(channelId)) {
      if (missingRowIsNormal) continue;
      return 'UNKNOWN';
    }
    const origin = rowOrigin(byId.get(channelId));
    if (origin === 'UNKNOWN') return 'UNKNOWN';
    resolved = mergeQuotaOrigins(resolved, candidateOrigin, origin) ?? 'NORMAL';
    if (resolved === 'PROBE') return 'PROBE';
  }
  return resolved;
}

export function isNormalOnlyJobType(type: string): boolean {
  return NORMAL_ONLY_JOB_TYPES.has(type);
}
