import { RawChannelInput, VerificationDecision, EvidenceItem } from './types';
import { getLayeredKnowledgeContext } from './knowledgePacks';
import { verifyChannelTradingRelevance } from './index';

export interface FullClassificationReport {
  timestamp: string;
  channelInfo: {
    channel_id?: string;
    channel_name: string;
    country: string;
  };
  countryAndLanguage: {
    detectedCountry: string;
    countrySelectionRationale: string;
    detectedLanguage: string;
    languageCode: string;
  };
  knowledgePacksLoaded: {
    globalInstrumentsCount: number;
    globalPlatformsCount: number;
    globalAdvancedConceptsCount: number;
    globalNegativeTermsCount: number;
    languagePack: {
      code: string;
      name: string;
      positiveTermsCount: number;
      negativeTermsCount: number;
      commonPhrasesCount: number;
    };
    countryPack: {
      name: string;
      exchanges: string[];
      brokers: string[];
      instruments: string[];
      propFirms: string[];
      terminologyCount: number;
    };
  };
  evidenceByProvider: Record<string, {
    providerName: string;
    positiveCount: number;
    negativeCount: number;
    totalWeightContrib: number;
    items: EvidenceItem[];
  }>;
  evidenceSummary: {
    positiveEvidence: EvidenceItem[];
    negativeEvidence: EvidenceItem[];
    totalPositiveWeight: number;
    totalNegativeWeight: number;
    netScore: number;
  };
  classificationOutcome: {
    finalStatus: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW';
    finalConfidence: number;
    primaryCategory: string;
    multiVideoConsistencyRatio: number;
    geminiAudit?: {
      isTrading: 'YES' | 'NO' | 'UNCERTAIN';
      concepts: string[];
      reason: string;
      modelUsed?: string;
    };
  };
  completeReasoningPath: string[];
}

export async function generateClassificationReport(
  input: RawChannelInput,
  existingDecision?: VerificationDecision
): Promise<FullClassificationReport> {
  const decision = existingDecision || await verifyChannelTradingRelevance(input);
  const country = input.country || 'UNKNOWN';
  const knowledgeContext = getLayeredKnowledgeContext(country);

  const allItems = [...decision.positiveEvidence, ...decision.negativeEvidence];

  // Group evidence by provider
  const evidenceByProvider: Record<string, {
    providerName: string;
    positiveCount: number;
    negativeCount: number;
    totalWeightContrib: number;
    items: EvidenceItem[];
  }> = {};

  for (const item of allItems) {
    const pKey = item.provenance?.provider || item.source || 'unknown_provider';
    if (!evidenceByProvider[pKey]) {
      evidenceByProvider[pKey] = {
        providerName: pKey,
        positiveCount: 0,
        negativeCount: 0,
        totalWeightContrib: 0,
        items: []
      };
    }
    evidenceByProvider[pKey].items.push(item);
    if (item.polarity === 'POSITIVE') {
      evidenceByProvider[pKey].positiveCount++;
      evidenceByProvider[pKey].totalWeightContrib += Math.abs(item.finalWeight);
    } else {
      evidenceByProvider[pKey].negativeCount++;
      evidenceByProvider[pKey].totalWeightContrib -= Math.abs(item.finalWeight);
    }
  }

  // Country Selection Rationale
  let countryRationale = `Selected target country '${country}' from channel metadata or discovery query parameter.`;
  if (input.location_tag) {
    countryRationale = `Location tag explicitly set to '${input.location_tag}' on YouTube channel profile. Matched country '${country}'.`;
  }

  // Reasoning Path
  const reasoningPath: string[] = [
    `[Step 1 - Country & Language Resolution] Target Country: '${country}' | Primary Language: '${knowledgeContext.languageKnowledge.languageName}' (${knowledgeContext.languageKnowledge.languageCode})`,
    `[Step 2 - Knowledge Pack Loading] Loaded Global Pack (${knowledgeContext.globalInstruments.length} instruments, ${knowledgeContext.globalPlatformsPropFirms.length} platforms) + Language Pack '${knowledgeContext.languageKnowledge.languageName}' + Country Pack '${knowledgeContext.countryKnowledge.countryName}'`,
    `[Step 3 - Independent Provider Evidence Collection] Collected ${allItems.length} evidence items across ${Object.keys(evidenceByProvider).length} active providers`,
    `[Step 4 - Weight Aggregation] Total Positive Weight: +${decision.totalPositiveWeight} | Total Negative Weight: -${decision.totalNegativeWeight} | Multi-Video Topic Consistency: ${Math.round(decision.multiVideoConsistencyRatio * 100)}%`,
    `[Step 5 - Final Decision Rule] Classification: ${decision.status} (Confidence: ${decision.confidenceScore}%, Category: ${decision.category})`,
    `[Detailed Justification] ${decision.mathematicalJustification}`
  ];

  return {
    timestamp: decision.timestamp || new Date().toISOString(),
    channelInfo: {
      channel_id: input.channel_id,
      channel_name: input.channel_name,
      country
    },
    countryAndLanguage: {
      detectedCountry: country,
      countrySelectionRationale: countryRationale,
      detectedLanguage: knowledgeContext.languageKnowledge.languageName,
      languageCode: knowledgeContext.languageKnowledge.languageCode
    },
    knowledgePacksLoaded: {
      globalInstrumentsCount: knowledgeContext.globalInstruments.length,
      globalPlatformsCount: knowledgeContext.globalPlatformsPropFirms.length,
      globalAdvancedConceptsCount: knowledgeContext.globalAdvancedConcepts.length,
      globalNegativeTermsCount: knowledgeContext.globalNegativeTerms.length,
      languagePack: {
        code: knowledgeContext.languageKnowledge.languageCode,
        name: knowledgeContext.languageKnowledge.languageName,
        positiveTermsCount: knowledgeContext.languageKnowledge.positiveTerms.length,
        negativeTermsCount: knowledgeContext.languageKnowledge.negativeTerms.length,
        commonPhrasesCount: knowledgeContext.languageKnowledge.commonPhrases.length
      },
      countryPack: {
        name: knowledgeContext.countryKnowledge.countryName,
        exchanges: knowledgeContext.countryKnowledge.regionalExchanges,
        brokers: knowledgeContext.countryKnowledge.localBrokers,
        instruments: knowledgeContext.countryKnowledge.popularInstruments,
        propFirms: knowledgeContext.countryKnowledge.localPropFirms,
        terminologyCount: knowledgeContext.countryKnowledge.nativeTradingTerminology.length
      }
    },
    evidenceByProvider,
    evidenceSummary: {
      positiveEvidence: decision.positiveEvidence,
      negativeEvidence: decision.negativeEvidence,
      totalPositiveWeight: decision.totalPositiveWeight,
      totalNegativeWeight: decision.totalNegativeWeight,
      netScore: Math.round((decision.totalPositiveWeight - decision.totalNegativeWeight) * 10) / 10
    },
    classificationOutcome: {
      finalStatus: decision.status,
      finalConfidence: decision.confidenceScore,
      primaryCategory: decision.category,
      multiVideoConsistencyRatio: decision.multiVideoConsistencyRatio,
      geminiAudit: decision.geminiSemanticSummary
    },
    completeReasoningPath: reasoningPath
  };
}
