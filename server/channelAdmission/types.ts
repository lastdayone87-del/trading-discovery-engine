import type { DiscoverySource } from '../../src/types';
import type { DiscoveredChannelRaw } from '../youtube';

export type AdmissionMode = 'ACTIVE' | 'OFF';

export type AdmissionStatus =
  | 'PENDING'
  | 'VERIFYING'
  | 'WAITING_EVIDENCE'
  | 'PROVIDER_DEFERRED'
  | 'NEEDS_REVIEW'
  | 'ADMITTED'
  | 'ADMITTED_AMBIGUOUS'
  | 'REJECTED_UNRELATED'
  | 'REJECTED_COUNTRY'
  | 'EXPIRED_MISSING_EVIDENCE';

/**
 * Terminal admission outcomes. Their evidence and decisions stay available,
 * but rediscovery must not reopen verification or enrichment.
 */
export const TERMINAL_ADMISSION_STATUSES: readonly AdmissionStatus[] = [
  'REJECTED_UNRELATED',
  'REJECTED_COUNTRY',
  'EXPIRED_MISSING_EVIDENCE',
  'NEEDS_REVIEW',
  'ADMITTED',
  'ADMITTED_AMBIGUOUS',
];

export function isTerminalAdmissionStatus(status: AdmissionStatus | string): boolean {
  return TERMINAL_ADMISSION_STATUSES.includes(status as AdmissionStatus);
}

/**
 * Outcomes that are finished without an admitted channel. Rediscovery must
 * neither reopen verification nor spend AI/enrichment on them.
 */
export const REJECTED_ADMISSION_STATUSES: readonly AdmissionStatus[] = [
  'REJECTED_UNRELATED',
  'REJECTED_COUNTRY',
  'EXPIRED_MISSING_EVIDENCE',
  'NEEDS_REVIEW',
];

export function isRejectedAdmissionStatus(status: AdmissionStatus | string): boolean {
  return REJECTED_ADMISSION_STATUSES.includes(status as AdmissionStatus);
}

export function isRetryableAdmissionStatus(status: AdmissionStatus | string): boolean {
  return status === 'PENDING' || status === 'VERIFYING'
    || status === 'WAITING_EVIDENCE' || status === 'PROVIDER_DEFERRED';
}

export function isWaitingAdmissionStatus(status: AdmissionStatus | string): boolean {
  return status === 'WAITING_EVIDENCE' || status === 'PROVIDER_DEFERRED';
}
export type AdmissionRediscoveryDisposition =
  | 'TERMINAL'
  | 'ACTIVE_JOB'
  | 'RESUME_ADMITTED'
  | 'ENQUEUE';

/**
 * Single decision point for rediscovering a channel that already has an
 * admission candidate. Callers perform the side effect only for the returned
 * disposition, so an active job or terminal outcome can never enqueue or
 * re-verify the same creator.
 */
export function admissionRediscoveryDisposition(
  status: AdmissionStatus | string,
  hasActiveJob: boolean,
): AdmissionRediscoveryDisposition {
  if (isRejectedAdmissionStatus(status)) return 'TERMINAL';
  if (hasActiveJob) return 'ACTIVE_JOB';
  if (status === 'ADMITTED' || status === 'ADMITTED_AMBIGUOUS') return 'RESUME_ADMITTED';
  return 'ENQUEUE';
}

export type AdmissionDecision =
  | 'ADMIT'
  | 'ADMIT_AMBIGUOUS'
  | 'REJECT_UNRELATED'
  | 'REJECT_COUNTRY'
  | 'HOLD_MISSING_EVIDENCE'
  | 'PROVIDER_DEFERRED'
  | 'NEEDS_REVIEW';

export interface AdmissionVideo {
  videoId?: string;
  title: string;
  description: string;
  publishedAt?: string;
}

export interface AdmissionEvidence {
  channelId: string;
  channelName: string;
  youtubeUrl: string;
  description: string;
  links: string[];
  country?: string;
  declaredLanguage?: string;
  subscriberCount?: string;
  videos: AdmissionVideo[];
  matchedDocument?: Record<string, unknown>;
  query?: string;
  queryId?: number;
  queryRunId?: string;
  pageNumber?: number;
  resultRank?: number;
  source: DiscoverySource;
  targetCountry: string;
  evidenceCoverage: 'COMPLETE' | 'PARTIAL';
  fetchedAt: string;
  failureReason?: string;
}

export interface SemanticCitation {
  field: 'channel_name' | 'bio' | 'video_title' | 'video_description' | 'link';
  index?: number;
  quote: string;
  supports: 'TRADING' | 'UNRELATED' | 'FINANCE_ADJACENT';
}

export interface SemanticJudgment {
  mainSubject: 'TRADING' | 'FINANCE_ADJACENT' | 'UNRELATED' | 'MIXED' | 'UNKNOWN';
  tradingFocus: number;
  unrelatedDomains: Array<{ domain: string; confidence: number }>;
  incidentalTradingMentions: Array<{ field: string; index?: number; quote: string }>;
  citations: SemanticCitation[];
  language?: string;
  explanation: string;
  model?: string;
  /** Provider that produced the decisive judgment (not inferred from the model name). */
  provider?: 'gemini_semantic' | 'groq_semantic';
  raw?: unknown;
}

export interface AdmissionPolicyResult {
  decision: AdmissionDecision;
  status: AdmissionStatus;
  reasonCodes: string[];
  rejected: boolean;
  admitted: boolean;
  hold: boolean;
  ambiguous: boolean;
  citationsValid: boolean;
  independentUnrelatedCitations: number;
  independentTradingCitations: number;
  effectiveRole?: 'PRIMARY' | 'SECOND';
  review?: boolean;
}

export interface AdmissionCandidateInput {
  candidate: DiscoveredChannelRaw;
  targetCountry: string;
  source: DiscoverySource;
  query?: string;
  queryId?: number;
  queryRunId?: string;
  discoveryJobId?: string;
  pageNumber?: number;
  resultRank?: number;
}

export interface AdmissionVerificationResult {
  channelId: string;
  channelName: string;
  decision: AdmissionDecision;
  status: AdmissionStatus;
  reasonCodes: string[];
  evidence: AdmissionEvidence;
  judgment?: SemanticJudgment;
  secondJudgment?: SemanticJudgment;
  decisionSource?: 'DETERMINISTIC' | 'SEMANTIC' | 'HUMAN';
  deterministicRoute?: string | null;
  priority?: number;
  channelRecord?: unknown;
}
