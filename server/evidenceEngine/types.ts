import { TradingStatus, TradingCategory } from '../../src/types';

export type EvidenceSourceType =
  | 'channel_metadata'
  | 'video_metadata'
  | 'external_links'
  | 'country_knowledge'
  | 'multilingual_context'
  | 'adaptive_catalog'
  | 'evidence_graph'
  | 'gemini_semantic'
  | 'discord_metadata';

export type EvidencePolarity = 'POSITIVE' | 'NEGATIVE';

export type EvidenceCategory =
  | 'INSTRUMENT'
  | 'PLATFORM_BROKER_PROPFIRM'
  | 'METHODOLOGY_CONCEPT'
  | 'TERMINOLOGY'
  | 'MULTI_VIDEO_CONSISTENCY'
  | 'EXTERNAL_RESOURCE'
  | 'NON_TRADING_ADJACENT'
  | 'HYPE_SPECULATION'
  | 'IRRELEVANT_DOMAIN'
  | 'SEMANTIC_ABSTENTION';

export type EvidenceReliability = 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOWER';

export interface EvidenceProvenance {
  provider: EvidenceSourceType;
  type: string;
  matchedTerm: string;
  sourceRef: string;
  /** Machine-readable input fields that support this assertion. */
  fields?: EvidenceFieldRef[];
  /** Versioned semantic-model details. Deterministic providers omit this. */
  semantic?: {
    modelVersion: string;
    promptVersion: string;
    featureVersion: string;
    calibrationVersion: string;
    taxonomyLabel: string;
    rawConfidence: number;
    calibratedConfidence: number;
    detectedLanguages: Array<{ language: string; script: string; confidence: number; field: EvidenceFieldType }>;
    reasonCodes: string[];
  };
}

export type EvidenceFieldType =
  | 'channel_title' | 'channel_bio' | 'video_title' | 'video_description'
  | 'playlist_name' | 'playlist_description' | 'external_link_label'
  | 'external_link_domain' | 'country' | 'language' | 'transcript_excerpt'
  | 'visual_evidence' | 'discord_invite' | 'pinned_comment' | 'activity_metadata' | 'location';

export interface EvidenceFieldRef {
  field: EvidenceFieldType;
  index?: number;
  sourceId?: string;
  sourceFamilyId?: string;
  sourceEntityId?: string;
  publishedAt?: string;
  contentType?: string;
}

export interface EvidenceItem {
  id: string;
  source: EvidenceSourceType;
  polarity: EvidencePolarity;
  category: EvidenceCategory;
  fact: string;
  rawMatches: string[];
  confidence: number; // 0 to 100
  reliability: EvidenceReliability;
  reliabilityMultiplier: number;
  rawWeight: number;
  finalWeight: number; // (polarity == 'POSITIVE' ? +1 : -1) * rawWeight * reliabilityMultiplier * (confidence / 100)
  provenance?: EvidenceProvenance;
  timestamp: string;
}

export interface RawChannelInput {
  channel_id?: string;
  channel_name: string;
  description: string;
  video_titles?: string[];
  video_descriptions?: string[];
  country?: string;
  external_links?: string[];
  location_tag?: string;
  discord_invite?: string | null;
  channel_entity_id?: string;
  channel_source_family_id?: string;
  videos?: Array<{ id?: string; title: string; description?: string; published_at?: string; content_type?: string; language?: string; script?: string; source_family_id?:string; source_entity_id?:string }>;
  playlists?: Array<{ id?: string; name: string; description?: string }>;
  external_link_details?: Array<{ label?: string; url: string; domain?: string; resolved_entity_type?: string; source_family_id?:string; source_entity_id?:string }>;
  detected_languages?: Array<{ language: string; confidence?: number; field?: EvidenceFieldType }>;
  transcript_excerpts?: Array<{ video_id?: string; text: string; language?: string }>;
  visual_evidence?: Array<{ source_ref: string; description: string; model_provenance: string }>;
  pinned_comment?: string;
  activity_metadata?: { latest_upload_at?: string; uploads_last_30_days?: number; uploads_last_90_days?: number; uploads_last_365_days?: number; activity_band?: string; activity_score?: number; observed_at?: string };
  enrichment_stage?: number;
}

export interface LanguageKnowledge {
  languageCode: string;
  languageName: string;
  positiveTerms: string[];
  negativeTerms: string[];
  commonPhrases: string[];
}

export interface CountryKnowledgePack {
  countryName: string;
  primaryLanguage: string;
  /** All deterministic language packs supported for multilingual countries. */
  languageCodes?: string[];
  regionalExchanges: string[];
  localBrokers: string[];
  popularInstruments: string[];
  localPropFirms: string[];
  nativeTradingTerminology: string[];
  regionalNegativeTerms: string[];
}

export interface LayeredKnowledgeContext {
  globalInstruments: string[];
  globalPlatformsPropFirms: string[];
  globalAdvancedConcepts: string[];
  globalNegativeTerms: string[];
  languageKnowledge?: LanguageKnowledge;
  languageKnowledgePacks?: LanguageKnowledge[];
  countryKnowledge?: CountryKnowledgePack;
}

export interface ScoringEngineConfig {
  minVerifiedTradingScore: number;     // e.g. 68
  maxVerifiedNonTradingScore: number;  // e.g. 25
  minMultiVideoConsistency: number;    // e.g. 0.35
  minPositiveWeightTrading: number;    // e.g. 25
  maxPositiveWeightNonTrading: number; // e.g. 10
  reliabilityWeights: Record<EvidenceReliability, number>;
}

export interface VerificationEngineVersions {
  evidenceEngineVersion: string;
  decisionEngineVersion: string;
  scoringEngineVersion: string;
  knowledgePackVersion: string;
  geminiModelVersion: string;
}

export interface VerificationDecision {
  status: TradingStatus; // 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN'
  confidenceScore: number; // 0 to 100
  category: TradingCategory | string;
  multiVideoConsistencyRatio: number; // 0.0 to 1.0
  positiveEvidence: EvidenceItem[];
  negativeEvidence: EvidenceItem[];
  totalPositiveWeight: number;
  totalNegativeWeight: number;
  countryContextUsed: {
    country: string;
    language: string;
    matchedTerms: string[];
    matchedNegativeTerms: string[];
  };
  geminiSemanticSummary?: {
    isTrading: 'YES' | 'NO' | 'UNCERTAIN';
    concepts: string[];
    instruments: string[];
    reason: string;
    modelUsed?: string;
  };
  versions: VerificationEngineVersions;
  mathematicalJustification: string;
  evidenceCollection: EvidenceCollectionReport;
  /** Present on production v2 decisions; optional for replaying pre-v2 fixtures. */
  stagedClassification?: StagedClassificationReport;
  timestamp: string;
}

export type ProviderAvailability = 'AVAILABLE' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | 'FAILED';
export type ProviderExecutionOutcome =
  | 'EXECUTED_WITH_EVIDENCE' | 'EXECUTED_NO_MATCH'
  | 'ABSTAINED_UNSUPPORTED_LANGUAGE' | 'ABSTAINED_LOW_CONFIDENCE'
  | 'NOT_APPLICABLE' | 'UNAVAILABLE_CONFIGURATION'
  | 'FAILED_TIMEOUT' | 'FAILED_PROVIDER' | 'SUPPRESSED_BY_POLICY';
export type EvidenceSufficiency = 'MISSING' | 'INSUFFICIENT' | 'SUFFICIENT';

export interface ProviderExecutionReport {
  provider: EvidenceSourceType;
  availability: ProviderAvailability;
  evidenceCount: number;
  outcome: ProviderExecutionOutcome;
  reasonCodes: string[];
  durationMs?: number;
  reason?: string;
}

export interface EvidenceCollectionReport {
  sufficiency: EvidenceSufficiency;
  sparseMetadata: boolean;
  degraded: boolean;
  fieldsPresent: string[];
  reasonCodes: string[];
  providers: ProviderExecutionReport[];
}

export type ClassificationStageName = 'AVAILABILITY' | 'CANDIDATE_DETECTION' | 'CORROBORATION' | 'CONTRADICTION' | 'LIFECYCLE';
export type StageDisposition = 'PASS' | 'ABSTAIN' | 'FAIL';
export type LifecycleAction = 'CONFIRM' | 'REJECT' | 'ENRICH' | 'REVIEW';

export interface ClassificationStageResult {
  stage: ClassificationStageName;
  disposition: StageDisposition;
  reasonCodes: string[];
  evidenceIds: string[];
  fields: EvidenceFieldRef[];
  metrics: Record<string, number | string | boolean>;
}

export interface StagedClassificationReport {
  pipelineVersion: string;
  stages: ClassificationStageResult[];
  lifecycleAction: LifecycleAction;
}

export interface EvidenceProvider {
  name: EvidenceSourceType;
  collectEvidence(input: RawChannelInput, knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]>;
  availability?(input: RawChannelInput): { availability: Exclude<ProviderAvailability, 'FAILED'>; reason?: string };
}
