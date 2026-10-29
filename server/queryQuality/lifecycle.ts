import type { QueryRecord } from '../../src/types';
import type { QueryAdmission } from './types';

export const QUERY_LIFECYCLE_VERSION = 'query-lifecycle-v1';

export interface SelectabilityRecord extends Pick<QueryRecord, 'id' | 'query' | 'collection' | 'status' | 'last_executed'> {
  primary_term?: string;
  next_eligible_at?: string | null;
  reserved_until?: string | null;
}

export interface SelectabilityInput {
  record: SelectabilityRecord;
  now: string;
  cooldownMinutes: number;
  admission?: QueryAdmission;
  /** Recent normalized primary-term uses, including this query's history. */
  primaryTermUses?: number;
  maxPrimaryUses?: number;
  consecutiveFailures?: number;
  backoffUntil?: string | null;
}

export interface SelectabilityDecision {
  selectable: boolean;
  reasonCodes: string[];
}

const INACTIVE_STATUSES = new Set(['ARCHIVED', 'PAUSED', 'DELETED', 'INACTIVE']);
const SEARCHABLE_COLLECTIONS = new Set(['PROVEN', 'EXPERIMENTAL']);

/**
 * The single selectability authority. Cooldown, lifecycle, admission and
 * failure backoff are hard gates rather than score penalties. `REJECTED`
 * rows are never selectable, and a newly generated/just-executed query cannot
 * be re-executed in the same tick.
 */
export function isQuerySelectable(input: SelectabilityInput): SelectabilityDecision {
  const reasons: string[] = [];
  const nowMs = Date.parse(input.now);
  const record = input.record;
  const hasValidNow = Number.isFinite(nowMs);

  if (!SEARCHABLE_COLLECTIONS.has(String(record.collection))) reasons.push('COLLECTION_NOT_SEARCHABLE');
  if (record.collection === 'REJECTED') reasons.push('REJECTED_COLLECTION');
  if (INACTIVE_STATUSES.has(String(record.status || '').toUpperCase())) reasons.push('INACTIVE_STATUS');
  if (input.admission && (!input.admission.eligible || input.admission.tier === 'SPECULATIVE')) reasons.push('NO_CURRENT_ADMISSION');

  if (hasValidNow) {
    const last = record.last_executed ? Date.parse(record.last_executed) : NaN;
    if (Number.isFinite(last)) {
      const elapsedMs = nowMs - last;
      if (elapsedMs >= 0 && elapsedMs < 60_000) reasons.push('SAME_TICK_REEXECUTION');
      if (elapsedMs >= 0 && elapsedMs < input.cooldownMinutes * 60_000) reasons.push('COOLDOWN_ACTIVE');
    }
    if (record.reserved_until && Date.parse(record.reserved_until) > nowMs) reasons.push('RESERVED_BY_ACTIVE_RUN');
    if (record.next_eligible_at && Date.parse(record.next_eligible_at) > nowMs) reasons.push('NEXT_ELIGIBLE_NOT_REACHED');
    if (input.backoffUntil && Date.parse(input.backoffUntil) > nowMs) reasons.push('FAILURE_BACKOFF_ACTIVE');
  }

  if (input.maxPrimaryUses !== undefined && (input.primaryTermUses || 0) >= input.maxPrimaryUses) {
    reasons.push('PRIMARY_TERM_DIVERSITY_CAP');
  }
  if ((input.consecutiveFailures || 0) >= 3) reasons.push('REPEATED_FAILURE_BACKOFF');

  return { selectable: reasons.length === 0, reasonCodes: [...new Set(reasons)] };
}

export function classifyQueryBackoff(failureKind: string | undefined, now = new Date()): { failures: 0 | 1 | 2 | 3; backoffUntil: string | null; reasonCodes: string[] } {
  if (!failureKind) return { failures: 0, backoffUntil: null, reasonCodes: [] };
  if (failureKind === 'PROVIDER_FAILURE' || failureKind === 'PROVIDER_CAPACITY') {
    // Provider failure is not query negative quality: no query backoff.
    return { failures: 0, backoffUntil: null, reasonCodes: ['PROVIDER_FAILURE_EXEMPT'] };
  }
  return {
    failures: 1,
    backoffUntil: new Date(now.getTime() + 15 * 60_000).toISOString(),
    reasonCodes: ['INVALID_OR_REPEATED_FAILURE_BACKOFF'],
  };
}
