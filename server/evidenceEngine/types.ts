import { TradingStatus, TradingCategory } from '../../src/types';

export type EvidenceSourceType =
  | 'channel_metadata'
  | 'video_metadata'
  | 'external_links'
  | 'country_knowledge'
  | 'multilingual_context'
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
  | 'IRRELEVANT_DOMAIN';

export type EvidenceReliability = 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOWER';

export interface EvidenceProvenance {
  provider: EvidenceSourceType;
  type: string;
  matchedTerm: string;
  sourceRef: string;
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
  timestamp: string;
}

export interface EvidenceProvider {
  name: EvidenceSourceType;
  collectEvidence(input: RawChannelInput, knowledgeContext: LayeredKnowledgeContext): Promise<EvidenceItem[]>;
}
