import {
  EvidenceItem,
  EvidenceCollectionReport,
  ScoringEngineConfig,
  VerificationDecision,
  LayeredKnowledgeContext
} from './types';
import type { StagedClassificationReport } from './types';
import { evaluateClassificationStages } from './stagedClassification';
import { ENGINE_VERSIONS, getScoringConfig } from './config';
import { TradingCategory } from '../../src/types';
import { evaluateUnifiedDecisionPolicy, UNIFIED_DECISION_POLICY_VERSION } from './decisionPolicy';

export class ConfigurableWeightedStrategy {
  private config: ScoringEngineConfig;

  constructor(customConfig?: Partial<ScoringEngineConfig>) {
    this.config = { ...getScoringConfig(), ...customConfig };
  }

  public evaluateDecision(
    evidenceItems: EvidenceItem[],
    knowledgeContext: LayeredKnowledgeContext,
    country: string,
    evidenceCollection: EvidenceCollectionReport = { sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false, fieldsPresent: [], reasonCodes: [], providers: [] },
    stagedClassification?: StagedClassificationReport
  ): VerificationDecision {
    const now = new Date().toISOString();
    const stages = stagedClassification || evaluateClassificationStages({ channel_name: '', description: '' }, evidenceItems, evidenceCollection);

    const positiveItems = evidenceItems.filter(i => i.polarity === 'POSITIVE');
    const negativeItems = evidenceItems.filter(i => i.polarity === 'NEGATIVE');

    const totalPositiveWeight = positiveItems.reduce((acc, curr) => acc + Math.abs(curr.finalWeight), 0);
    const totalNegativeWeight = negativeItems.reduce((acc, curr) => acc + Math.abs(curr.finalWeight), 0);
    // Multi-video consistency ratio check
    const consistencyItem = evidenceItems.find(i => i.category === 'MULTI_VIDEO_CONSISTENCY');
    let consistencyRatio = 0.5; // default if no video titles present
    if (consistencyItem) {
      if (consistencyItem.polarity === 'POSITIVE') {
        consistencyRatio = Math.max(0.4, consistencyItem.confidence / 100);
      } else {
        consistencyRatio = Math.min(0.35, 1 - (consistencyItem.confidence / 100));
      }
    }

    // Calculate Net Evidence Score (baseline 50)
    const netWeight = totalPositiveWeight - totalNegativeWeight;
    let confidenceScore = Math.max(0, Math.min(100, Math.round(50 + netWeight)));

    // Categorize
    const category = this.detectPrimaryCategory(evidenceItems);

    // Determine lifecycle state through one selective policy after feature/stage construction.
    let status: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN' = 'UNCERTAIN';
    const justifications: string[] = [];

    justifications.push(`Positive evidence weight: +${totalPositiveWeight.toFixed(1)} (${positiveItems.length} items)`);
    justifications.push(`Negative evidence weight: -${totalNegativeWeight.toFixed(1)} (${negativeItems.length} items)`);
    justifications.push(`Multi-video topic consistency ratio: ${Math.round(consistencyRatio * 100)}%`);

    // High confidence trading conditions:
    const hasHighReliabilityMatch = positiveItems.some(i => i.reliability === 'VERY_HIGH' && i.polarity === 'POSITIVE');
    const hasPlatformOrPropFirm = positiveItems.some(i => i.category === 'PLATFORM_BROKER_PROPFIRM' || i.category === 'EXTERNAL_RESOURCE');
    const hasMethodologyConcept = positiveItems.some(i => i.category === 'METHODOLOGY_CONCEPT' || i.category === 'TERMINOLOGY');

    const policyMinimum=(hasMethodologyConcept||hasHighReliabilityMatch||hasPlatformOrPropFirm)?15:this.config.minPositiveWeightTrading;
    const policy=evaluateUnifiedDecisionPolicy({evidence:evidenceItems,collection:evidenceCollection,lifecycleAction:stages.lifecycleAction,minimumPositiveWeight:policyMinimum,minimumTradingScore:this.config.minVerifiedTradingScore});
    status=policy.status;confidenceScore=policy.confidenceScore;
    if(status==='TRADING_CONFIRMED')justifications.push('DECISION: VERIFIED_TRADING. Calibrated support and independent corroboration satisfied.');
    else if(status==='NON_TRADING')justifications.push('DECISION: VERIFIED_NON_TRADING. Explicit negative-domain evidence forms a dominant attributed contradiction.');
    else {
      const suffix = evidenceCollection.sufficiency === 'MISSING'
        ? 'Required classification metadata is missing.'
        : evidenceCollection.sufficiency === 'INSUFFICIENT'
          ? 'Available metadata is insufficient; absence of a vocabulary match is not negative evidence.'
          : 'Evidence is ambiguous or does not meet a terminal threshold.';
      justifications.push(`DECISION: UNCERTAIN. ${suffix} Preserving for enrichment or review.`);
    }

    justifications.push(`UNIFIED POLICY ${UNIFIED_DECISION_POLICY_VERSION}: ${policy.reasonCodes.join(', ')}; calibrated trading probability ${policy.tradingProbability}%; coverage ${policy.coverageConfidence}%.`);

    // Extract Gemini semantic summary if available
    const geminiItem = evidenceItems.find(i => i.source === 'gemini_semantic');
    let geminiSemanticSummary = undefined;
    if (geminiItem) {
      geminiSemanticSummary = {
        isTrading: geminiItem.polarity === 'POSITIVE' ? ('YES' as const) : geminiItem.polarity === 'NEGATIVE' ? ('NO' as const) : ('UNCERTAIN' as const),
        concepts: geminiItem.rawMatches,
        instruments: [],
        reason: geminiItem.fact,
        modelUsed: ENGINE_VERSIONS.geminiModelVersion
      };
    }

    return {
      status,
      confidenceScore,
      category,
      multiVideoConsistencyRatio: Math.round(consistencyRatio * 100) / 100,
      positiveEvidence: positiveItems,
      negativeEvidence: negativeItems,
      totalPositiveWeight: Math.round(totalPositiveWeight * 10) / 10,
      totalNegativeWeight: Math.round(totalNegativeWeight * 10) / 10,
      countryContextUsed: {
        country,
        language: knowledgeContext.languageKnowledge?.languageName || 'English',
        matchedTerms: positiveItems.flatMap(i => i.rawMatches).slice(0, 10),
        matchedNegativeTerms: negativeItems.flatMap(i => i.rawMatches).slice(0, 10)
      },
      geminiSemanticSummary,
      versions: ENGINE_VERSIONS,
      mathematicalJustification: justifications.join(' | '),
      evidenceCollection,
      stagedClassification: stages,
      timestamp: now,
      decisionPolicy:{version:UNIFIED_DECISION_POLICY_VERSION,tradingProbability:policy.tradingProbability,nonTradingProbability:policy.nonTradingProbability,coverageConfidence:policy.coverageConfidence,reasonCodes:policy.reasonCodes}
    };
  }

  private detectPrimaryCategory(items: EvidenceItem[]): TradingCategory | string {
    const categoryCounts: Record<string, number> = {};

    for (const item of items) {
      if (item.polarity !== 'POSITIVE') continue;

      for (const match of item.rawMatches) {
        const m = match.toLowerCase();
        if (m.includes('futures') || m.includes('nq') || m.includes('es') || m.includes('topstep') || m.includes('apex')) {
          categoryCounts['Futures'] = (categoryCounts['Futures'] || 0) + 2;
        } else if (m.includes('forex') || m.includes('eurusd') || m.includes('gbpusd') || m.includes('cable')) {
          categoryCounts['Forex'] = (categoryCounts['Forex'] || 0) + 2;
        } else if (m.includes('option') || m.includes('0dte') || m.includes('spx')) {
          categoryCounts['Options'] = (categoryCounts['Options'] || 0) + 2;
        } else if (m.includes('crypto') || m.includes('btc') || m.includes('bitcoin') || m.includes('eth') || m.includes('defi')) {
          categoryCounts['Crypto'] = (categoryCounts['Crypto'] || 0) + 2;
        } else if (m.includes('ict') || m.includes('smc') || m.includes('smart money') || m.includes('fvg')) {
          categoryCounts['ICT / Smart Money'] = (categoryCounts['ICT / Smart Money'] || 0) + 2;
        } else if (m.includes('order flow') || m.includes('sierra chart') || m.includes('footprint') || m.includes('dom')) {
          categoryCounts['Order Flow'] = (categoryCounts['Order Flow'] || 0) + 2;
        } else if (m.includes('prop firm') || m.includes('ftmo') || m.includes('funded')) {
          categoryCounts['Prop Firm'] = (categoryCounts['Prop Firm'] || 0) + 2;
        } else if (m.includes('stock') || m.includes('equity') || m.includes('share') || m.includes('pea') || m.includes('actions') || m.includes('bolsa')) {
          categoryCounts['Stocks'] = (categoryCounts['Stocks'] || 0) + 2;
        }
      }
    }

    let topCat = 'General Trading';
    let maxScore = 0;

    for (const [cat, score] of Object.entries(categoryCounts)) {
      if (score > maxScore) {
        maxScore = score;
        topCat = cat;
      }
    }

    return topCat as TradingCategory;
  }
}
