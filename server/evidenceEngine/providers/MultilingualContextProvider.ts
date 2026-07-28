import type { EvidenceItem, EvidenceProvider, LayeredKnowledgeContext, RawChannelInput } from '../types';
import { completeChannelText, matchedTerms, MULTILINGUAL_CLASSIFICATION_PACKS } from '../multilingualTerminology';

export class MultilingualContextProvider implements EvidenceProvider {
  name = 'multilingual_context' as const;

  async collectEvidence(input: RawChannelInput, context: LayeredKnowledgeContext): Promise<EvidenceItem[]> {
    const languageCode = (context.languageKnowledge?.languageCode || 'en') as keyof typeof MULTILINGUAL_CLASSIFICATION_PACKS;
    const pack = MULTILINGUAL_CLASSIFICATION_PACKS[languageCode] || MULTILINGUAL_CLASSIFICATION_PACKS.en;
    const text = completeChannelText(input);
    const execution = matchedTerms(text, pack.executionTerms);
    const education = matchedTerms(text, pack.educationalTerms);
    const news = matchedTerms(text, pack.businessNewsTerms);
    const genericFinance = matchedTerms(text, pack.genericFinanceTerms);
    const hype = matchedTerms(text, pack.hypeTerms);
    const motivation = matchedTerms(text, pack.motivationTerms);
    const hasCreatorTradingPractice = execution.length > 0 || education.length > 0;
    const items: EvidenceItem[] = [];
    const now = new Date().toISOString();

    if (hasCreatorTradingPractice) {
      const matches = [...execution, ...education];
      const rawWeight = Math.min(30, execution.length * 10 + education.length * 7);
      items.push({
        id: `multi_practice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: this.name,
        polarity: 'POSITIVE',
        category: 'METHODOLOGY_CONCEPT',
        fact: `Authentic ${context.languageKnowledge?.languageName || 'English'} trading education/execution terminology appears across the complete channel context: ${matches.join(', ')}`,
        rawMatches: matches,
        confidence: execution.length >= 2 || (execution.length && education.length) ? 94 : 86,
        reliability: 'VERY_HIGH',
        reliabilityMultiplier: 1,
        rawWeight,
        finalWeight: rawWeight * (execution.length >= 2 ? 0.94 : 0.86),
        provenance: { provider: this.name, type: 'AUTHENTIC_TRADING_PRACTICE', matchedTerm: matches.join(', '), sourceRef: 'Channel title, description, recent uploads, metadata, and official links' },
        timestamp: now
      });
    }

    const addNegative = (matches: string[], category: 'NON_TRADING_ADJACENT' | 'HYPE_SPECULATION', label: string, rawWeight: number, confidence: number) => {
      if (!matches.length) return;
      items.push({
        id: `multi_negative_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: this.name,
        polarity: 'NEGATIVE',
        category,
        fact: `${label}: ${matches.join(', ')}`,
        rawMatches: matches,
        confidence,
        reliability: 'HIGH',
        reliabilityMultiplier: 0.85,
        rawWeight,
        finalWeight: -rawWeight * 0.85 * (confidence / 100),
        provenance: { provider: this.name, type: category, matchedTerm: matches.join(', '), sourceRef: 'Complete channel context contrast analysis' },
        timestamp: now
      });
    };

    // Adjacent finance/news/motivation is negative only when creator-level trading
    // practice is absent; this protects legitimate educators who discuss news.
    if (!hasCreatorTradingPractice) {
      addNegative(news, 'NON_TRADING_ADJACENT', 'Business-news terminology without trading execution or education', 18, 88);
      addNegative(genericFinance, 'NON_TRADING_ADJACENT', 'Generic finance/investing terminology without trading practice', 20, 90);
      addNegative(motivation, 'NON_TRADING_ADJACENT', 'Motivational wealth content without trading practice', 22, 92);
    }
    addNegative(hype, 'HYPE_SPECULATION', 'Crypto/speculation hype terminology', 32, 96);
    return items;
  }
}
