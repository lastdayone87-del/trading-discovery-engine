import { createHash } from 'node:crypto';

/**
 * Daily AI extraction budget policy for the native-vocabulary path.
 *
 * The ledger row is a logical call, not a provider attempt: the Groq primary
 * and the optional Gemini fallback share one request id and one call slot.
 * Reservations are deliberately conservative ($0.025 per logical call, 200
 * calls/day, $5.00/day) so the cost cap can never be exceeded by outstanding
 * work. Rule-based extraction is never budgeted.
 */
export const NATIVE_VOCABULARY_AI_PROMPT_VERSION = 'native-vocabulary-v2';

export interface NativeVocabularyAiBudgetPolicy {
  dailyCalls: number;
  countryDailyCalls: number;
  dailyCostMicrounits: number;
  reservationMicrounits: number;
}

export const DEFAULT_NATIVE_VOCABULARY_AI_BUDGET: NativeVocabularyAiBudgetPolicy = Object.freeze({
  dailyCalls: 200,
  countryDailyCalls: 20,
  dailyCostMicrounits: 5_000_000,
  reservationMicrounits: 25_000,
});

export type NativeVocabularyAiRunStatus = 'RESERVED' | 'SUCCEEDED' | 'FAILED' | 'BUDGET_SKIPPED';

export interface NativeVocabularyAiBudgetSnapshot {
  globalCalls: number;
  countryCalls: number;
  actualCostMicrounits: number;
  outstandingReservationMicrounits: number;
}

export interface NativeVocabularyAiBudgetDecision {
  admit: boolean;
  status: 'RESERVED' | 'BUDGET_SKIPPED';
  reason: string;
  requestId: string;
}

/** Stable per-day logical-call identity. Re-ingesting identical metadata on
 * the same Pacific quota day must not spend a second AI call. */
export function computeNativeVocabularyRequestId(args: {
  channelId: string;
  metadataHash: string;
  budgetDay: string;
  promptVersion?: string;
}): string {
  return createHash('sha256')
    .update([
      args.channelId,
      args.metadataHash,
      args.promptVersion || NATIVE_VOCABULARY_AI_PROMPT_VERSION,
      args.budgetDay,
    ].join('|'))
    .digest('hex');
}

export function computeNativeVocabularyMetadataHash(parts: Array<string | null | undefined>): string {
  return createHash('sha256')
    .update(parts.map(part => String(part || '')).join('\u0000'))
    .digest('hex');
}

/**
 * Pure admission decision. Terminal rows are idempotent skips; call caps and
 * the cost cap (actual + outstanding + this reservation) are hard bounds.
 * A skipped call never consumes budget.
 */
export function evaluateNativeVocabularyAiBudget(args: {
  requestId: string;
  existingStatus?: NativeVocabularyAiRunStatus | null;
  snapshot: NativeVocabularyAiBudgetSnapshot;
  policy?: Partial<NativeVocabularyAiBudgetPolicy>;
}): NativeVocabularyAiBudgetDecision {
  const policy = { ...DEFAULT_NATIVE_VOCABULARY_AI_BUDGET, ...(args.policy || {}) };
  const existing = args.existingStatus || null;
  if (existing && existing !== 'RESERVED') {
    return {
      admit: false,
      status: 'BUDGET_SKIPPED',
      reason: `IDEMPOTENT_${existing}`,
      requestId: args.requestId,
    };
  }
  if (args.snapshot.globalCalls >= policy.dailyCalls) {
    return {
      admit: false,
      status: 'BUDGET_SKIPPED',
      reason: `GLOBAL_CALL_CAP:${args.snapshot.globalCalls}>=${policy.dailyCalls}`,
      requestId: args.requestId,
    };
  }
  if (args.snapshot.countryCalls >= policy.countryDailyCalls) {
    return {
      admit: false,
      status: 'BUDGET_SKIPPED',
      reason: `COUNTRY_CALL_CAP:${args.snapshot.countryCalls}>=${policy.countryDailyCalls}`,
      requestId: args.requestId,
    };
  }
  const committed = args.snapshot.actualCostMicrounits + args.snapshot.outstandingReservationMicrounits;
  if (committed + policy.reservationMicrounits > policy.dailyCostMicrounits) {
    return {
      admit: false,
      status: 'BUDGET_SKIPPED',
      reason: `DAILY_COST_CAP:${committed}+${policy.reservationMicrounits}>${policy.dailyCostMicrounits}`,
      requestId: args.requestId,
    };
  }
  return { admit: true, status: 'RESERVED', reason: 'RESERVED', requestId: args.requestId };
}

/** Actual cost estimate when provider telemetry is unavailable. Deliberately
 * conservative: the ledger's cost cap must never be understated. */
export function estimateNativeVocabularyActualCostMicrounits(args: {
  attempts: number;
  promptChars: number;
  responseChars: number;
}): number {
  const attempts = Math.max(1, Math.trunc(args.attempts) || 1);
  const inputTokens = Math.ceil(Math.max(0, args.promptChars) / 4);
  const outputTokens = Math.ceil(Math.max(0, args.responseChars) / 4);
  // Small-model order of magnitude: $0.10/M input, $0.40/M output, converted
  // to microunits ($1 = 1,000,000 microunits). Provider attempts multiply.
  const perAttempt = inputTokens * 0.1 + outputTokens * 0.4;
  return Math.max(0, Math.ceil(perAttempt * attempts));
}
