import type { DiscoverySource } from '../../src/types';
import type { DiscoveredChannelRaw } from '../youtube';

export type AdmissionMode = 'ACTIVE' | 'OFF';

export type AdmissionStatus =
  | 'PENDING'
  | 'VERIFYING'
  | 'WAITING_EVIDENCE'
  | 'ADMITTED'
  | 'ADMITTED_AMBIGUOUS'
  | 'REJECTED_UNRELATED'
  | 'REJECTED_COUNTRY'
  | 'EXPIRED_MISSING_EVIDENCE';

export type AdmissionDecision =
  | 'ADMIT'
  | 'ADMIT_AMBIGUOUS'
  | 'REJECT_UNRELATED'
  | 'REJECT_COUNTRY'
  | 'HOLD_MISSING_EVIDENCE';

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
  channelRecord?: unknown;
}
